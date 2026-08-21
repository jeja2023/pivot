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
    return {
        userDataDir: createIsolatedProfile(options.profileRoot, options.taskId),
        headless: options.headless !== false,
        viewport: options.viewport || { width: 1440, height: 900 },
        acceptDownloads: false,
        javaScriptEnabled: true,
        serviceWorkers: 'block'
    };
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
    const contextOptions = buildBrowserContextOptions(options);
    const profile = contextOptions.userDataDir;
    delete contextOptions.userDataDir;
    const context = await chromium.launchPersistentContext(profile, contextOptions);
    await context.route('**/*', async route => {
        try {
            const request = route.request();
            let fromUrl = request.url();
            try { fromUrl = request.frame()?.url() || fromUrl; } catch (_) {}
            await assertNetworkPolicyUrl(request.url(), policy, { requireAllowlist: true });
            assertRedirectAllowed(fromUrl, request.url(), policy);
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
    closeAgentBrowserContext,
    createAgentBrowserContext,
    createIsolatedProfile,
    evaluateSafe
};
