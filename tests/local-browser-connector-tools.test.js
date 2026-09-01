const assert = require('node:assert/strict');
const test = require('node:test');
const {
    browserNetworkPolicy,
    localBrowserToolDefinitions,
    normalizeLocalBrowserGrant,
    normalizeLocalBrowserTask
} = require('../server/services/local-browser-connector-tools');

const grant = {
    browsers: [
        { id: 'edge-local', label: 'Microsoft Edge', engine: 'chromium' },
        { id: 'firefox-local', label: 'Firefox', engine: 'firefox' }
    ],
    allowedOrigins: ['https://oa.example.internal', 'http://10.2.3.4:8080']
};

test('本机浏览器工具只接受已授权浏览器和精确 Origin', async () => {
    const normalized = normalizeLocalBrowserGrant(grant);
    assert.equal(normalized.browsers.length, 2);
    assert.deepEqual(browserNetworkPolicy(normalized).allowed_origins, grant.allowedOrigins);
    const task = await normalizeLocalBrowserTask('browser.click', {
        browserId: 'firefox-local',
        url: 'http://10.2.3.4:8080/portal',
        target: { role: 'button', name: '提交' }
    }, normalized);
    assert.equal(task.browser.engine, 'firefox');
    await assert.rejects(
        () => normalizeLocalBrowserTask('browser.inspect', { browserId: 'edge-local', url: 'https://example.com' }, normalized),
        error => error.code === 'LOCAL_BROWSER_ORIGIN_FORBIDDEN'
    );
    await assert.rejects(
        () => normalizeLocalBrowserTask('browser.click', { browserId: 'edge-local', url: 'https://oa.example.internal' }, normalized),
        error => error.code === 'LOCAL_BROWSER_TARGET_REQUIRED'
    );
});

test('本机浏览器工具契约不允许任意脚本执行或日常 Profile 参数', () => {
    const definitions = localBrowserToolDefinitions();
    assert.deepEqual(definitions.map(item => item.name), ['browser.open', 'browser.inspect', 'browser.click', 'browser.screenshot']);
    definitions.forEach(tool => {
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'script'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'profilePath'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'browserId'), true);
    });
});
