/* global window, document, Event, currentAbortController, getComputedStyle -- Playwright 浏览器端执行上下文 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { execute, queryOne } = require('../../server/db/client');
const { createToolOrchestrator } = require('../../server/services/agent-tool-orchestrator');
const { saveAssistantMessage } = require('../../server/services/chat-messages');

async function loginAndSession(page, title) {
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const created = await page.request.post('/api/sessions', { headers, data: { title } });
    expect(created.ok()).toBeTruthy();
    return { session: await created.json(), headers };
}

async function openSession(page, id) {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('chat.tasks')?.attach));
    await page.evaluate(sessionId => window.Pivot.legacy.selectSession(sessionId), id);
}

async function refreshTask(page, runId) {
    await page.evaluate(async id => {
        const element = [...document.querySelectorAll('[data-chat-agent-run-id]')].find(node => node.dataset.chatAgentRunId === id);
        const api = window.Pivot.moduleApi('chat.tasks');
        await api.refresh(api.attach(element, id));
    }, runId);
}

test('真实持久事件驱动工具执行、完成回看与受控文件下载', async ({ page }) => {
    const { session, headers } = await loginAndSession(page, '执行过程与文件交付');
    const user = await queryOne("SELECT * FROM users WHERE username = 'admin'");
    const runId = `browser-${crypto.randomUUID()}`;
    const run = { id: runId, user_id: user.id, session_id: session.id, status: 'running' };
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,input_tokens,output_tokens,total_tokens,last_heartbeat_at) VALUES (?,?,?,'整理数据并生成结果','生成可下载结果','running',?,200,60,260,NOW())", [runId, user.id, session.id, JSON.stringify({ chatBridge: { version: 1, sessionId: session.id } })]);
    let release;
    let ready;
    const entered = new Promise(resolve => { ready = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const orchestrator = createToolOrchestrator({ enforceToolPolicy: ({ input }) => ({ input, decision: 'allow' }),
        issueToolExecutionGrant: () => null, stageDeferredToolEffect: async () => null });
    const operation = orchestrator.execute({ run, user, tool: { name: 'db.read', idempotent: true },
        context: { stepId: 'query-one' }, execute: async () => { ready(); await barrier; return { rows: [{ value: 1 }, { value: 2 }] }; } });
    await entered;
    try {
        await openSession(page, session.id);
        const card = page.locator(`[data-chat-agent-run-id="${runId}"]`);
        await expect(card).toHaveCount(1);
        await expect(card).toContainText('查询业务数据');
        await expect(card.locator('.chat-task-record-meta')).toContainText('执行中');
        await page.evaluate(id => window.Pivot.legacy.handleChatAgentStreamingEvent({ runId: id, completed: true, partialToolCalls: [{ name: 'db.read' }] }), runId);
        await expect(card.locator('.chat-task-record-meta')).toContainText('执行中');
        await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/chat-task-running.png') });
        release();
        await operation;
        await refreshTask(page, runId);
        await expect(card.locator('.chat-task-record-meta')).toContainText('完成');
        await expect(card.locator('.chat-task-record')).toHaveCount(1);
        const content = '已整理两条记录，合计为 3。';
        const currentCsrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const generated = await page.request.post('/api/agents/code-renditions', { headers: { ...headers, 'x-csrf-token': currentCsrf }, data: { filename: '执行结果.txt', language: 'txt', content } });
        expect(generated.ok(), `创建文件返回 ${generated.status()}：${generated.ok() ? '' : await generated.text()}`).toBeTruthy();
        const artifact = await generated.json();
        await execute('UPDATE agent_artifacts SET run_id = ? WHERE id = ?', [runId, artifact.artifact.id]);
        await execute('UPDATE agent_artifact_renditions SET run_id = ? WHERE id = ?', [runId, artifact.rendition.id]);
        const answer = '已完成数据整理，结果文件已生成，可以下载。';
        const saved = await saveAssistantMessage({ sessionId: session.id, userId: user.id, content: answer, agentRunId: runId });
        await execute("UPDATE agent_runs SET status = 'completed', final_answer = ?, completed_at = NOW(), updated_at = NOW(), metadata = jsonb_set(metadata, '{chatBridge,messageId}', ?::jsonb) WHERE id = ?", [answer, String(saved.lastInsertRowid), runId]);
        await refreshTask(page, runId);
        await expect(card).toContainText(answer);
        await expect(card).toContainText('执行结果.txt');
        await expect(card).toContainText('暂无独立核验记录');
        const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '下载已生成的结果文件', exact: true }).click()]);
        expect(download.suggestedFilename()).toBe('执行结果.txt');
        expect(fs.readFileSync(await download.path(), 'utf8')).toBe(content);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        const restored = page.locator(`[data-chat-agent-run-id="${runId}"]`);
        await expect(restored).toHaveCount(1);
        await expect(restored).toContainText('执行结果.txt');
        await restored.locator('.chat-task-process > summary').click();
        await expect(restored.locator('.chat-task-record')).toHaveCount(1);
        await page.evaluate(() => { document.getElementById('message-container').scrollTop = 0; });
        await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/chat-task-completed-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);
        await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
        await expect(restored.getByRole('button', { name: '下载已生成的结果文件', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
        await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/chat-task-completed-mobile.png'), fullPage: true });
    } finally {
        release();
        await operation.catch(() => {});
        await execute('DELETE FROM agent_artifacts WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('审批卡不被模型流覆盖，明确绑定决定并在断线时保留最后确认状态', async ({ page }) => {
    const { session } = await loginAndSession(page, '审批与连接状态');
    let stage = 'approval_required';
    let unavailable = false;
    let decision;
    const binding = { inputHash: 'a'.repeat(64), key: 'operation-one', requestedAt: '2026-10-20T08:00:00+08:00' };
    const run = () => ({ id: 'browser-approval', session_id: session.id, status: stage, title: '更新指定文件',
        waiting: stage === 'approval_required', terminal: false, updated_at: '2026-10-20T08:01:00+08:00' });
    await page.route(/\/api\/agents\/runs\/chat-active(?:\?.*)?$/, route => route.fulfill({ json: { runs: [run(), run()] } }));
    await page.route('**/api/agents/runs/browser-approval/chat-feed?*', route => unavailable ? route.fulfill({ status: 503, json: { error: '暂不可用' } }) : route.fulfill({ json: {
        run: run(), events: [], legacySteps: [], artifacts: [], verification: stage === 'verifying' ? { status: 'verified', label: '结果已通过核验' } : { status: 'unknown' }, older: { hasMore: false },
        cursor: { eventSeq: stage === 'approval_required' ? 2 : 3 }, nextAfter: stage === 'approval_required' ? 2 : 3,
        approval: stage === 'approval_required' ? { title: '修改指定文件', location: '我的电脑', binding, expiresAt: '2099-01-01T08:00:00+08:00', fields: [{ label: '文件范围', value: '已授权工作目录' }] } : null,
        pollAfterMs: stage === 'approval_required' ? null : 4000
    } }));
    await page.route('**/api/agents/runs/browser-approval/approval', route => {
        decision = route.request().postDataJSON();
        stage = 'running';
        return route.fulfill({ json: { success: true, run: run() } });
    });
    await openSession(page, session.id);
    const card = page.locator('[data-chat-agent-run-id="browser-approval"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('已授权工作目录');
    await page.evaluate(() => window.Pivot.legacy.handleChatAgentStreamingEvent({ runId: 'browser-approval', completed: true, partialToolCalls: [{ name: 'workspace.patch' }] }));
    await expect(card.getByRole('button', { name: '允许当前操作并继续任务', exact: true })).toBeVisible();
    await card.getByRole('button', { name: '允许当前操作并继续任务', exact: true }).click();
    await expect(card.locator('.chat-task-approval')).toHaveCount(0);
    expect(decision).toEqual({ approve: true, ...binding });
    unavailable = true;
    await refreshTask(page, 'browser-approval');
    await expect(card).toContainText('暂时无法确认最新状态');
    await expect(card).toContainText('最后确认：正在处理任务');
    unavailable = false;
    await card.getByRole('button', { name: '重新获取任务最新状态', exact: true }).click();
    await expect(card).not.toContainText('暂时无法确认最新状态');
    stage = 'verifying';
    await refreshTask(page, 'browser-approval');
    await expect(card).toContainText('正在核验本次结果');
    await expect(card).not.toContainText('结果已通过核验');
});

