const assert = require('node:assert/strict');
const test = require('node:test');

const { createDesktopDeliveryController } = require('../desktop/delivery/controller');

test('桌面端受控请求将 CSRF Cookie 同步到写请求头', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        return {
            status: 200,
            headers: { entries: () => [['content-type', 'application/json']] },
            json: async () => ({ success: true }),
            text: async () => ''
        };
    };

    try {
        const controller = createDesktopDeliveryController({
            getTargetUrl: () => 'https://pivot.example.internal/workbench',
            getSession: () => ({
                cookies: {
                    get: async () => [
                        { name: 'pivot_access_token', value: 'access-token' },
                        { name: 'pivot_csrf_token', value: 'csrf-token' }
                    ]
                }
            })
        });

        const response = await controller.request({
            method: 'POST',
            path: '/api/mcp/local-device/connector/heartbeat',
            body: { deviceId: 'device-1' }
        });

        assert.equal(response.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.headers.Cookie, 'pivot_access_token=access-token; pivot_csrf_token=csrf-token');
        assert.equal(calls[0].options.headers['X-CSRF-Token'], 'csrf-token');
    } finally {
        global.fetch = originalFetch;
    }
});

test('桌面端只在存在 CSRF Cookie 时发送 CSRF 请求头', async () => {
    const originalFetch = global.fetch;
    let requestHeaders = null;
    global.fetch = async (_url, options) => {
        requestHeaders = options.headers;
        return {
            status: 200,
            headers: { entries: () => [['content-type', 'application/json']] },
            json: async () => ({ success: true }),
            text: async () => ''
        };
    };

    try {
        const controller = createDesktopDeliveryController({
            getTargetUrl: () => 'https://pivot.example.internal',
            getSession: () => ({ cookies: { get: async () => [{ name: 'pivot_access_token', value: 'access-token' }] } })
        });

        await controller.request({ method: 'GET', path: '/api/health' });

        assert.equal(requestHeaders.Cookie, 'pivot_access_token=access-token');
        assert.equal(requestHeaders['X-CSRF-Token'], undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test('首次读取本机交付状态会初始化执行器并返回目录授权', () => {
    let created = 0;
    const controller = createDesktopDeliveryController({
        createExecutor: () => {
            created += 1;
            return {
                getStatus: () => ({
                    available: true,
                    deviceId: 'desktop-status-test-1',
                    grants: [{
                        grantId: 'grant-active-1',
                        pathHint: 'exports/docs',
                        allowedFormats: ['docx'],
                        expiresAt: '2026-12-31T00:00:00.000Z',
                        expired: false
                    }]
                })
            };
        }
    });

    const status = controller.status();

    assert.equal(created, 1);
    assert.equal(status.available, true);
    assert.equal(status.deviceId, 'desktop-status-test-1');
    assert.deepEqual(status.grants, [{
        grantId: 'grant-active-1',
        pathHint: 'exports/docs',
        allowedFormats: ['docx'],
        expiresAt: '2026-12-31T00:00:00.000Z',
        expired: false
    }]);
});

test('状态窗口读取本地交付状态时也会初始化执行器并请求完整路径', async () => {
    let created = 0;
    let includeDirectory = false;
    let suppliedStatus = null;
    const controller = createDesktopDeliveryController({
        createExecutor: () => {
            created += 1;
            return {
                getStatus(options = {}) {
                    includeDirectory = options.includeDirectory === true;
                    return { available: true, grants: [] };
                }
            };
        },
        openDeliveryStatusWindow: options => {
            suppliedStatus = options.getStatus();
        }
    });

    await controller.showStatusFromMenu();

    assert.equal(created, 1);
    assert.equal(includeDirectory, true);
    assert.equal(suppliedStatus.available, true);
});

test('创建交付任务前会强制以当前会话重新验证设备注册', async () => {
    let force = false;
    let started = 0;
    const controller = createDesktopDeliveryController({
        createExecutor: () => ({
            getStatus: () => ({ available: true, deviceId: 'desktop-prepare-test-1', registered: true, grants: [] }),
            ensureRegistered: async (_deviceId, options) => { force = options?.force === true; },
            start: () => { started += 1; }
        })
    });

    const status = await controller.prepare();

    assert.equal(force, true);
    assert.equal(started, 1);
    assert.equal(status.available, true);
    assert.equal(status.registered, true);
});
