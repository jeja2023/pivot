'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { normalizeNetworkPolicy } = require('./agent-network-policy');
const { getRenditionForUser, openRenditionContent } = require('./agent-artifact-renditions');
const { createBrowserSessionLeaseStore, DEFAULT_BROWSER_LEASE_MS } = require('./agent-browser-session-leases');
const { removeClosedBrowserProfile } = require('./agent-browser-profile-cleanup');
const { captureBrowserVisualObservation, compareBrowserVisualObservations, observeBrowserPage, recordBrowserActionEvidence, serializeBrowserActionEvidence } = require('./agent-browser-action-evidence');
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
const BROWSER_MUTATION_ACTIONS = new Set(['click', 'fill', 'select', 'download', 'upload']);
const liveSessions = new Map();
const activeSessionActions = new Set();
const browserOwnerId = crypto.randomUUID();
const browserLeases = createBrowserSessionLeaseStore();

function leaseInput(id, user, token = '') {
    return { sessionId: String(id), userId: user?.id, ownerId: browserOwnerId, token, leaseMs: DEFAULT_BROWSER_LEASE_MS };
}

function beginSessionAction(id) {
    const key = String(id || '');
    if (!key) return () => {};
    if (activeSessionActions.has(key)) throw browserError('浏览器会话正在执行其他操作，请稍后重试。', 'AGENT_BROWSER_SESSION_BUSY', 409);
    activeSessionActions.add(key);
    return () => activeSessionActions.delete(key);
}

function stopLeaseHeartbeat(live) {
    if (live?.leaseHeartbeat) clearInterval(live.leaseHeartbeat);
    if (live) live.leaseHeartbeat = null;
}

function startLeaseHeartbeat(id, user, live) {
    let renewing = false;
    live.leaseHeartbeat = setInterval(async () => {
        if (renewing || live.leaseLost) return;
        renewing = true;
        try {
            if (!await browserLeases.renewBrowserSessionLease({ ...leaseInput(id, user, live.leaseToken), recovery: live.recovering === true || live.closing === true })) throw new Error('浏览器会话租约已失效。');
        } catch (_) {
            live.leaseLost = true;
            stopLeaseHeartbeat(live);
            if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
            if (live.context) live.closePromise = Promise.resolve(closeAgentBrowserContext(live.context)).catch(() => {});
        } finally {
            renewing = false;
        }
    }, Math.max(1000, Math.floor(DEFAULT_BROWSER_LEASE_MS / 4)));
    live.leaseHeartbeat.unref?.();
}

async function assertLiveLease(id, user, live) {
    let renewed = false;
    try {
        renewed = Boolean(live?.leaseToken && !live.leaseLost && await browserLeases.renewBrowserSessionLease({ ...leaseInput(id, user, live.leaseToken), recovery: live.recovering === true }));
    } catch (_) {}
    if (!renewed) {
        if (live) live.leaseLost = true;
        stopLeaseHeartbeat(live);
        if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
        if (live?.context) live.closePromise = Promise.resolve(closeAgentBrowserContext(live.context)).catch(() => {});
        throw browserError('浏览器会话执行权已失效，请重新检查会话。', 'AGENT_BROWSER_LEASE_LOST', 409);
    }
}

function attachLeaseCloseHandler(id, user, live) {
    live.context?.once?.('close', () => {
        if (live.closing === true) return;
        stopLeaseHeartbeat(live);
        if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
        browserLeases.finishBrowserSessionOwner(leaseInput(id, user, live.leaseToken)).catch(() => {});
    });
}

function leaseAcquisitionError(result) {
    if (result?.reason === 'lease_lost') return browserError('浏览器会话执行权已失效，请重新检查会话。', 'AGENT_BROWSER_LEASE_LOST', 409);
    return result?.reason === 'recovery_required'
        ? browserError('浏览器在写操作后失去运行态，请由用户确认并重新观察。', 'AGENT_BROWSER_RECOVERY_REQUIRED', 409)
        : browserError('浏览器会话正在其他执行器中使用，请稍后重试。', 'AGENT_BROWSER_SESSION_BUSY', 409);
}