test('多任务卡补充与暂停绑定指定任务，历史翻页和迟到响应不串会话', async ({ page }) => {
    const { session, headers } = await loginAndSession(page, '多任务与执行历史');
    const created = await page.request.post('/api/sessions', { headers, data: { title: '另一会话' } });
    expect(created.ok()).toBeTruthy();
    const other = await created.json();
    const statuses = { 'browser-task-a': 'needs_input', 'browser-task-b': 'running' };
    const operations = [];
    let hold = false;
    let releaseHeld;
    let held;
    const holding = new Promise(resolve => { held = resolve; });
    const run = id => ({ id, session_id: session.id, status: statuses[id], title: id.endsWith('a') ? '资料检查' : '订单报告',
        updated_at: '2026-10-20T08:02:00+08:00', waiting: statuses[id] === 'needs_input', terminal: false,
        final_answer: id.endsWith('a') ? '已保留资料检查结果。' : '' });
    await page.route(/\/api\/agents\/runs\/chat-active(?:\?.*)?$/, route => route.fulfill({ json: {
        runs: new URL(route.request().url()).searchParams.get('sessionId') === String(session.id) ? [run('browser-task-a'), run('browser-task-b')] : []
    } }));
    await page.route(/\/api\/agents\/runs\/browser-task-[ab]\/chat-feed\?/, async route => {
        const url = new URL(route.request().url());
        const id = url.pathname.split('/')[4];
        if (hold && id === 'browser-task-b') {
            held();
            await new Promise(resolve => { releaseHeld = resolve; });
        }
        const old = url.searchParams.has('before');
        const delta = url.searchParams.has('after');
        const records = !delta && id.endsWith('b') ? Array.from({ length: old ? 3 : 30 }, (_, index) => {
            const seq = old ? index + 1 : index + 4;
            return { id: `event:${seq}`, seq, kind: 'tool', operationId: `op-${seq}`, status: 'completed', title: `读取第 ${seq} 份资料`, at: '2026-10-20T08:00:00+08:00' };
        }) : [];
        return route.fulfill({ json: { run: run(id), events: records, legacySteps: [], artifacts: [], verification: { status: 'unknown' },
            cursor: { eventSeq: 34 }, nextAfter: 34, older: { hasMore: !old && id.endsWith('b'), before: old ? 1 : 4 },
            pollAfterMs: statuses[id] === 'running' ? 4000 : null } });
    });
    await page.route(/\/api\/agents\/runs\/browser-task-[ab]\/(?:pause|control-messages)$/, route => {
        const parts = new URL(route.request().url()).pathname.split('/');
        const id = parts[4];
        operations.push({ id, action: parts[5], body: route.request().postDataJSON() });
        if (parts[5] === 'pause') statuses[id] = 'needs_input';
        return route.fulfill({ json: { success: true, run: run(id) } });
    });
    await openSession(page, session.id);
    const card = page.locator('[data-chat-agent-run-id="browser-task-b"]');
    await expect(card.locator('.chat-task-record')).toHaveCount(30);
    await card.getByRole('button', { name: '加载更早的执行记录', exact: true }).click();
    await expect(card.locator('.chat-task-record')).toHaveCount(33);
    await expect(card.locator('.chat-task-record').first()).toContainText('第 1 份资料');
    const stoppedText = await page.evaluate(async () => {
        let aborted = false;
        currentAbortController = { pivotAgentRunId: 'browser-task-b', abort() { aborted = true; } };
        await window.Pivot.legacy.cancelCurrentChatAgent();
        const interrupted = aborted && currentAbortController.pivotSupersededBySend === true;
        currentAbortController = null;
        return interrupted;
    });
    expect(stoppedText).toBe(true);
    expect(operations).toHaveLength(0);
    await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
    await expect(page.locator('.input-area [data-task-action]')).toHaveCount(0);
    await page.evaluate(() => { window.Pivot.legacy.showInputPrompt = async () => '只处理已付款订单，保留异常依据。'; });
    await card.getByRole('button', { name: '为当前任务补充要求', exact: true }).click();
    await expect.poll(() => operations.length).toBe(1);
    expect(operations[0]).toMatchObject({ id: 'browser-task-b', action: 'control-messages', body: { type: 'steer', payload: { instruction: '只处理已付款订单，保留异常依据。' } } });
    await card.getByRole('button', { name: '暂停当前任务，可随后继续', exact: true }).click();
    await expect(card).toContainText('等待补充信息或继续');
    expect(operations[1].id).toBe('browser-task-b');
    await expect(page.locator('[data-chat-agent-run-id="browser-task-a"]')).toContainText('已保留资料检查结果');
    hold = true;
    await page.evaluate(() => {
        const element = document.querySelector('[data-chat-agent-run-id="browser-task-b"]');
        const tasks = window.Pivot.moduleApi('chat.tasks');
        void tasks.refresh(tasks.attach(element, 'browser-task-b'));
    });
    await holding;
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), other.id);
    releaseHeld();
    await page.waitForTimeout(150);
    await expect(page.locator('#message-container [data-chat-agent-run-id]')).toHaveCount(0);
    await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
});

