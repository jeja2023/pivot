'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const master = require('../server/repositories/presentation-master-tasks');
const native = require('../server/repositories/presentation-native');
const store = require('../server/services/tool-tasks');
const deployment = require('../server/services/presentations/master/deployment');
const probe = require('../scripts/preflight_ppt_master');
const options = { skip: !process.env.DATABASE_URL, timeout: 60000 };

test('PPT更新维护接纳与真实任务创建串行，有活动任务时不进入切换', options, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    let entered, release;
    const inside = new Promise(resolve => entered = resolve), resume = new Promise(resolve => release = resolve);
    const pending = master.admit(user, async client => {
        entered(); await resume; deployment.assertAccepting();
        return store.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: master.TOOL });
    });
    await inside;
    const token = crypto.randomBytes(16).toString('hex'), quiesce = probe.quiesce(token).then(value => ({ value }), error => ({ error }));
    release(); const task = await pending;
    try { assert.match((await quiesce).error.message, /仍有PPT任务/); assert.equal(deployment.accepting(), true); }
    finally { await execute('DELETE FROM tool_tasks WHERE id=?', [task.id]); }
});

test('维护期间新制作和原稿任务均不能接纳，更新标识只能由所属部署解除', options, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'), token = crypto.randomBytes(16).toString('hex');
    await probe.quiesce(token);
    try {
        for (const repository of [master, native]) await assert.rejects(() => repository.admit(user, () => deployment.assertAccepting()), { code: 'PPT_MASTER_MAINTENANCE' });
        await assert.rejects(() => probe.unquiesce(crypto.randomBytes(16).toString('hex')), /不匹配/);
        assert.equal(deployment.accepting(), false);
    } finally { await probe.unquiesce(token); }
    assert.equal(deployment.accepting(), true);
    await assert.rejects(() => fs.readFile(deployment.gateFile()), { code: 'ENOENT' });
});
