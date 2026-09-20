'use strict';

// 只读迁移对账：部署后确认旧 RAG 投影与产品化身份、引用、权限和向量索引
// 状态一致。默认仅输出报告；--strict 会把影响正式检索的一致性问题作为失败。
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { query, queryOne } = require('../server/db/client');
const { closePgPool } = require('../server/db/pg-connection');

async function count(sql, params = []) {
    const row = await queryOne(sql, params);
    return Number(row?.count || 0);
}

async function collectKnowledgeMigrationReport() {
    const foundation = await queryOne("SELECT to_regclass('knowledge_documents') AS table_name");
    if (!foundation?.table_name) {
        throw new Error('当前 PostgreSQL 尚未应用知识库产品化迁移；请先启动 Pivot 或执行正式数据库迁移，再运行本对账命令。');
    }
    const [legacyDocuments, readyLegacyDocuments, productDocuments, publishedDocuments, chunks, vectorChunks, lexicalReadyDocuments, permissions, citations, orphanEnabledLegacyDocuments, publishedWithoutCurrentProjection, duplicateCanonicalUris, jobs] = await Promise.all([
        count('SELECT COUNT(*) AS count FROM knowledge_docs WHERE deleted_at IS NULL'),
        count("SELECT COUNT(*) AS count FROM knowledge_docs WHERE deleted_at IS NULL AND status IN ('ready', 'lexical_ready') AND COALESCE(is_enabled, 1) = 1"),
        count('SELECT COUNT(*) AS count FROM knowledge_documents WHERE deleted_at IS NULL'),
        count("SELECT COUNT(*) AS count FROM knowledge_documents WHERE deleted_at IS NULL AND lifecycle_status = 'published'"),
        count('SELECT COUNT(*) AS count FROM knowledge_chunks'),
        count('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE embedding IS NOT NULL'),
        count("SELECT COUNT(*) AS count FROM knowledge_docs WHERE deleted_at IS NULL AND status = 'lexical_ready'"),
        count('SELECT COUNT(*) AS count FROM knowledge_permissions'),
        count('SELECT COUNT(*) AS count FROM knowledge_citations'),
        count(`
            SELECT COUNT(*) AS count FROM knowledge_docs legacy
            LEFT JOIN knowledge_documents product ON product.id = legacy.product_document_id AND product.deleted_at IS NULL
            WHERE legacy.deleted_at IS NULL AND legacy.status IN ('ready', 'lexical_ready')
              AND COALESCE(legacy.is_enabled, 1) = 1 AND product.id IS NULL
        `),
        count(`
            SELECT COUNT(*) AS count FROM knowledge_documents product
            LEFT JOIN knowledge_docs legacy ON legacy.id = product.legacy_doc_id AND legacy.deleted_at IS NULL
            WHERE product.deleted_at IS NULL AND product.lifecycle_status = 'published'
              AND (legacy.id IS NULL OR COALESCE(legacy.is_enabled, 1) = 0)
        `),
        count(`
            SELECT COUNT(*) AS count FROM (
                SELECT source_id, canonical_uri FROM knowledge_documents
                WHERE deleted_at IS NULL AND canonical_uri != ''
                GROUP BY source_id, canonical_uri HAVING COUNT(*) > 1
            ) duplicate_uri
        `),
        query(`SELECT status, COUNT(*) AS count FROM knowledge_ingestion_jobs GROUP BY status`)
    ]);
    return {
        generatedAt: new Date().toISOString(),
        documents: { legacyDocuments, readyLegacyDocuments, productDocuments, publishedDocuments },
        indexing: { chunks, vectorChunks, lexicalReadyDocuments, vectorCoverage: chunks ? Number((vectorChunks / chunks).toFixed(4)) : null },
        governance: { permissions, citations },
        jobs: Object.fromEntries(jobs.map(row => [row.status, Number(row.count || 0)])),
        consistency: { orphanEnabledLegacyDocuments, publishedWithoutCurrentProjection, duplicateCanonicalUris }
    };
}

async function main() {
    const report = await collectKnowledgeMigrationReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!process.argv.includes('--strict')) return;
    const failures = Object.entries(report.consistency).filter(([, count]) => Number(count) > 0);
    if (failures.length) {
        process.stderr.write(`知识库迁移对账失败：${failures.map(([name, count]) => `${name}=${count}`).join(', ')}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) main().catch(error => {
    process.stderr.write(`知识库迁移对账失败：${error.message}\n`);
    process.exitCode = 1;
}).finally(() => closePgPool().catch(() => {}));

module.exports = { collectKnowledgeMigrationReport };
