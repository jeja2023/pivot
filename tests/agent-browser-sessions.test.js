'use strict';
/* global document, window */

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { promisify } = require('node:util');
const { execute, queryOne } = require('../server/db/client');
const {
    closeAgentBrowserSession,
    createAgentBrowserSession,
    executeAgentBrowserSessionAction,
    loadBrowserSession,
    redactConsoleMessage,
    recoverAgentBrowserSession,
    sweepExpiredAgentBrowserSessions
} = require('../server/services/agent-browser-sessions');
const { isAgentBrowserRuntimeAvailable } = require('../server/services/agent-browser');
const execFileAsync = promisify(execFile);

function startFixture() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Session fixture</title></head><body><label>备注<input id="note" type="text" aria-label="备注"></label><label>类别<select id="kind" aria-label="类别"><option value="daily">日报</option><option value="weekly">周报</option></select></label><input id="secret" type="password"><button id="run">Run</button><p id="result">ready</p><script>console.error("fixture-console-error");document.querySelector("#run").onclick=()=>document.querySelector("#result").textContent="clicked";</script></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function startPendingMutationFixture() {
    let count = 0;
    let notifyRequest;
    const received = new Promise(resolve => { notifyRequest = resolve; });
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/write') {
            count += 1;
            req.resume();
            req.on('end', notifyRequest);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><form method="post" action="/write"><button id="submit" type="submit">提交</button></form></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, received, count: () => count })));
}

function startDownloadFixture() {
    const content = Buffer.from('受控浏览器下载内容，不应作为页面正文或本机路径返回。', 'utf8');
    const server = http.createServer((req, res) => {
        if (req.url === '/download') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="report.txt"', 'content-length': String(content.length) });
            return res.end(content);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><a id="download" href="/download" download>下载报告</a></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, content })));
}

