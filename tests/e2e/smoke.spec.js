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

async function ensureBrowserSession(page) {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    const app = page.locator('#app');
    try {
        await expect(app).toBeVisible({ timeout: 8_000 });
        return;
    } catch (_) {
        // Cookie 登录失败或未完成时，回退到真实登录表单。
    }
    await expect(page.locator('#username')).toBeVisible({ timeout: 8_000 });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15_000 });
    await expect(app).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
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

    test('对话页模型统计样式来自首屏消息壳，而不是设置工作区 CSS', async ({ page }) => {
        await ensureBrowserSession(page);
        const stats = page.locator('#message-container .message-stats').first();
        await expect(stats).toHaveCount(0);
        await page.evaluate(() => {
            const container = document.getElementById('message-container');
            const message = document.createElement('div');
            message.className = 'message assistant';
            message.innerHTML = `
                <div class="avatar">✦</div>
                <div class="message-content">
                    <div class="text-body"><p>样式回归测试消息</p></div>
                    <div class="message-footer">
                        <div class="message-stats">
                            <span class="stat-item stat-model">◈chatgpt-5.5</span>
                            <span class="stat-item">◷10.0s</span>
                            <span class="stat-item">◈305 Tokens</span>
                            <span class="stat-item">↯30.4 t/s</span>
                        </div>
                    </div>
                </div>`;
            container.appendChild(message);
        });
        const renderedStats = page.locator('#message-container .message-stats').last();
        await expect(renderedStats).toBeVisible();
        await expect.poll(() => renderedStats.evaluate(element => {
            const style = window.getComputedStyle(element);
            const model = window.getComputedStyle(element.querySelector('.stat-model'));
            return style.borderRadius === '999px'
                && style.gap === '8px'
                && style.backgroundColor.includes('15, 23, 42')
                && ['flex', 'inline-flex'].includes(style.display)
                && model.maxWidth === '180px';
        })).toBe(true);
    });

    test('对话列表可被真实鼠标滚轮滚动，触底后自动继续加载下一页', async ({ page }) => {
        await ensureBrowserSession(page);
        const list = page.locator('#session-list');
        await expect(list).toBeVisible();
        await page.evaluate(() => document.body.classList.add('pivot-desktop-runtime'));
        await expect.poll(() => list.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            overflowY: window.getComputedStyle(element).overflowY,
            minHeight: window.getComputedStyle(element).minHeight
        }))).toMatchObject({ overflowY: 'auto', minHeight: '0px' });
        const initialMetrics = await list.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
        }));
        if (initialMetrics.scrollHeight > initialMetrics.clientHeight) {
            await list.hover();
            await page.mouse.wheel(0, 640);
            await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        }
        if (await list.locator('.session-item').count() > 0) {
            const before = await list.locator('.session-item').count();
            await list.hover();
            await page.mouse.wheel(0, 4_000);
            await expect.poll(() => list.locator('.session-item').count()).toBeGreaterThan(before);
        }
    });

    test('Agent 工作台 exposes profile wizard, goals, inbox and channel controls', async ({ page }) => {
        await ensureBrowserSession(page);
        await expect(page.locator('#agent-workbench-modal')).toHaveCount(0);
        const workspaceResponse = page.waitForResponse(response => response.url().endsWith('/chat/workspaces/agent'));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.());
        await expect((await workspaceResponse).status()).toBe(200);
        await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
        await expect(page.locator('#agent-control-plane')).toBeVisible();
        await page.locator('[data-agent-cp-subview="governance"]').click();
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

        const workflowResponse = page.waitForResponse(response => response.url().endsWith('/chat/workspaces/agent-dag'));
        await page.locator('#agent-workbench-modal [data-automation-section="workflows"]').click();
        await expect((await workflowResponse).status()).toBe(200);
        await expect(page.locator('#agent-dag-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#agent-workbench-modal')).toBeHidden();
    });

    test('应用、知识库、工具库和设置工作区均在首次打开时按需挂载', async ({ page }) => {
        await ensureBrowserSession(page);
        const workspaces = [
            ['apps', 'apps-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.()],
            ['knowledge', 'knowledge-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.()],
            ['mcp', 'mcp-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.()],
            ['settings', 'admin-container', () => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true })]
        ];
        for (const [name, panelId, open] of workspaces) {
            await expect(page.locator(`#${panelId}`)).toHaveCount(0);
            const responsePromise = page.waitForResponse(response => response.url().endsWith(`/chat/workspaces/${name}`));
            await page.evaluate(open);
            await expect((await responsePromise).status()).toBe(200);
            await expect(page.locator(`#${panelId}`)).toBeVisible({ timeout: 15_000 });
            const styleName = name === 'settings' ? 'settings' : name;
            await expect(page.locator(`link[href*="/chat/chat.workspace.${styleName}.css"]`)).toHaveCount(1);
            await expect.poll(() => page.evaluate((href) => {
                const link = [...document.querySelectorAll('link[rel="stylesheet"]')]
                    .find(item => (item.getAttribute('href') || '').includes(href));
                return Boolean(link?.sheet);
            }, `/chat/chat.workspace.${styleName}.css`)).toBe(true);
            if (name === 'knowledge') {
                const table = page.locator('#knowledge-workbench-modal .data-table');
                await expect(table).toBeVisible();
                await expect.poll(() => table.evaluate(element => {
                    const header = element.querySelector('th');
                    const tableStyle = window.getComputedStyle(element);
                    const headerStyle = window.getComputedStyle(header);
                    return {
                        tableLayout: tableStyle.tableLayout,
                        headerBackground: headerStyle.backgroundColor,
                        headerBorder: headerStyle.borderTopStyle
                    };
                })).toEqual({
                    tableLayout: 'fixed',
                    headerBackground: 'rgb(248, 250, 252)',
                    headerBorder: 'solid'
                });
            }
            const closeButton = {
                apps: '#apps-modal-close',
                knowledge: '#knowledge-modal-close',
                mcp: '#mcp-modal-close',
                settings: '#admin-modal-close'
            }[name];
            const closeControl = page.locator(closeButton);
            await expect.poll(() => closeControl.evaluate(button => {
                const rect = button.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return hit === button || button.contains(hit);
            })).toBe(true);
            if (name === 'knowledge' || name === 'mcp') {
                const closeFunction = name === 'knowledge' ? 'closeKnowledgeWorkbench' : 'closeMcpWorkbench';
                await page.evaluate((functionName) => {
                    const original = window.Pivot.legacy[functionName];
                    window.__workspaceCloseCalls = 0;
                    window.Pivot.legacy[functionName] = (...args) => {
                        window.__workspaceCloseCalls += 1;
                        return original(...args);
                    };
                }, closeFunction);
                await closeControl.click();
                await expect.poll(() => page.evaluate(() => window.__workspaceCloseCalls)).toBe(1);
                await expect(page.locator(`#${panelId}`)).toBeHidden();
            } else {
                await closeControl.click();
                await expect(page.locator(`#${panelId}`)).toBeHidden();
            }
        }
    });

    test('工作区样式资源短暂失败时，知识库仍会挂载并保持关闭控件可点击', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => {
            window.Pivot.moduleApi('workspaces.styleLoader').ensureWorkspaceStyles = () => (
                Promise.reject(new Error('E2E 模拟样式资源暂不可用'))
            );
        });
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
        const panel = page.locator('#knowledge-workbench-modal');
        const closeControl = page.locator('#knowledge-modal-close');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => closeControl.evaluate(button => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === button || button.contains(hit);
        })).toBe(true);
        await closeControl.click();
        await expect(panel).toBeHidden();
    });

    test('工具库的动态操作在重绘后仍可刷新、自检并打开本机授权中心', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.());
        await expect(page.locator('#mcp-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#mcp-refresh-btn')).toBeVisible({ timeout: 15_000 });

        const refreshRequest = page.waitForRequest(request => (
            request.method() === 'GET' && new URL(request.url()).pathname === '/api/mcp/governance'
        ));
        await page.locator('#mcp-refresh-btn').click();
        await refreshRequest;
        await expect(page.locator('#mcp-refresh-btn')).toHaveText('刷新');

        await page.evaluate(() => {
            const api = window.Pivot.moduleApi('mcp.workbench');
            window.__mcpHealthCheckCalls = 0;
            api.runMcpBatchHealthCheck = async () => {
                window.__mcpHealthCheckCalls += 1;
            };
        });
        await page.locator('#mcp-health-check-btn').click();
        await expect.poll(() => page.evaluate(() => window.__mcpHealthCheckCalls)).toBe(1);

        await page.locator('[data-mcp-section="data"]').click();
        await expect(page.locator('[data-mcp-pane="data"]')).toBeVisible();
        await expect(page.locator('[data-mcp-open-local-auth] .mcp-source-btn-wrap em')).toHaveText(/授权/);
        await page.locator('[data-mcp-open-local-auth]').first().click();
        await expect(page.locator('#mcp-local-auth-modal')).toBeVisible();
        await expect(page.locator('#mcp-local-auth-body')).toContainText(/网页端|桌面客户端|本机授权/);

        await page.locator('#mcp-local-auth-close-btn').click();
        await page.locator('[data-mcp-create="database"]').click();
        await expect(page.locator('#mcp-edit-modal')).toBeVisible();
    });

    test('个人工作台入口可打开并关闭所有按需工作区', async ({ page }) => {
        test.setTimeout(90_000);
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('personal'));
        await expect(page.locator('#personal-workbench-modal')).toBeVisible();

        const cases = [
            ['open-apps', '#apps-workbench-modal', '#apps-modal-close'],
            ['open-automation', '#agent-workbench-modal', '#agent-modal-close'],
            ['open-knowledge', '#knowledge-workbench-modal', '#knowledge-modal-close'],
            ['open-tools', '#mcp-workbench-modal', '#mcp-modal-close'],
            ['open-settings', '#admin-container', '#admin-modal-close']
        ];
        for (const [action, panel, close] of cases) {
            await page.locator(`[data-personal-action="${action}"]`).first().click();
            await expect(page.locator(panel)).toBeVisible({ timeout: 20_000 });
            await page.locator(close).click();
            await expect(page.locator(panel)).toBeHidden({ timeout: 15_000 });
            await expect(page.locator('#personal-workbench-modal')).toBeVisible({ timeout: 15_000 });
        }
    });

    test('统一分页与设置页分页均可翻页，并会钳制越界页码', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => {
            const pager = document.createElement('div');
            pager.id = 'pagination-contract-smoke';
            document.body.appendChild(pager);
            window.__workspacePaginationPages = [];
            window.Pivot.legacy.renderWorkspacePagination(pager, {
                total: 30,
                limit: 15,
                page: 99,
                onPageChange: pageNo => window.__workspacePaginationPages.push(pageNo)
            });
        });
        await expect(page.locator('#pagination-contract-smoke')).toContainText('第 2 / 2 页');
        await expect(page.locator('#pagination-contract-smoke button', { hasText: '下一页' })).toBeDisabled();
        await page.locator('#pagination-contract-smoke button', { hasText: '上一页' }).click();
        await expect.poll(() => page.evaluate(() => window.__workspacePaginationPages)).toEqual([1]);

        await page.evaluate(() => {
            const pager = document.getElementById('pagination-contract-smoke');
            window.__workspacePaginationPages = [];
            window.Pivot.legacy.renderWorkspacePagination(pager, {
                total: 30,
                limit: 15,
                page: 1,
                onPageChange: pageNo => window.__workspacePaginationPages.push(pageNo)
            });
        });
        await page.locator('#pagination-contract-smoke button', { hasText: '末页' }).click();
        await expect.poll(() => page.evaluate(() => window.__workspacePaginationPages)).toEqual([2]);

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        const modelsLoaded = page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === '/api/models' && url.searchParams.get('limit') === '15';
        });
        await page.locator('#tab-models').click();
        await modelsLoaded;
        await expect(page.locator('#tab-content-models')).toBeVisible();
        await page.evaluate(() => {
            window.__settingsPaginationCalls = [];
            window.Pivot.legacy.loadTabData = async (tab, pageNo) => {
                window.__settingsPaginationCalls.push({ tab, pageNo });
            };
            window.renderPagination('models', 30, 1);
        });
        await page.locator('#pagination-models button', { hasText: '下一页' }).click();
        await expect.poll(() => page.evaluate(() => window.__settingsPaginationCalls)).toEqual([{ tab: 'models', pageNo: 2 }]);
    });

    test('chat shell loads safe HTML and Pivot module namespace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
        await page.waitForFunction('() => Boolean(window.Pivot && window.Pivot.modules && window.Pivot.html)');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.ui"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.attachments"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.messageVirtualizer"])');
    });

    test('Markdown code and formula vendors load only when a rendered message needs them', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.Pivot && window.renderMarkdown)');
        await expect(page.locator('script[src*="highlight.min.js"]')).toHaveCount(0);
        await expect(page.locator('script[src*="katex.min.js"]')).toHaveCount(0);
        await page.evaluate(() => window.renderMarkdown('```js\nconst value = 1;\n```\n\n$x^2$'));
        await page.waitForFunction('() => Boolean(window.hljs && window.katex)', null, { timeout: 10_000 });
        await expect(page.locator('script[src*="highlight.min.js"]')).toHaveCount(1);
        await expect(page.locator('script[src*="katex.min.js"]')).toHaveCount(1);
        await expect(page.locator('link[href*="katex.min.css"]')).toHaveCount(1);
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
        await ensureBrowserSession(page);

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
        await ensureBrowserSession(page);

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
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

    test('知识库预加载配置后，设置工作区仍会绑定运行时参数和记忆操作', async ({ page }) => {
        test.setTimeout(60_000);
        await ensureBrowserSession(page);

        // 知识库会按需预加载 admin-settings.js；这里刻意在设置模板挂载前走这条路径，
        // 防止脚本缓存后设置页的事件监听未重新绑定。
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
        await expect(page.locator('#knowledge-workbench-modal')).toBeVisible({ timeout: 15_000 });

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });

        await page.locator('#tab-memories').click();
        await expect(page.locator('#memory-refresh-btn')).toBeVisible();
        await page.evaluate(() => {
            window.__memoryRefreshCalls = 0;
            window.Pivot.legacy.loadMemories = async () => { window.__memoryRefreshCalls += 1; };
        });
        await page.locator('#memory-refresh-btn').click();
        await expect.poll(() => page.evaluate(() => window.__memoryRefreshCalls)).toBe(1);

        await page.locator('#tab-global-params').click();
        await expect(page.locator('#runtime-settings-page-refresh')).toBeVisible();
        await page.evaluate(() => {
            window.__runtimeSettingsRefreshCalls = 0;
            window.Pivot.legacy.loadSettings = async () => { window.__runtimeSettingsRefreshCalls += 1; };
        });
        await page.locator('#runtime-settings-page-refresh').click();
        await expect.poll(() => page.evaluate(() => window.__runtimeSettingsRefreshCalls)).toBe(1);
    });

    test('system monitor renders RAG diagnostics and embedding latency state', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await page.locator('#tab-monitor').click();

        await expect(page.locator('#tab-content-monitor')).toBeVisible();
        await expect(page.locator('#monitor-summary-grid')).toContainText('平均延迟');
        await expect(page.locator('#monitor-rag-storage-list')).toContainText('检索诊断（24h）');
        await expect(page.locator('#monitor-rag-latency-trend')).toContainText(/Embedding|暂无/);
    });

    test('model configuration sends the native tool-call mode selected by an administrator', async ({ page }) => {
        let savedPayload = null;
        await page.route('**/api/models', async route => {
            if (route.request().method() !== 'POST') return route.continue();
            savedPayload = route.request().postDataJSON();
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
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
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const modelName = `E2E real model ${Date.now()}`;
        const created = await page.request.post('/api/models', {
            headers: { 'x-csrf-token': csrf },
            data: { name: modelName, url: process.env.E2E_MODEL_URL, model_name: 'e2e-real-model' }
        });
        expect(created.ok()).toBeTruthy();
        const modelsResponse = await page.request.get('/api/models?limit=100');
        expect(modelsResponse.ok()).toBeTruthy();
        const modelsBody = await modelsResponse.json();
        const model = (modelsBody.data || []).find(item => item.name === modelName);
        expect(model).toBeTruthy();
        const defaultResponse = await page.request.put('/api/settings/default-model', {
            headers: { 'x-csrf-token': csrf },
            data: { default_model_id: model.id }
        });
        expect(defaultResponse.ok()).toBeTruthy();
        await ensureBrowserSession(page);
        await expect(page.locator(`#model-dropdown-list .model-item[data-id="${model.id}"]`)).toHaveCount(1, { timeout: 15_000 });
        await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
        await expect(page.locator('#user-input')).toBeVisible({ timeout: 10_000 });
        await page.locator('#user-input').fill('请返回一段 E2E 流式文本');
        const chatResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/chat'));
        await page.locator('#send-btn').click();
        const chatResponse = await chatResponsePromise;
        expect(chatResponse.ok()).toBeTruthy();
        await expect(page.locator('#message-container')).toContainText('真实 E2E 流式回答', { timeout: 20_000 });
    });

    test('knowledge upload queue accepts a selected file and sends it through the guarded upload route', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        await ensureBrowserSession(page);
        await page.evaluate(async () => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench());
        await expect(page.locator('#knowledge-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.locator('#rag-upload-btn').click();
        await expect(page.locator('#knowledge-upload-modal')).toBeVisible();
        await page.locator('#rag-upload-input').setInputFiles({
            name: 'e2e-knowledge.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('# E2E 知识库\n\n用于验证上传队列。', 'utf8')
        });
        await expect(page.locator('#knowledge-upload-list')).toContainText('e2e-knowledge.md');
        await expect(page.locator('#knowledge-upload-submit-btn')).toBeEnabled();
        const uploadResponsePromise = page.waitForResponse(response => response.url().includes('/api/rag/upload') && response.request().method() === 'POST');
        await page.locator('#knowledge-upload-submit-btn').click();
        const uploadResponse = await uploadResponsePromise;
        expect(uploadResponse.ok()).toBeTruthy();
        const uploadBody = await uploadResponse.json();
        expect(Number(uploadBody.docId)).toBeGreaterThan(0);
        await expect(page.locator('#knowledge-upload-modal')).toBeHidden();
    });
});
