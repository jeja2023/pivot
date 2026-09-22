'use strict';

const WINDOWS_RELEASE_CHANNELS = Object.freeze({
    development: 'development',
    offline: 'offline',
    update: 'update'
});

const CHANNEL_FLAGS = Object.freeze({
    '--development': WINDOWS_RELEASE_CHANNELS.development,
    '--offline-release': WINDOWS_RELEASE_CHANNELS.offline,
    '--release': WINDOWS_RELEASE_CHANNELS.update
});

function resolveWindowsReleaseChannel(args = []) {
    const selected = [...new Set((Array.isArray(args) ? args : [])
        .map(arg => CHANNEL_FLAGS[arg])
        .filter(Boolean))];
    if (selected.length > 1) {
        throw new Error('Windows 桌面构建只能选择一种发布通道：--release、--offline-release 或 --development。');
    }
    return selected[0] || WINDOWS_RELEASE_CHANNELS.development;
}

function stripWindowsReleaseChannelArgs(args = []) {
    return (Array.isArray(args) ? args : []).filter(arg => !Object.hasOwn(CHANNEL_FLAGS, arg));
}

function isTrustedWindowsRelease(channel) {
    return channel === WINDOWS_RELEASE_CHANNELS.update || channel === WINDOWS_RELEASE_CHANNELS.offline;
}

function isWindowsUpdateRelease(channel) {
    return channel === WINDOWS_RELEASE_CHANNELS.update;
}

module.exports = {
    WINDOWS_RELEASE_CHANNELS,
    isTrustedWindowsRelease,
    isWindowsUpdateRelease,
    resolveWindowsReleaseChannel,
    stripWindowsReleaseChannelArgs
};
