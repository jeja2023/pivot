const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalAuthorizationManager } = require('../desktop/local-authorizations');

test('OCR 目录授权在桌面端可授予、撤销且不会落入旧类型白名单', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-local-auth-'));
    const watchedDirectory = path.join(root, 'watch');
    fs.mkdirSync(watchedDirectory);
    const manager = createLocalAuthorizationManager({
        app: { getPath: () => root },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [watchedDirectory] }) },
        getMainWindow: () => null
    });
    try {
        const granted = await manager.grantLocalAuthorization('local_ocr_watch_dir');
        assert.equal(granted.canceled, false);
        assert.equal(granted.status.grants.local_ocr_watch_dir.authorized, true);
        assert.ok(granted.status.supportedTypes.includes('local_ocr_watch_dir'));
        const status = manager.revokeLocalAuthorization('local_ocr_watch_dir');
        assert.equal(status.grants.local_ocr_watch_dir.authorized, false);
    } finally {
        manager.revokeLocalAuthorization('local_ocr_watch_dir');
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('桌面截图请求进入桌面控制处理器，而非旧版 MCP 工具拒绝分支', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-local-auth-desktop-'));
    const manager = createLocalAuthorizationManager({
        app: { getPath: () => root },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) },
        getMainWindow: () => null
    });
    try {
        await assert.rejects(
            () => manager.executeLocalMcpTool({ toolName: 'desktop.screenshot', input: {} }),
            error => error?.code === 'LOCAL_DESKTOP_CONTROL_GRANT_REQUIRED'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
