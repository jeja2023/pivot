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
