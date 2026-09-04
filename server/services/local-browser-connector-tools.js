/**
 * 本机浏览器连接器的无状态契约与服务端输入校验。
 * 浏览器可执行路径、独立 Profile 和会话数据只保存在桌面端；服务端仅保存浏览器名称、内核和允许 Origin。
 */
const { normalizeNetworkPolicy, validateNetworkPolicyUrl } = require('./agent-network-policy');

const LOCAL_BROWSER_ENGINES = Object.freeze(['chromium', 'firefox']);
const LOCAL_BROWSER_TOOL_NAMES = Object.freeze(['browser.open', 'browser.inspect', 'browser.click', 'browser.screenshot']);
const BROWSER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_ALLOWED_ORIGINS = 32;

function localBrowserError(message, code = 'LOCAL_BROWSER_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.expose = true;
    return error;
}

function normalizeBrowserId(value) {
    const browserId = String(value || '').trim();
    return BROWSER_ID_RE.test(browserId) ? browserId : '';
}

function normalizeAllowedOrigins(value) {
    const candidates = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const origins = [];
    for (const raw of candidates) {
        if (origins.length >= MAX_ALLOWED_ORIGINS) break;
        try {
            const parsed = new URL(String(raw || '').trim());
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
            const origin = parsed.origin.toLowerCase();
            if (!origins.includes(origin)) origins.push(origin);
        } catch (_) {}
    }
    return origins;
}

function normalizeGrantedBrowsers(value) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const browsers = [];
    for (const item of source) {
        if (browsers.length >= 12 || !item || typeof item !== 'object') continue;
        const id = normalizeBrowserId(item.id);
        const engine = String(item.engine || '').trim().toLowerCase();
        const label = String(item.label || '').trim().replace(/[\r\n]/g, ' ').slice(0, 120);
        if (!id || !LOCAL_BROWSER_ENGINES.includes(engine) || !label || seen.has(id)) continue;
        seen.add(id);
        browsers.push({ id, label, engine });
    }
    return browsers;
}

function normalizeLocalBrowserGrant(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const browsers = normalizeGrantedBrowsers(source.browsers || source.metadata?.browsers);
    const allowedOrigins = normalizeAllowedOrigins(source.allowedOrigins || source.allowed_origins || source.metadata?.allowedOrigins);
    return { browsers, allowedOrigins };
}

function browserNetworkPolicy(grant = {}) {
    const normalized = normalizeLocalBrowserGrant(grant);
    const allowedPorts = new Set([80, 443, 8080]);
    normalized.allowedOrigins.forEach(origin => {
        try {
            const parsed = new URL(origin);
            allowedPorts.add(Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)));
        } catch (_) {}
    });
    return normalizeNetworkPolicy({
        allowed_origins: normalized.allowedOrigins,
        allowed_ports: [...allowedPorts],
        allow_redirect: false,
        allowed_redirect_origins: [],
        block_private_ranges: true,
        block_loopback: true,
        block_link_local: true,
        max_download_size_bytes: 10 * 1024 * 1024
    });
}

function normalizeTarget(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const target = {};
    for (const key of ['selector', 'role', 'name', 'text']) {
        const text = String(source[key] || '').trim();
        if (text) target[key] = text.slice(0, 500);
    }
    if (source.exact === true) target.exact = true;
    return target;
}

