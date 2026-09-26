'use strict';

const crypto = require('crypto');
const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { normalizeNetworkPolicy } = require('./agent-network-policy');
const {
    captureAgentScreenshot,
    clickBrowserTarget,
    closeAgentBrowserContext,
    createAgentBrowserContext,
    fillBrowserTarget,
    locateBrowserTarget,
    selectBrowserTarget,
    snapshotBrowserPage,
    waitForBrowserTarget
} = require('./agent-browser');

const MAX_BROWSER_TEXT_CHARS = 12000;
const MAX_BROWSER_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const BROWSER_SESSION_TTL_MS = Math.min(Math.max(Number.parseInt(process.env.AGENT_BROWSER_SESSION_TTL_MS || '1800000', 10) || 1800000, 60_000), 24 * 60 * 60 * 1000);
const liveSessions = new Map();

function registerLivePage(live, page) {
    if (!live?.tabs || !page) return '';
    for (const [id, candidate] of live.tabs) {
        if (candidate === page) return id;
    }
    const id = `tab_${++live.nextTabId}`;
    live.tabs.set(id, page);
    page.once?.('close', () => live.tabs.delete(id));
    return id;
}

function attachLiveTabs(live) {
    if (!live?.context) return live;
    if (!live.tabs) {
        live.tabs = new Map();
        live.nextTabId = 0;
        live.context.pages().forEach(page => registerLivePage(live, page));
        live.context.on('page', page => registerLivePage(live, page));
    }
    return live;
}

function listLiveTabs(live, activePage = null) {
    return [...(live?.tabs || new Map()).entries()]
        .filter(([, page]) => page && !page.isClosed?.())
        .map(([id, page]) => ({ id, active: page === activePage, url: page.url(), title: '' }));
}

function resolveLivePage(live, tabId = '') {
    attachLiveTabs(live);
    const requested = String(tabId || '').trim();
    if (requested) {
        const page = live.tabs.get(requested);
        if (!page || page.isClosed?.()) throw browserError('浏览器标签不存在、已关闭或不可访问。', 'AGENT_BROWSER_TAB_NOT_FOUND', 404);
        return { id: requested, page };
    }
    const page = live.page && !live.page.isClosed?.() ? live.page : [...live.tabs.values()].find(item => item && !item.isClosed?.());
    if (!page) throw browserError('浏览器会话没有可用页面。', 'AGENT_BROWSER_TAB_NOT_FOUND', 409);
    return { id: registerLivePage(live, page), page };
}

function sessionId() {
    return `browser_${crypto.randomUUID().replace(/-/g, '')}`;
}