test('任务长文本、审批和文件卡适配深浅主题与桌面及窄屏', async ({ page }) => {
    const { session } = await loginAndSession(page, '任务主题与窄屏');
    const run = { id: 'browser-layout', session_id: session.id, status: 'approval_required', title: '核对指定资料并生成部门异常汇总报告', waiting: true, terminal: false };
    await page.route(/\/api\/agents\/runs\/chat-active(?:\?.*)?$/, route => route.fulfill({ json: { runs: [run] } }));
    await page.route('**/api/agents/runs/browser-layout/chat-feed?*', route => route.fulfill({ json: {
        run, events: [{ id: 'event:1', seq: 1, kind: 'tool', operationId: 'long-operation', title: '查询已授权业务数据并核对异常来源', status: 'failed',
            location: '外部服务', detail: '外部数据源暂时无法连接，请检查已授权连接状态。'.repeat(4), durationMs: 1200 }], legacySteps: [],
        cursor: { eventSeq: 2 }, nextAfter: 2, older: { hasMore: false }, pollAfterMs: null, verification: { status: 'unknown' },
        approval: { title: '更新指定结果文件', location: '隔离执行环境', fields: [{ label: '文件范围', value: '授权工作区内的结果目录，完整范围可在任务详情中核对。' }],
            binding: { inputHash: 'a'.repeat(64), key: 'layout', requestedAt: '2026-10-20T08:00:00+08:00' }, expiresAt: '2099-01-01T08:00:00+08:00' },
        artifacts: [{ id: 'result', title: '部门异常统计与整改建议报告及来源明细.xlsx', version: 2, rendition: { id: 'rendition', format: 'xlsx', byteSize: 10240, status: 'ready', ready: true } }]
    } }));
    await openSession(page, session.id);
    const card = page.locator('[data-chat-agent-run-id="browser-layout"]');
    await expect(card.locator('.chat-task-approval')).toBeVisible();
    for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [1280, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            if (width < 720) await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
            const metrics = await card.evaluate(node => {
                const panel = node.querySelector('.chat-task-panel');
                const style = getComputedStyle(node);
                const input = document.querySelector('.input-area');
                return { pageOverflow: document.documentElement.scrollWidth > window.innerWidth, panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
                    inputOverflow: input.scrollWidth > input.clientWidth + 1, foreground: style.color, background: style.backgroundColor };
            });
            expect(metrics.pageOverflow, `${colorScheme} ${width} 页面`).toBe(false);
            expect(metrics.panelOverflow, `${colorScheme} ${width} 任务`).toBe(false);
            expect(metrics.inputOverflow, `${colorScheme} ${width} 输入区`).toBe(false);
            await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
            const luminance = rgb => {
                const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const foreground = luminance(metrics.foreground);
            const background = luminance(metrics.background);
            expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), `${colorScheme} ${width} 正文对比度`).toBeGreaterThanOrEqual(4.5);
        }
    }
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/chat-task-dark-mobile.png'), animations: 'disabled' });
});