async function closeLiveContextWithDeadline(live) {
    if (!live?.context) return;
    let timer;
    const closing = Promise.resolve().then(() => closeAgentBrowserContext(live.context));
    live.closePromise = closing.catch(() => {});
    try {
        await Promise.race([closing, new Promise((_, reject) => {
            timer = setTimeout(() => reject(browserError('浏览器关闭超时，需要人工核对。', 'AGENT_BROWSER_CLOSE_UNCERTAIN', 409)), 5000);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

function text(value, max = 500) { return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }

function browserDownloadDirectory(sessionId, root = '') {
    const base = path.resolve(root || profileRoot(), 'browser-downloads');
    const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
    return path.resolve(base, safeId || 'session');
}

async function collectBrowserDownload(download, sessionId, policy, root = '') {
    const directory = browserDownloadDirectory(sessionId, root);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const fileName = text(download.suggestedFilename?.() || 'download', 180).replace(/[\\/:*?"<>|]+/g, '_') || 'download';
    const temporary = path.resolve(directory, `${crypto.randomUUID()}.download`);
    try {
        await download.saveAs(temporary);
        const stat = await fs.promises.stat(temporary);
        const maxBytes = Math.max(1, Number(policy.max_download_size_bytes) || 0);
        if (!stat.isFile() || stat.size > maxBytes) throw browserError('浏览器下载超过受控大小上限，已丢弃。', 'AGENT_BROWSER_DOWNLOAD_TOO_LARGE', 413);
        const content = await fs.promises.readFile(temporary);
        return { fileName, bytes: content.length, digest: crypto.createHash('sha256').update(content).digest('hex'), retained: false };
    } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        await fs.promises.rmdir(directory).catch(() => {});
    }
}

async function triggerControlledBrowserDownload(live, page, input, sessionId, policy, options = {}) {
    const found = await locateBrowserTarget(page, input.target || {}, { visionLocator: null });
    if (found.method !== 'dom') throw browserError('浏览器下载只能使用可验证的 DOM 目标。', 'AGENT_BROWSER_DOM_TARGET_REQUIRED', 409);
    const timeoutMs = Math.min(Math.max(Number(input.timeoutMs || input.timeout_ms) || 30000, 1000), 60000);
    live.downloadPage = page;
    try {
        const pending = page.waitForEvent('download', { timeout: timeoutMs });
        await found.locator.click();
        const download = await pending;
        return { method: 'dom', download: await collectBrowserDownload(download, sessionId, policy, options.profileRoot) };
    } catch (error) {
        if (error?.name === 'TimeoutError') throw browserError('浏览器下载在受控等待时间内未开始。', 'AGENT_BROWSER_DOWNLOAD_TIMEOUT', 504);
        throw error;
    } finally {
        live.downloadPage = null;
    }
}

function browserUploadFileName(rendition) {
    const id = String(rendition?.id || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'rendition';
    const extension = String(rendition?.format || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'bin';
    return `artifact-${id}.${extension}`;
}

async function readBrowserUploadContent(stream, maxBytes, expectedBytes) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > maxBytes) throw browserError('浏览器上传产物超过受控大小上限。', 'AGENT_BROWSER_UPLOAD_TOO_LARGE', 413);
            chunks.push(buffer);
        }
    } finally {
        stream?.destroy?.();
    }
    if (total !== expectedBytes) throw browserError('浏览器上传产物大小与登记值不一致。', 'AGENT_BROWSER_UPLOAD_SIZE_MISMATCH', 409);
    return Buffer.concat(chunks, total);
}

async function loadControlledBrowserUpload(input, user, policy, options = {}) {
    const renditionId = String(input.renditionId || input.rendition_id || '').trim();
    if (!renditionId || renditionId.length > 128) throw browserError('浏览器上传必须指定已登记的 renditionId。', 'AGENT_BROWSER_RENDITION_REQUIRED', 400);
    const lookup = options.getRenditionForUser || getRenditionForUser;
    const open = options.openRenditionContent || openRenditionContent;
    const rendition = await lookup(renditionId, user);
    if (!rendition) throw browserError('上传产物不存在或无权访问。', 'AGENT_BROWSER_RENDITION_NOT_FOUND', 404);
    if (rendition.status !== 'ready') throw browserError('上传产物尚未就绪。', 'AGENT_BROWSER_RENDITION_NOT_READY', 409);
    const expectedBytes = Math.max(0, Number(rendition.byte_size) || 0);
    const maxBytes = Math.max(1, Number(policy.max_upload_size_bytes) || 0);
    if (!expectedBytes || expectedBytes > maxBytes) throw browserError('浏览器上传产物超过受控大小上限。', 'AGENT_BROWSER_UPLOAD_TOO_LARGE', 413);
    const buffer = await readBrowserUploadContent(await open(rendition, user), maxBytes, expectedBytes);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== String(rendition.content_digest || '').toLowerCase()) {
        throw browserError('浏览器上传产物摘要与登记值不一致。', 'AGENT_BROWSER_UPLOAD_DIGEST_MISMATCH', 409);
    }
    const mimeType = text(rendition.mime_type || 'application/octet-stream', 160) || 'application/octet-stream';
    return {
        buffer,
        renditionId: String(rendition.id),
        fileName: browserUploadFileName(rendition),
        mimeType,
        bytes: buffer.length,
        digest
    };
}

async function triggerControlledBrowserUpload(page, input, user, policy, options = {}) {
    const found = await locateBrowserTarget(page, input.target || {}, { visionLocator: null });
    if (found.method !== 'dom') throw browserError('浏览器上传只能使用可验证的 DOM 文件控件。', 'AGENT_BROWSER_DOM_TARGET_REQUIRED', 409);
    const descriptor = await found.locator.evaluate(element => ({
        tagName: String(element?.tagName || '').toLowerCase(),
        type: String(element?.getAttribute?.('type') || '').toLowerCase(),
        disabled: Boolean(element?.disabled)
    }));
    if (descriptor.tagName !== 'input' || descriptor.type !== 'file' || descriptor.disabled) {
        throw browserError('浏览器上传目标必须是可用的 input[type=file]。', 'AGENT_BROWSER_UPLOAD_TARGET_INVALID', 409);
    }
    const upload = await loadControlledBrowserUpload(input, user, policy, options);
    await found.locator.setInputFiles({ name: upload.fileName, mimeType: upload.mimeType, buffer: upload.buffer });
    return { method: 'dom', upload: { renditionId: upload.renditionId, fileName: upload.fileName, bytes: upload.bytes, digest: upload.digest } };
}

function redactConsoleMessage(value) {
    return text(value, 1000)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ig, 'Bearer [已脱敏]')
        .replace(/\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/ig, match => match.replace(/([:=]).*$/, '$1 [已脱敏]'))
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已脱敏 JWT]')
        .slice(0, 500);
}

function recordConsoleSummary(live, kind, message) {
    if (!live) return;
    const item = { kind: text(kind, 40) || 'error', message: redactConsoleMessage(message) };
    if (!item.message) return;
    const items = Array.isArray(live.consoleSummary) ? live.consoleSummary : [];
    if (!items.some(entry => entry.kind === item.kind && entry.message === item.message)) items.push(item);
    live.consoleSummary = items.slice(-20);
}

function attachConsoleObserver(live, page) {
    if (!page || page.__pivotConsoleObserved) return;
    Object.defineProperty(page, '__pivotConsoleObserved', { value: true, configurable: true });
    page.on?.('console', message => {
        if (['error', 'warning'].includes(message.type?.())) recordConsoleSummary(live, message.type(), message.text?.());
    });
    page.on?.('pageerror', error => recordConsoleSummary(live, 'pageerror', error?.message));
}

function registerLivePage(live, page) {
    if (!live?.tabs || !page) return '';
    for (const [id, candidate] of live.tabs) {
        if (candidate === page) return id;
    }
    const id = `tab_${++live.nextTabId}`;
    live.tabs.set(id, page);
    attachConsoleObserver(live, page);
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
        mutationPendingRecovery: row.mutation_pending_recovery === true,
        consoleSummary: Array.isArray(parseJson(row.console_summary, [])) ? parseJson(row.console_summary, []) : [],
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
    const expectedStatus = patch.expectedStatus || (String(patch.status || 'active') === 'active' ? 'active' : null);
    const allowed = {
        current_url: String(patch.currentUrl || patch.current_url || '').slice(0, 4000),
        page_title: String(patch.pageTitle || patch.page_title || '').slice(0, 500),
        last_action: String(patch.lastAction || patch.last_action || '').slice(0, 80),
        expires_at: patch.expiresAt || patch.expires_at || expiresAt(),
        status: String(patch.status || 'active').slice(0, 24),
        mutation_pending_recovery: typeof patch.mutationPendingRecovery === 'boolean' ? patch.mutationPendingRecovery : null,
        console_summary: Array.isArray(patch.consoleSummary || patch.console_summary) ? (patch.consoleSummary || patch.console_summary).slice(-20) : []
    };
    const row = await browserLeases.withBrowserSessionLease(leaseInput(id, user, patch.leaseToken), async trx => await trx.queryOne(`
        UPDATE agent_browser_sessions
        SET current_url = ?, page_title = ?, last_action = ?, expires_at = ?, status = ?, console_summary = ?::jsonb,
            mutation_pending_recovery = COALESCE(?, mutation_pending_recovery),
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND (?::text IS NULL OR status = ?)
        RETURNING *
    `, [allowed.current_url, allowed.page_title, allowed.last_action, allowed.expires_at, allowed.status, JSON.stringify(allowed.console_summary), allowed.mutation_pending_recovery, getBeijingTimestamp(), id, user.id, expectedStatus, expectedStatus]));
    if (!row) throw browserError('浏览器会话状态已变化，请重新检查后再操作。', 'AGENT_BROWSER_SESSION_STATE_CONFLICT', 409);
    return { ...row, network_policy: parseJson(row.network_policy, {}) };
}

async function createLiveSession(row, user, options = {}) {
    const id = String(row.id);
    const existing = liveSessions.get(id);
    if (existing?.context && existing?.page && !existing.page.isClosed?.()) {
        await assertLiveLease(id, user, existing);
        return attachLiveTabs(existing);
    }
    if (existing) {
        stopLeaseHeartbeat(existing);
        liveSessions.delete(id);
        await browserLeases.releaseBrowserSessionLease(leaseInput(id, user, existing.leaseToken)).catch(() => {});
    }
    const lease = await browserLeases.acquireBrowserSessionLease(leaseInput(id, user));
    if (!lease.acquired) throw leaseAcquisitionError(lease);
    const live = { context: null, page: null, leaseToken: lease.token, leaseLost: false, userId: Number(user.id), runId: row.run_id || null, profileRoot: options.profileRoot || profileRoot(),
        consoleSummary: Array.isArray(parseJson(row.console_summary, [])) ? parseJson(row.console_summary, []) : [] };
    startLeaseHeartbeat(id, user, live);
    try {
        live.context = await createAgentBrowserContext({
            taskId: id, profileRoot: options.profileRoot || profileRoot(),
            networkPolicy: normalizeNetworkPolicy(row.network_policy || {}), executablePath: options.browserExecutablePath,
            acceptDownloads: true, isDownloadAllowed: page => live.downloadPage === page
        });
        attachLeaseCloseHandler(id, user, live);
        await assertLiveLease(id, user, live);
        live.page = live.context.pages()[0] || await live.context.newPage();
        attachLiveTabs(live);
        liveSessions.set(id, live);
        if (row.current_url) await live.page.goto(row.current_url, { waitUntil: 'domcontentloaded', timeout: Math.min(Number(options.timeoutMs) || 60000, 180000) });
        await assertLiveLease(id, user, live);
        return live;
    } catch (error) {
        stopLeaseHeartbeat(live);
        if (liveSessions.get(id) === live) liveSessions.delete(id);
        try { await closeAgentBrowserContext(live.context); } catch (_) {}
        await browserLeases.releaseBrowserSessionLease(leaseInput(id, user, live.leaseToken)).catch(() => {});
        throw error;
    }
}

async function createAgentBrowserSession({ user, run = null, networkPolicy = {}, initialUrl = '', options = {} } = {}) {
    if (!user?.id) throw browserError('浏览器会话需要有效用户。', 'AGENT_BROWSER_SESSION_USER_REQUIRED', 401);
    const tenant = await assertTenantContext(user);
    const id = sessionId();
    const rawPolicy = typeof networkPolicy === 'string' ? parseJson(networkPolicy, null) : networkPolicy;
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
        throw browserError('当前任务网络策略无效，不能创建浏览器会话。', 'AGENT_BROWSER_POLICY_INVALID', 409);
    }
    const policy = normalizeNetworkPolicy(rawPolicy);
    const row = await queryOne(`
        INSERT INTO agent_browser_sessions (
            id, run_id, user_id, tenant_id, status, network_policy, current_url, page_title,
            revision, last_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, '', '', 0, 'created', ?, ?, ?)
        RETURNING *
    `, [id, run?.id || run?.run_id || null, user.id, tenant.tenantId, JSON.stringify(policy), expiresAt(), getBeijingTimestamp(), getBeijingTimestamp()]);
    let live;
    const finishAction = beginSessionAction(id);
    try {
        live = await createLiveSession({ ...row, network_policy: policy }, user, options);
        if (initialUrl) await live.page.goto(String(initialUrl), { waitUntil: 'domcontentloaded', timeout: Math.min(Number(options.timeoutMs) || 60000, 180000) });
        const persisted = await persistBrowserSession(id, user, {
            currentUrl: live.page.url(), pageTitle: await live.page.title(), lastAction: initialUrl ? 'navigate' : 'created', leaseToken: live.leaseToken, consoleSummary: live.consoleSummary || []
        });
        return { session: serializeSession(persisted), live };
    } catch (error) {
        stopLeaseHeartbeat(live);
        if (liveSessions.get(id) === live) liveSessions.delete(id);
        try { await closeAgentBrowserContext(live?.context); } catch (_) {}
        if (live?.leaseToken) await browserLeases.releaseBrowserSessionLease(leaseInput(id, user, live.leaseToken)).catch(() => {});
        await execute(`UPDATE agent_browser_sessions SET status = 'error', last_action = 'startup_failed', updated_at = ?
            WHERE id = ? AND status = 'active' AND NOT EXISTS (
                SELECT 1 FROM agent_browser_session_leases l WHERE l.session_id = ? AND l.lease_expires_at > NOW()
            )`, [getBeijingTimestamp(), id, id]);
        throw error;
    } finally {
        finishAction();
    }
}

async function closeAgentBrowserSession(id, user, { reason = 'closed', fromAction = false } = {}) {
    const finishAction = fromAction ? () => {} : beginSessionAction(id);
    try {
        const row = await loadBrowserSession(id, user, { includeClosed: true });
        if (!row) return null;
        if (row.status === 'closed') return serializeSession(row);
        const live = liveSessions.get(String(id));
        const outcome = await browserLeases.closeBrowserSessionWithLease({ ...leaseInput(id, user, live?.leaseToken), reason });
        if (!outcome.closed && !outcome.pending) throw leaseAcquisitionError(outcome);
        if (outcome.pending) {
            live.closing = true;
            if (!live.leaseHeartbeat) startLeaseHeartbeat(id, user, live);
            try {
                await closeLiveContextWithDeadline(live);
                // 仅在确认关闭且持有租约时删除配置目录。
                await browserLeases.withBrowserSessionLease(leaseInput(id, user, live.leaseToken), async () => {
                    await removeClosedBrowserProfile(String(id), live.profileRoot).catch(() => {});
                });
                const persisted = await browserLeases.completeBrowserSessionClose({ ...leaseInput(id, user, live.leaseToken), reason });
                stopLeaseHeartbeat(live);
                if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
                return serializeSession(persisted);
            } catch (_) {
                live.closing = false;
                stopLeaseHeartbeat(live);
                if (live.page?.isClosed?.()) {
                    if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
                    await browserLeases.finishBrowserSessionOwner(leaseInput(id, user, live.leaseToken)).catch(() => {});
                }
                throw browserError('浏览器未能确认关闭，需先核对旧执行器和外部状态。', 'AGENT_BROWSER_CLOSE_UNCERTAIN', 409);
            }
        }
        stopLeaseHeartbeat(live);
        if (liveSessions.get(String(id)) === live) liveSessions.delete(String(id));
        return serializeSession(outcome.session);
    } finally {
        finishAction();
    }
}

async function listAgentBrowserSessionsForRun(runId, user, { limit = 20, includeClosed = false } = {}) {
    if (!runId || !user?.id) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = await query(`
        SELECT * FROM agent_browser_sessions
        WHERE run_id = ? AND user_id = ?${includeClosed ? '' : " AND status <> 'closed'"}
        ORDER BY updated_at DESC LIMIT ?
    `, [String(runId), user.id, safeLimit]);
    return rows.map(row => serializeSession(row));
}

/**
 * 仅由面向用户的恢复入口调用。Agent 工具不能传入此确认，因此不会在写操作
 * 崩溃后自行按历史 URL 续跑；用户确认后系统只恢复到“观察”状态，不重放操作。
 */
async function recoverAgentBrowserSession(id, user, { confirmed = false, options = {} } = {}) {
    if (confirmed !== true) throw browserError('必须由用户明确确认后才能重新观察浏览器会话。', 'AGENT_BROWSER_RECOVERY_CONFIRMATION_REQUIRED', 409);
    const finishAction = beginSessionAction(id);
    try {
        const session = await loadBrowserSession(id, user, { includeClosed: true });
        if (!session) throw browserError('浏览器会话不存在或无权恢复。', 'AGENT_BROWSER_SESSION_NOT_FOUND', 404);
        if (String(session.status) !== 'needs_user_recovery') {
            throw browserError('当前浏览器会话不处于待人工恢复状态。', 'AGENT_BROWSER_RECOVERY_STATE_INVALID', 409);
        }
        const url = String(session.current_url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw browserError('待恢复会话没有可重新观察的 HTTP/HTTPS 页面。', 'AGENT_BROWSER_RECOVERY_URL_INVALID', 409);
        const existing = liveSessions.get(String(session.id));
        if (existing) {
            stopLeaseHeartbeat(existing);
            liveSessions.delete(String(session.id));
            if (existing.page && !existing.page.isClosed?.()) {
                try { await closeAgentBrowserContext(existing.context); } catch (_) {}
            }
            await browserLeases.releaseBrowserSessionLease(leaseInput(id, user, existing.leaseToken)).catch(() => {});
        }
        const lease = await browserLeases.acquireBrowserSessionLease({ ...leaseInput(id, user), recovery: true, confirmed: true });
        if (!lease.acquired) throw leaseAcquisitionError(lease);
        const live = { context: null, page: null, leaseToken: lease.token, leaseLost: false, recovering: true, userId: Number(user.id), runId: session.run_id || null, profileRoot: options.profileRoot || profileRoot(),
            consoleSummary: Array.isArray(parseJson(session.console_summary, [])) ? parseJson(session.console_summary, []) : [] };
        startLeaseHeartbeat(id, user, live);
        try {
            live.context = await createAgentBrowserContext({ taskId: String(session.id), profileRoot: options.profileRoot || profileRoot(),
                networkPolicy: normalizeNetworkPolicy(session.network_policy || {}), executablePath: options.browserExecutablePath,
                acceptDownloads: true, isDownloadAllowed: page => live.downloadPage === page });
            attachLeaseCloseHandler(id, user, live);
            await assertLiveLease(id, user, live);
            live.page = live.context.pages()[0] || await live.context.newPage();
            attachLiveTabs(live);
            liveSessions.set(String(session.id), live);
            await live.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(Number(options.timeoutMs) || 60000, 180000) });
            const observation = await observeBrowserPage(live.page);
            const persisted = await persistBrowserSession(session.id, user, {
                currentUrl: live.page.url(), pageTitle: await live.page.title(), lastAction: 'user_recovered_observe', status: 'active',
                expectedStatus: 'needs_user_recovery', mutationPendingRecovery: false, leaseToken: live.leaseToken, consoleSummary: live.consoleSummary || []
            });
            live.recovering = false;
            return { session: serializeSession(persisted), observation, tabs: listLiveTabs(live, live.page) };
        } catch (error) {
            stopLeaseHeartbeat(live);
            if (liveSessions.get(String(session.id)) === live) liveSessions.delete(String(session.id));
            try { await closeAgentBrowserContext(live.context); } catch (_) {}
            await browserLeases.releaseBrowserSessionLease(leaseInput(id, user, live.leaseToken)).catch(() => {});
            throw error;
        }
    } finally {
        finishAction();
    }
}

