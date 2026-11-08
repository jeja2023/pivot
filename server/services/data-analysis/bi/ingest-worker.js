'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sqlIdentifier, sqlLiteral } = require('./sql-expressions');
const { profileWithConnection } = require('../profile-sql');
const { biError } = require('./errors');

const invalid = message => biError('ANALYSIS_INGESTION_INVALID', message);

// 分块按原字节顺序拼接，跨块引号、换行和 UTF-8 多字节字符保持原样。
async function ingestCsvChunks(connection, payload) {
    const { headers, expectedRows, role } = payload.query;
    if (!Array.isArray(headers) || !headers.length || headers.length > 120 || !['fact', 'dimension'].includes(role)) throw invalid('分批导入字段合同无效。');
    const parts = Object.entries(payload.sources).sort(([left], [right]) => left.localeCompare(right, 'en'));
    if (!parts.length || parts.length > 256) throw invalid('分批导入分块数量无效。');
    const inputFile = path.join(payload.outputRoot, 'source.csv'), outputFile = path.join(payload.outputRoot, 'dataset.parquet');
    const progress = async (phase, column = null) => fs.promises.writeFile(path.join(payload.outputRoot, 'execution-progress.json'), JSON.stringify({ phase, column, maxRssBytes: process.resourceUsage().maxRSS * 1024 }), { mode: 0o644 });
    await progress('merge');
    const handle = await fs.promises.open(inputFile, 'wx', 0o600);
    let bytes = 0;
    try {
        for (const [index, [name, part]] of parts.entries()) {
            if (name !== `chunk_${String(index).padStart(3, '0')}` || !path.isAbsolute(part.file) || !/^[a-f0-9]{64}$/.test(part.digest)) throw invalid('分批导入分块顺序无效。');
            const hash = crypto.createHash('sha256'); let partBytes = 0;
            for await (const data of fs.createReadStream(part.file)) {
                bytes += data.length; partBytes += data.length;
                if (bytes > 2 * 1024 ** 3 || partBytes > 8 * 1024 ** 2) throw invalid('分批导入超出受控字节上限。');
                hash.update(data); await handle.writeFile(data);
            }
            if (hash.digest('hex') !== part.digest || String(partBytes) !== String(part.byteLength)) throw invalid('分批导入分块内容发生变化。');
        }
        if (String(bytes) !== String(payload.query.expectedBytes)) throw invalid('分批导入文件总字节数不一致。');
        await handle.sync();
    } finally { await handle.close(); }
    try {
        await connection.run('SET autoinstall_known_extensions=false');
        await connection.run('SET autoload_known_extensions=false');
        // 只限制导入缓冲和写入行组，文件仍逐行严格校验；分析结果不依赖物理行序。
        await connection.run('SET preserve_insertion_order=false');
        await progress('schema');
        const csv = `read_csv(${sqlLiteral(inputFile)},header=true,delim=',',quote='"',escape='"',all_varchar=true,strict_mode=true,null_padding=false,ignore_errors=false,parallel=false,max_line_size=4194304,buffer_size=16777216,sample_size=2048)`;
        const schema = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${csv}`)).getRowObjectsJson();
        if (schema.length !== headers.length || schema.some((column, index) => column.column_name !== headers[index])) throw invalid('CSV 表头与声明字段不一致，不接受自动重命名或缺失列。');
        await progress('count');
        const rows = Number((await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${csv}`)).getRowObjectsJson()[0].n);
        if (rows < 1 || rows > (role === 'fact' ? 1000000 : 2000000) || expectedRows !== null && rows !== expectedRows) throw invalid('CSV 实际行数超过档位或与声明不一致，未创建部分数据集。');
        const columns = headers.map((name, index) => ({ key: `c_${index + 1}`, name, index, sourceKey: name, previewCharacterLimit: 256 }));
        await progress('parquet');
        await connection.run(`COPY (SELECT ${columns.map(column => `${sqlIdentifier(column.name)} AS ${sqlIdentifier(column.key)}`).join(',')} FROM ${csv}) TO ${sqlLiteral(outputFile)} (FORMAT PARQUET,COMPRESSION ZSTD,COMPRESSION_LEVEL 1,ROW_GROUP_SIZE 8192)`);
        const stat = await fs.promises.stat(outputFile);
        if (stat.size > 2 * 1024 ** 3) throw invalid('导入数据文件超出 2 GiB 上限，未登记数据集。');
        const profile = await profileWithConnection(connection, outputFile, columns, rows, { sampleChars: 256, onColumn: column => progress('profile', column) });
        await progress('verify');
        const previewRows = (await connection.runAndReadAll(`SELECT ${columns.map(column => `left(${sqlIdentifier(column.key)},256) AS ${sqlIdentifier(column.key)}`).join(',')} FROM read_parquet(${sqlLiteral(outputFile)}) LIMIT 100`)).getRowObjectsJson();
        const verified = Number((await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(outputFile)})`)).getRowObjectsJson()[0].n);
        if (verified !== rows) throw invalid('导入产物记录数不一致，未登记数据集。');
        const file = await fs.promises.open(outputFile, 'r+'); try { await file.sync(); } finally { await file.close(); }
        await fs.promises.chmod(outputFile, 0o644);
        return { rowCount: rows, columns, profile, previewRows, previewCellLimit: 256, complete: true, inputBytes: bytes, outputBytes: stat.size };
    } catch (error) {
        if (/^(?:Invalid Input Error: )?(?:CSV Error|Invalid unicode|Invalid UTF-8)/i.test(String(error.message || ''))) throw invalid('CSV 数据行或编码与字段合同不一致，未登记部分数据；请修正 CSV 后重试。');
        throw error;
    } finally { await fs.promises.unlink(inputFile).catch(() => {}); }
}

module.exports = { ingestCsvChunks };
