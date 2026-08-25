/* Rotate encrypted application secrets in PostgreSQL. Use only on a maintenance
 * window with the old and new keys supplied explicitly; plaintext is never logged. */
require('dotenv').config();
const { transaction } = require('../server/db/client');
const { decryptSecretWithKey, encryptSecretWithKey } = require('../server/security');

const oldKey = String(process.env.OLD_DATA_ENCRYPTION_KEY || '').trim();
const newKey = String(process.env.NEW_DATA_ENCRYPTION_KEY || '').trim();
if (!oldKey || !newKey || oldKey === newKey) throw new Error('需要不同的 OLD_DATA_ENCRYPTION_KEY 和 NEW_DATA_ENCRYPTION_KEY。');

const targets = [
    ['models', 'api_key'],
    ['mcp_servers', 'api_key'],
    ['mcp_database_connections', 'password'],
    ['mcp_builtin_configs', 'config'],
    ['workflow_credentials', 'secret_value'],
    ['workflow_credentials', 'previous_value']
];

async function rotate() {
    let changed = 0;
    await transaction(async trx => {
        for (const [table, column] of targets) {
            const rows = await trx.query(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
            for (const row of rows) {
                const value = String(row.value || '');
                if (!value.startsWith('enc:v1:')) continue;
                let plain;
                try { plain = decryptSecretWithKey(value, oldKey); } catch (error) { throw new Error(`${table}.${column} id=${row.id} 解密失败：${error.message}`); }
                const rotated = encryptSecretWithKey(plain, newKey);
                await trx.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [rotated, row.id]);
                changed += 1;
            }
        }
    });
    console.log(JSON.stringify({ changed, rotatedAt: new Date().toISOString(), tables: targets.map(item => `${item[0]}.${item[1]}`) }, null, 2));
}

if (require.main === module) rotate().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { rotate };
