'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { formatDesktopUpdateError } = require('../client/common/desktop-update-errors');

test('更新错误按已知错误码和旧版文本分类，不向用户输出原始技术详情', () => {
    const message = formatDesktopUpdateError({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: '包含私密请求详情' });
    assert.match(message, /latest\.yml.*HTTP 404/);
    assert.equal(formatDesktopUpdateError(message), message);
    assert.equal(formatDesktopUpdateError('Cannot find channel "latest.yml" update info: HttpError: 404 Not Found\nHeaders: private'), message);
    assert.match(formatDesktopUpdateError({ statusCode: 404 }), /安装包不存在/);
    assert.match(formatDesktopUpdateError({ code: 'ERR_UPDATER_INVALID_SIGNATURE' }), /签名校验未通过/);
    assert.match(formatDesktopUpdateError({ statusCode: 403 }), /拒绝访问/);
    assert.match(formatDesktopUpdateError({ code: 'ECONNREFUSED' }), /无法连接/);
    assert.match(formatDesktopUpdateError({ code: 'ETIMEDOUT' }), /超时/);
    assert.doesNotMatch(formatDesktopUpdateError('C:\\private\\token.txt: unknown error'), /private|token|unknown/);
});

test('更新器的错误事件与异常捕获只发送一次短错误状态', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-error-'));
    const file = path.resolve(__dirname, '../desktop/updater.js');
    const nativeRequire = createRequire(file);
    const updater = new EventEmitter();
    const raw = Object.assign(new Error('Cannot find channel "latest.yml" update info: HttpError: 404 Not Found\nHeaders: private\nat C:\\private\\app.asar'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    updater.verifyUpdateCodeSignature = () => {};
    updater.checkForUpdates = async () => { updater.emit('error', raw); throw raw; };
    const mainWindow = new EventEmitter();
    const states = [];
    mainWindow.isDestroyed = () => false;
    mainWindow.webContents = { send: (_channel, state) => states.push(state) };
    const context = {
        module: { exports: {} },
        require: name => name === 'electron' ? { ipcMain: { handle() {} } } : nativeRequire(name),
        process: { platform: 'win32', resourcesPath: root, env: {} },
        setTimeout, clearTimeout, setInterval, clearInterval
    };
    let controller;
    try {
        fs.writeFileSync(path.join(root, 'app-update.yml'), 'publisherName: Pivot Release\n');
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
        controller = context.module.exports.setupAutoUpdater({
            app: { isPackaged: true, getVersion: () => '0.7.155' }, mainWindow, autoUpdater: updater,
            config: { autoUpdate: { enabled: true, publisherName: 'Pivot Release', url: 'https://updates.example.test/', allowedOrigins: ['https://updates.example.test'], checkOnStart: false, checkIntervalMinutes: 0 } }
        });
        const state = await controller.checkForUpdates(true);
        assert.equal(state.status, 'error');
        assert.match(state.error, /latest\.yml.*HTTP 404/);
        assert.doesNotMatch(state.error, /Headers|private|app\.asar/);
        assert.equal(states.filter(item => item.status === 'error').length, 1);
    } finally {
        controller?.destroy();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
