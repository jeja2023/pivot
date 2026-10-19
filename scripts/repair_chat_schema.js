'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const { getPgPool, closePgPool } = require('../server/db/pg-connection');
const { ensurePgMigrationTable, recordPgMigration } = require('../server/db/migrations/runner');
const [repair] = require('../server/db/migrations/chat-message-turn-link-repair');

async function main() {
    const client = await getPgPool().connect();
    try {
        await client.query("BEGIN; SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '120s'");
        const ready = await repair.checkPg(client);
        if (!ready) await repair.upPg(client);
        if (!await repair.checkPg(client)) throw new Error('聊天消息字段、外键或唯一索引仍未就绪，修复已回滚。');
        await ensurePgMigrationTable(client);
        await recordPgMigration(client, repair.id, repair.description);
        await client.query('COMMIT');
        process.stdout.write(JSON.stringify({ success: true, changed: !ready, migration: repair.id, message: '聊天消息轮次关联结构已就绪，历史消息保留。' }) + '\n');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}

main().catch(error => { process.stderr.write(`聊天数据库修复失败：${error.message}\n`); process.exitCode = 1; }).finally(closePgPool);