function startUploadFixture() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><label>上传产物<input id="upload" type="file"></label><output id="result">等待上传</output><script>document.querySelector("#upload").addEventListener("change", event => { const file = event.target.files[0]; document.querySelector("#result").textContent = file ? `${file.name}:${file.size}` : "无文件"; });</script></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function browserTestStep(label, operation, timeoutMs = 15000) {
    if (process.env.PIVOT_BROWSER_TEST_DEBUG === 'true') process.stderr.write(`浏览器测试阶段：${label}\n`);
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`浏览器测试阶段超时：${label}`)), timeoutMs); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test('browser sessions preserve an authorized page across sequential Agent actions', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const run = { id: `browser-session-${suffix}`, user_id: user.id };
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-sessions-'));
    const fixture = await startFixture();
    let sessionId = '';
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        await execute(`
            INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
            VALUES (?, ?, 'browser session', 'browser session', 'running', '{}', NOW(), NOW())
        `, [run.id, user.id]);
        const policy = {
            allowed_origins: [fixture.url],
            allowed_ports: [Number(new URL(fixture.url).port)],
            block_private_ranges: false,
            block_loopback: false,
            block_link_local: false
        };
        const created = await browserTestStep('创建会话', () => createAgentBrowserSession({ user, run, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } }));
        sessionId = created.session.id;
        assert.equal(created.session.status, 'active');
        assert.equal(JSON.stringify(created.session).includes(created.live.leaseToken), false);
        const worker = path.join(__dirname, 'helpers', 'agent-browser-session-action-worker.js');
        const { stdout } = await execFileAsync(process.execPath, [worker, sessionId, String(user.id), profileRoot], {
            cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, timeout: 20000
        });
        const workerResult = stdout.match(/RESULT:(\{[^\r\n]+\})/);
        assert.ok(workerResult);
        assert.equal(JSON.parse(workerResult[1]).code, 'AGENT_BROWSER_SESSION_BUSY');
        const foreignClose = await execFileAsync(process.execPath, [worker, sessionId, String(user.id), profileRoot, 'close'], {
            cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, timeout: 20000
        });
        const closeResult = foreignClose.stdout.match(/RESULT:(\{[^\r\n]+\})/);
        assert.ok(closeResult);
        assert.equal(JSON.parse(closeResult[1]).code, 'AGENT_BROWSER_SESSION_BUSY');
        assert.equal((await queryOne('SELECT status FROM agent_browser_sessions WHERE id = ?', [sessionId])).status, 'active');
        const inspected = await browserTestStep('首次观察', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id,
            user,
            run,
            input: { action: 'inspect' },
            context: { profileRoot }
        }));
        assert.match(inspected.text, /ready/);
        const originalWait = created.live.page.waitForTimeout;
        let markWaiting;
        let releaseWaiting;
        const reachedWait = new Promise(resolve => { markWaiting = resolve; });
        const waitGate = new Promise(resolve => { releaseWaiting = resolve; });
        created.live.page.waitForTimeout = async () => { markWaiting(); await waitGate; };
        try {
            const staleRead = browserTestStep('并发状态保护', () => executeAgentBrowserSessionAction({
                sessionId: created.session.id, user, run, input: { action: 'wait', timeoutMs: 500 }, context: { profileRoot }
            }));
            await browserTestStep('等待只读操作', () => reachedWait);
            await assert.rejects(() => executeAgentBrowserSessionAction({ sessionId, user, run, input: { action: 'inspect' }, context: { profileRoot } }), error => error.code === 'AGENT_BROWSER_SESSION_BUSY');
            await assert.rejects(() => closeAgentBrowserSession(sessionId, user), error => error.code === 'AGENT_BROWSER_SESSION_BUSY');
            await execute("UPDATE agent_browser_sessions SET status = 'needs_user_recovery', mutation_pending_recovery = TRUE WHERE id = ?", [created.session.id]);
            releaseWaiting();
            await assert.rejects(() => staleRead, error => error.code === 'AGENT_BROWSER_SESSION_STATE_CONFLICT');
            const guarded = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [created.session.id]);
            assert.equal(guarded.status, 'needs_user_recovery');
            assert.equal(guarded.mutation_pending_recovery, true);
        } finally {
            releaseWaiting();
            created.live.page.waitForTimeout = originalWait;
            // 仅复位隔离测试夹具，后续使用真实确认恢复路径验证屏障清除。
            await execute("UPDATE agent_browser_sessions SET status = 'active', mutation_pending_recovery = FALSE WHERE id = ?", [created.session.id]);
        }
        assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '故障注入只能在隔离测试 schema 中运行。');
        await execute(`CREATE FUNCTION pivot_test_block_browser_mutation() RETURNS trigger AS $$
            BEGIN
                IF NEW.last_action = 'mutation_intent' THEN RAISE EXCEPTION '测试写入屏障失败'; END IF;
                RETURN NEW;
            END;
        $$ LANGUAGE plpgsql`);
        try {
            await execute('CREATE TRIGGER pivot_test_browser_mutation BEFORE UPDATE ON agent_browser_sessions FOR EACH ROW EXECUTE FUNCTION pivot_test_block_browser_mutation()');
            await assert.rejects(() => browserTestStep('写入屏障失败拒绝操作', () => executeAgentBrowserSessionAction({
                sessionId: created.session.id, user, run,
                input: { action: 'click', target: { selector: '#run' } }, context: { profileRoot }
            })), /测试写入屏障失败/);
            assert.equal(await created.live.page.locator('#result').innerText(), 'ready');
        } finally {
            await execute('DROP TRIGGER IF EXISTS pivot_test_browser_mutation ON agent_browser_sessions');
            await execute('DROP FUNCTION IF EXISTS pivot_test_block_browser_mutation()');
        }
        const clicked = await browserTestStep('点击', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id,
            user,
            run,
            input: { action: 'click', target: { selector: '#run' } },
            context: { profileRoot }
        }));
        assert.equal(clicked.target.method, 'dom');
        assert.match(clicked.text, /clicked/);
        assert.equal(clicked.session.mutationPendingRecovery, true);
        assert.equal(clicked.session.consoleSummary.some(item => item.message === 'fixture-console-error'), true);
        const filled = await browserTestStep('填写', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run,
            input: { action: 'fill', target: { selector: '#note' }, value: '请核对数据来源' }, context: { profileRoot }
        }));
        assert.equal(filled.target.chars, 7);
        const selected = await browserTestStep('选择', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run,
            input: { action: 'select', target: { selector: '#kind' }, value: 'weekly' }, context: { profileRoot }
        }));
        assert.deepEqual(selected.target.selected, ['weekly']);
        const snapshot = await browserTestStep('快照', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'snapshot' }, context: { profileRoot }
        }));
        assert.ok(snapshot.snapshot.controls.some(item => item.text === '备注'));
        assert.ok(!snapshot.snapshot.controls.some(item => item.type === 'password'));
        assert.equal(snapshot.session.mutationPendingRecovery, true);
        await assert.rejects(
            () => browserTestStep('凭证字段拒绝', () => executeAgentBrowserSessionAction({
                sessionId: created.session.id, user, run,
                input: { action: 'fill', target: { selector: '#secret' }, value: 'not-a-password' }, context: { profileRoot }
            })),
            error => error.code === 'AGENT_BROWSER_CREDENTIAL_ACCESS_DENIED'
        );
        const opened = await browserTestStep('新标签', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'new_tab', url: fixture.url }, context: { profileRoot }
        }));
        assert.equal(opened.tabs.length, 2);
        const switched = await browserTestStep('切换标签', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'switch_tab', tabId: clicked.tabId }, context: { profileRoot }
        }));
        assert.equal(switched.tabId, clicked.tabId);
        assert.equal(switched.session.mutationPendingRecovery, true);
        assert.ok(clicked.session.revision >= 2);
        await browserTestStep('关闭旧上下文', () => created.live.context.close());
        await assert.rejects(
            () => browserTestStep('写后崩溃保护', () => executeAgentBrowserSessionAction({
                sessionId: created.session.id, user, run, input: { action: 'inspect' }, context: { profileRoot }
            })),
            error => error.code === 'AGENT_BROWSER_RECOVERY_REQUIRED'
        );
        const recovery = await queryOne('SELECT status, last_action FROM agent_browser_sessions WHERE id = ?', [created.session.id]);
        assert.equal(recovery.status, 'needs_user_recovery');
        assert.equal(recovery.last_action, 'crash_recovery_required');
        await assert.rejects(
            () => recoverAgentBrowserSession(created.session.id, user, { confirmed: false, options: { profileRoot } }),
            error => error.code === 'AGENT_BROWSER_RECOVERY_CONFIRMATION_REQUIRED'
        );
        await execute(`CREATE FUNCTION pivot_test_block_browser_recovery() RETURNS trigger AS $$
            BEGIN
                IF NEW.last_action = 'user_recovered_observe' THEN RAISE EXCEPTION '测试恢复状态写入失败'; END IF;
                RETURN NEW;
            END;
        $$ LANGUAGE plpgsql`);
        try {
            await execute('CREATE TRIGGER pivot_test_browser_recovery BEFORE UPDATE ON agent_browser_sessions FOR EACH ROW EXECUTE FUNCTION pivot_test_block_browser_recovery()');
            await assert.rejects(() => browserTestStep('恢复落盘失败', () => recoverAgentBrowserSession(created.session.id, user, { confirmed: true, options: { profileRoot, timeoutMs: 5000 } })), /测试恢复状态写入失败/);
            const failedRecovery = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [created.session.id]);
            assert.equal(failedRecovery.status, 'needs_user_recovery');
            assert.equal(failedRecovery.mutation_pending_recovery, true);
        } finally {
            await execute('DROP TRIGGER IF EXISTS pivot_test_browser_recovery ON agent_browser_sessions');
            await execute('DROP FUNCTION IF EXISTS pivot_test_block_browser_recovery()');
        }
        const userRecovered = await browserTestStep('人工观察恢复', () => recoverAgentBrowserSession(created.session.id, user, { confirmed: true, options: { profileRoot, timeoutMs: 5000 } }));
        assert.equal(userRecovered.session.status, 'active');
        assert.equal(userRecovered.session.lastAction, 'user_recovered_observe');
        assert.equal(userRecovered.session.mutationPendingRecovery, false);
        assert.match(userRecovered.observation.url, /127\.0\.0\.1/);
        const reobserved = await browserTestStep('恢复后观察', () => executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'inspect' }, context: { profileRoot }
        }));
        assert.match(reobserved.text, /ready/);
        const closed = await browserTestStep('关闭会话', () => closeAgentBrowserSession(created.session.id, user));
        assert.equal(closed.status, 'closed');
        assert.equal(await loadBrowserSession(created.session.id, user), null);
    } finally {
        if (sessionId) await browserTestStep('清理浏览器', () => closeAgentBrowserSession(sessionId, user), 5000).catch(() => {});
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
        fixture.server.closeAllConnections();
        await new Promise(resolve => fixture.server.close(resolve));
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
        fs.rmSync(profileRoot, { recursive: true, force: true });
    }
});

