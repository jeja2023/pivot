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
const repairOrphanForeignKeys = String(process.env.REPAIR_ORPHAN_FOREIGN_KEYS || '').trim().toLowerCase() === 'true';

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

// 向量列白名单
const VECTOR_COLUMNS = {
    knowledge_chunks: ['embedding'],
    memories:         ['embedding'],
    regulation_articles: ['embedding'],
};

function quoteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * 普通业务账号不能关闭约束触发器时，暂存外键定义。导入完成后以 NOT VALID
 * 恢复，因此存量历史数据不阻断迁移，而后续写入仍受约束保护。
 */
async function loadForeignKeys(client) {
    const result = await client.query(`
        SELECT DISTINCT
            tc.table_name,
            tc.constraint_name,
            pg_get_constraintdef(con.oid) AS definition
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
         AND tc.table_name = kcu.table_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_schema = ccu.constraint_schema
         AND tc.constraint_name = ccu.constraint_name
        JOIN pg_constraint con
          ON con.conname = tc.constraint_name
         AND con.conrelid = format('%I.%I', tc.constraint_schema, tc.table_name)::regclass
        WHERE tc.table_schema = current_schema()
          AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name, tc.constraint_name
    `);
    return result.rows.map(row => ({
        ...row,
        // pg_get_constraintdef() 在约束本身未验证时可能包含 NOT VALID；
        // 恢复时统一由本工具追加，避免生成重复语法。
        definition: String(row.definition || '').replace(/\s+NOT VALID\s*$/i, ''),
    }));
}

async function dropForeignKeys(client, foreignKeys) {
    for (const fk of foreignKeys) {
        await client.query(
            `ALTER TABLE ${quoteIdentifier(fk.table_name)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(fk.constraint_name)}`
        );
    }
}

async function restoreForeignKeys(client, foreignKeys) {
    for (const fk of foreignKeys) {
        const exists = await client.query(`
            SELECT 1
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
            WHERE ns.nspname = current_schema()
              AND rel.relname = $1
              AND con.conname = $2
            LIMIT 1
        `, [fk.table_name, fk.constraint_name]);
        if (exists.rowCount) continue;

        await client.query(
            `ALTER TABLE ${quoteIdentifier(fk.table_name)}
             ADD CONSTRAINT ${quoteIdentifier(fk.constraint_name)} ${fk.definition} NOT VALID`
        );
        try {
            await client.query(
                `ALTER TABLE ${quoteIdentifier(fk.table_name)}
                 VALIDATE CONSTRAINT ${quoteIdentifier(fk.constraint_name)}`
            );
        } catch (err) {
            // SQLite 历史数据可能存在孤儿引用。保留 NOT VALID 外键可保护后续写入，
            // 同时把无法验证的约束记录下来，避免迁移因存量脏数据失败。
            if (err.code !== '23503') throw err;
            console.warn(`   ⚠️ 外键 ${fk.table_name}.${fk.constraint_name} 含历史孤儿引用，保留 NOT VALID`);
        }
    }
}

/**
 * 可选的数据修复：只处理允许 NULL 的历史外键，将不再存在的引用置空。
 * 默认关闭以保持迁移逐字段无损；测试库或已批准的数据治理窗口可显式开启，
 * 以取得全部外键的 VALID 状态而不删除业务记录。
 */
async function repairNullableOrphanForeignKeys(client) {
    const repairs = [
        { table: 'messages', column: 'model_id', refTable: 'models', refColumn: 'id' },
        { table: 'sessions', column: 'forked_from_message_id', refTable: 'messages', refColumn: 'id' },
    ];

    let repairedRows = 0;
    for (const repair of repairs) {
        const result = await client.query(`
            UPDATE ${quoteIdentifier(repair.table)} AS child
            SET ${quoteIdentifier(repair.column)} = NULL
            WHERE child.${quoteIdentifier(repair.column)} IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM ${quoteIdentifier(repair.refTable)} AS parent
                  WHERE parent.${quoteIdentifier(repair.refColumn)} = child.${quoteIdentifier(repair.column)}
              )
        `);
        if (result.rowCount) {
            repairedRows += result.rowCount;
            console.warn(`  🩹 已清理 ${repair.table}.${repair.column} 的 ${result.rowCount} 条失效历史引用`);
        }
    }
    return repairedRows;
}

