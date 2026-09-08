/* Rotate encrypted application secrets in PostgreSQL. Use only on a maintenance
 * window with the old and new keys supplied explicitly; plaintext is never logged. */
require('dotenv').config();
const { transaction, queryOne } = require('../server/db/client');
const { decryptSecretWithKey, encryptSecretWithKey } = require('../server/security');

const oldKey = String(process.env.OLD_DATA_ENCRYPTION_KEY || '').trim();
const newKey = String(process.env.NEW_DATA_ENCRYPTION_KEY || '').trim();
if (!oldKey || !newKey || oldKey === newKey) throw new Error('需要不同的 OLD_DATA_ENCRYPTION_KEY 和 NEW_DATA_ENCRYPTION_KEY。');

const targets = [
    { table: 'models', column: 'api_key', context: 'models.api_key', keyColumns: ['id'] },
    { table: 'mcp_servers', column: 'api_key', context: 'mcp_servers.api_key', keyColumns: ['id'] },
    { table: 'mcp_database_connections', column: 'password', context: 'mcp_database_connections.password', keyColumns: ['id'] },
    { table: 'mcp_builtin_configs', column: 'secret', context: 'mcp_builtin_configs.secret', keyColumns: ['id'] },
    { table: 'workflow_credentials', column: 'secret_value', context: 'workflow_credentials.secret_value', keyColumns: ['id'] },
    { table: 'workflow_credentials', column: 'previous_value', context: 'workflow_credentials.secret_value', keyColumns: ['id'] },
    { table: 'app_settings', column: 'value', context: 'rag.embedding_api_key', keyColumns: ['key'], where: "key = 'rag_embedding_api_key'" },
    { table: 'user_settings', column: 'value', context: 'rag.embedding_api_key', keyColumns: ['user_id', 'key'], where: "key = 'rag_embedding_api_key'" }
];

async function rotate() {
    let changed = 0;
    await transaction(async trx => {
        for (const target of targets) {
            const { table, column, context, keyColumns, where: extraWhere = '' } = target;
            const where = `${column} IS NOT NULL AND ${column} <> ''${extraWhere ? ` AND ${extraWhere}` : ''}`;
            const rows = await trx.query(`SELECT ${keyColumns.join(', ')}, ${column} AS value FROM ${table} WHERE ${where}`);
            for (const row of rows) {
                const value = String(row.value || '');
                if (!value.startsWith('enc:v1:') && !value.startsWith('enc:v2:')) continue;
                let plain;
                try { plain = decryptSecretWithKey(value, oldKey, value.startsWith('enc:v2:') ? context : 'pivot.encryption-rotation'); } catch (error) { throw new Error(`${table}.${column} id=${row.id} 解密失败：${error.message}`); }
                const rotated = encryptSecretWithKey(plain, newKey, context);
                const identityWhere = keyColumns.map(key => `${key} = ?`).join(' AND ');
                await trx.execute(`UPDATE ${table} SET ${column} = ? WHERE ${identityWhere}`, [rotated, ...keyColumns.map(key => row[key])]);
                changed += 1;
            }
        }
    });
    const remainingLegacy = [];
    for (const target of targets) {
        const extraWhere = target.where ? ` AND ${target.where}` : '';
        const row = await queryOne(`SELECT COUNT(*) AS count FROM ${target.table} WHERE ${target.column} LIKE 'enc:v1:%'${extraWhere}`);
        if (Number(row?.count || 0) > 0) remainingLegacy.push({ table: target.table, column: target.column, count: Number(row.count) });
    }
    if (remainingLegacy.length) throw new Error(`密钥轮转未收口，仍存在旧版密文：${JSON.stringify(remainingLegacy)}`);
    console.log(JSON.stringify({ changed, rotatedAt: new Date().toISOString(), tables: targets.map(item => `${item.table}.${item.column}`), remainingLegacy: 0 }, null, 2));
}

if (require.main === module) rotate().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { rotate };
