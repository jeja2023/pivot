'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeChatLocalBridgeDebug, registerChatRequestLocalBridge } = require('../server/routes/chat/local-bridge');

test('chat local bridge diagnostics remain bounded and never register user-supplied devices', () => {
    const payload = { page: 'x'.repeat(80), deviceName: '本机', hasDesktopBridge: true, deviceId: 'untrusted-device',
        grants: { local_database: true, local_browser: false, local_browser_origin_count: 2, secret: '不应透传' } };
    const req = { body: { localMcpBridgeDebug: payload } };
    assert.equal(registerChatRequestLocalBridge(req), null);
    assert.equal(req.localMcpBridgeDebug.page.length, 40);
    assert.equal(req.localMcpBridgeDebug.grants.local_database, true);
    assert.equal(req.localMcpBridgeDebug.grants.local_browser_origin_count, 2);
    assert.equal(Object.hasOwn(req.localMcpBridgeDebug, 'deviceId'), false);
    assert.equal(Object.hasOwn(req.localMcpBridgeDebug.grants, 'secret'), false);
    assert.equal(normalizeChatLocalBridgeDebug(null), null);
});
