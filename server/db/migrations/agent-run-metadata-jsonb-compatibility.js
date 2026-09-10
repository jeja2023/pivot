'use strict';

/**
 * 早期 PostgreSQL 部署从 SQLite 表结构迁移时，agent_runs.metadata 可能保留为
 * TEXT；而后续运行时的并发比较交换（CAS）以 JSONB 为契约。类型不一致会让
 * COALESCE(metadata, '{}'::jsonb) 在聊天 Agent 结果恢复中持续报错。
 */
const migration = {
    id: '202609100003_agent_run_metadata_jsonb_compatibility',
    description: 'Convert legacy agent_runs.metadata TEXT values to JSONB for concurrent Agent result recovery.',
    up(_db) {
        // SQLite 持续以 TEXT 保存 JSON，当前 SQLite 适配层会处理其序列化。
    },
    async upPg(client) {
        const typeResult = await client.query(`
            SELECT a.atttypid::regtype::text AS data_type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.oid = 'agent_runs'::regclass
              AND a.attname = 'metadata'
              AND a.attnum > 0
              AND NOT a.attisdropped
        `);
        if (String(typeResult.rows[0]?.data_type || '').toLowerCase() === 'jsonb') return;

        // 历史运行记录通常已是 JSON 文本。对极少量格式异常值保留原值，避免
        // 一次类型升级因单条脏数据中断，也不丢失人工排查所需内容。
        await client.query(`
            CREATE OR REPLACE FUNCTION pg_temp.pivot_agent_metadata_to_jsonb(input TEXT)
            RETURNS JSONB
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                IF input IS NULL OR BTRIM(input) = '' THEN
                    RETURN '{}'::jsonb;
                END IF;
                RETURN input::jsonb;
            EXCEPTION WHEN others THEN
                RETURN jsonb_build_object('_legacyRaw', input);
            END;
            $function$;
        `);
        await client.query('ALTER TABLE agent_runs ALTER COLUMN metadata DROP DEFAULT;');
        await client.query(`
            ALTER TABLE agent_runs
            ALTER COLUMN metadata TYPE JSONB
            USING pg_temp.pivot_agent_metadata_to_jsonb(metadata::text);
        `);
        await client.query('DROP FUNCTION IF EXISTS pg_temp.pivot_agent_metadata_to_jsonb(TEXT);');
    }
};

module.exports = [migration];
