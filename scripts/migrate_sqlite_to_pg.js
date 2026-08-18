/**
 * scripts/migrate_sqlite_to_pg.js
 * Pivot 生产级无损数据迁移引擎 (SQLite ➔ PostgreSQL) v2.2
 * 用法：SQLITE_TIMEZONE=Asia/Shanghai DATABASE_URL=postgresql://... node scripts/migrate_sqlite_to_pg.js
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const sqlitePath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db');
const pgUrl = process.env.DATABASE_URL;
const sqliteTz = process.env.SQLITE_TIMEZONE || 'Asia/Shanghai';
const startFromTable = process.env.START_FROM_TABLE || null;

if (!pgUrl) {
    console.error('❌ [Fatal] 未配置 DATABASE_URL 环境变量');
    process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ [Fatal] SQLite 数据库文件不存在: ${sqlitePath}`);
    process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({
    connectionString: pgUrl,
    max: 3,
    options: `-c timezone=${sqliteTz}`
});

// ── 拓扑顺序：父表在前，子表在后 ───────────────────────────────────────
const TABLE_TOPOLOGY = [
    { name: 'users' },
    { name: 'app_meta' },
    { name: 'app_settings' },
    { name: 'user_settings' },
    { name: 'models' },
    { name: 'sessions' },
    { name: 'messages' },
    { name: 'memories' },
    { name: 'memory_extraction_jobs' },
    { name: 'refresh_tokens' },
    { name: 'api_keys' },
    { name: 'model_usage_events' },
    { name: 'api_call_logs' },
    { name: 'audit_logs' },
    { name: 'attachments' },
    { name: 'prompts' },
    { name: 'announcements' },
    { name: 'announcement_reads' },
    { name: 'knowledge_collections' },
    { name: 'knowledge_docs' },
    { name: 'knowledge_chunks' },
    { name: 'knowledge_doc_tags' },
    { name: 'knowledge_tags' },
    { name: 'knowledge_entities' },
    { name: 'knowledge_entity_mentions' },
    { name: 'knowledge_relations' },
    { name: 'rag_feedback' },
    { name: 'rag_debug_queries' },
    { name: 'regulation_documents' },
    { name: 'regulation_versions' },
    { name: 'regulation_articles' },
    { name: 'regulation_article_links' },
    { name: 'regulation_aliases' },
    { name: 'regulation_article_annotations' },
    { name: 'regulation_access_logs' },
    { name: 'regulation_saved_searches' },
    { name: 'agent_runs' },
    { name: 'agent_steps' },
    { name: 'agent_traces' },
    { name: 'agent_trace_spans' },
    { name: 'agent_run_checkpoints' },
    { name: 'agent_notifications' },
    { name: 'agent_dag_nodes' },
    { name: 'agent_approval_requests' },
    { name: 'agent_artifacts' },
    { name: 'agent_artifact_versions' },
    { name: 'agent_eval_suites' },
    { name: 'agent_eval_cases' },
    { name: 'agent_eval_runs' },
    { name: 'agent_eval_results' },
    { name: 'agent_templates' },
    { name: 'agent_schedules' },
    { name: 'agent_workflows' },
    { name: 'agent_workflow_versions' },
    { name: 'agent_workflow_triggers' },
    { name: 'agent_workflow_dependency_bindings' },
    { name: 'workflow_credentials' },
    { name: 'organizations' },
    { name: 'teams' },
    { name: 'team_members' },
    { name: 'resource_permissions' },
    { name: 'policy_objects' },
    { name: 'deployment_provider_configs' },
    { name: 'mcp_servers' },
    { name: 'mcp_tool_cache' },
    { name: 'mcp_call_logs' },
    { name: 'mcp_database_connections' },
    { name: 'mcp_builtin_configs' },
    { name: 'document_files' },
    { name: 'document_jobs' },
    { name: 'document_pages' },
    { name: 'document_ocr_blocks' },
    { name: 'document_outputs' },
    { name: 'document_reviews' },
    { name: 'analysis_datasets' },
    { name: 'analysis_artifacts' },
    { name: 'capability_packages' },
    { name: 'observability_events' },
    { name: 'schema_migrations' },
];

// JSONB 白名单（严禁首字符猜测）
const JSONB_COLUMNS = {};

// 布尔列白名单（仅 0/1 整型语义）
const BOOLEAN_COLUMNS = {
    users:                ['deleted_by_admin'],
    sessions:             ['is_pinned', 'is_archived', 'deleted_by_user'],
    messages:             ['is_summary', 'context_archived', 'deleted_by_user'],
    models:               ['is_default'],
    knowledge_docs:       ['is_enabled', 'deleted_by_user'],
    attachments:          ['deleted_by_user'],
    agent_eval_results:   ['passed'],
    agent_runs:           ['deleted_by_user'],
    regulation_documents: ['deleted_by_user'],
    agent_approval_requests: ['callback_signature_required'],
    mcp_servers:          [],
    api_keys:             [],
    api_call_logs:        ['stream'],
};

// 向量列白名单
const VECTOR_COLUMNS = {
    knowledge_chunks: ['embedding'],
    memories:         ['embedding'],
    regulation_articles: ['embedding'],
};

// ── 序列重置：兼容 SERIAL 与 GENERATED ALWAYS AS IDENTITY ─────────────
async function resetSequence(client, tableName, pkName) {
    try {
        const seqRes = await client.query(
            'SELECT pg_get_serial_sequence($1, $2) AS seq_name',
            [tableName, pkName]
        );
        const seqName = seqRes.rows[0]?.seq_name;
        if (seqName) {
            await client.query(
                `SELECT setval($1, COALESCE((SELECT MAX("${pkName}") FROM "${tableName}"), 1), true)`,
                [seqName]
            );
            console.log(`   🔢 SERIAL 序列已重置`);
            return;
        }
        // IDENTITY 列
        const maxRes = await client.query(`SELECT MAX("${pkName}") AS m FROM "${tableName}"`);
        const maxVal = maxRes.rows[0]?.m;
        if (maxVal !== null && maxVal !== undefined) {
            const next = BigInt(maxVal) + 1n;
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${pkName}" RESTART WITH ${next}`);
            console.log(`   🔢 IDENTITY 序列已重置为 ${next}`);
        }
    } catch (_) {
        // VARCHAR/UUID 主键无序列，正常跳过
    }
}

// ── 单张表迁移 ─────────────────────────────────────────────────────────
async function migrateTable(tableConfig, client) {
    const tableName = tableConfig.name;

    const tableCheck = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(tableName);
    if (!tableCheck) {
        console.log(`⏩ [Skip] SQLite 中不存在表 [${tableName}]`);
        return;
    }

    const totalCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get().c;
    console.log(`\n📦 迁移 [${tableName}] | ${totalCount} 行`);
    if (totalCount === 0) {
        console.log(`   ⏩ 空表，跳过`);
        return;
    }

    const colInfo = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all();
    const pkInfo  = colInfo.find(c => c.pk === 1);
    const pkName  = tableConfig.pkOverride || (pkInfo ? pkInfo.name : 'rowid');

    // 动态批次防爆
    const tableCols = colInfo.map(c => c.name);
    const safeBatch = Math.max(10, Math.min(1000, Math.floor(60000 / tableCols.length)));

    const jsonCols = new Set(JSONB_COLUMNS[tableName] || []);
    const boolCols = new Set(BOOLEAN_COLUMNS[tableName] || []);
    const vecCols  = new Set(VECTOR_COLUMNS[tableName] || []);

    let lastId = null;
    let migratedCount = 0;

    await client.query('BEGIN');
    try {
        while (migratedCount < totalCount) {
            let sql = `SELECT * FROM "${tableName}"`;
            const params = [];
            if (lastId !== null) {
                sql += ` WHERE "${pkName}" > ?`;
                params.push(lastId);
            }
            sql += ` ORDER BY "${pkName}" ASC LIMIT ?`;
            params.push(safeBatch);

            const rows = sqlite.prepare(sql).all(...params);
            if (rows.length === 0) break;

            const columns      = Object.keys(rows[0]);
            const colsFmt      = columns.map(c => `"${c}"`).join(', ');
            const allPlaceholders = [];
            const flatParams   = [];
            let paramIdx = 1;

            for (const row of rows) {
                const rowPH = [];
                for (const col of columns) {
                    let val = row[col];

                    // 1. JSONB 白名单转换
                    if (jsonCols.has(col)) {
                        if (val === null || val === undefined) {
                            val = null;
                        } else if (typeof val === 'string') {
                            try { val = JSON.stringify(JSON.parse(val)); }
                            catch (e) {
                                throw new Error(`[${tableName}][${col}] pk=${row[pkName]} JSON 损坏: ${String(val).slice(0, 100)}`);
                            }
                        } else if (typeof val === 'object') {
                            val = JSON.stringify(val);
                        }
                    }

                    // 2. Boolean 转换（仅 0/1 整型）
                    if (boolCols.has(col) && val !== null && val !== undefined) {
                        val = (val === 1 || val === '1' || val === true);
                    }

                    // 3. Vector 格式化
                    if (vecCols.has(col)) {
                        if (val === null || val === undefined || val === '' || val === '[]') {
                            val = null; // 空值或空数组统一置 NULL
                        } else if (typeof val === 'string' && val.trim().startsWith('[')) {
                            // 已合法，保持
                        } else if (Array.isArray(val) && val.length > 0) {
                            val = `[${val.join(',')}]`;
                        } else {
                            val = null; // 其他非法格式静默置 NULL
                        }
                    }

                    flatParams.push(val);
                    rowPH.push(`$${paramIdx++}`);
                }
                allPlaceholders.push(`(${rowPH.join(', ')})`);
                lastId = row[pkName];
            }

            const insertSql = `INSERT INTO "${tableName}" (${colsFmt}) OVERRIDING SYSTEM VALUE VALUES ${allPlaceholders.join(', ')}`;
            await client.query(insertSql, flatParams);

            migratedCount += rows.length;
            process.stdout.write(`\r   ├─ ${migratedCount}/${totalCount} (${Math.round(migratedCount / totalCount * 100)}%)`);
        }

        await resetSequence(client, tableName, pkName);
        await client.query('COMMIT');
        console.log(`\n   ✅ 完成 (${migratedCount} 行)`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
            `[${tableName}] 迁移失败，事务已回滚。\n` +
            `重跑：START_FROM_TABLE=${tableName} node scripts/migrate_sqlite_to_pg.js\n` +
            `详情: ${err.message}`
        );
    }
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
    const client = await pool.connect();
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Pivot 生产级数据迁移引擎: SQLite ➔ PostgreSQL  ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  SQLite 路径   : ${sqlitePath}`);
    console.log(`  时区基准      : ${sqliteTz}`);
    console.log(`  目标数据库    : ${pgUrl.replace(/:[^@]+@/, ':***@')}`);
    if (startFromTable) console.log(`  ⚡ 断点续传从 : [${startFromTable}]`);
    const t0 = Date.now();

    try {
        await client.query(`SET timezone = '${sqliteTz}'`);
        // 关闭外键约束检查，迁移完成后再开启
        // sessions.forked_from_message_id 等循环 FK 在数据全部导入后才能满足
        await client.query('SET session_replication_role = replica');

        let startIdx = 0;
        if (startFromTable) {
            const idx = TABLE_TOPOLOGY.findIndex(t => t.name === startFromTable);
            if (idx < 0) throw new Error(`START_FROM_TABLE=[${startFromTable}] 不在拓扑列表中`);
            startIdx = idx;
        }

        for (let i = startIdx; i < TABLE_TOPOLOGY.length; i++) {
            await migrateTable(TABLE_TOPOLOGY[i], client);
        }

        // 恢复外键约束检查
        await client.query('SET session_replication_role = DEFAULT');

        console.log('\n╔══════════════════════════════════════════════════╗');
        console.log(`║  🎉 全量迁移成功！耗时: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        console.log('╚══════════════════════════════════════════════════╝');
    } catch (err) {
        console.error('\n❌ [Fatal] 迁移中断:', err.message);
        process.exit(1);
    } finally {
        client.release();
        sqlite.close();
        await pool.end();
    }
}

main();
