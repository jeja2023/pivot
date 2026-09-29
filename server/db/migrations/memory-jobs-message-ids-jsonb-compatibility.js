'use strict';

/**
 * 早期 PostgreSQL 部署中 memory_extraction_jobs.message_ids 可能保留为 TEXT；
 * 新版本快照与运行时以 JSONB 为规范。若为 TEXT，直接执行 jsonb 运算或 COALESCE 会引发类型冲突 (42804)。
 * 本迁移将遗留的 TEXT 类型平滑转换为 JSONB。
 */
const migration = {
    id: '202609290001_memory_jobs_message_ids_jsonb_compatibility',
    description: 'Convert legacy memory_extraction_jobs.message_ids TEXT values to JSONB.',
    async upPg(client) {
        const typeResult = await client.query(`
            SELECT a.atttypid::regtype::text AS data_type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.oid = 'memory_extraction_jobs'::regclass
              AND a.attname = 'message_ids'
              AND a.attnum > 0
              AND NOT a.attisdropped
        `);
        if (String(typeResult.rows[0]?.data_type || '').toLowerCase() === 'jsonb') return;

        await client.query(`
            CREATE OR REPLACE FUNCTION pg_temp.pivot_memory_job_message_ids_to_jsonb(input TEXT)
            RETURNS JSONB
            LANGUAGE plpgsql
            AS $function$
            DECLARE
                parsed JSONB;
            BEGIN
                IF input IS NULL OR BTRIM(input) = '' THEN
                    RETURN '[]'::jsonb;
                END IF;
                parsed := input::jsonb;
                IF jsonb_typeof(parsed) <> 'array' THEN
                    RETURN '[]'::jsonb;
                END IF;
                RETURN parsed;
            EXCEPTION WHEN others THEN
                RETURN '[]'::jsonb;
            END;
            $function$;
        `);
        await client.query('ALTER TABLE memory_extraction_jobs ALTER COLUMN message_ids DROP DEFAULT;');
        await client.query(`
            ALTER TABLE memory_extraction_jobs
            ALTER COLUMN message_ids TYPE JSONB
            USING pg_temp.pivot_memory_job_message_ids_to_jsonb(message_ids::text);
        `);
        await client.query("ALTER TABLE memory_extraction_jobs ALTER COLUMN message_ids SET DEFAULT '[]'::jsonb;");
        await client.query('DROP FUNCTION IF EXISTS pg_temp.pivot_memory_job_message_ids_to_jsonb(TEXT);');
    }
};

module.exports = [migration];
