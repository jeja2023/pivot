const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalMcpConnector, withRetryJitter } = require('../desktop/local-mcp-connector');

const mockIdentity = {
    getDeviceId: () => 'desktop-test-device',
    getPublicKeyPem: () => 'test-public-key',
    signPayload: payload => `sig:${payload}`,
    getIdentityStatus: () => ({ available: true, deviceId: 'desktop-test-device' })
};

test('本机连接器重试抖动始终受 ±20% 边界约束', () => {
    assert.equal(withRetryJitter(10000, () => 0), 8000);
    assert.equal(withRetryJitter(10000, () => 0.5), 10000);
    assert.equal(withRetryJitter(10000, () => 1), 12000);
});

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

test('本机连接器优先使用注入的 ensureRegistered 并支持并发防重', async () => {
    let customRegisterCount = 0;
    const requests = [];
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        ensureRegistered: async (deviceId) => {
            customRegisterCount += 1;
            assert.equal(deviceId, 'desktop-test-device');
        },
        request: async ({ method, path, body }) => {
            requests.push({ method, path, body });
            if (path === '/api/agents/local-devices/challenge') {
                return { status: 201, data: { nonce: 'nonce-789' } };
            }
            if (path === '/api/mcp/local-device/connector/heartbeat') {
                return { status: 200, data: { success: true } };
            }
            return { status: 200, data: {} };
        },
        getLocalAuthorizationStatus: () => ({
            deviceName: '测试电脑',
            grants: {}
        }),
        executeLocalTool: async () => {}
    });

    const [r1, r2] = await Promise.all([
        connector.runOnce(),
        connector.runOnce()
    ]);

    assert.equal(r1.status, 'idle');
    assert.equal(r2.status, 'idle');
    assert.equal(customRegisterCount, 1);
    // 确认未再发出 /api/agents/local-devices 请求（已委托给外部并完成）
    assert.equal(requests.some(r => r.path === '/api/agents/local-devices'), false);
});

test('停止期间迟到的领取不能执行，重新启动必须重新登记', async () => {
    let resolveClaim, enteredClaim, registrations = 0, executions = 0;
    const claimEntered = new Promise(resolve => { enteredClaim = resolve; });
    const claimGate = new Promise(resolve => { resolveClaim = resolve; });
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        ensureRegistered: async () => { registrations++; },
        request: async ({ path }) => {
            if (path === '/api/agents/local-devices/challenge') return { status: 200, data: { nonce: 'nonce' } };
            if (path.endsWith('/heartbeat')) return { status: 200, data: {} };
            if (path.endsWith('/tasks/claim')) { enteredClaim(); return claimGate; }
            return { status: 200, data: {} };
        },
        getLocalAuthorizationStatus: () => ({ grants: { local_desktop_control: { authorized: true } } }),
        executeLocalTool: async () => { executions++; }
    });
    const run = connector.runOnce(); await claimEntered;
    const drained = connector.stopAndDrain();
    resolveClaim({ status: 200, data: { status: 'claimed', claimToken: 'claim', task: { id: 'old', toolName: 'desktop.click', input: {} } } });
    await assert.rejects(run, { code: 'LOCAL_CONNECTOR_STOPPED' });
    await drained;
    assert.equal(executions, 0);
    await connector.sync();
    assert.equal(registrations, 2);
});

test('停止后等待已开始的本机执行结束，不向新会话回传旧结果', async () => {
    let release, started, completed = false;
    const entered = new Promise(resolve => { started = resolve; });
    const work = new Promise(resolve => { release = resolve; });
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        ensureRegistered: async () => {},
        request: async ({ path }) => {
            if (path === '/api/agents/local-devices/challenge') return { status: 200, data: { nonce: 'nonce' } };
            if (path.endsWith('/tasks/claim')) return { status: 200, data: { status: 'claimed', claimToken: 'claim', task: { id: 'old', toolName: 'desktop.click', input: {} } } };
            if (path.endsWith('/result')) completed = true;
            return { status: 200, data: {} };
        },
        getLocalAuthorizationStatus: () => ({ grants: { local_desktop_control: { authorized: true } } }),
        executeLocalTool: async () => { started(); await work; return {}; }
    });
    const run = connector.runOnce(); await entered;
    let finished = false;
    const drained = connector.stopAndDrain().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false);
    release(); await assert.rejects(run, { code: 'LOCAL_CONNECTOR_STOPPED' }); await drained;
    assert.equal(completed, false);
});

test('停止并排空也等待手动授权同步结束，旧同步不能登记为新会话', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const connector = createLocalMcpConnector({
        identity: mockIdentity,
        ensureRegistered: async () => { entered(); await gate; },
        request: async () => ({ status: 200, data: { nonce: 'nonce' } }),
        getLocalAuthorizationStatus: () => ({ grants: {} }),
        executeLocalTool: async () => {}
    });
    const syncing = connector.sync(); await started;
    let finished = false;
    const drained = connector.stopAndDrain().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false);
    release(); await assert.rejects(syncing, { code: 'LOCAL_CONNECTOR_STOPPED' }); await drained;
    assert.equal(finished, true);
});
