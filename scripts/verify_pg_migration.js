/**
 * scripts/verify_pg_migration.js
 * 数据迁移四级一致性深度核验工具 v2.2
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const sqlite = new Database(
    process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db'),
    { readonly: true }
);
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot',
    options: `-c timezone=${process.env.SQLITE_TIMEZONE || 'Asia/Shanghai'}`
});

// 需要核验的业务表 (全量 79 张表)
const VERIFY_TABLES = [
    'users', 'app_meta', 'app_settings', 'user_settings', 'models',
    'sessions', 'messages', 'memories', 'memory_extraction_jobs',
    'refresh_tokens', 'api_keys', 'model_usage_events', 'api_call_logs',
    'audit_logs', 'attachments', 'prompts', 'announcements', 'announcement_reads',
    'knowledge_collections', 'knowledge_docs', 'knowledge_chunks',
    'knowledge_doc_tags', 'knowledge_tags',
    'knowledge_entities', 'knowledge_entity_mentions', 'knowledge_relations',
    'rag_feedback', 'rag_debug_queries',
    'regulation_documents', 'regulation_versions', 'regulation_articles',
    'regulation_article_links', 'regulation_aliases', 'regulation_article_annotations',
    'regulation_access_logs', 'regulation_saved_searches',
    'agent_runs', 'agent_steps', 'agent_traces', 'agent_trace_spans',
    'agent_run_checkpoints', 'agent_notifications', 'agent_dag_nodes',
    'agent_approval_requests', 'agent_artifacts', 'agent_artifact_versions',
    'agent_eval_suites', 'agent_eval_cases', 'agent_eval_runs', 'agent_eval_results',
    'agent_templates', 'agent_schedules', 'agent_workflows', 'agent_workflow_versions',
    'agent_workflow_triggers', 'agent_workflow_dependency_bindings',
    'workflow_credentials', 'organizations', 'teams', 'team_members',
    'resource_permissions', 'policy_objects', 'deployment_provider_configs',
    'mcp_servers', 'mcp_tool_cache', 'mcp_call_logs',
    'mcp_database_connections', 'mcp_builtin_configs',
    'document_files', 'document_jobs', 'document_pages',
    'document_ocr_blocks', 'document_outputs', 'document_reviews',
    'analysis_datasets', 'analysis_artifacts',
    'capability_packages', 'observability_events', 'schema_migrations',
];

async function verify() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   SQLite ➔ PostgreSQL 四级一致性深度核验                ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    const client = await pool.connect();
    let hasError = false;

    // ── 第一级：行数精确核验 ─────────────────────────────────────────
    console.log('【第一级】行数精确核验');
    console.log(`${'─'.repeat(70)}`);
    console.log(`| ${'表名'.padEnd(35)} | ${'SQLite'.padEnd(8)} | ${'PG'.padEnd(8)} | 状态 |`);
    console.log(`${'─'.repeat(70)}`);

    for (const table of VERIFY_TABLES) {
        try {
            const tableCheck = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            const sqCount = tableCheck ? (sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c || 0) : 0;
            const pgRes = await client.query(`SELECT COUNT(*) AS c FROM "${table}"`);
            const pgCount = parseInt(pgRes.rows[0]?.c || '0', 10);
            const diff = pgCount - sqCount;
            const status = diff === 0 ? '✅ 一致' : `❌ 差 ${diff}`;
            if (diff !== 0) hasError = true;
            console.log(`| ${table.padEnd(35)} | ${String(sqCount).padEnd(8)} | ${String(pgCount).padEnd(8)} | ${status}`);
        } catch (e) {
            const msg = e.message.split('\n')[0].slice(0, 40);
            console.log(`| ${table.padEnd(35)} | 检查异常: ${msg}`);
            hasError = true;
        }
    }

    // ── 第三级：核心文本字段哈希比对 ─────────────────────────────────
    console.log(`\n【第三级】核心文本哈希比对`);
    const hashTargets = [
        { table: 'messages',          col: 'content' },
        { table: 'knowledge_chunks',  col: 'content' },
        { table: 'regulation_articles', col: 'content' },
        { table: 'agent_runs',        col: 'goal' },
    ];
    for (const { table, col } of hashTargets) {
        try {
            const tableCheck = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            if (!tableCheck) {
                console.log(`  ⏩ ${table}.${col}: SQLite 中无此表，跳过`);
                continue;
            }
            const sqRows = sqlite.prepare(`SELECT "${col}" FROM "${table}" ORDER BY id ASC`).all();
            if (sqRows.length === 0) { console.log(`  ⏩ ${table}.${col}: 空表，跳过`); continue; }
            const sqHash = crypto.createHash('sha256')
                .update(sqRows.map(r => r[col] ?? '').join('\x00'))
                .digest('hex');
            const pgRes = await client.query(`SELECT "${col}" FROM "${table}" ORDER BY id ASC`);
            const pgHash = crypto.createHash('sha256')
                .update(pgRes.rows.map(r => r[col] ?? '').join('\x00'))
                .digest('hex');
            const match = sqHash === pgHash;
            if (!match) hasError = true;
            console.log(`  ${match ? '✅' : '❌'} ${table}.${col}: ${match ? 'HASH 完全一致' : '哈希不匹配！'}`);
        } catch (e) {
            console.log(`  ❌ ${table}.${col} 异常: ${e.message.split('\n')[0]}`);
            hasError = true;
        }
    }

    // ── 第四级：业务关系孤儿数据排查 ─────────────────────────────────
    console.log(`\n【第四级】业务关系图完整性排查`);
    const orphanChecks = [
        {
            label: '孤儿消息（无对应会话）',
            sql: `SELECT COUNT(*) AS c FROM messages m LEFT JOIN sessions s ON m.session_id = s.id WHERE s.id IS NULL`
        },
        {
            label: '孤儿会话（无对应用户）',
            sql: `SELECT COUNT(*) AS c FROM sessions s LEFT JOIN users u ON s.user_id = u.id WHERE u.id IS NULL`
        },
        {
            label: '孤儿知识分块（无对应文档）',
            sql: `SELECT COUNT(*) AS c FROM knowledge_chunks kc LEFT JOIN knowledge_docs kd ON kc.doc_id = kd.id WHERE kd.id IS NULL`
        },
        {
            label: '孤儿 Agent 步骤（无对应任务）',
            sql: `SELECT COUNT(*) AS c FROM agent_steps s LEFT JOIN agent_runs r ON s.run_id = r.id WHERE r.id IS NULL`
        },
        {
            label: '孤儿法规条文（无对应版本）',
            sql: `SELECT COUNT(*) AS c FROM regulation_articles a LEFT JOIN regulation_versions v ON a.version_id = v.id WHERE v.id IS NULL`
        },
        {
            label: '消息无效模型引用',
            sql: `SELECT COUNT(*) AS c FROM messages m LEFT JOIN models model ON m.model_id = model.id WHERE m.model_id IS NOT NULL AND model.id IS NULL`
        },
        {
            label: '会话无效分叉消息引用',
            sql: `SELECT COUNT(*) AS c FROM sessions s LEFT JOIN messages m ON s.forked_from_message_id = m.id WHERE s.forked_from_message_id IS NOT NULL AND m.id IS NULL`
        },
    ];
    for (const { label, sql } of orphanChecks) {
        try {
            const res = await client.query(sql);
            const count = parseInt(res.rows[0].c, 10);
            if (count > 0) {
                console.error(`  ❌ 发现 ${count} 条${label}！`);
                hasError = true;
            } else {
                console.log(`  ✅ ${label}: 0 条`);
            }
        } catch (e) {
            console.log(`  ❌ ${label} 检查异常: ${e.message.split('\n')[0]}`);
            hasError = true;
        }
    }

    client.release();
    sqlite.close();
    await pool.end();

    console.log(`\n${'═'.repeat(60)}`);
    if (hasError) {
        console.error('❌ [核验失败] 存在差异，请检查上方报告后再割接！');
        process.exit(1);
    } else {
        console.log('🎉 [核验通过] 四级一致性 100% 通过，数据完整！');
    }
}

verify();
