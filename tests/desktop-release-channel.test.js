'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WINDOWS_RELEASE_CHANNELS,
    isTrustedWindowsRelease,
    isWindowsUpdateRelease,
    resolveWindowsReleaseChannel,
    stripWindowsReleaseChannelArgs
} = require('../scripts/desktop_release_channel');

test('Windows desktop build channels are explicit and never leak release flags to electron-builder', () => {
    assert.equal(resolveWindowsReleaseChannel(['nsis']), WINDOWS_RELEASE_CHANNELS.development);
    assert.equal(resolveWindowsReleaseChannel(['nsis', '--development']), WINDOWS_RELEASE_CHANNELS.development);
    assert.equal(resolveWindowsReleaseChannel(['nsis', '--offline-release']), WINDOWS_RELEASE_CHANNELS.offline);
    assert.equal(resolveWindowsReleaseChannel(['nsis', '--release']), WINDOWS_RELEASE_CHANNELS.update);
    assert.throws(
        () => resolveWindowsReleaseChannel(['nsis', '--release', '--development']),
        /只能选择一种发布通道/
    );
    assert.deepEqual(stripWindowsReleaseChannelArgs(['nsis', '--release', '--output-dir=dist-electron-test']), ['nsis', '--output-dir=dist-electron-test']);
    assert.equal(isTrustedWindowsRelease(WINDOWS_RELEASE_CHANNELS.update), true);
    assert.equal(isTrustedWindowsRelease(WINDOWS_RELEASE_CHANNELS.offline), true);
    assert.equal(isTrustedWindowsRelease(WINDOWS_RELEASE_CHANNELS.development), false);
    assert.equal(isWindowsUpdateRelease(WINDOWS_RELEASE_CHANNELS.update), true);
    assert.equal(isWindowsUpdateRelease(WINDOWS_RELEASE_CHANNELS.offline), false);
});
