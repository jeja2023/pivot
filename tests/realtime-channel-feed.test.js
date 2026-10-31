'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { startChannelFeed } = require('../server/services/realtime-channel-feed');

function response() {
    const res = new EventEmitter();
    res.headers = {};
    res.chunks = [];
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.flushHeaders = () => {};
    res.write = value => { res.chunks.push(String(value)); return true; };
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    return res;
}

test('渠道补发按用户和游标读取，清除受保护目标并在数据库失败时断开', async () => {
    const res = response();
    let calls = 0;
    const database = { async query(_sql, args) {
        calls += 1;
        assert.deepEqual(args, [7, 7, calls === 1 ? '0' : '1']);
        if (calls === 1) return [{ cursor: '1', delivery_id: '4', event_type: 'test', subject: 'subject', body: 'body', attachments: [], interaction: { outboundTargetEncrypted: 'secret', nested: { outboundTargetEncrypted: 'secret' }, runId: 'run' } }];
        throw new Error('数据库不可用');
    } };
    let wake;
    let unsubscribed = false;
    await startChannelFeed({ userId: 7, after: '0', suppliedCursor: '0', database, response: res, wakeup: { subscribe(_id, fn) { wake = fn; return () => { unsubscribed = true; }; } }, intervalMs: 30000 });
    assert.match(res.chunks.join(''), /event: agent.channel/);
    assert.doesNotMatch(res.chunks.join(''), /secret|outboundTargetEncrypted/);
    wake();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.destroyed, true);
    assert.equal(unsubscribed, true);
});

test('渠道保留清理只删除已送达且超过七天的有限批次', async () => {
    let sql;
    const { cleanupRetired } = require('../server/services/realtime-channel-feed');
    cleanupRetired({ async query(value) { sql = value; return []; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(sql, /retired_at < NOW\(\) - INTERVAL '7 days'/);
    assert.match(sql, /LIMIT 500/);
});
