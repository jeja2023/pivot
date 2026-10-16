'use strict';

// 上线前只读验收：确认知识库 AI 的审计表、索引、模型上下文与语义核验配置已
// 达到可用状态。它不发送模型请求，也不读取任何用户知识库正文。
require('dotenv').config();
const { getPgPool, closePgPool } = require('../server/db/pg-connection');
const { readTypedEnv } = require('../server/config/env-registry');

const MIGRATION = '202610160001_knowledge_ai_answer_audit';
const TABLES = ['knowledge_ai_answer_logs', 'knowledge_eval_cases', 'knowledge_eval_runs', 'knowledge_eval_results'];
const INDEXES = ['idx_knowledge_ai_answer_logs_user_created', 'idx_knowledge_ai_answer_logs_surface_created'];

function getMinimumContext() {
    return process.argv.includes('--require-256k') ? 262_144 : 0;
}

async function main() {
    if (!String(process.env.DATABASE_URL || '').trim()) {
        throw new Error('需要 DATABASE_URL 才能验证目标 PostgreSQL 的知识库 AI 上线状态。');
    }
    const pool = getPgPool();
    try {
        const [migrationRows, tableRows, indexRows, modelRows] = await Promise.all([
            pool.query('SELECT id FROM schema_migrations WHERE id = $1', [MIGRATION]),
            pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])', [TABLES]),
            pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])', [INDEXES]),
            pool.query(`
                SELECT id, name, model_name, context_window_tokens, max_tokens
                FROM models WHERE status = 'active' ORDER BY context_window_tokens DESC NULLS LAST, id ASC
            `)
        ]);
        const presentMigrations = new Set(migrationRows.rows.map(row => row.id));
        const presentTables = new Set(tableRows.rows.map(row => row.table_name));
        const presentIndexes = new Set(indexRows.rows.map(row => row.indexname));
        const minimumContext = getMinimumContext();
        const models = modelRows.rows.map(row => ({
            id: Number(row.id),
            name: row.name || row.model_name || '',
            contextWindowTokens: Number(row.context_window_tokens || 0),
            maxTokens: Number(row.max_tokens || 0)
        }));
        const usableModels = minimumContext
            ? models.filter(model => model.contextWindowTokens >= minimumContext)
            : models;
        const missing = [
            ...(!presentMigrations.has(MIGRATION) ? [`迁移 ${MIGRATION}`] : []),
            ...TABLES.filter(name => !presentTables.has(name)).map(name => `表 ${name}`),
            ...INDEXES.filter(name => !presentIndexes.has(name)).map(name => `索引 ${name}`),
            ...(readTypedEnv('PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED') !== true ? ['PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED=true'] : []),
            ...(usableModels.length ? [] : [minimumContext ? `上下文窗口不少于 ${minimumContext} tokens 的活动模型` : '活动模型'])
        ];
        if (missing.length) throw new Error(`知识库 AI 上线验收未通过：缺少 ${missing.join('；')}`);
        process.stdout.write(`${JSON.stringify({
            ok: true,
            migration: MIGRATION,
            tables: TABLES,
            indexes: INDEXES,
            semanticVerifierEnabled: true,
            minimumContextWindowTokens: minimumContext || null,
            models: usableModels
        }, null, 2)}\n`);
    } finally {
        await closePgPool();
    }
}

main().catch(error => {
    process.stderr.write(`知识库 AI 上线验收失败：${error.message}\n`);
    process.exitCode = 1;
});
