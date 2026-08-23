const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertNetworkPolicyUrl, assertRedirectAllowed, normalizeNetworkPolicy } = require('./agent-network-policy');

const SENSITIVE_EVALUATION_RE = /(?:document\s*\.\s*cookie|localStorage|sessionStorage|password|authorization|token)/i;

function createIsolatedProfile(root = '', taskId = '') {
    const base = path.resolve(root || path.join(os.tmpdir(), 'pivot-agent-browser'));
    const safeId = String(taskId || 'session').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const profile = path.join(base, safeId);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    return profile;
}

function assertSafeBrowserEvaluation(expression) {
    if (SENSITIVE_EVALUATION_RE.test(String(expression || ''))) {
        const error = new Error('浏览器 Agent 禁止读取 Cookie、Storage 或凭证字段。');
        error.code = 'AGENT_BROWSER_CREDENTIAL_ACCESS_DENIED';
        error.category = 'policy';
        throw error;
    }
}

function buildBrowserContextOptions(options = {}) {
    const result = {
        userDataDir: createIsolatedProfile(options.profileRoot, options.taskId),
        headless: options.headless !== false,
        viewport: options.viewport || { width: 1440, height: 900 },
        acceptDownloads: false,
        javaScriptEnabled: true,
        serviceWorkers: 'block'
    };
    if (options.executablePath) result.executablePath = String(options.executablePath);
    return result;
}

function resolveChromiumExecutable(chromium, options = {}) {
    const candidates = [
        options.executablePath,
        process.env.PIVOT_CHROMIUM_PATH,
        process.resourcesPath && path.join(process.resourcesPath, 'agent-runtime', 'browser', 'chromium', process.platform === 'win32' ? 'chrome.exe' : 'chrome'),
        process.resourcesPath && path.join(process.resourcesPath, 'agent-runtime', 'browser', 'chromium', 'chrome'),
        typeof chromium?.executablePath === 'function' ? chromium.executablePath() : ''
    ].filter(Boolean).map(item => path.resolve(String(item)));
    return candidates.find(item => fs.existsSync(item)) || '';
}

async function createAgentBrowserContext(options = {}) {
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (error) {
        const unavailable = new Error('Playwright 未安装，无法创建 Agent Browser Worker。');
        unavailable.code = 'AGENT_BROWSER_UNAVAILABLE';
        unavailable.cause = error;
        throw unavailable;
    }
    const policy = normalizeNetworkPolicy(options.networkPolicy || {});
    const executablePath = resolveChromiumExecutable(chromium, options);
    if (!executablePath) {
        const unavailable = new Error('未找到可用的 Chromium 浏览器可执行文件，无法创建 Agent Browser Worker。');
        unavailable.code = 'AGENT_BROWSER_UNAVAILABLE';
        throw unavailable;
    }
    const contextOptions = buildBrowserContextOptions({ ...options, executablePath });
    const profile = contextOptions.userDataDir;
    delete contextOptions.userDataDir;
    const context = await chromium.launchPersistentContext(profile, contextOptions);
    await context.route('**/*', async route => {
        try {
            const request = route.request();
            let fromUrl = request.url();
            try { fromUrl = request.frame()?.url() || fromUrl; } catch (_) {}
            if (!['about:blank', 'about:srcdoc', 'null'].includes(String(fromUrl || '').toLowerCase())) {
                assertRedirectAllowed(fromUrl, request.url(), policy);
            }
            await assertNetworkPolicyUrl(request.url(), policy, {
                requireAllowlist: true,
                isRedirect: !['about:blank', 'about:srcdoc', 'null'].includes(String(fromUrl || '').toLowerCase())
            });
            await route.continue();
        } catch (error) {
            await route.abort('blockedbyclient');
        }
    });
    context.on('page', page => {
        page.on('response', async response => {
            const length = Number(response.headers()['content-length'] || 0);
            if (length > 0 && length > policy.max_download_size_bytes) {
                try { await page.close({ runBeforeUnload: false }); } catch (_) {}
            }
        });
        page.on('download', download => {
            // Downloads are disabled by default; cancel the event explicitly so a
            // hostile page cannot leave an uncontrolled artifact on disk.
            download.cancel().catch(() => {});
        });
    });
    return context;
}

async function createControlledLoginFlow(options = {}) {
    const policy = normalizeNetworkPolicy(options.networkPolicy || {});
    const loginUrl = String(options.loginUrl || '').trim();
    await assertNetworkPolicyUrl(loginUrl, policy, { requireAllowlist: true });
    const context = await createAgentBrowserContext({ ...options, headless: false, networkPolicy: policy });
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: options.waitUntil || 'domcontentloaded' });
    return {
        context,
        page,
        async waitForUserReady({ readySelector = '', timeoutMs = 10 * 60 * 1000 } = {}) {
            if (readySelector) await page.locator(String(readySelector)).waitFor({ state: 'visible', timeout: timeoutMs });
            else await page.waitForTimeout(Math.min(Math.max(Number(timeoutMs) || 1000, 1000), 10 * 60 * 1000));
            await assertNetworkPolicyUrl(page.url(), policy, { requireAllowlist: true });
            return { url: page.url(), authenticated: true };
        },
        async close() { await closeAgentBrowserContext(context); }
    };
}

async function captureAgentScreenshot(page, options = {}) {
    if (options.loginPhase === true) {
        const error = new Error('登录阶段禁止截取页面，避免凭证进入 Agent 上下文。');
        error.code = 'AGENT_BROWSER_LOGIN_SCREENSHOT_DENIED';
        error.category = 'policy';
        throw error;
    }
    return page.screenshot({ type: 'png', fullPage: options.fullPage === true });
}

async function locateBrowserTarget(page, target = {}, options = {}) {
    const spec = typeof target === 'string' ? { selector: target } : (target || {});
    const candidates = [];
    if (spec.selector) candidates.push(page.locator(String(spec.selector)).first());
    if (spec.role && spec.name) candidates.push(page.getByRole(String(spec.role), { name: String(spec.name) }).first());
    if (spec.text) candidates.push(page.getByText(String(spec.text), { exact: spec.exact === true }).first());
    for (const locator of candidates) {
        try {
            if (await locator.count() && await locator.isVisible()) return { method: 'dom', locator };
        } catch (_) {}
    }
    if (typeof options.visionLocator === 'function') {
        const screenshot = await captureAgentScreenshot(page, options);
        const visual = await options.visionLocator({ screenshot, target: spec });
        if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) return { method: 'vision', ...visual };
    }
    const error = new Error('浏览器页面未找到目标元素。');
    error.code = 'AGENT_BROWSER_TARGET_NOT_FOUND';
    error.category = 'schema';
    throw error;
}

async function clickBrowserTarget(page, target, options = {}) {
    const found = await locateBrowserTarget(page, target, options);
    if (found.method === 'dom') await found.locator.click();
    else await page.mouse.click(Number(found.x), Number(found.y));
    return { method: found.method };
}

async function evaluateSafe(page, expression, arg) {
    assertSafeBrowserEvaluation(expression);
    return page.evaluate(expression, arg);
}

async function closeAgentBrowserContext(context) {
    if (context?.close) await context.close();
}

module.exports = {
    assertSafeBrowserEvaluation,
    buildBrowserContextOptions,
    captureAgentScreenshot,
    clickBrowserTarget,
    closeAgentBrowserContext,
    createControlledLoginFlow,
    createAgentBrowserContext,
    createIsolatedProfile,
    evaluateSafe,
    locateBrowserTarget,
    resolveChromiumExecutable
};