async function executeAgentBrowserSessionActionUnlocked({ sessionId: requestedSessionId, user, run = null, input = {}, context = {} } = {}) {
    let session = requestedSessionId ? await loadBrowserSession(requestedSessionId, user) : null;
    let created = false;
    if (session && requestedSessionId) {
        const currentRun = run || context.run || null;
        const currentRunId = String(currentRun?.id || currentRun?.run_id || '');
        if (String(session.run_id || '') !== currentRunId) {
            throw browserError('浏览器会话属于其他任务，请为当前任务创建新会话。', 'AGENT_BROWSER_RUN_MISMATCH', 403);
        }
        const currentPolicy = currentRun?.network_policy ?? currentRun?.networkPolicy ?? context.run?.network_policy ?? context.run?.networkPolicy;
        if (currentPolicy !== undefined && currentPolicy !== null) {
            const rawPolicy = typeof currentPolicy === 'string' ? parseJson(currentPolicy, null) : currentPolicy;
            if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
                throw browserError('当前任务网络策略无效，不能复用浏览器会话。', 'AGENT_BROWSER_POLICY_INVALID', 409);
            }
            const policyFingerprint = value => {
                const policy = normalizeNetworkPolicy(value);
                return JSON.stringify({
                    enabled: policy.enabled !== false,
                    origins: [...policy.allowed_origins].sort(), ports: [...policy.allowed_ports].sort((a, b) => a - b),
                    redirects: [...policy.allowed_redirect_origins].sort(), allowRedirect: policy.allow_redirect,
                    privateRanges: policy.block_private_ranges, loopback: policy.block_loopback, linkLocal: policy.block_link_local,
                    maxDownload: policy.max_download_size_bytes, maxUpload: policy.max_upload_size_bytes
                });
            };
            if (policyFingerprint(rawPolicy) !== policyFingerprint(session.network_policy)) {
                throw browserError('任务网络策略已变化，请创建新的浏览器会话。', 'AGENT_BROWSER_POLICY_CHANGED', 409);
            }
        }
    }
    if (!session) {
        if (requestedSessionId) {
            const previous = await loadBrowserSession(requestedSessionId, user, { includeClosed: true });
            if (previous?.status === 'needs_user_recovery') throw leaseAcquisitionError({ reason: 'recovery_required' });
            throw browserError('浏览器会话不存在、已关闭或无权访问。', 'AGENT_BROWSER_SESSION_NOT_FOUND', 404);
        }
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
    if (action === 'close') return { action: 'close', session: await closeAgentBrowserSession(session.id, user, { fromAction: true }) };
    if (action === 'close_tab') {
        await page.close({ runBeforeUnload: false });
        const remaining = listLiveTabs(live);
        if (!remaining.length) return { action, session: await closeAgentBrowserSession(session.id, user, { fromAction: true }), tabs: [] };
        live.page = live.tabs.get(remaining[0].id);
        const persisted = await persistBrowserSession(session.id, user, {
            currentUrl: live.page.url(), pageTitle: await live.page.title(), lastAction: action, leaseToken: live.leaseToken
        });
        return { action, session: serializeSession(persisted), tabs: listLiveTabs(live, live.page) };
    }
    let target = null;
    let snapshot = null;
    const requiresEvidence = BROWSER_MUTATION_ACTIONS.has(action);
    if (requiresEvidence) {
        const marked = await browserLeases.markBrowserMutationWithLease(leaseInput(session.id, user, live.leaseToken));
        if (!marked) throw browserError('浏览器会话执行权已失效或状态已变化，不能执行写操作。', 'AGENT_BROWSER_LEASE_LOST', 409);
    }
    const beforeState = requiresEvidence ? await observeBrowserPage(page) : null;
    const beforeVisual = requiresEvidence ? await captureBrowserVisualObservation(page).catch(() => null) : null;
    if (requiresEvidence) await assertLiveLease(session.id, user, live);
    if (action === 'click') target = await clickBrowserTarget(page, input.target || {}, { visionLocator: context.visionLocator });
    else if (action === 'fill') target = await fillBrowserTarget(page, input.target || {}, input.value, { visionLocator: context.visionLocator });
    else if (action === 'select') target = await selectBrowserTarget(page, input.target || {}, input.value, { visionLocator: context.visionLocator });
    else if (action === 'download') target = await triggerControlledBrowserDownload(live, page, input, session.id, normalizeNetworkPolicy(session.network_policy || {}), context);
    else if (action === 'upload') target = await triggerControlledBrowserUpload(page, input, user, normalizeNetworkPolicy(session.network_policy || {}), context);
    else if (action === 'scroll') {
        const deltaX = Math.max(-5000, Math.min(Number(input.deltaX ?? input.delta_x) || 0, 5000));
        const rawDeltaY = input.deltaY ?? input.delta_y;
        const deltaY = Math.max(-5000, Math.min(rawDeltaY == null ? 800 : Number(rawDeltaY) || 0, 5000));
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
    const persisted = await persistBrowserSession(session.id, user, { currentUrl, pageTitle, lastAction: action, leaseToken: live.leaseToken, consoleSummary: live.consoleSummary || [] });
    output.session = serializeSession(persisted);
    if (beforeState) {
        try {
            const afterState = await observeBrowserPage(page);
            const afterVisual = await captureBrowserVisualObservation(page).catch(() => null);
            const visualDiff = compareBrowserVisualObservations(beforeVisual, afterVisual);
            if (beforeVisual) beforeState.visualDigest = beforeVisual.digest;
            if (afterVisual) afterState.visualDigest = afterVisual.digest;
            const evidence = await recordBrowserActionEvidence({
                sessionId: session.id, runId: run?.id || run?.run_id || null, transactionId: context.taskTransactionId || context.task_transaction_id || null,
                user, action, tabId: active.id, beforeState, afterState,
                outcome: { method: target?.method || '', target: input.target || {}, valueChars: action === 'fill' ? String(input.value ?? '').length : 0, visualDiff, download: target?.download || null, upload: target?.upload || null }
            });
            if (evidence) output.actionEvidence = serializeBrowserActionEvidence(evidence);
        } catch (_) {
            // 外部页面动作已经生效，审计存储故障不能把它伪装为“没有发生”。
            output.actionEvidence = { status: 'audit_unavailable' };
        }
    }
    return output;
}

async function executeAgentBrowserSessionAction(args = {}) {
    const finishAction = beginSessionAction(args.sessionId);
    try {
        return await executeAgentBrowserSessionActionUnlocked(args);
    } finally {
        finishAction();
    }
}

async function sweepExpiredAgentBrowserSessions() {
    const rows = await queryOne(`
        WITH expired AS (
            UPDATE agent_browser_sessions
            SET status = CASE WHEN mutation_pending_recovery THEN 'needs_user_recovery' ELSE 'expired' END,
                last_action = CASE WHEN mutation_pending_recovery THEN 'crash_recovery_required' ELSE 'expired' END, updated_at = ?
            WHERE status = 'active' AND expires_at <= ?
            RETURNING status
        ) SELECT COUNT(*) FILTER (WHERE status = 'expired') AS count FROM expired
    `, [getBeijingTimestamp(), getBeijingTimestamp()]);
    const abandoned = await query(`
        SELECT s.id, s.user_id FROM agent_browser_sessions s
        WHERE s.status = 'active' AND s.mutation_pending_recovery = TRUE
          AND NOT EXISTS (
              SELECT 1 FROM agent_browser_session_leases l WHERE l.session_id = s.id AND l.lease_expires_at > NOW()
          )
        ORDER BY s.updated_at ASC LIMIT 100
    `);
    for (const session of abandoned) {
        await browserLeases.markAbandonedBrowserSession(leaseInput(session.id, { id: session.user_id }));
    }
    for (const [id, live] of liveSessions) {
        if (activeSessionActions.has(id)) continue;
        const row = await queryOne('SELECT status FROM agent_browser_sessions WHERE id = ?', [id]);
        if (row?.status === 'active') continue;
        liveSessions.delete(id);
        stopLeaseHeartbeat(live);
        try {
            await closeAgentBrowserContext(live.context);
            if (!live.leaseLost) await browserLeases.withBrowserSessionLease(leaseInput(id, { id: live.userId }, live.leaseToken), async () => {
                await removeClosedBrowserProfile(id, live.profileRoot).catch(() => {});
            });
        } catch (_) {}
        await browserLeases.releaseBrowserSessionLease(leaseInput(id, { id: live.userId }, live.leaseToken)).catch(() => {});
    }
    return Number(rows?.count || 0);
}

module.exports = {
    closeAgentBrowserSession,
    createAgentBrowserSession,
    executeAgentBrowserSessionAction,
    listAgentBrowserSessionsForRun,
    loadBrowserSession,
    redactConsoleMessage,
    recoverAgentBrowserSession,
    serializeSession,
    sweepExpiredAgentBrowserSessions
};