test('任务卡保留过程展开与控制，停止任务在进度接口失败时仍立即生效', async ({ page }) => {
    const { session } = await loginAndSession(page, '任务卡过程与控制');
    const user = await queryOne("SELECT id FROM users WHERE username = 'admin'");
    const runId = `controls-${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,last_heartbeat_at) VALUES (?,?,?,'核对订单并生成汇总','核对订单','running',?,NOW())", [runId, user.id, session.id, JSON.stringify({ chatBridge: { version: 1, sessionId: session.id } })]);
    await page.route(`**/api/agents/runs/${runId}/chat-feed?*`, route => route.fulfill({ status: 503, json: { error: '模拟进度暂时不可用' } }));
    try {
        await openSession(page, session.id);
        const card = page.locator(`[data-chat-agent-run-id="${runId}"]`);
        await expect(card).toContainText('任务进度暂时无法读取');
        await expect(card).toContainText('核对订单并生成汇总');
        await card.locator('.chat-task-process > summary').click();
        await expect(card.locator('.chat-task-process')).not.toHaveAttribute('open');
        await card.locator('.chat-task-process > summary').click();
        await expect(card.locator('.chat-task-process')).toHaveAttribute('open');
        await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
        await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/task-card-only-desktop.png') });
        const cancelled = page.waitForResponse(response => response.url().endsWith(`/agents/runs/${runId}/cancel`));
        await card.getByRole('button', { name: '停止当前任务的后续处理', exact: true }).click();
        expect((await cancelled).ok()).toBeTruthy();
        await expect(card).toContainText('任务已停止');
        await expect(card).toContainText('已停止后续处理，已完成操作保留记录');
        await expect(card.getByRole('button', { name: '停止当前任务的后续处理', exact: true })).toHaveCount(0);
        await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
        expect((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId])).status).toBe('cancelled');
        await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/task-controls-stopped-desktop.png') });
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); }
});

test('停止确认不被迟到的运行快照覆盖，操作按钮有处理中反馈', async ({ page }) => {
    const { session } = await loginAndSession(page, '停止确认竞争');
    const id = 'stop-race';
    let cancelled = false;
    let hold = false;
    let releaseOld;
    let entered;
    const barrier = new Promise(resolve => { entered = resolve; });
    const run = () => ({ id, session_id: session.id, title: '生成业务报告', status: cancelled ? 'cancelled' : 'running', terminal: cancelled, waiting: false });
    await page.route(/\/api\/agents\/runs\/chat-active(?:\?.*)?$/, route => route.fulfill({ json: { runs: [run()] } }));
    await page.route(`**/api/agents/runs/${id}/chat-feed?*`, async route => {
        const stale = run();
        if (hold && !cancelled) { entered(); await new Promise(resolve => { releaseOld = resolve; }); }
        if (cancelled) return route.fulfill({ status: 503, json: { error: '停止后记录读取异常' } }).catch(() => {});
        return route.fulfill({ json: { run: stale, events: [], artifacts: [], legacySteps: [], cursor: { eventSeq: 1 }, nextAfter: 1, older: { hasMore: false }, pollAfterMs: 4000 } }).catch(() => {});
    });
    await page.route(`**/api/agents/runs/${id}/cancel`, async route => {
        await new Promise(resolve => setTimeout(resolve, 350));
        cancelled = true;
        return route.fulfill({ json: { success: true, run: run() } });
    });
    await openSession(page, session.id);
    const card = page.locator(`[data-chat-agent-run-id="${id}"]`);
    await expect(card).toContainText('正在处理任务');
    hold = true;
    await page.evaluate(() => {
        const tasks = window.Pivot.moduleApi('chat.tasks');
        void tasks.refresh(tasks.attach(document.querySelector('[data-chat-agent-run-id="stop-race"]'), 'stop-race'));
    });
    await barrier;
    await card.getByRole('button', { name: '停止当前任务的后续处理', exact: true }).click();
    await expect(card).toContainText('正在停止…');
    await expect(card).toContainText('任务已停止');
    releaseOld();
    await page.waitForTimeout(200);
    await expect(card.locator('.chat-task-status-summary')).toHaveText('任务已停止');
    await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
});

test('历史任务随虚拟列表滚动恢复，输入区不重复显示任务状态', async ({ page }) => {
    const { session } = await loginAndSession(page, '虚拟消息中的任务定位');
    const user = await queryOne("SELECT id FROM users WHERE username = 'admin'");
    const id = `virtual-task-${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata) VALUES (?,?,?,'较早任务','查看任务','completed',?)", [id, user.id, session.id, JSON.stringify({ chatBridge: { version: 1, sessionId: session.id } })]);
    await saveAssistantMessage({ sessionId: session.id, userId: user.id, content: '较早任务的已有回答。', agentRunId: id });
    await execute("INSERT INTO messages (session_id,user_id,role,content) SELECT ?,?,'assistant','后续对话第 ' || n::text || ' 条。' FROM generate_series(1,35) n", [session.id, user.id]);
    const run = { id, session_id: session.id, title: '较早任务', status: 'running', terminal: false };
    await page.route(`**/api/agents/runs/${id}/chat-feed?*`, route => route.fulfill({ json: { run, events: [], legacySteps: [], artifacts: [],
        cursor: { eventSeq: 1 }, nextAfter: 1, older: { hasMore: false }, pollAfterMs: 4000 } }));
    try {
        await openSession(page, session.id);
        await expect(page.locator(`[data-chat-agent-run-id="${id}"]`)).toHaveCount(0);
        await page.locator('#message-container').hover();
        await page.mouse.wheel(0, -20000);
        await page.locator('#message-container').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
        const card = page.locator(`[data-chat-agent-run-id="${id}"]`);
        await expect(card).toHaveCount(1);
        await expect(card.locator('.chat-task-process')).toHaveAttribute('open');
        await expect(card.getByRole('button', { name: '停止当前任务的后续处理', exact: true })).toBeVisible();
        await expect(page.locator('#chat-task-composer-bar')).toHaveCount(0);
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [id]); }
});
