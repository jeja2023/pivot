'use strict';

// 恢复到独立演练数据库后，仅做只读数据对账。
const { Client } = require('pg');

const TABLES = ['knowledge_docs', 'knowledge_chunks', 'knowledge_documents', 'knowledge_document_versions', 'knowledge_citations', 'knowledge_pdf_ocr_pages', 'knowledge_sources'];

function validateTargets(source, target) {
    const a = new URL(source), b = new URL(target);
    if (!['postgres:', 'postgresql:'].includes(a.protocol) || !['postgres:', 'postgresql:'].includes(b.protocol)) throw new Error('对照地址必须是 PostgreSQL 地址。');
    if (a.search || b.search || a.hash || b.hash) throw new Error('对照地址不支持额外连接参数，请使用明确的数据库地址。');
    const identity = value => `${value.hostname.toLowerCase()}:${value.port || '5432'}${value.pathname.toLowerCase()}`;
    if (identity(a) === identity(b) || a.pathname.toLowerCase() === b.pathname.toLowerCase()) throw new Error('源库与恢复库必须是不同名称的数据库。');
}

async function collect(client) {
    const values = {};
    for (const table of TABLES) {
        const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
        values[table] = Number(result.rows[0].count);
    }
    const invalid = await client.query(`SELECT COUNT(*)::bigint AS count FROM knowledge_chunks c LEFT JOIN knowledge_docs d ON d.id = c.doc_id WHERE d.id IS NULL`);
    values.orphanChunks = Number(invalid.rows[0].count);
    return values;
}

async function compareDatabases(sourceUrl, targetUrl) {
    validateTargets(sourceUrl, targetUrl);
    const source = new Client({ connectionString: sourceUrl }), target = new Client({ connectionString: targetUrl });
    try {
        await source.connect(); await target.connect();
        await source.query('SET default_transaction_read_only = on');
        await target.query('SET default_transaction_read_only = on');
        const original = await collect(source), restored = await collect(target);
        const differences = TABLES.filter(table => original[table] !== restored[table]).map(table => ({ table, source: original[table], restored: restored[table] }));
        return { ok: differences.length === 0 && restored.orphanChunks === 0, original, restored, differences,
            note: '仅检查数据库表计数与分块引用。原文件、密钥、权限、索引检索、时间一致性及应用恢复仍须独立核验。' };
    } finally { await source.end().catch(() => {}); await target.end().catch(() => {}); }
}

if (require.main === module) {
    if (process.env.KNOWLEDGE_RESTORE_CHECK_CONFIRM !== 'YES') { process.stderr.write('请显式设置 KNOWLEDGE_RESTORE_CHECK_CONFIRM=YES 并提供源库及恢复库地址。\n'); process.exitCode = 1; }
    else compareDatabases(process.env.KNOWLEDGE_RESTORE_SOURCE_URL, process.env.KNOWLEDGE_RESTORE_TARGET_URL)
        .then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (!report.ok) process.exitCode = 1; })
        .catch(error => { process.stderr.write(`恢复核验失败：${error.message}\n`); process.exitCode = 1; });
}

module.exports = { validateTargets, compareDatabases };