test('受控浏览器下载只留下摘要证据并立即清理会话隔离临时文件', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const run = { id: `browser-download-${suffix}`, user_id: user.id };
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-download-'));
    const fixture = await startDownloadFixture();
    let sessionId = '';
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'browser download', 'browser download', 'running', '{}', NOW(), NOW())", [run.id, user.id]);
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false, max_download_size_bytes: fixture.content.length + 64 };
        const created = await createAgentBrowserSession({ user, run, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } });
        sessionId = created.session.id;
        await executeAgentBrowserSessionAction({ sessionId, user, run, input: { action: 'click', target: { selector: '#download' } }, context: { profileRoot } });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(path.join(profileRoot, 'browser-downloads', sessionId)), false, '普通 click 触发的下载必须被浏览器守卫取消');
        const downloaded = await browserTestStep('受控下载', () => executeAgentBrowserSessionAction({ sessionId, user, run, input: { action: 'download', target: { selector: '#download' } }, context: { profileRoot } }));
        assert.equal(downloaded.target.method, 'dom');
        assert.equal(downloaded.target.download.fileName, 'report.txt');
        assert.equal(downloaded.target.download.bytes, fixture.content.length);
        assert.match(downloaded.target.download.digest, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(downloaded.target.download, 'path'), false);
        assert.equal(JSON.stringify(downloaded).includes(profileRoot), false);
        assert.equal(fs.existsSync(path.join(profileRoot, 'browser-downloads', sessionId)), false);
        assert.equal(downloaded.actionEvidence.outcome.download.digest, downloaded.target.download.digest);
    } finally {
        if (sessionId) await closeAgentBrowserSession(sessionId, user).catch(() => {});
        await new Promise(resolve => fixture.server.close(resolve));
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
        await fs.promises.rm(profileRoot, { recursive: true, force: true });
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
    }
});

