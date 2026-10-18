'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function bridgeEnvironment(desktop) {
    const requests = [];
    const context = {
        window: { pivotDesktop: desktop },
        document: { readyState: 'complete' },
        API_BASE: '/api',
        apiFetch: async (...args) => { requests.push(args); throw new Error('不应由浏览器发送心跳'); }
    };
    vm.runInNewContext(read('client/chat/engine-local-mcp-bridge.js'), context);
    return { context, requests };
}

test('聊天首屏在发送引擎之前加载桌面连接器模块', () => {
    const scripts = read('client/chat/partials/scripts.html');
    const bridge = scripts.indexOf('/chat/engine-local-mcp-bridge.js');
    const engine = scripts.indexOf('/chat/engine.js');
    assert.ok(bridge >= 0 && engine > bridge);
    assert.match(scripts, /engine-local-mcp-bridge\.js\?v=__APP_VERSION__/);
});

test('发送前使用桌面持久连接器同步，不由网页发送自报心跳', async () => {
    const calls = [];
    const { context, requests } = bridgeEnvironment({
        getLocalAuthorizationStatus: async () => ({ grants: {
            local_database: { authorized: true },
            local_browser: { authorized: true, allowedOrigins: ['https://one.example', 'https://two.example'] }
        } }),
        syncLocalMcpConnector: async () => { calls.push('sync'); return { status: 'ok' }; },
        getLocalMcpConnectorStatus: async () => { calls.push('status'); return { running: true, identity: { deviceName: '测试电脑' } }; }
    });
    assert.equal(await context.syncChatLocalMcpBridgeBeforeSend(), null);
    const snapshot = context.getChatLocalMcpBridgeDebugSnapshot();
    assert.equal(snapshot.status, 'persistent_connector_synced');
    assert.equal(snapshot.grants.local_database, true);
    assert.equal(snapshot.grants.local_browser_origin_count, 2);
    assert.equal(Object.hasOwn(snapshot.grants, 'allowedOrigins'), false);
    assert.deepEqual(calls, ['sync', 'status']);
    assert.equal(requests.length, 0);
});

test('无桌面端或同步失败时只记录受限诊断信息', async () => {
    const absent = bridgeEnvironment(undefined);
    await absent.context.syncChatLocalMcpBridgeBeforeSend();
    assert.equal(absent.context.getChatLocalMcpBridgeDebugSnapshot().status, 'persistent_connector_unavailable');
    const failed = bridgeEnvironment({
        syncLocalMcpConnector: async () => { throw new Error('x'.repeat(400)); },
        getLocalMcpConnectorStatus: async () => { throw new Error('不应读取连接器状态'); }
    });
    await failed.context.syncChatLocalMcpBridgeBeforeSend();
    const snapshot = failed.context.getChatLocalMcpBridgeDebugSnapshot();
    assert.equal(snapshot.status, 'persistent_connector_sync_failed');
    assert.equal(snapshot.reason.length, 300);
    assert.equal(failed.requests.length, 0);
});
