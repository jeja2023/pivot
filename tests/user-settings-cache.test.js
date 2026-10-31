'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('用户设置缓存有界，失效后等待数据库，并拒绝并发写入前的旧结果', async () => {
    const db = require('../server/db/client');
    const original = { query: db.query, queryOne: db.queryOne, execute: db.execute };
    const values = new Map([['1:rag_top_k', '4']]);
    let reads = 0;
    let delay = false;
    let fail = false;
    let release;
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    db.query = async (_sql, [userId, keys]) => {
        reads += 1;
        if (fail) throw new Error('模拟数据库不可用');
        const result = keys.filter(key => values.has(`${userId}:${key}`)).map(key => ({ user_id: userId, key, value: values.get(`${userId}:${key}`) }));
        if (delay) { delay = false; started(); await barrier; }
        return result;
    };
    db.queryOne = async (_sql, [userId, key, value]) => {
        values.set(`${userId}:${key}`, value);
        return { user_id: userId, key, value };
    };
    db.execute = async (_sql, [userId, key]) => { values.delete(`${userId}:${key}`); return 1; };
    const modulePath = require.resolve('../server/services/user-settings');
    const realNow = Date.now;
    delete require.cache[modulePath];
    const settings = require(modulePath);
    try {
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '4');
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '4');
        assert.equal(reads, 1);
        await settings.setUserSettingAsync(2, 'rag_top_k', '8');
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '4');
        assert.equal(reads, 1);
        for (let id = 2; id <= 513; id += 1) await settings.getUserSettingValueAsync(id, 'rag_top_k');
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '4');
        assert.equal(reads, 514);
        values.set('1:rag_top_k', '6');
        Date.now = () => realNow() + 6000;
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '6');
        Date.now = realNow;
        await settings.refreshUserSettingsCache();
        delay = true;
        const oldRead = settings.getUserSettingValueAsync(1, 'rag_top_k');
        const sharedRead = settings.getUserSettingValueAsync(1, 'rag_top_k');
        await startedPromise;
        await settings.setUserSettingAsync(1, 'rag_top_k', '9');
        release();
        assert.equal(await oldRead, '9');
        assert.equal(await sharedRead, '9');
        await settings.deleteUserSettingAsync(1, 'rag_top_k');
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), undefined);
        await settings.refreshUserSettingsCache();
        fail = true;
        await assert.rejects(settings.getUserSettingValueAsync(1, 'rag_top_k'), /模拟数据库不可用/);
    } finally {
        release();
        Date.now = realNow;
        Object.assign(db, original);
        delete require.cache[modulePath];
    }
});

test('其他用户的写入不会使在途读取重试', async () => {
    const db = require('../server/db/client');
    const original = { query: db.query, queryOne: db.queryOne };
    let release;
    let notify;
    let reads = 0;
    const ready = new Promise(resolve => { notify = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    db.query = async (_sql, [userId]) => { reads += 1; notify(); await gate; return [{ user_id: userId, key: 'rag_top_k', value: '4' }]; };
    db.queryOne = async (_sql, [userId, key, value]) => ({ user_id: userId, key, value });
    const modulePath = require.resolve('../server/services/user-settings');
    delete require.cache[modulePath];
    const settings = require(modulePath);
    try {
        const read = settings.getUserSettingValueAsync(1, 'rag_top_k');
        await ready;
        await settings.setUserSettingAsync(2, 'rag_top_k', '9');
        release();
        assert.equal(await read, '4');
        assert.equal(reads, 1);
        assert.equal(await settings.getUserSettingValueAsync(1, 'rag_top_k'), '4');
        assert.equal(reads, 1);
    } finally {
        release();
        Object.assign(db, original);
        delete require.cache[modulePath];
    }
});