test('受控浏览器上传只接受已登记 rendition，并且不暴露正文或本地路径', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const run = { id: `browser-upload-${suffix}`, user_id: user.id };
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-upload-'));
    const fixture = await startUploadFixture();
    const payload = Buffer.from('registered-rendition-only-content', 'utf8');
    const digest = require('node:crypto').createHash('sha256').update(payload).digest('hex');
    let sessionId = '';
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'browser upload', 'browser upload', 'running', '{}', NOW(), NOW())", [run.id, user.id]);
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false, max_upload_size_bytes: payload.length + 64 };
        const created = await createAgentBrowserSession({ user, run, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } });
        sessionId = created.session.id;
        const uploaded = await browserTestStep('受控上传', () => executeAgentBrowserSessionAction({
            sessionId,
            user,
            run,
            input: {
                action: 'upload',
                target: { selector: '#upload' },
                renditionId: 'registered-rendition-1',
                path: 'C:\\untrusted\\host-file.txt',
                fileName: 'untrusted-name.txt',
                content: payload.toString('base64')
            },
            context: {
                profileRoot,
                getRenditionForUser: async (renditionId, requestingUser) => {
                    assert.equal(renditionId, 'registered-rendition-1');
                    assert.equal(requestingUser.id, user.id);
                    return { id: renditionId, status: 'ready', format: 'txt', mime_type: 'text/plain', byte_size: payload.length, content_digest: digest };
                },
                openRenditionContent: async rendition => {
                    assert.equal(rendition.id, 'registered-rendition-1');
                    return Readable.from([payload]);
                }
            }
        }));
        assert.equal(uploaded.target.method, 'dom');
        assert.equal(uploaded.target.upload.renditionId, 'registered-rendition-1');
        assert.equal(uploaded.target.upload.fileName, 'artifact-registered-rendition-1.txt');
        assert.equal(uploaded.target.upload.bytes, payload.length);
        assert.equal(uploaded.target.upload.digest, digest);
        assert.match(uploaded.text, /artifact-registered-rendition-1\.txt/);
        const serialized = JSON.stringify(uploaded);
        assert.equal(serialized.includes('C:\\untrusted\\host-file.txt'), false);
        assert.equal(serialized.includes(payload.toString('utf8')), false);
        assert.equal(serialized.includes(payload.toString('base64')), false);
        assert.equal(uploaded.actionEvidence.outcome.upload.digest, digest);
        assert.equal(Object.hasOwn(uploaded.actionEvidence.outcome.upload, 'path'), false);
    } finally {
        if (sessionId) await closeAgentBrowserSession(sessionId, user).catch(() => {});
        await new Promise(resolve => fixture.server.close(resolve));
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
        await fs.promises.rm(profileRoot, { recursive: true, force: true });
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
    }
});

