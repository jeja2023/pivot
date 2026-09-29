'use strict';

/*
 * 旧库的 memories.source_message_ids 曾以 TEXT 保存；新运行时会在来源撤销
 * 时写入 JSONB。仅把 TEXT 临时转换用于回填证据并不足以修复运行期类型冲突，
 * 因此这里将两张持久化来源表统一为 JSONB，并安全保留可解析的数组值。
 */
const SOURCE_COLUMNS = [
    { table: 'memories', column: 'source_message_ids', nullable: true },
    { table: 'memory_suppressions', column: 'source_message_ids', nullable: false }
];

async function getColumnType(client, table, column) {
    const result = await client.query(`
        SELECT a.atttypid::regtype::text AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.oid = $1::regclass
          AND a.attname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
    `, [table, column]);
    return String(result.rows[0]?.data_type || '').toLowerCase();
}

module.exports = [{
    id: '202609290003_memory_source_ids_jsonb_compatibility',
    description: 'Convert legacy memory source-message arrays from TEXT to JSONB before deletion and revocation operations.',
    async upPg(client) {
        const legacyColumns = [];
        for (const entry of SOURCE_COLUMNS) {
            const dataType = await getColumnType(client, entry.table, entry.column);
            if (dataType && dataType !== 'jsonb') legacyColumns.push(entry);
        }
        if (!legacyColumns.length) return;
        await client.query(`
            CREATE OR REPLACE FUNCTION pg_temp.pivot_memory_source_ids_to_jsonb(input TEXT)
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
        try {
            for (const entry of legacyColumns) {
                await client.query(`ALTER TABLE ${entry.table} ALTER COLUMN ${entry.column} DROP DEFAULT;`);
                await client.query(`
                    ALTER TABLE ${entry.table}
                    ALTER COLUMN ${entry.column} TYPE JSONB
                    USING pg_temp.pivot_memory_source_ids_to_jsonb(${entry.column}::text);
                `);
                await client.query(`ALTER TABLE ${entry.table} ALTER COLUMN ${entry.column} SET DEFAULT '[]'::jsonb;`);
                if (!entry.nullable) {
                    await client.query(`ALTER TABLE ${entry.table} ALTER COLUMN ${entry.column} SET NOT NULL;`);
                }
            }
        } finally {
            await client.query('DROP FUNCTION IF EXISTS pg_temp.pivot_memory_source_ids_to_jsonb(TEXT);');
        }
    }
}];
