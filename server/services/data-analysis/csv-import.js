const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { TextDecoder } = require('node:util');
const { bestEffortRemove, createDuckConnection, MAX_UPLOAD_COLUMNS, MAX_UPLOAD_ROWS, normalizeHeader, sqlIdent, sqlLiteral } = require('./shared');
const { executionSignal } = require('./runtime-budget');

function invalidCsvEncoding() {
    return Object.assign(new Error('无法识别 CSV 编码或文件中有损坏的字符，请另存为 UTF-8 CSV 后重新上传。'), {
        status: 400, code: 'ANALYSIS_CSV_ENCODING'
    });
}

async function* decodeCsv(sourcePath, encoding, signal) {
    const decoder = new TextDecoder(encoding, { fatal: true });
    for await (const chunk of fs.createReadStream(sourcePath, { signal })) {
        const text = decoder.decode(chunk, { stream: true });
        if (text.includes('\0')) throw invalidCsvEncoding();
        yield text;
    }
    yield decoder.decode();
}

async function detectCsvEncoding(sourcePath, signal) {
    const file = await fs.promises.open(sourcePath, 'r');
    const prefix = Buffer.alloc(3);
    try {
        await file.read(prefix, 0, prefix.length, 0);
    } finally {
        await file.close();
    }
    if (prefix[0] === 0xff && prefix[1] === 0xfe) return 'utf-16le';
    if (prefix[0] === 0xfe && prefix[1] === 0xff) return 'utf-16be';

    // 无 BOM 时优先校验全文件的 UTF-8，避免仅在后续数据行出现中文时误判。
    try {
        for await (const _text of decodeCsv(sourcePath, 'utf-8', signal)) {
            // 仅验证编码，不保留内容。
        }
    } catch (error) {
        if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
        if (prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw invalidCsvEncoding();
        return 'gb18030';
    }
    return 'utf-8';
}

async function copyCsvToParquet(csvPath, parquetPath) {
    const { instance, connection } = await createDuckConnection();
    try {
        const source = `read_csv_auto(${sqlLiteral(csvPath)}, header=false, all_varchar=true)`;
        const headerRows = (await connection.runAndReadAll(`SELECT * FROM ${source} LIMIT 1`)).getRowObjectsJson();
        if (!headerRows.length) {
            throw Object.assign(new Error('未识别到有效表头或数据行。'), { status: 400 });
        }
        const firstRow = headerRows[0];
        const fieldKeys = Object.keys(firstRow);
        const seen = new Set();
        const columns = fieldKeys.slice(0, MAX_UPLOAD_COLUMNS).map((fieldKey, index) => ({
            key: `c_${index + 1}`,
            name: normalizeHeader(firstRow[fieldKey], index, seen),
            index
        }));
        const sourceRowCount = Number((await connection.runAndReadAll(
            `SELECT GREATEST(COUNT(*) - 1, 0) AS n FROM ${source}`
        )).getRowObjectsJson()[0]?.n || 0);
        if (!sourceRowCount) {
            throw Object.assign(new Error('表格中没有可分析的数据行。'), { status: 400 });
        }

        // DuckDB 会随列数为列名补零，复制时使用探测到的实际列名。
        const selectList = columns.map(column => `${sqlIdent(fieldKeys[column.index])} AS ${sqlIdent(column.key)}`).join(', ');
        await connection.run(
            `COPY (SELECT ${selectList} FROM ${source} OFFSET 1 LIMIT ${MAX_UPLOAD_ROWS}) TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`
        );
        const rowCount = Number((await connection.runAndReadAll(
            `SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(parquetPath)})`
        )).getRowObjectsJson()[0]?.n || 0);
        if (!rowCount) {
            throw Object.assign(new Error('表格中没有可分析的数据行。'), { status: 400 });
        }
        const sourceColumnCount = fieldKeys.length;
        const truncatedRows = sourceRowCount > MAX_UPLOAD_ROWS;
        const truncatedColumns = sourceColumnCount > MAX_UPLOAD_COLUMNS;
        return {
            columns,
            rowCount,
            sourceRowCount,
            sourceColumnCount,
            truncated: truncatedRows || truncatedColumns,
            truncatedRows,
            truncatedColumns,
            truncationReason: [
                truncatedRows ? `行数超过上限 ${MAX_UPLOAD_ROWS}` : '',
                truncatedColumns ? `列数超过上限 ${MAX_UPLOAD_COLUMNS}` : ''
            ].filter(Boolean).join('；')
        };
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

async function importCsvToParquet(sourcePath, parquetPath) {
    const signal = executionSignal();
    let tempDir;
    try {
        const encoding = await detectCsvEncoding(sourcePath, signal);
        if (encoding === 'utf-8') return await copyCsvToParquet(sourcePath, parquetPath);

        // 仅为需要转码的文件写入临时副本，原始文件继续用于溯源。
        tempDir = await fs.promises.mkdtemp(path.join(path.dirname(parquetPath), '.csv-import-'));
        const csvPath = path.join(tempDir, 'normalized.csv');
        await pipeline(decodeCsv(sourcePath, encoding, signal), fs.createWriteStream(csvPath, {
            flags: 'wx', mode: 0o600
        }), { signal });
        return await copyCsvToParquet(csvPath, parquetPath);
    } catch (error) {
        if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw invalidCsvEncoding();
        if (error.code === 'ABORT_ERR' && signal?.aborted) {
            throw Object.assign(new Error('分析执行已取消，请重新上传。'), { status: 409, code: 'ANALYSIS_MODEL_LEASE_LOST' });
        }
        if (/^Invalid Input Error: (?:CSV Error\b|Error when sniffing file\b)/.test(error.message)) {
            throw Object.assign(new Error('无法解析 CSV，请检查各行字段数、分隔符和引号后重新上传。'), {
                status: 400, code: 'ANALYSIS_CSV_FORMAT'
            });
        }
        throw error;
    } finally {
        await bestEffortRemove(tempDir, { recursive: true });
    }
}

module.exports = { importCsvToParquet };
