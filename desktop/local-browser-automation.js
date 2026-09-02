/**
 * 桌面连接器的本机浏览器执行面。
 * 仅使用授权的浏览器可执行文件与 Pivot 自己的隔离 Profile；绝不接管用户日常浏览器 Profile、Cookie 或密码库。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    clickBrowserTarget,
    closeAgentBrowserContext,
    createManagedBrowserContext
} = require('../server/services/agent-browser');
const {
    browserNetworkPolicy,
    isLocalBrowserConnectorTool,
    normalizeLocalBrowserGrant,
    normalizeLocalBrowserTask
} = require('../server/services/local-browser-connector-tools');

const MAX_TEXT_CHARS = 12000;
const MAX_SCREENSHOT_BYTES = 1024 * 1024;

function browserExecutionError(message, code = 'LOCAL_BROWSER_EXECUTION_FAILED', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function resolveGrantedBrowser(grant = {}, browserId = '') {
    const source = Array.isArray(grant?.browsers) ? grant.browsers : [];
    const browser = source.find(item => String(item?.id || '') === String(browserId || ''));
    const executablePath = String(browser?.executablePath || '').trim();
    if (!browser || !executablePath) throw browserExecutionError('当前设备未找到所选浏览器的本机授权记录。', 'LOCAL_BROWSER_NOT_AUTHORIZED', 403);
    const resolved = path.resolve(executablePath);
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) {
        throw browserExecutionError('授权的浏览器已移动、卸载或当前不可访问，请重新授权。', 'LOCAL_BROWSER_EXECUTABLE_MISSING', 404);
    }
    if (!stat.isFile()) throw browserExecutionError('授权的浏览器路径不是可执行文件。', 'LOCAL_BROWSER_EXECUTABLE_INVALID');
    return { id: browser.id, label: browser.label, engine: browser.engine, executablePath: resolved };
}

function profileDirectory(root, browserId) {
    const base = path.resolve(root);
    const safeId = String(browserId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const target = path.resolve(base, safeId || 'browser');
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw browserExecutionError('浏览器隔离 Profile 路径无效。', 'LOCAL_BROWSER_PROFILE_INVALID');
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
}

async function confirmLocalBrowserAction(confirmAction, details) {
    if (typeof confirmAction !== 'function') {
        throw browserExecutionError('本机浏览器操作缺少用户确认通道。', 'LOCAL_BROWSER_CONFIRMATION_UNAVAILABLE', 409);
    }
    const accepted = await confirmAction(details);
    if (accepted !== true) throw browserExecutionError('用户取消了本机浏览器操作。', 'LOCAL_BROWSER_USER_CANCELLED', 409);
}

async function runLocalBrowserTask({ toolName, input, grant, profileRoot, confirmAction } = {}) {
    if (!isLocalBrowserConnectorTool(toolName)) {
        throw browserExecutionError('不支持的本机浏览器任务。', 'LOCAL_BROWSER_TOOL_INVALID');
    }
    const normalizedGrant = normalizeLocalBrowserGrant(grant);
    const task = await normalizeLocalBrowserTask(toolName, input, normalizedGrant);
    const browser = resolveGrantedBrowser(grant, task.browserId);
    const policy = browserNetworkPolicy(normalizedGrant);
    const profile = profileDirectory(profileRoot, browser.id);
    const context = await createManagedBrowserContext({
        engine: browser.engine,
        executablePath: browser.executablePath,
        userDataDir: profile,
        headless: false,
        networkPolicy: policy,
        viewport: { width: 1440, height: 900 }
    });
    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: task.timeoutMs });
        const base = {
            browserId: browser.id,
            browser: browser.label,
            engine: browser.engine,
            url: page.url(),
            title: await page.title()
        };
        if (toolName === 'browser.open') {
            await confirmLocalBrowserAction(confirmAction, {
                kind: 'login', title: '本机浏览器已打开', url: page.url(), browser: browser.label,
                message: '如需要，请在独立浏览器窗口中完成登录。完成后点击“继续”；不会读取或上传登录凭据。'
            });
            return { ...base, action: 'opened', url: page.url(), title: await page.title(), profile: 'isolated' };
        }
        if (toolName === 'browser.click') {
            await confirmLocalBrowserAction(confirmAction, {
                kind: 'click', title: '确认本机浏览器点击', url: page.url(), browser: browser.label,
                target: task.target, message: '此操作会在本机浏览器中点击页面元素，可能触发外部副作用。'
            });
            const target = await clickBrowserTarget(page, task.target);
            await page.waitForLoadState('domcontentloaded', { timeout: Math.min(task.timeoutMs, 30000) }).catch(() => {});
            return { ...base, action: 'clicked', target, url: page.url(), title: await page.title() };
        }
        if (toolName === 'browser.screenshot') {
            await confirmLocalBrowserAction(confirmAction, {
                kind: 'screenshot', title: '确认截取本机浏览器页面', url: page.url(), browser: browser.label,
                message: '页面截图将作为本次任务结果回传。请确认当前页面不含不应分享的内容。'
            });
            const screenshot = await page.screenshot({ type: 'png', fullPage: false });
            if (screenshot.length > MAX_SCREENSHOT_BYTES) {
                throw browserExecutionError('页面截图超过 1 MB 安全上限，未回传。', 'LOCAL_BROWSER_SCREENSHOT_TOO_LARGE', 413);
            }
            return { ...base, action: 'screenshot', screenshot: { mimeType: 'image/png', sha256: crypto.createHash('sha256').update(screenshot).digest('hex'), dataBase64: screenshot.toString('base64') } };
        }
        await confirmLocalBrowserAction(confirmAction, {
            kind: 'inspect', title: '确认读取本机网页内容', url: page.url(), browser: browser.label,
            message: '页面正文将作为本次任务结果回传。请确认当前页面不含不应分享的内容。'
        });
        return { ...base, action: 'inspected', text: String(await page.locator('body').innerText()).slice(0, MAX_TEXT_CHARS) };
    } finally {
        await closeAgentBrowserContext(context);
    }
}

module.exports = {
    MAX_SCREENSHOT_BYTES,
    browserExecutionError,
    profileDirectory,
    resolveGrantedBrowser,
    runLocalBrowserTask
};