async function normalizeLocalBrowserTask(toolName, input = {}, grant = {}) {
    const name = String(toolName || '').trim();
    if (!LOCAL_BROWSER_TOOL_NAMES.includes(name)) {
        throw localBrowserError('不支持的本机浏览器工具。', 'LOCAL_BROWSER_TOOL_INVALID');
    }
    const normalizedGrant = normalizeLocalBrowserGrant(grant);
    if (!normalizedGrant.browsers.length) {
        throw localBrowserError('当前设备未授权任何本机浏览器。', 'LOCAL_BROWSER_GRANT_REQUIRED', 403);
    }
    if (!normalizedGrant.allowedOrigins.length) {
        throw localBrowserError('本机浏览器授权未配置允许访问的站点。', 'LOCAL_BROWSER_ORIGIN_REQUIRED', 409);
    }
    let browserId = normalizeBrowserId(input.browserId || input.browser_id);
    if (!browserId && normalizedGrant.browsers.length === 1) browserId = normalizedGrant.browsers[0].id;
    const browser = normalizedGrant.browsers.find(item => item.id === browserId);
    if (!browser) throw localBrowserError('所选浏览器不在当前设备的授权列表中。', 'LOCAL_BROWSER_NOT_AUTHORIZED', 403);
    const url = String(input.url || '').trim();
    if (!url || url.length > 2048) throw localBrowserError('本机浏览器任务缺少有效页面地址。', 'LOCAL_BROWSER_URL_INVALID');
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    } catch (_) {
        throw localBrowserError('浏览器页面地址必须是完整的 HTTP/HTTPS URL，例如 https://oa.example.internal/。', 'LOCAL_BROWSER_URL_INVALID');
    }
    const policy = browserNetworkPolicy(normalizedGrant);
    try {
        // 服务端只做 URL/Origin/端口契约校验；DNS 与地址安全必须由实际执行浏览器的桌面端
        // 在用户本机网络环境中复验，不能拿服务端的 DNS 结果误判仅本机可达的内网域名。
        validateNetworkPolicyUrl(url, policy, { requireAllowlist: true });
    } catch (error) {
        throw localBrowserError(error.message || '浏览器目标不在本机授权站点范围内。', 'LOCAL_BROWSER_ORIGIN_FORBIDDEN', 403);
    }
    const target = normalizeTarget(input.target);
    if (name === 'browser.click' && !Object.keys(target).length) {
        throw localBrowserError('点击操作必须指定目标元素。', 'LOCAL_BROWSER_TARGET_REQUIRED');
    }
    return {
        browserId: browser.id,
        browser: { id: browser.id, label: browser.label, engine: browser.engine },
        url,
        target,
        timeoutMs: Math.min(Math.max(Number.parseInt(input.timeoutMs || input.timeout_ms, 10) || 30000, 5000), 120000),
        policy
    };
}

function localBrowserToolDefinitions() {
    const common = {
        type: 'object',
        properties: {
            browserId: { type: 'string', description: '从当前设备已授权浏览器中选择的标识。' },
            url: { type: 'string', description: '必须位于该设备授权站点白名单中的 HTTP/HTTPS 页面。' },
            timeoutMs: { type: 'integer', minimum: 5000, maximum: 120000, default: 30000 }
        },
        required: ['url']
    };
    return [
        { name: 'browser.open', description: '在当前设备授权的隔离浏览器中打开页面，用户可在本机完成登录；不读取日常浏览器凭据。', inputSchema: common },
        { name: 'browser.inspect', description: '在当前设备授权的隔离浏览器中读取页面标题和受限正文文本。', inputSchema: common },
        { name: 'browser.click', description: '在当前设备授权的隔离浏览器中点击页面目标；桌面端会要求用户确认。', inputSchema: { ...common, properties: { ...common.properties, target: { type: 'object', description: '目标元素，支持 selector、role/name 或 text。' } }, required: ['url', 'target'] } },
        { name: 'browser.screenshot', description: '截取当前设备授权浏览器中的页面截图；桌面端会要求用户确认。', inputSchema: common }
    ];
}

function isLocalBrowserConnectorTool(toolName) {
    return LOCAL_BROWSER_TOOL_NAMES.includes(String(toolName || '').trim());
}

module.exports = {
    BROWSER_ID_RE,
    LOCAL_BROWSER_ENGINES,
    LOCAL_BROWSER_TOOL_NAMES,
    browserNetworkPolicy,
    isLocalBrowserConnectorTool,
    localBrowserError,
    localBrowserToolDefinitions,
    normalizeAllowedOrigins,
    normalizeBrowserId,
    normalizeGrantedBrowsers,
    normalizeLocalBrowserGrant,
    normalizeLocalBrowserTask
};
