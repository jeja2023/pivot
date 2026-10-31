'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { recordAgentEvent } = require('../server/services/agent-event-log');
const { enqueueChannelDelivery, deliverChannelDelivery } = require('../server/services/agent-channel-adapters');

function startNode() {
    const child = fork(path.join(__dirname, 'fixtures/realtime-durable-node.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('节点启动超时')); }, 15000);
        child.once('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`节点提前退出: ${code}`)); });
        child.once('message', ({ port }) => { clearTimeout(timer); resolve({ child, port }); });
    });
}
function openFeed(port, userId, after, endpoint = '/events') {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: endpoint, headers: { 'X-Test-User': String(userId), ...(after === undefined ? {} : { 'Last-Event-ID': String(after) }) } }, res => {
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

test('Web 渠道逐条跨节点投递并从独立游标恢复，隔离其他用户', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id, username, nickname, unit, role FROM users ORDER BY id LIMIT 1');
    const binding = `channel-realtime-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_channel_bindings (id,user_id,channel_type,channel_key,credential_ref,config,notification_policy,status,created_at,updated_at) VALUES (?,?,'web','test','','{}'::jsonb,'{}'::jsonb,'active',NOW(),NOW())", [binding, user.id]);
    const nodes = []; const feeds = [];
    try {
        nodes.push(await startNode(), await startNode());
        feeds.push(await openFeed(nodes[0].port, user.id, undefined, '/events/channels'), await openFeed(nodes[1].port, user.id, undefined, '/events/channels'));
        const connected = await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes('event: channel.connected'))));
        const initialCursor = /^id: (\d+)$/m.exec(connected[1])[1];
        const deliveries = await Promise.all(Array.from({ length: 4 }, (_, index) => enqueueChannelDelivery(user, {
            bindingId: binding, idempotencyKey: `${binding}-${index}`, eventType: 'test', subject: `item-${index}`, body: `content-${index}`
        })));
        await Promise.all(feeds.flatMap(feed => deliveries.map(item => feed.wait(frame => frame.includes(`"deliveryId":"${item.id}"`)))));
        await Promise.all(deliveries.map(item => deliverChannelDelivery(item.id)));
        for (const feed of feeds) {
            const frames = feed.frames.filter(frame => frame.includes('event: agent.channel'));
            assert.equal(frames.length, 4);
            const ids = frames.map(frame => /^id: (\d+)$/m.exec(frame)[1]);
            assert.deepEqual(ids, [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1));
        }
        feeds.push(await openFeed(nodes[0].port, user.id, undefined, '/events/channels'));
        await Promise.all(deliveries.map(item => feeds[2].wait(frame => frame.includes(`"deliveryId":"${item.id}"`))));
        feeds[2].close();
        const history = await queryOne('SELECT COUNT(*)::int AS count FROM realtime_channel_deliveries WHERE delivery_id = ANY(?::bigint[]) AND retired_at IS NOT NULL', [deliveries.map(item => item.id)]);
        assert.equal(history.count, 4);
        await execute("UPDATE realtime_channel_deliveries SET retired_at = NOW() - INTERVAL '8 days' WHERE delivery_id = ?", [deliveries[0].id]);
        const purged = await queryOne("DELETE FROM realtime_channel_deliveries WHERE id IN (SELECT id FROM realtime_channel_deliveries WHERE retired_at < NOW() - INTERVAL '7 days' ORDER BY retired_at LIMIT 500) RETURNING delivery_id");
        assert.equal(String(purged.delivery_id), String(deliveries[0].id));
        feeds[1].close();
        const exited = new Promise(resolve => nodes[1].child.once('exit', resolve)); nodes[1].child.kill(); await exited;
        nodes.push(await startNode());
        feeds.push(await openFeed(nodes[2].port, user.id, initialCursor, '/events/channels'));
        const replay = feeds[3];
        await Promise.all(deliveries.slice(1).map(item => replay.wait(frame => frame.includes(`"deliveryId":"${item.id}"`))));
        const listenerName = `pivot-realtime-test-${nodes[2].child.pid}`;
        let listener;
        const listenerDeadline = Date.now() + 10000;
        while (!listener && Date.now() < listenerDeadline) {
            listener = await queryOne('SELECT pid FROM pg_stat_activity WHERE application_name = ?', [listenerName]);
            if (!listener) await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.ok(listener);
        await queryOne('SELECT pg_terminate_backend(?) AS terminated', [listener.pid]);
        const afterDisconnect = await enqueueChannelDelivery(user, { bindingId: binding, idempotencyKey: `${binding}-offline`, eventType: 'test', subject: 'after disconnect', body: 'recover-channel' });
        await replay.wait(frame => frame.includes(`"deliveryId":"${afterDisconnect.id}"`));
        feeds.push(await openFeed(nodes[2].port, Number(user.id) + 1000000, '0', '/events/channels'));
        await feeds[4].wait(frame => frame.includes('event: channel.connected'));
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(feeds[4].frames.some(frame => frame.includes(binding) || frame.includes('content-')), false);
        assert.equal(replay.frames.filter(frame => frame.includes('event: agent.channel')).length, 4);
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
        await execute('DELETE FROM agent_channel_deliveries WHERE binding_id = ?', [binding]);
        await execute('DELETE FROM agent_channel_bindings WHERE id = ?', [binding]);
    }
});

test('流式快照通过另一节点授权读取，重连和执行权切换不会读取旧快照', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `snapshot-multinode-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,locked_by,realtime_lease_epoch,lock_expires_at,created_at,updated_at) VALUES (?,?,'snapshot','snapshot','planning','{}','writer-one',1,NOW()+INTERVAL '5 minutes',NOW(),NOW())", [runId, user.id]);
    const nodes = []; const feeds = [];
    try {
        nodes.push(await startNode(), await startNode());
        feeds.push(await openFeed(nodes[1].port, user.id));
        await feeds[0].wait(frame => frame.includes('listener_reconnected'));
        const snapshot = { runId, step: 1, content: 'cross-node full content', partialToolCalls: [{ argumentsRaw: 'private args' }] };
        const ack = new Promise(resolve => nodes[0].child.once('message', resolve));
        nodes[0].child.send({ type: 'snapshot', input: { runId, userId: user.id, leaseOwner: 'writer-one', leaseEpoch: '1', step: 1, snapshot } });
        assert.equal((await ack).snapshotWritten, true);
        const hint = await feeds[0].wait(frame => frame.includes('event: agent.streaming') && frame.includes(runId));
        assert.doesNotMatch(hint, /cross-node full content|private args/);
        const get = id => fetch(`http://127.0.0.1:${nodes[1].port}/events/streaming/${runId}`, { headers: { 'X-Test-User': String(id) } });
        const response = await get(user.id);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).snapshot, { ...snapshot, streamLeaseEpoch: '1', streamRevision: '1' });
        assert.equal((await get(Number(user.id) + 100000)).status, 404);
        feeds[0].close();
        const restartedExit = new Promise(resolve => nodes[1].child.once('exit', resolve));
        nodes[1].child.kill(); await restartedExit;
        nodes.push(await startNode());
        const recovered = await fetch(`http://127.0.0.1:${nodes[2].port}/events/streaming/${runId}`, { headers: { 'X-Test-User': String(user.id) } });
        assert.deepEqual((await recovered.json()).snapshot, { ...snapshot, streamLeaseEpoch: '1', streamRevision: '1' });
        await execute("UPDATE agent_runs SET locked_by = 'writer-two' WHERE id = ?", [runId]);
        assert.equal((await fetch(`http://127.0.0.1:${nodes[2].port}/events/streaming/${runId}`, { headers: { 'X-Test-User': String(user.id) } })).status, 404);
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('旧节点写入的 Web 渠道记录在新节点按提交顺序补发', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const binding = `channel-rolling-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_channel_bindings (id,user_id,channel_type,channel_key,credential_ref,config,notification_policy,status,created_at,updated_at) VALUES (?,?,'web','test','','{}'::jsonb,'{}'::jsonb,'active',NOW(),NOW())", [binding, user.id]);
    let node; let feed;
    try {
        node = await startNode();
        feed = await openFeed(node.port, user.id, '0', '/events/channels');
        await feed.wait(frame => frame.includes('event: channel.connected'));
        // 直接使用旧代码同样的数据库插入，模拟尚未升级的写入节点。
        const row = await queryOne(`INSERT INTO agent_channel_deliveries (binding_id,user_id,idempotency_key,event_type,subject,body,attachments,interaction,status,attempts,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,'test','old-node','rolling message','[]'::jsonb,'{}'::jsonb,'queued',0,NOW(),NOW(),NOW()) RETURNING id`, [binding, user.id, `${binding}-one`]);
        const frame = await feed.wait(value => value.includes(`"deliveryId":"${row.id}"`));
        assert.match(frame, /rolling message/);
        await execute("UPDATE agent_channel_deliveries SET status = 'delivered' WHERE id = ?", [row.id]);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(feed.frames.filter(value => value.includes(`"deliveryId":"${row.id}"`)).length, 1);
    } finally {
        feed?.close();
        if (node?.child && node.child.exitCode === null && node.child.connected) { node.child.send('stop'); await new Promise(resolve => node.child.once('exit', resolve)); }
        await execute('DELETE FROM agent_channel_deliveries WHERE binding_id = ?', [binding]);
        await execute('DELETE FROM agent_channel_bindings WHERE id = ?', [binding]);
    }
});

test('跨进程提交唤醒补查，监听连接中断后重新订阅并恢复事件', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `relay-listener-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'relay','relay','queued','{}',NOW(),NOW())", [runId, user.id]);
    let node; let feed;
    try {
        node = await startNode();
        feed = await openFeed(node.port, user.id);
        await feed.wait(frame => frame.includes('event: connected'));
        const name = `pivot-realtime-test-${node.child.pid}`;
        let listener;
        const readyDeadline = Date.now() + 10000;
        while (!listener && Date.now() < readyDeadline) {
            listener = await queryOne('SELECT pid FROM pg_stat_activity WHERE application_name = ?', [name]);
            if (!listener) await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.ok(listener);
        // 等待 LISTEN 完成，避免将建立订阅期间的补查误判为通知唤醒。
        await new Promise(resolve => setTimeout(resolve, 300));
        const start = Date.now();
        const event = await recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'wake-one', payload: {} });
        await feed.wait(frame => frame.includes(`id: ${event.id}\n`));
        assert.ok(Date.now() - start < 4000, '通知应在 5 秒周期补查前触发');
        const killed = await queryOne('SELECT pg_terminate_backend(?) AS terminated', [listener.pid]);
        assert.equal(killed.terminated, true);
        const duringLoss = await recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'wake-two', payload: {} });
        await feed.wait(frame => frame.includes(`id: ${duringLoss.id}\n`));
        let renewed;
        const deadline = Date.now() + 10000;
        while (!renewed && Date.now() < deadline) {
            renewed = await queryOne('SELECT pid FROM pg_stat_activity WHERE application_name = ? AND pid <> ?', [name, listener.pid]);
            if (!renewed) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(renewed, '监听连接应自动重建');
        const resyncDeadline = Date.now() + 5000;
        while (feed.frames.filter(frame => frame.includes('listener_reconnected')).length < 2 && Date.now() < resyncDeadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(feed.frames.filter(frame => frame.includes('listener_reconnected')).length >= 2);
        const after = await recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'wake-three', payload: {} });
        await feed.wait(frame => frame.includes(`id: ${after.id}\n`));
        assert.equal(feed.frames.filter(frame => frame.includes(`id: ${duringLoss.id}\n`)).length, 1);
    } finally {
        feed?.close();
        if (node?.child && node.child.exitCode === null && node.child.connected) { node.child.send('stop'); await new Promise(resolve => node.child.once('exit', resolve)); }
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('跨节点转发不含正文的刷新提示且隔离用户', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const nodes = []; const feeds = [];
    try {
        nodes.push(await startNode(), await startNode());
        feeds.push(await openFeed(nodes[0].port, user.id), await openFeed(nodes[1].port, user.id), await openFeed(nodes[1].port, Number(user.id) + 1000000));
        await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes('event: connected'))));
        const name = `pivot-realtime-test-${nodes[1].child.pid}`;
        const deadline = Date.now() + 10000;
        while (!(await queryOne('SELECT pid FROM pg_stat_activity WHERE application_name = ?', [name])) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
        await new Promise(resolve => setTimeout(resolve, 300));
        nodes[0].child.send({ type: 'publish', userId: user.id, eventType: 'presentation.comments', payload: { presentationId: 'test-doc', secret: 'never-relayed' } });
        const frame = await feeds[1].wait(value => value.includes('event: presentation.comments') && value.includes('test-doc'));
        assert.doesNotMatch(frame, /never-relayed/);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(feeds[0].frames.filter(value => value.includes('event: presentation.comments')).length, 1);
        assert.equal(feeds[2].frames.some(value => value.includes('test-doc')), false);
        nodes[0].child.send({ type: 'publish', userId: user.id, eventType: 'agent.streaming', payload: {
            runId: 'run-test', step: 2, content: 'private-stream-content', partialToolCalls: [{ arguments: 'private-tool-arguments' }]
        } });
        const stream = await feeds[1].wait(value => value.includes('event: agent.streaming') && value.includes('run-test'));
        assert.match(stream, /metadataOnly/);
        assert.doesNotMatch(stream, /private-stream-content|private-tool-arguments/);
        assert.equal(feeds[2].frames.some(value => value.includes('run-test')), false);
        nodes[0].child.send({ type: 'publish-batch', userId: user.id, events: Array.from({ length: 10 }, (_, index) => ({
            eventType: 'agent.streaming', payload: { runId: 'run-batch', step: index + 1, completed: index === 9 }
        })) });
        const latest = await feeds[1].wait(value => value.includes('event: agent.streaming') && value.includes('run-batch'));
        assert.match(latest, /"step":10/);
        assert.match(latest, /"completed":true/);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(feeds[1].frames.filter(value => value.includes('run-batch')).length, 1);
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
    }
});