function profileRoot() {
    return String(process.env.PIVOT_AGENT_BROWSER_SESSION_ROOT || '').trim() || undefined;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function browserError(message, code = 'AGENT_BROWSER_SESSION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = code.includes('FORBIDDEN') ? 'policy' : 'resource';
    return error;
}

function serializeSession(row = {}) {
    return {
        id: String(row.id || ''),
        runId: row.run_id || null,
        status: String(row.status || 'active'),
        currentUrl: String(row.current_url || ''),
        pageTitle: String(row.page_title || ''),
        revision: Number(row.revision || 0),
        lastAction: String(row.last_action || ''),
        expiresAt: row.expires_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        live: liveSessions.has(String(row.id || ''))
    };
}

function expiresAt() {
    return getBeijingTimestamp(new Date(Date.now() + BROWSER_SESSION_TTL_MS));
}

async function loadBrowserSession(id, user, { includeClosed = false } = {}) {
    const safeId = String(id || '').trim();
    if (!safeId || !user?.id) return null;
    const row = await queryOne(`
        SELECT * FROM agent_browser_sessions
        WHERE id = ? AND user_id = ?${includeClosed ? '' : " AND status = 'active'"}
    `, [safeId, user.id]);
    return row ? { ...row, network_policy: parseJson(row.network_policy, {}) } : null;
}

async function persistBrowserSession(id, user, patch = {}) {
    const allowed = {
        current_url: String(patch.currentUrl || patch.current_url || '').slice(0, 4000),
        page_title: String(patch.pageTitle || patch.page_title || '').slice(0, 500),
        last_action: String(patch.lastAction || patch.last_action || '').slice(0, 80),
        expires_at: patch.expiresAt || patch.expires_at || expiresAt(),
        status: String(patch.status || 'active').slice(0, 24)
    };
    const row = await queryOne(`
        UPDATE agent_browser_sessions
        SET current_url = ?, page_title = ?, last_action = ?, expires_at = ?, status = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
        RETURNING *
    `, [allowed.current_url, allowed.page_title, allowed.last_action, allowed.expires_at, allowed.status, getBeijingTimestamp(), id, user.id]);
    return row ? { ...row, network_policy: parseJson(row.network_policy, {}) } : null;
}

async function createLiveSession(row, user, options = {}) {
    const id = String(row.id);
    const existing = liveSessions.get(id);
    if (existing?.context && existing?.page && !existing.page.isClosed?.()) return attachLiveTabs(existing);
    const context = await createAgentBrowserContext({
        taskId: id,
        profileRoot: options.profileRoot || profileRoot(),
        networkPolicy: normalizeNetworkPolicy(row.network_policy || {}),
        executablePath: options.browserExecutablePath
    });
    const page = context.pages()[0] || await context.newPage();
    const live = attachLiveTabs({ context, page, userId: Number(user.id), runId: row.run_id || null });
    liveSessions.set(id, live);
    if (row.current_url) {
        await page.goto(row.current_url, { waitUntil: 'domcontentloaded', timeout: Math.min(Number(options.timeoutMs) || 60000, 180000) });
    }
    return live;
}

async function createAgentBrowserSession({ user, run = null, networkPolicy = {}, initialUrl = '', options = {} } = {}) {
    if (!user?.id) throw browserError('浏览器会话需要有效用户。', 'AGENT_BROWSER_SESSION_USER_REQUIRED', 401);
    const tenant = await assertTenantContext(user);
    const id = sessionId();
    const policy = normalizeNetworkPolicy(networkPolicy);
    const row = await queryOne(`
        INSERT INTO agent_browser_sessions (
            id, run_id, user_id, tenant_id, status, network_policy, current_url, page_title,
            revision, last_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, '', '', 0, 'created', ?, ?, ?)
        RETURNING *
    `, [id, run?.id || run?.run_id || null, user.id, tenant.tenantId, JSON.stringify(policy), expiresAt(), getBeijingTimestamp(), getBeijingTimestamp()]);
    let live;
    try {
        live = await createLiveSession({ ...row, network_policy: policy }, user, options);
        if (initialUrl) await live.page.goto(String(initialUrl), { waitUntil: 'domcontentloaded', timeout: Math.min(Number(options.timeoutMs) || 60000, 180000) });
        const persisted = await persistBrowserSession(id, user, {
            currentUrl: live.page.url(), pageTitle: await live.page.title(), lastAction: initialUrl ? 'navigate' : 'created'
        });
        return { session: serializeSession(persisted), live };
    } catch (error) {
        liveSessions.delete(id);
        try { await closeAgentBrowserContext(live?.context); } catch (_) {}
        await execute("UPDATE agent_browser_sessions SET status = 'error', last_action = 'startup_failed', updated_at = ? WHERE id = ?", [getBeijingTimestamp(), id]);
        throw error;
    }
}

async function closeAgentBrowserSession(id, user, { reason = 'closed' } = {}) {
    const row = await loadBrowserSession(id, user, { includeClosed: true });
    if (!row) return null;
    const live = liveSessions.get(String(id));
    liveSessions.delete(String(id));
    try { await closeAgentBrowserContext(live?.context); } catch (_) {}
    const persisted = await persistBrowserSession(id, user, {
        currentUrl: live?.page?.url?.() || row.current_url,
        pageTitle: row.page_title,
        lastAction: reason,
        status: 'closed',
        expiresAt: getBeijingTimestamp()
    });
    return persisted ? serializeSession(persisted) : null;
}

async function executeAgentBrowserSessionAction({ sessionId: requestedSessionId, user, run = null, input = {}, context = {} } = {}) {
    let session = requestedSessionId ? await loadBrowserSession(requestedSessionId, user) : null;
    let created = false;
    if (!session) {
        if (requestedSessionId) throw browserError('浏览器会话不存在、已关闭或无权访问。', 'AGENT_BROWSER_SESSION_NOT_FOUND', 404);
        const createdSession = await createAgentBrowserSession({
            user,
            run,
            networkPolicy: context.run?.network_policy || context.run?.networkPolicy || input.networkPolicy || input.network_policy || {},
            initialUrl: input.url || '',
            options: context
        });
        session = await loadBrowserSession(createdSession.session.id, user);
        created = true;
    }
    const live = await createLiveSession(session, user, context);
    const action = String(input.action || 'inspect').trim().toLowerCase();
    const url = String(input.url || '').trim();
    const createTab = input.newTab === true || input.new_tab === true || action === 'new_tab';
    let active = resolveLivePage(live, input.tabId || input.tab_id || '');
    if (createTab) {
        active = { id: registerLivePage(live, await live.context.newPage()), page: null };
        active.page = live.tabs.get(active.id);
    }
    const page = active.page;
    if (['navigate', 'open', 'new_tab'].includes(action) || (url && url !== session.current_url && created !== true)) {
        if (!url) throw browserError('浏览器导航需要 URL。', 'AGENT_BROWSER_URL_REQUIRED');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(Number(input.timeoutMs) || 60000, 180000) });
    }
    if (action === 'close') return { action: 'close', session: await closeAgentBrowserSession(session.id, user) };
    if (action === 'close_tab') {
        await page.close({ runBeforeUnload: false });
        const remaining = listLiveTabs(live);
        if (!remaining.length) return { action, session: await closeAgentBrowserSession(session.id, user), tabs: [] };
        live.page = live.tabs.get(remaining[0].id);
        const persisted = await persistBrowserSession(session.id, user, {
            currentUrl: live.page.url(), pageTitle: await live.page.title(), lastAction: action
        });
        return { action, session: serializeSession(persisted), tabs: listLiveTabs(live, live.page) };
    }
    let target = null;
    let snapshot = null;
    if (action === 'click') target = await clickBrowserTarget(page, input.target || {}, { visionLocator: context.visionLocator });
    else if (action === 'fill') target = await fillBrowserTarget(page, input.target || {}, input.value, { visionLocator: context.visionLocator });
    else if (action === 'select') target = await selectBrowserTarget(page, input.target || {}, input.value, { visionLocator: context.visionLocator });
    else if (action === 'scroll') {
        const deltaX = Math.max(-5000, Math.min(Number(input.deltaX ?? input.delta_x) || 0, 5000));
        const deltaY = Math.max(-5000, Math.min(Number(input.deltaY ?? input.delta_y) || 800, 5000));
        await page.mouse.wheel(deltaX, deltaY);
        target = { method: 'mouse', deltaX, deltaY };
    } else if (action === 'wait') {
        target = await waitForBrowserTarget(page, input.target || {}, {
            timeoutMs: input.timeoutMs || input.timeout_ms,
            state: input.waitState || input.wait_state,
            visionLocator: context.visionLocator
        });
    } else if (action === 'snapshot') {
        snapshot = await snapshotBrowserPage(page, { limit: input.limit });
    }
    else if (input.target) {
        const found = await locateBrowserTarget(page, input.target, { visionLocator: context.visionLocator });
        target = { method: found.method };
    }
    live.page = page;
    const currentUrl = page.url();
    const pageTitle = await page.title();
    const output = {
        action,
        sessionId: session.id,
        tabId: active.id,
        url: currentUrl,
        title: pageTitle,
        target,
        text: String(await page.locator('body').innerText()).slice(0, MAX_BROWSER_TEXT_CHARS),
        tabs: listLiveTabs(live, page)
    };
    if (snapshot) output.snapshot = snapshot;
    if (input.screenshot === true || action === 'screenshot') {
        const screenshot = await captureAgentScreenshot(page, { fullPage: input.fullPage === true });
        if (screenshot.length > MAX_BROWSER_SCREENSHOT_BYTES) throw browserError('浏览器截图超过安全上限，未回传。', 'AGENT_BROWSER_SCREENSHOT_TOO_LARGE', 413);
        output.screenshot = screenshot.toString('base64');
    }
    const persisted = await persistBrowserSession(session.id, user, { currentUrl, pageTitle, lastAction: action });
    output.session = serializeSession(persisted);
    return output;
}

async function sweepExpiredAgentBrowserSessions() {
    const rows = await queryOne(`
        WITH expired AS (
            UPDATE agent_browser_sessions
            SET status = 'expired', last_action = 'expired', updated_at = ?
            WHERE status = 'active' AND expires_at <= ?
            RETURNING id
        ) SELECT COUNT(*) AS count FROM expired
    `, [getBeijingTimestamp(), getBeijingTimestamp()]);
    for (const [id, live] of liveSessions) {
        const row = await queryOne('SELECT status FROM agent_browser_sessions WHERE id = ?', [id]);
        if (row?.status === 'active') continue;
        liveSessions.delete(id);
        try { await closeAgentBrowserContext(live.context); } catch (_) {}
    }
    return Number(rows?.count || 0);
}

module.exports = {
    closeAgentBrowserSession,
    createAgentBrowserSession,
    executeAgentBrowserSessionAction,
    loadBrowserSession,
    serializeSession,
    sweepExpiredAgentBrowserSessions
};
