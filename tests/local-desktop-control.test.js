'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    localDesktopControlToolDefinitions,
    normalizeDesktopControlTask
} = require('../server/services/local-desktop-control-tools');
const { desktopControlEnvironment, runLocalDesktopControlTask } = require('../desktop/local-desktop-control');
const { WINDOWS_ACCESSIBILITY_SCRIPT } = require('../desktop/local-desktop-control');

const grant = { windowTitle: 'Pivot Fixture', processName: 'pivot-fixture.exe', label: 'Fixture App' };

test('native desktop control is limited to accessibility actions and rejects absent grants', () => {
    assert.deepEqual(localDesktopControlToolDefinitions().map(tool => tool.name), ['desktop.inspect', 'desktop.screenshot', 'desktop.click', 'desktop.type', 'desktop.wait']);
    assert.throws(
        () => normalizeDesktopControlTask('desktop.type', { target: { name: '密码' }, text: '' }, grant),
        error => error.code === 'LOCAL_DESKTOP_CONTROL_TEXT_INVALID'
    );
    assert.throws(
        () => normalizeDesktopControlTask('desktop.click', { target: { name: '保存' } }, {}),
        error => error.code === 'LOCAL_DESKTOP_CONTROL_GRANT_REQUIRED'
    );
    assert.match(WINDOWS_ACCESSIBILITY_SCRIPT, /GetForegroundWindow/);
    assert.match(WINDOWS_ACCESSIBILITY_SCRIPT, /IsPassword/);
    assert.match(WINDOWS_ACCESSIBILITY_SCRIPT, /PrintWindow/);
    assert.doesNotMatch(WINDOWS_ACCESSIBILITY_SCRIPT, /CopyFromScreen/);
    assert.doesNotMatch(WINDOWS_ACCESSIBILITY_SCRIPT, /\.IndexOf\(/);
    assert.match(WINDOWS_ACCESSIBILITY_SCRIPT, /等待授权窗口控件超时/);
    assert.doesNotMatch(WINDOWS_ACCESSIBILITY_SCRIPT, /SendKeys|mouse_event|keybd_event/);
});

test('native desktop driver only receives Windows runtime variables and its typed request', () => {
    const previous = process.env.PIVOT_TEST_SECRET;
    process.env.PIVOT_TEST_SECRET = 'must-not-reach-driver';
    try {
        const environment = desktopControlEnvironment({ action: 'desktop.inspect', grant: grant });
        assert.equal(environment.PIVOT_TEST_SECRET, undefined);
        assert.match(Buffer.from(environment.PIVOT_DESKTOP_CONTROL_REQUEST, 'base64').toString('utf8'), /desktop\.inspect/);
    } finally {
        if (previous === undefined) delete process.env.PIVOT_TEST_SECRET;
        else process.env.PIVOT_TEST_SECRET = previous;
    }
});

test('native desktop control requires confirmation and delegates only a typed accessibility request', async () => {
    const calls = [];
    const result = await runLocalDesktopControlTask({
        toolName: 'desktop.click',
        input: { target: { automationId: 'save-button' } },
        grant,
        platform: 'win32',
        confirmAction: async detail => { calls.push(detail); return true; },
        runner: async (_script, request) => {
            assert.equal(request.action, 'desktop.click');
            assert.equal(request.target.automationId, 'save-button');
            assert.equal(request.grant.processName, 'pivot-fixture.exe');
            return { ok: true, result: { action: 'desktop.click', invoked: true } };
        }
    });
    assert.deepEqual(result, { action: 'desktop.click', invoked: true });
    assert.equal(calls.length, 1);
    const screenshot = await runLocalDesktopControlTask({
        toolName: 'desktop.screenshot', input: {}, grant, platform: 'win32', confirmAction: async () => true,
        runner: async (_script, request) => {
            assert.equal(request.action, 'desktop.screenshot');
            return { ok: true, result: { action: 'desktop.screenshot', screenshot: { mimeType: 'image/jpeg', sha256: 'a'.repeat(64), dataBase64: 'AA==' } } };
        }
    });
    assert.equal(screenshot.screenshot.mimeType, 'image/jpeg');
    await assert.rejects(
        () => runLocalDesktopControlTask({ toolName: 'desktop.inspect', input: {}, grant, platform: 'linux', confirmAction: async () => true }),
        error => error.code === 'LOCAL_DESKTOP_CONTROL_UNAVAILABLE'
    );
});
