'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { recordAgentEvent } = require('../server/services/agent-event-log');

function startNode() {
    const child = fork(path.join(__dirname, 'fixtures/realtime-durable-node.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('节点启动超时')); }, 15000);
        child.once('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`节点提前退出: ${code}`)); });
        child.once('message', ({ port }) => { clearTimeout(timer); resolve({ child, port }); });
    });
}
function openFeed(port, userId, after) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { 'X-Test-User': String(userId), ...(after === undefined ? {} : { 'Last-Event-ID': String(after) }) } }, res => {
            let buffer = '';
            const frames = [];
            const waiters = [];
            res.on('data', chunk => {
                buffer += chunk.toString();
                const parts = buffer.split('\n\n'); buffer = parts.pop();
                for (const frame of parts) {
                    frames.push(frame);
                    for (const waiter of [...waiters]) if (waiter.check(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
                }
            });
            function wait(check) {
                const found = frames.find(check);
                if (found) return Promise.resolve(found);
                return new Promise((res, rej) => {
                    const timeout = setTimeout(() => rej(new Error('实时事件等待超时')), 10000);
                    waiters.push({ check, resolve: frame => { clearTimeout(timeout); res(frame); } });
                });
            }
            resolve({ frames, wait, close() { res.destroy(); req.destroy(); } });
        });
        req.on('error', reject);
    });
}

test('两个进程读取同一用户事件，节点崩溃后从游标恢复并隔离其他用户', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `relay-multiprocess-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'relay','relay','queued','{}',NOW(),NOW())", [runId, user.id]);
    const nodes = [];
    const feeds = [];
    try {
        nodes.push(await startNode(), await startNode());
        feeds.push(await openFeed(nodes[0].port, user.id), await openFeed(nodes[1].port, user.id));
        await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes('event: connected'))));
        const first = await recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'one', payload: {} });
        await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes(`id: ${first.id}\n`))));
        const saved = String(first.id);
        feeds[1].close();
        nodes[1].child.kill();
        await new Promise(resolve => nodes[1].child.once('exit', resolve));
        const second = await recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'two', payload: {} });
        await feeds[0].wait(frame => frame.includes(`id: ${second.id}\n`));
        nodes.push(await startNode());
        feeds.push(await openFeed(nodes[2].port, user.id, saved));
        await feeds[2].wait(frame => frame.includes(`id: ${second.id}\n`));
        feeds.push(await openFeed(nodes[2].port, Number(user.id) + 1000000, '0'));
        await feeds[3].wait(frame => frame.includes('event: connected'));
        await new Promise(resolve => setTimeout(resolve, 1300));
        assert.ok(!feeds[3].frames.some(frame => frame.includes(runId)));
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
