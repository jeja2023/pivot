'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    closeAgentBrowserSession,
    createAgentBrowserSession,
    executeAgentBrowserSessionAction,
    loadBrowserSession,
    sweepExpiredAgentBrowserSessions
} = require('../server/services/agent-browser-sessions');
const { isAgentBrowserRuntimeAvailable } = require('../server/services/agent-browser');

function startFixture() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Session fixture</title></head><body><label>备注<input id="note" type="text" aria-label="备注"></label><label>类别<select id="kind" aria-label="类别"><option value="daily">日报</option><option value="weekly">周报</option></select></label><input id="secret" type="password"><button id="run">Run</button><p id="result">ready</p><script>document.querySelector("#run").onclick=()=>document.querySelector("#result").textContent="clicked";</script></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('browser sessions preserve an authorized page across sequential Agent actions', { skip: !isAgentBrowserRuntimeAvailable() && '未检测到可用 Chromium' }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const run = { id: `browser-session-${suffix}`, user_id: user.id };
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-sessions-'));
    const fixture = await startFixture();
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
        const created = await createAgentBrowserSession({ user, run, networkPolicy: policy, initialUrl: fixture.url, options: { profileRoot } });
        assert.equal(created.session.status, 'active');
        const inspected = await executeAgentBrowserSessionAction({
            sessionId: created.session.id,
            user,
            run,
            input: { action: 'inspect' },
            context: { profileRoot }
        });
        assert.match(inspected.text, /ready/);
        const clicked = await executeAgentBrowserSessionAction({
            sessionId: created.session.id,
            user,
            run,
            input: { action: 'click', target: { selector: '#run' } },
            context: { profileRoot }
        });
        assert.equal(clicked.target.method, 'dom');
        assert.match(clicked.text, /clicked/);
        const filled = await executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run,
            input: { action: 'fill', target: { selector: '#note' }, value: '请核对数据来源' }, context: { profileRoot }
        });
        assert.equal(filled.target.chars, 7);
        const selected = await executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run,
            input: { action: 'select', target: { selector: '#kind' }, value: 'weekly' }, context: { profileRoot }
        });
        assert.deepEqual(selected.target.selected, ['weekly']);
        const snapshot = await executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'snapshot' }, context: { profileRoot }
        });
        assert.ok(snapshot.snapshot.controls.some(item => item.text === '备注'));
        assert.ok(!snapshot.snapshot.controls.some(item => item.type === 'password'));
        await assert.rejects(
            () => executeAgentBrowserSessionAction({
                sessionId: created.session.id, user, run,
                input: { action: 'fill', target: { selector: '#secret' }, value: 'not-a-password' }, context: { profileRoot }
            }),
            error => error.code === 'AGENT_BROWSER_CREDENTIAL_ACCESS_DENIED'
        );
        const opened = await executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'new_tab', url: fixture.url }, context: { profileRoot }
        });
        assert.equal(opened.tabs.length, 2);
        const switched = await executeAgentBrowserSessionAction({
            sessionId: created.session.id, user, run, input: { action: 'switch_tab', tabId: clicked.tabId }, context: { profileRoot }
        });
        assert.equal(switched.tabId, clicked.tabId);
        assert.ok(clicked.session.revision >= 2);
        const closed = await closeAgentBrowserSession(created.session.id, user);
        assert.equal(closed.status, 'closed');
        assert.equal(await loadBrowserSession(created.session.id, user), null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
        await new Promise(resolve => fixture.server.close(resolve));
        if (previousSensitiveOutbound === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound;
        fs.rmSync(profileRoot, { recursive: true, force: true });
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
