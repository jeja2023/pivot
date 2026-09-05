/* global document, Event, window -- Playwright 浏览器端执行上下文全局变量 */
const { expect, test } = require('@playwright/test');

if (process.env.PIVOT_E2E_DEBUG === 'true') {
    test.beforeEach(({ page }) => {
        page.on('pageerror', error => console.error(`[pageerror] ${error.stack || error.message}`));
        page.on('console', message => {
            if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
        });
    });
}

test.describe('Pivot browser smoke', () => {
    test('login form establishes a browser session and reveals the authenticated workspace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#auth-container')).toBeVisible();
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
        await expect(page.locator('#auth-container')).toBeHidden();
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator('#user-info')).toContainText(/admin|管理员/i);
    });

    test('Agent 工作台 exposes profile wizard, goals, inbox and channel controls', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: {
                username: 'admin',
                password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'
            }
        });
        expect(login.ok()).toBeTruthy();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#automation-workbench-btn').click();
        await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
        await expect(page.locator('#agent-control-plane')).toBeVisible();
        await expect(page.locator('[data-agent-cp-pane="governance"]')).toBeVisible();
        await page.locator('[data-agent-cp-subview="inbox"]').click();
        await expect(page.locator('#agent-inbox-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="goals"]').click();
        await expect(page.locator('#agent-goals-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="channels"]').click();
        await expect(page.locator('#agent-channels-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="goals"]').click();
        await page.locator('#agent-profile-wizard-panel').evaluate(panel => { panel.classList.remove('hidden'); panel.style.display = 'block'; });
        await expect(page.locator('#agent-profile-wizard-panel')).toHaveClass(/agent-profile-wizard-panel/);
        await page.locator('#agent-goal-create').evaluate(button => button.click());
        await expect(page.locator('#agent-goal-editor')).toBeVisible();
        await page.locator('#agent-goal-title').fill('E2E 临时目标');
        await page.locator('#agent-goal-goal').fill('E2E 验证持续目标入口');
        await page.locator('#agent-goal-trigger').selectOption('manual');
        await page.locator('#agent-goal-editor button[type="submit"]').click();
        await expect(page.locator('#agent-goals-panel')).toContainText('E2E 临时目标');
    });

    test('chat shell loads safe HTML and Pivot module namespace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
        await page.waitForFunction('() => Boolean(window.Pivot && window.Pivot.modules && window.Pivot.html)');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.ui"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.attachments"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.messageVirtualizer"])');
    });

    test('knowledge workspace exposes RAG debug controls', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#rag-debug-modal')).toHaveCount(1);
        await expect(page.locator('#rag-debug-history')).toHaveCount(1);
        await expect(page.locator('#rag-debug-results')).toHaveCount(1);
    });

    test('long chat opens at the newest message and remains scrollable both ways', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.Pivot?.modules?.["chat.messageVirtualizer"])');
        await page.evaluate(() => {
            const container = document.getElementById('message-container');
            document.body.appendChild(container);
            Object.assign(container.style, {
                display: 'flex',
                height: '600px',
                inset: '0',
                position: 'fixed',
                width: '900px',
                zIndex: '99999'
            });
            const records = Array.from({ length: 140 }, (_, index) => ({
                id: index + 1,
                role: index % 2 ? 'assistant' : 'user',
                content: 'virtual-message-' + (index + 1) + ' ' + 'variable height content '.repeat(18),
                created_at: '2026-08-17 12:00:00',
                token_count: index + 1
            }));
            window.Pivot.modules['chat.messageVirtualizer'].start({
                sessionId: 'virtual-scroll-smoke',
                records,
                page: { hasMore: false, beforeId: 1 }
            });
        });
        await page.waitForTimeout(500);

        const readWindow = () => page.locator('#message-container').evaluate(container => ({
            distanceFromBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
            firstId: Number(container.querySelector('.message')?.dataset.virtualMessageKey?.split(':')[1] || 0),
            lastId: Number(Array.from(container.querySelectorAll('.message')).at(-1)?.dataset.virtualMessageKey?.split(':')[1] || 0)
        }));

        const initial = await readWindow();
        expect(initial.lastId).toBe(140);
        expect(initial.distanceFromBottom).toBeLessThanOrEqual(5);

        await page.locator('#message-container').evaluate(container => {
            container.scrollTop = Math.max(0, container.scrollTop - 5000);
            container.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(250);
        const earlier = await readWindow();
        expect(earlier.firstId).toBeLessThan(initial.firstId);

        await page.locator('#message-container').evaluate(container => {
            container.scrollTop = container.scrollHeight;
            container.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(250);
        const newest = await readWindow();
        expect(newest.lastId).toBe(140);
        expect(newest.distanceFromBottom).toBeLessThanOrEqual(5);
    });

    test('chat knowledge and tool subpanels stay visible and show the selected tool count', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 520 });
        await page.route('**/api/mcp/tools', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                tools: [
                    { fullName: 'mcp.1.db.count_tables', name: 'db.count_tables', serverName: 'Database' },
                    { fullName: 'mcp.1.db.list_tables', name: 'db.list_tables', serverName: 'Database' },
                    { fullName: 'mcp.1.db.describe_table', name: 'db.describe_table', serverName: 'Database' }
                ]
            })
        }));
        const login = await page.request.post('/api/auth/login', {
            data: {
                username: 'admin',
                password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'
            }
        });
        expect(login.ok()).toBeTruthy();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });

        await page.locator('#chat-tools-menu-btn').click();
        await page.locator('[data-chat-tool-config="rag"]').click();
        await expect(page.locator('#chat-rag-subpanel')).toBeVisible();
        const ragBounds = await page.locator('#chat-rag-subpanel').evaluate(panel => {
            const rect = panel.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
        });
        expect(ragBounds.top).toBeGreaterThanOrEqual(11.5);
        expect(ragBounds.bottom).toBeLessThanOrEqual(ragBounds.viewportHeight - 11.5);

        await page.locator('[data-chat-tool-config="mcp"]').click();
        await expect(page.locator('#chat-mcp-tool-summary')).toHaveText('3 个工具可用，模型按需选择');
        await expect(page.locator('#chat-tool-status')).toBeHidden();
        await page.locator('#chat-mcp-mode-manual').check();
        await expect(page.locator('#chat-mcp-tool-summary')).toHaveText('已选择 0 / 3 个工具');
        await page.locator('#chat-mcp-tool-list input[type="checkbox"]').first().check();
        await expect(page.locator('#chat-mcp-tool-summary')).toHaveText('已选择 1 / 3 个工具');
        const toolBounds = await page.locator('#chat-mcp-subpanel').evaluate(panel => {
            const rect = panel.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
        });
        expect(toolBounds.top).toBeGreaterThanOrEqual(11.5);
        expect(toolBounds.bottom).toBeLessThanOrEqual(toolBounds.viewportHeight - 11.5);
    });

    test('chat Agent detail button lazy-loads the task detail and shows safe reasoning summary', async ({ page }) => {
        await page.route('**/api/agents/runs/run-lazy-detail', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                run: {
                    id: 'run-lazy-detail',
                    title: '连续 Agent 测试任务',
                    goal: '检查详情按钮和执行判断摘要',
                    status: 'running',
                    run_mode: 'standard',
                    tool_policy: 'builtin_only',
                    metadata: {},
                    created_at: '2026-08-24 14:00:00'
                },
                steps: [{
                    step_index: 1,
                    type: 'plan',
                    title: '先检查当前任务上下文',
                    output: { thought: '先检查当前任务上下文', action: 'final', answer: '测试' },
                    status: 'success',
                    duration_ms: 12
                }],
                dagNodes: [],
                progress: { stepCount: 1, roundCount: 1, maxSteps: 30, percent: 20, totalDurationMs: 12 },
                trace: {},
                checkpoints: { total: 0 }
            })
        }));
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.attachChatAgentControls && window.ensureWorkspaceScripts)');
        await page.evaluate(() => {
            const card = document.createElement('div');
            card.id = 'chat-agent-detail-smoke';
            card.style.position = 'fixed';
            card.style.inset = '20px auto auto 20px';
            card.style.zIndex = '99999';
            card.style.background = 'white';
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            card.appendChild(actions);
            document.body.appendChild(card);
            window.attachChatAgentControls(card, 'run-lazy-detail', 'running');
        });

        await page.locator('#chat-agent-detail-smoke .chat-agent-controls button', { hasText: '详情' }).click();
        await expect(page.locator('#agent-run-detail-modal')).toBeVisible();
        await expect(page.locator('#agent-run-detail')).toContainText('先检查当前任务上下文');
    });

    test('usage audit workspace switches between statistics, details and report', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: {
                username: 'admin',
                password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'
            }
        });
        expect(login.ok()).toBeTruthy();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });

        await page.locator('#admin-panel-btn').click();
        await expect(page.locator('#admin-container')).toBeVisible();
        await page.locator('#tab-usage').click();

        await expect(page.locator('#usage-title')).toHaveText('用量统计');
        await expect(page.locator('#tab-content-stats')).toBeVisible();
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeHidden();

        await page.locator('#usage-subtab-details').click();
        await expect(page.locator('#usage-subtab-details')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#usage-title')).toHaveText('用量明细');
        await expect(page.locator('#tab-content-stats')).toBeHidden();
        await expect(page.locator('#tab-content-details')).toBeVisible();

        await page.locator('#usage-subtab-report').click();
        await expect(page.locator('#usage-subtab-report')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#usage-title')).toHaveText('审计报表');
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeVisible();
        await expect(page.locator('#report-query-btn')).toBeVisible();
    });

    test('system monitor renders RAG diagnostics and embedding latency state', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: {
                username: 'admin',
                password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'
            }
        });
        expect(login.ok()).toBeTruthy();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#admin-panel-btn').click();
        await page.locator('#tab-monitor').click();

        await expect(page.locator('#tab-content-monitor')).toBeVisible();
        await expect(page.locator('#monitor-summary-grid')).toContainText('平均延迟');
        await expect(page.locator('#monitor-rag-storage-list')).toContainText('检索诊断（24h）');
        await expect(page.locator('#monitor-rag-latency-trend')).toContainText(/Embedding|暂无/);
    });

    test('model configuration sends the native tool-call mode selected by an administrator', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: {
                username: 'admin',
                password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'
            }
        });
        expect(login.ok()).toBeTruthy();
        let savedPayload = null;
        await page.route('**/api/models', async route => {
            if (route.request().method() !== 'POST') return route.continue();
            savedPayload = route.request().postDataJSON();
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#admin-panel-btn').click();
        await page.locator('#tab-models').click();
        await page.locator('#model-add-btn').click();
        await expect(page.locator('#m-tool-call-mode')).toHaveValue('auto');
        await page.locator('#m-name').fill('E2E tool mode');
        await page.locator('#m-url').fill('https://models.example.com/v1');
        await page.locator('#m-model').fill('e2e-tool-mode');
        await page.locator('#m-tool-call-mode').selectOption('disabled');
        await page.locator('#m-submit-btn').click();
        await expect.poll(() => savedPayload).not.toBeNull();
        expect(savedPayload.tool_call_mode).toBe('disabled');
    });

    test('chat submits an SSE request and renders the persisted streaming answer', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        let requestPayload = null;
        await page.route('**/api/chat', async route => {
            requestPayload = route.request().postDataJSON();
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream; charset=utf-8',
                body: [
                    'data: {"content":"E2E 流式回答"}',
                    '',
                    'data: {"type":"message_saved","role":"assistant","messageId":999,"content":"E2E 流式回答","tokenCount":6,"costTime":0.1,"tps":60}',
                    '',
                    'data: [DONE]',
                    ''
                ].join('\n')
            });
        });
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#user-input').fill('请返回一段 E2E 流式文本');
        await page.locator('#send-btn').click();
        await expect(page.locator('#message-container')).toContainText('E2E 流式回答');
        await expect.poll(() => requestPayload).not.toBeNull();
        expect(requestPayload.content).toContain('E2E 流式文本');
        expect(requestPayload.sessionId).toBeTruthy();
    });

    test('knowledge upload queue accepts a selected file and sends it through the guarded upload route', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        let uploadObserved = false;
        await page.route('**/api/rag/upload', async route => {
            uploadObserved = route.request().method() === 'POST';
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, docId: 987, message: '后台处理中' }) });
        });
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#knowledge-workbench-btn').click();
        await page.locator('#rag-upload-btn').click();
        await expect(page.locator('#knowledge-upload-modal')).toBeVisible();
        await page.locator('#rag-upload-input').setInputFiles({
            name: 'e2e-knowledge.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('# E2E 知识库\n\n用于验证上传队列。', 'utf8')
        });
        await expect(page.locator('#knowledge-upload-list')).toContainText('e2e-knowledge.md');
        await expect(page.locator('#knowledge-upload-submit-btn')).toBeEnabled();
        await page.locator('#knowledge-upload-submit-btn').click();
        await expect.poll(() => uploadObserved).toBe(true);
        await expect(page.locator('#knowledge-upload-modal')).toBeHidden();
    });
});