test('a browser close failure keeps the session available for manual recovery', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-close-'));
    let created;
    try {
        created = await browserTestStep('创建待关闭会话', () => createAgentBrowserSession({ user, options: { profileRoot } }));
        const originalClose = created.live.context.close;
        created.live.context.close = async () => { throw new Error('模拟浏览器关闭失败'); };
        try {
            await assert.rejects(() => closeAgentBrowserSession(created.session.id, user), error => error.code === 'AGENT_BROWSER_CLOSE_UNCERTAIN');
            const state = await queryOne('SELECT status, mutation_pending_recovery, last_action FROM agent_browser_sessions WHERE id = ?', [created.session.id]);
            assert.equal(state.status, 'needs_user_recovery');
            assert.equal(state.mutation_pending_recovery, true);
            assert.equal(state.last_action, 'close_pending');
        } finally {
            created.live.context.close = originalClose;
        }
        const closed = await browserTestStep('再次确认关闭', () => closeAgentBrowserSession(created.session.id, user));
        assert.equal(closed.status, 'closed');
    } finally {
        if (created?.session?.id) {
            await browserTestStep('清理关闭失败测试', () => closeAgentBrowserSession(created.session.id, user), 5000).catch(() => {});
            await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [created.session.id]);
        }
        fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('browser console summary redacts secret-shaped values before persistence', () => {
    assert.equal(redactConsoleMessage('token=abc123456789 password: hidden-value'), 'token= [已脱敏] password: [已脱敏]');
    assert.equal(redactConsoleMessage('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [已脱敏] [已脱敏]');
});

test('a persisted mutation intent requires explicit recovery even without action evidence', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `browser-intent-${suffix}`;
    const sessionId = `browser_intent_${suffix}`;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '浏览器写入边界', '验证写入屏障', 'running', '{}', NOW(), NOW())", [runId, user.id]);
        await execute(`INSERT INTO agent_browser_sessions (id, run_id, user_id, tenant_id, status, network_policy, current_url, last_action, mutation_pending_recovery, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, 1, 'active', '{}', 'https://example.invalid/', 'mutation_intent', TRUE, NOW() + INTERVAL '1 hour', NOW(), NOW())`, [sessionId, runId, user.id]);
        await assert.rejects(() => executeAgentBrowserSessionAction({ sessionId, user, input: { action: 'inspect' } }), error => error.code === 'AGENT_BROWSER_RECOVERY_REQUIRED');
        const stored = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [sessionId]);
        assert.equal(stored.status, 'needs_user_recovery');
        assert.equal(stored.mutation_pending_recovery, true);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [sessionId]);
    }
});