// ── 序列重置：兼容 SERIAL 与 GENERATED ALWAYS AS IDENTITY ─────────────
async function resetSequence(client, tableName, pkName) {
    if (!pkName || pkName === 'rowid') return;
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

        // 检查是否为 IDENTITY 列
        const idColRes = await client.query(`
            SELECT attidentity 
            FROM pg_attribute 
            WHERE attrelid = $1::regclass AND attname = $2
        `, [tableName, pkName]).catch(() => ({ rows: [] }));
        const isIdentity = Boolean(idColRes.rows[0]?.attidentity);
        if (isIdentity) {
            const maxRes = await client.query(`SELECT MAX("${pkName}") AS m FROM "${tableName}"`);
            const maxVal = maxRes.rows[0]?.m;
            if (maxVal !== null && maxVal !== undefined) {
                const next = BigInt(maxVal) + 1n;
                await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${pkName}" RESTART WITH ${next}`);
                console.log(`   🔢 IDENTITY 序列已重置为 ${next}`);
            }
        }
    } catch (_) {
        // 无序列，正常跳过
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
    const pkName  = tableConfig.pkOverride || (pkInfo ? pkInfo.name : 'id');

    // 动态批次防爆
    const tableCols = colInfo.map(c => c.name);
    const safeBatch = Math.max(10, Math.min(1000, Math.floor(60000 / tableCols.length)));

    // 查询 PostgreSQL 目标表列类型
    const pgColsRes = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = current_schema() AND table_name = $1
    `, [tableName]);
    const pgColTypes = Object.fromEntries(pgColsRes.rows.map(r => [r.column_name, String(r.data_type).toLowerCase()]));

    const jsonCols = new Set(JSONB_COLUMNS[tableName] || []);
    const vecCols  = new Set(VECTOR_COLUMNS[tableName] || []);

    let lastRowId = 0;
    let migratedCount = 0;

    await client.query('BEGIN');
    try {
        // 清理初始化时自动生成的初始种子数据（如默认 prompt 模板、默认模型等），避免主键冲突
        await client.query(`DELETE FROM "${tableName}"`);

        while (migratedCount < totalCount) {
            let sql = `SELECT *, rowid AS _sqlite_rowid_ FROM "${tableName}"`;
            const params = [];
            if (lastRowId > 0) {
                sql += ` WHERE rowid > ?`;
                params.push(lastRowId);
            }
            sql += ` ORDER BY rowid ASC LIMIT ?`;
            params.push(safeBatch);

            const rows = sqlite.prepare(sql).all(...params);
            if (rows.length === 0) break;

            const columns      = Object.keys(rows[0]).filter(c => c !== '_sqlite_rowid_');
            const colsFmt      = columns.map(c => `"${c}"`).join(', ');
            const allPlaceholders = [];
            const flatParams   = [];
            let paramIdx = 1;

            for (const row of rows) {
                const rowPH = [];
                for (const col of columns) {
                    let val = row[col];
                    const pgType = pgColTypes[col] || '';

                    // 1. JSONB 白名单与自动转换
                    if (jsonCols.has(col) || pgType === 'jsonb' || pgType === 'json') {
                        if (val === null || val === undefined || val === '') {
                            val = null;
                        } else if (typeof val === 'string') {
                            try { val = JSON.stringify(JSON.parse(val)); }
                            catch (e) {
                                throw new Error(`[${tableName}][${col}] JSON 损坏: ${String(val).slice(0, 100)}`);
                            }
                        } else if (typeof val === 'object') {
                            val = JSON.stringify(val);
                        }
                    }

                    // 2. 整型与数值类型转换（防止 SQLite 存放的 false/true 触发 invalid input syntax for type bigint）
                    if (pgType.includes('int') || pgType.includes('numeric') || pgType.includes('double') || pgType.includes('real')) {
                        if (val === false || val === 'false') {
                            val = 0;
                        } else if (val === true || val === 'true') {
                            val = 1;
                        } else if (typeof val === 'string' && val.trim() === '') {
                            val = null;
                        } else if (typeof val === 'boolean') {
                            val = val ? 1 : 0;
                        } else if (val !== null && val !== undefined && !Number.isNaN(Number(val))) {
                            val = Number(val);
                        }
                    }

                    // 3. 布尔类型转换（如果目标表列为 PG 原生 boolean）
                    if (pgType === 'boolean') {
                        if (val === null || val === undefined || val === '') {
                            val = null;
                        } else {
                            val = (val === 1 || val === '1' || val === true || val === 'true');
                        }
                    }

                    // 4. 时间戳类型转换
                    if (pgType.includes('time') || pgType === 'date') {
                        if (val === null || val === undefined || val === '' || val === 'null' || val === 'undefined') {
                            val = null;
                        }
                    }

                    // 5. Vector 格式化
                    if (vecCols.has(col) || pgType === 'vector') {
                        if (val === null || val === undefined || val === '' || val === '[]') {
                            val = null;
                        } else if (typeof val === 'string' && val.trim().startsWith('[')) {
                            // 已合法
                        } else if (Array.isArray(val) && val.length > 0) {
                            val = `[${val.join(',')}]`;
                        } else {
                            val = null;
                        }
                    }

                    flatParams.push(val);
                    rowPH.push(`$${paramIdx++}`);
                }
                allPlaceholders.push(`(${rowPH.join(', ')})`);
                lastRowId = row._sqlite_rowid_;
            }

            const insertSql = `INSERT INTO "${tableName}" (${colsFmt}) OVERRIDING SYSTEM VALUE VALUES ${allPlaceholders.join(', ')}`;
            await client.query(insertSql, flatParams);

            migratedCount += rows.length;
            process.stdout.write(`\r   ├─ ${migratedCount}/${totalCount} (${Math.round(migratedCount / totalCount * 100)}%)`);
        }

        await client.query('COMMIT');
        await resetSequence(client, tableName, pkName);
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
    if (repairOrphanForeignKeys) console.log('  🩹 已启用可空外键孤儿引用修复');
    const t0 = Date.now();

    let foreignKeysDisabled = false;
    let suspendedForeignKeys = [];
    let foreignKeysRestored = true;
    try {
        await client.query(`SET timezone = '${sqliteTz}'`);
        // 关闭外键约束检查，迁移完成后再开启
        // sessions.forked_from_message_id 等循环 FK 在数据全部导入后才能满足
        // 普通业务账号通常没有修改 session_replication_role 的权限；此时
        // 依赖父表优先的拓扑顺序正常导入，不应因为权限不足阻断迁移。
        try {
            await client.query('SET session_replication_role = replica');
            foreignKeysDisabled = true;
        } catch (err) {
            if (err.code !== '42501') throw err;
            console.warn('  ⚠️ 当前账号无权关闭 session_replication_role，将按外键拓扑顺序导入');
        }

        if (!startFromTable) {
            const tablesRes = await client.query(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
            );
            if (tablesRes.rows.length > 0) {
                const tableList = tablesRes.rows.map(r => `"${r.tablename}"`).join(', ');
                await client.query(`TRUNCATE TABLE ${tableList} CASCADE`);
                console.log(`  🧹 已清空目标库初始种子数据 (${tablesRes.rows.length} 张表)，准备全量纯净导入...`);
            }
        }

        let startIdx = 0;
        if (startFromTable) {
            const idx = TABLE_TOPOLOGY.findIndex(t => t.name === startFromTable);
            if (idx < 0) throw new Error(`START_FROM_TABLE=[${startFromTable}] 不在拓扑列表中`);
            startIdx = idx;
        }

        if (!foreignKeysDisabled) {
            suspendedForeignKeys = await loadForeignKeys(client);
            foreignKeysRestored = false;
            await dropForeignKeys(client, suspendedForeignKeys);
            console.log(`  🔗 已暂时移除 ${suspendedForeignKeys.length} 条外键，导入后将以 NOT VALID 恢复`);
        }

        for (let i = startIdx; i < TABLE_TOPOLOGY.length; i++) {
            await migrateTable(TABLE_TOPOLOGY[i], client);
        }

        if (repairOrphanForeignKeys) await repairNullableOrphanForeignKeys(client);

        if (!foreignKeysDisabled) {
            await restoreForeignKeys(client, suspendedForeignKeys);
            foreignKeysRestored = true;
        }

        // 恢复外键约束检查
        if (foreignKeysDisabled) await client.query('SET session_replication_role = DEFAULT');

        console.log('\n╔══════════════════════════════════════════════════╗');
        console.log(`║  🎉 全量迁移成功！耗时: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        console.log('╚══════════════════════════════════════════════════╝');
    } catch (err) {
        if (foreignKeysDisabled) {
            try {
                await client.query('SET session_replication_role = DEFAULT');
            } catch (resetErr) {
                console.error(`  ❌ 迁移失败后的外键触发器恢复失败: ${resetErr.message}`);
            }
        }
        if (!foreignKeysDisabled && !foreignKeysRestored && suspendedForeignKeys.length) {
            try {
                await restoreForeignKeys(client, suspendedForeignKeys);
                foreignKeysRestored = true;
                console.warn('  ⚠️ 迁移失败，已尝试恢复暂存外键约束');
            } catch (restoreErr) {
                console.error(`  ❌ 迁移失败后的外键恢复也失败: ${restoreErr.message}`);
            }
        }
        console.error('\n❌ [Fatal] 迁移中断:', err.message);
        process.exit(1);
    } finally {
        client.release();
        sqlite.close();
        await pool.end();
    }
}

main();