test('不同运行并发提交时两个节点按用户事件 ID 顺序投递且不重复', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const prefix = `relay-concurrent-${process.pid}-${Date.now()}`;
    const runs = Array.from({ length: 16 }, (_, index) => `${prefix}-${index}`);
    const nodes = []; const feeds = [];
    try {
        for (const runId of runs) await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'relay','relay','queued','{}',NOW(),NOW())", [runId, user.id]);
        nodes.push(await startNode(), await startNode());
        feeds.push(await openFeed(nodes[0].port, user.id), await openFeed(nodes[1].port, user.id));
        await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes('event: connected'))));
        const events = await Promise.all(runs.map(runId => recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'concurrent', payload: {} })));
        const expected = events.map(event => String(event.id)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        await Promise.all(feeds.flatMap(feed => expected.map(id => feed.wait(frame => frame.includes(`id: ${id}\n`)))));
        await new Promise(resolve => setTimeout(resolve, 250));
        for (const feed of feeds) {
            const ids = feed.frames.filter(frame => frame.includes('event: agent.event')).map(frame => /^id: (\d+)$/m.exec(frame)?.[1]).filter(Boolean);
            assert.deepEqual(ids, expected);
        }
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
        for (const runId of runs) await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('开发环境两节点多连接事件补查压力探针', { skip: !process.env.DATABASE_URL || process.env.PIVOT_REALTIME_STRESS !== '1', timeout: 60000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const prefix = `relay-load-${process.pid}-${Date.now()}`;
    const runs = Array.from({ length: 24 }, (_, index) => `${prefix}-${index}`);
    const nodes = []; const feeds = [];
    try {
        for (const runId of runs) await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'relay','relay','queued','{}',NOW(),NOW())", [runId, user.id]);
        nodes.push(await startNode(), await startNode());
        for (const node of nodes) for (let index = 0; index < 8; index += 1) feeds.push(await openFeed(node.port, user.id));
        await Promise.all(feeds.map(feed => feed.wait(frame => frame.includes('event: connected'))));
        await new Promise(resolve => setTimeout(resolve, 400));
        const start = Date.now();
        const committed = await Promise.all(runs.map(runId => recordAgentEvent({ runId, userId: user.id, type: 'run.progress', eventKey: 'load', payload: {} })));
        const ids = committed.map(event => String(event.id)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        await Promise.all(feeds.flatMap(feed => ids.map(id => feed.wait(frame => frame.includes(`id: ${id}\n`)))));
        const elapsedMs = Date.now() - start;
        for (const feed of feeds) {
            const delivered = feed.frames.filter(frame => frame.includes('event: agent.event')).map(frame => /^id: (\d+)$/m.exec(frame)?.[1]).filter(Boolean);
            assert.deepEqual(delivered, ids);
        }
        console.log(JSON.stringify({ scenario: 'synthetic-realtime', nodes: 2, connections: feeds.length, users: 1, concurrentRuns: runs.length,
            deliveries: feeds.length * ids.length, elapsedMs }));
    } finally {
        feeds.forEach(feed => feed.close());
        for (const { child } of nodes) if (child.exitCode === null && child.connected) { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); }
        for (const runId of runs) await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