test('a browser action cannot use an old lease after another process takes ownership', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `browser-fence-${process.pid}-${Date.now()}`;
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-fence-'));
    const fixture = await startFixture();
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let sessionId = '';
    let clicks = 0;
    let ownedLive = null;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '浏览器租约测试', '测试旧令牌拒绝写入', 'running', '{}', NOW(), NOW())", [runId, user.id]);
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        const created = await browserTestStep('创建隔离会话', () => createAgentBrowserSession({ user, run: { id: runId, user_id: user.id }, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } }));
        sessionId = created.session.id;
        ownedLive = created.live;
        await created.live.page.exposeFunction('pivotTestClick', () => { clicks += 1; });
        await created.live.page.evaluate(() => { document.querySelector('#run').addEventListener('click', () => window.pivotTestClick()); });
        await execute("UPDATE agent_browser_session_leases SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = ?", [sessionId]);
        const worker = path.join(__dirname, 'helpers', 'agent-browser-lease-worker.js');
        const { stdout } = await execFileAsync(process.execPath, [worker, sessionId, String(user.id), 'replacement-worker'], {
            cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, timeout: 20000
        });
        const result = stdout.match(/RESULT:(\{[^\r\n]+\})/);
        assert.ok(result);
        assert.equal(JSON.parse(result[1]).acquired, true);
        await assert.rejects(() => executeAgentBrowserSessionAction({ sessionId, user, input: { action: 'click', target: { selector: '#run' } }, context: { profileRoot } }), error => error.code === 'AGENT_BROWSER_LEASE_LOST');
        assert.equal(clicks, 0);
    } finally {
        if (ownedLive?.closePromise) await browserTestStep('等待失效浏览器关闭', () => ownedLive.closePromise, 10000).catch(() => {});
        else if (ownedLive?.context) await browserTestStep('清理失效浏览器上下文', () => ownedLive.context.close(), 10000).catch(() => {});
        if (sessionId) {
            await execute('DELETE FROM agent_browser_session_leases WHERE session_id = ?', [sessionId]);
            await browserTestStep('清理失效租约会话', () => closeAgentBrowserSession(sessionId, user), 5000).catch(() => {});
        }
        fixture.server.closeAllConnections();
        await new Promise(resolve => fixture.server.close(resolve));
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
        fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('lease loss after the mutation barrier prevents the pending click', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `browser-preclick-${process.pid}-${Date.now()}`;
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-preclick-'));
    const fixture = await startFixture();
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let sessionId = '';
    let ownedLive = null;
    let releaseScreenshot = () => {};
    let clicks = 0;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '浏览器动作边界', '测试动作前租约失效', 'running', '{}', NOW(), NOW())", [runId, user.id]);
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        const created = await browserTestStep('创建动作边界会话', () => createAgentBrowserSession({ user, run: { id: runId, user_id: user.id }, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } }));
        sessionId = created.session.id;
        ownedLive = created.live;
        await ownedLive.page.exposeFunction('pivotTestClick', () => { clicks += 1; });
        await ownedLive.page.evaluate(() => { document.querySelector('#run').addEventListener('click', () => window.pivotTestClick()); });
        const originalScreenshot = ownedLive.page.screenshot.bind(ownedLive.page);
        let reachedScreenshot;
        const reached = new Promise(resolve => { reachedScreenshot = resolve; });
        const screenshotGate = new Promise(resolve => { releaseScreenshot = resolve; });
        ownedLive.page.screenshot = async (...args) => { reachedScreenshot(); await screenshotGate; return await originalScreenshot(...args); };
        const pending = browserTestStep('等待动作前观察', () => executeAgentBrowserSessionAction({ sessionId, user, input: { action: 'click', target: { selector: '#run' } }, context: { profileRoot } }));
        pending.catch(() => {});
        await browserTestStep('等待屏障后的截图', () => reached);
        assert.equal((await queryOne('SELECT mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [sessionId])).mutation_pending_recovery, true);
        await execute("UPDATE agent_browser_session_leases SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = ?", [sessionId]);
        const worker = path.join(__dirname, 'helpers', 'agent-browser-lease-worker.js');
        const { stdout } = await execFileAsync(process.execPath, [worker, sessionId, String(user.id), 'replacement-after-barrier'], {
            cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, timeout: 20000
        });
        const result = stdout.match(/RESULT:(\{[^\r\n]+\})/);
        assert.ok(result);
        assert.equal(JSON.parse(result[1]).reason, 'recovery_required');
        releaseScreenshot();
        await assert.rejects(() => pending, error => error.code === 'AGENT_BROWSER_LEASE_LOST');
        assert.equal(clicks, 0);
        const state = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [sessionId]);
        assert.equal(state.status, 'needs_user_recovery');
        assert.equal(state.mutation_pending_recovery, true);
    } finally {
        releaseScreenshot();
        if (ownedLive?.closePromise) await browserTestStep('等待动作边界会话关闭', () => ownedLive.closePromise, 10000).catch(() => {});
        else if (ownedLive?.context) await browserTestStep('关闭动作边界会话', () => ownedLive.context.close(), 10000).catch(() => {});
        fixture.server.closeAllConnections();
        await new Promise(resolve => fixture.server.close(resolve));
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        if (sessionId) await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [sessionId]);
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
        fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('an external write received before context failure is not automatically replayed', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `browser-inflight-${process.pid}-${Date.now()}`;
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-inflight-'));
    const fixture = await startPendingMutationFixture();
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let sessionId = '';
    let live = null;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '浏览器中断测试', '验证外部写入不重放', 'running', '{}', NOW(), NOW())", [runId, user.id]);
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        const created = await browserTestStep('创建外部写入测试会话', () => createAgentBrowserSession({ user, run: { id: runId, user_id: user.id }, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } }));
        sessionId = created.session.id;
        live = created.live;
        let settled = false;
        const pending = browserTestStep('派发外部写入', () => executeAgentBrowserSessionAction({ sessionId, user, input: { action: 'click', target: { selector: '#submit' } }, context: { profileRoot } }));
        pending.then(() => { settled = true; }, () => { settled = true; });
        await browserTestStep('等待外部服务接收写入', () => fixture.received);
        assert.equal(settled, false);
        assert.equal(fixture.count(), 1);
        assert.equal((await queryOne('SELECT mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [sessionId])).mutation_pending_recovery, true);
        await browserTestStep('中断浏览器上下文', () => live.context.close());
        await assert.rejects(() => pending);
        await assert.rejects(() => executeAgentBrowserSessionAction({ sessionId, user, input: { action: 'inspect' }, context: { profileRoot } }), error => error.code === 'AGENT_BROWSER_RECOVERY_REQUIRED');
        assert.equal(fixture.count(), 1);
        assert.equal((await queryOne('SELECT status FROM agent_browser_sessions WHERE id = ?', [sessionId])).status, 'needs_user_recovery');
    } finally {
        if (live?.context) await browserTestStep('清理中断上下文', () => live.context.close(), 10000).catch(() => {});
        fixture.server.closeAllConnections();
        await new Promise(resolve => fixture.server.close(resolve));
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        if (sessionId) await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [sessionId]);
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
        fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('migration conservatively restores barriers for active legacy sessions with earlier writes', async () => {
    assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '迁移回填测试只能在隔离测试 schema 中运行。');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const active = `browser_legacy_active_${suffix}`;
    const closed = `browser_legacy_closed_${suffix}`;
    try {
        await execute(`INSERT INTO agent_browser_sessions (id, user_id, tenant_id, status, network_policy, last_action, mutation_pending_recovery, expires_at, created_at, updated_at)
            VALUES (?, ?, 1, 'active', '{}', 'snapshot', FALSE, NOW() + INTERVAL '1 hour', NOW(), NOW()),
                   (?, ?, 1, 'closed', '{}', 'click', FALSE, NOW(), NOW(), NOW())`, [active, user.id, closed, user.id]);
        await execute("INSERT INTO agent_browser_action_evidence (session_id, user_id, action) VALUES (?, ?, 'click')", [active, user.id]);
        const migration = require('../server/db/migrations/agent-browser-mutation-barrier')[0];
        await migration.upPg(require('../server/db/pg-connection').getPgPool());
        assert.equal((await queryOne('SELECT mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [active])).mutation_pending_recovery, true);
        assert.equal((await queryOne('SELECT mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [closed])).mutation_pending_recovery, false);
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id IN (?, ?)', [active, closed]);
    }
});

test('expired browser sessions are closed by the runtime sweep', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-expired`;
    const runId = `browser-expired-${suffix}`;
    try {
        await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'browser expired', 'browser expired', 'running', '{}', NOW(), NOW())`, [runId, user.id]);
        await execute(`INSERT INTO agent_browser_sessions (id, run_id, user_id, tenant_id, status, network_policy, expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', '{}', NOW() - INTERVAL '1 second', NOW(), NOW())`, [`browser_expired_${suffix}`, runId, user.id]);
        assert.equal(await sweepExpiredAgentBrowserSessions(), 1);
        const row = await queryOne('SELECT status FROM agent_browser_sessions WHERE id = ?', [`browser_expired_${suffix}`]);
        assert.equal(row.status, 'expired');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('sweep exposes abandoned or expired mutation sessions for manual recovery', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const abandoned = `browser_abandoned_${suffix}`;
    const expired = `browser_expired_mutation_${suffix}`;
    try {
        await execute(`INSERT INTO agent_browser_sessions (id, user_id, tenant_id, status, network_policy, mutation_pending_recovery, expires_at, created_at, updated_at)
            VALUES (?, ?, 1, 'active', '{}', TRUE, NOW() + INTERVAL '1 hour', NOW(), NOW()),
                   (?, ?, 1, 'active', '{}', TRUE, NOW() - INTERVAL '1 second', NOW(), NOW())`, [abandoned, user.id, expired, user.id]);
        await sweepExpiredAgentBrowserSessions();
        for (const id of [abandoned, expired]) {
            const row = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [id]);
            assert.equal(row.status, 'needs_user_recovery');
            assert.equal(row.mutation_pending_recovery, true);
        }
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id IN (?, ?)', [abandoned, expired]);
    }
});
