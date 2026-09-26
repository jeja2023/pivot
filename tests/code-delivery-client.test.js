const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'code-delivery.js'), 'utf8');

function loadCodeDelivery(statuses, { promptResponse = '' } = {}) {
    const modules = new Map();
    const toasts = [];
    const requests = [];
    let statusIndex = 0;
    let authorizeCalls = 0;
    let startCalls = 0;
    let prepareCalls = 0;
    const context = {
        API_BASE: '/api',
        showToast: (message, level) => toasts.push({ message, level }),
        apiFetch: async (url, options = {}) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ reused: false, intent: { id: 'intent-1' } }) };
        },
        window: {
            prompt() { return promptResponse; },
            pivotDesktop: {
                getDeliveryStatus: async () => statuses[Math.min(statusIndex++, statuses.length - 1)],
                authorizeDeliveryDirectory: async () => {
                    authorizeCalls += 1;
                    return { canceled: false };
                },
                startDelivery: async () => { startCalls += 1; },
                prepareDelivery: async () => {
                    prepareCalls += 1;
                    return { ...statuses[Math.min(statusIndex - 1, statuses.length - 1)], registered: true };
                }
            },
            Pivot: {
                exposeModule(name, api) { modules.set(name, api); }
            }
        }
    };
    vm.runInNewContext(source, context, { filename: 'client/chat/code-delivery.js' });
    return {
        api: modules.get('chat.codeDelivery'),
        requests,
        toasts,
        getAuthorizeCalls: () => authorizeCalls,
        getStartCalls: () => startCalls,
        getPrepareCalls: () => prepareCalls
    };
}

test('网页首次保存会在没有可用授权时引导选择本机目录并创建交付任务', async () => {
    const delivery = loadCodeDelivery([
        { available: true, deviceId: 'desktop-client-test-1', grants: [] },
        {
            available: true,
            deviceId: 'desktop-client-test-1',
            grants: [{ grantId: 'grant-docx-1', pathHint: 'exports/docs', allowedFormats: ['docx'], expired: false }]
        }
    ]);

    const result = await delivery.api.queueRenditionToDesktop({ id: 'rendition-1', format: 'docx' }, '通知.docx');

    assert.equal(delivery.getAuthorizeCalls(), 1);
    assert.equal(delivery.getPrepareCalls(), 1);
    assert.equal(delivery.getStartCalls(), 1);
    assert.equal(result.intent.id, 'intent-1');
    assert.equal(delivery.requests.length, 1);
    assert.equal(delivery.requests[0].url, '/api/agents/deliveries');
    assert.deepEqual(JSON.parse(delivery.requests[0].options.body), {
        renditionId: 'rendition-1',
        channel: 'local_device',
        deviceId: 'desktop-client-test-1',
        targetDirGrant: 'grant-docx-1',
        targetFilename: '通知.docx'
    });
});

test('过期目录授权不会被用于创建本机交付任务', async () => {
    const delivery = loadCodeDelivery([
        {
            available: true,
            deviceId: 'desktop-client-test-2',
            grants: [{ grantId: 'grant-expired-1', pathHint: 'exports/old', allowedFormats: ['docx'], expired: true }]
        },
        {
            available: true,
            deviceId: 'desktop-client-test-2',
            grants: [{ grantId: 'grant-current-1', pathHint: 'exports/new', allowedFormats: ['docx'], expired: false }]
        }
    ]);

    await delivery.api.queueRenditionToDesktop({ id: 'rendition-2', format: 'docx' });

    assert.equal(delivery.getAuthorizeCalls(), 1);
    assert.equal(JSON.parse(delivery.requests[0].options.body).targetDirGrant, 'grant-current-1');
});

test('多个本机目录按用户选择的序号创建交付任务', async () => {
    const delivery = loadCodeDelivery([{
        available: true,
        deviceId: 'desktop-client-test-3',
        grants: [
            { grantId: 'grant-one', pathHint: 'exports/first', allowedFormats: ['docx'], expired: false },
            { grantId: 'grant-two', pathHint: 'exports/second', allowedFormats: ['docx'], expired: false }
        ]
    }], { promptResponse: '2' });

    await delivery.api.queueRenditionToDesktop({ id: 'rendition-3', format: 'docx' });

    assert.equal(delivery.getAuthorizeCalls(), 0);
    assert.equal(delivery.getPrepareCalls(), 1);
    assert.equal(JSON.parse(delivery.requests[0].options.body).targetDirGrant, 'grant-two');
});
