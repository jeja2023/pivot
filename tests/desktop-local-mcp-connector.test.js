const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalMcpConnector } = require('../desktop/local-mcp-connector');

const mockIdentity = {
    getDeviceId: () => 'desktop-test-device',
    getPublicKeyPem: () => 'test-public-key',
    signPayload: payload => `sig:${payload}`,
    getIdentityStatus: () => ({ available: true, deviceId: 'desktop-test-device' })
};

test('本机连接器在无授权工具时待机，不发起任务认领', async () => {
    const requests = [];
    let executed = false;
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        request: async ({ method, path, body }) => {
            requests.push({ method, path, body });
            if (path === '/api/agents/local-devices/challenge') {
                return { status: 201, data: { nonce: 'nonce-123' } };
            }
            if (path === '/api/agents/local-devices') {
                return { status: 201, data: { success: true } };
            }
            if (path === '/api/mcp/local-device/connector/heartbeat') {
                return { status: 200, data: { success: true } };
            }
            return { status: 200, data: { status: 'idle' } };
        },
        getLocalAuthorizationStatus: () => ({
            deviceName: '测试电脑',
            grants: {
                local_database: { authorized: false },
                local_browser: { authorized: false }
            }
        }),
        executeLocalTool: async () => { executed = true; }
    });

    const result = await connector.runOnce();
    assert.equal(result.status, 'idle');
    assert.equal(result.active, false);
    assert.equal(executed, false);

    // 首次注册和心跳发出了，但没有发出 claim 任务认领请求
    assert.ok(requests.some(r => r.path === '/api/mcp/local-device/connector/heartbeat'));
    assert.equal(requests.some(r => r.path === '/api/mcp/local-device/connector/tasks/claim'), false);

    // 第二次立即执行，因距离上次心跳小于 45s，不再重复发出心跳请求
    const reqCountBefore = requests.length;
    const secondResult = await connector.runOnce();
    assert.equal(secondResult.status, 'idle');
    assert.equal(requests.length, reqCountBefore);
});

test('本机连接器在存在授权工具时正常发起任务认领并执行工具', async () => {
    const requests = [];
    let toolExecuted = false;
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        request: async ({ method, path, body }) => {
            requests.push({ method, path, body });
            if (path === '/api/agents/local-devices/challenge') {
                return { status: 201, data: { nonce: 'nonce-456' } };
            }
            if (path === '/api/agents/local-devices') {
                return { status: 201, data: { success: true } };
            }
            if (path === '/api/mcp/local-device/connector/heartbeat') {
                return { status: 200, data: { success: true } };
            }
            if (path === '/api/mcp/local-device/connector/tasks/claim') {
                return {
                    status: 200,
                    data: {
                        status: 'claimed',
                        claimToken: 'token-abc',
                        task: { id: 'task-001', toolName: 'browser.open', input: { url: 'https://example.com' } }
                    }
                };
            }
            if (path.includes('/result')) {
                return { status: 200, data: { success: true } };
            }
            return { status: 200, data: {} };
        },
        getLocalAuthorizationStatus: () => ({
            deviceName: '测试电脑',
            grants: {
                local_browser: { authorized: true }
            }
        }),
        executeLocalTool: async ({ taskId, toolName }) => {
            assert.equal(taskId, 'task-001');
            assert.equal(toolName, 'browser.open');
            toolExecuted = true;
            return { opened: true };
        }
    });

    const result = await connector.runOnce();
    assert.equal(result.status, 'completed');
    assert.equal(result.taskId, 'task-001');
    assert.equal(toolExecuted, true);

    assert.ok(requests.some(r => r.path === '/api/mcp/local-device/connector/tasks/claim'));
    assert.ok(requests.some(r => r.path.includes('/result')));
});
