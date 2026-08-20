/* global document, Event, window -- Playwright 浏览器端执行上下文全局变量 */
const { expect, test } = require('@playwright/test');

test.describe('Pivot browser smoke', () => {
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

        await expect(page.locator('#usage-title')).toHaveText('用量审计');
        await expect(page.locator('#tab-content-stats')).toBeVisible();
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeHidden();

        await page.locator('#usage-subtab-details').click();
        await expect(page.locator('#usage-subtab-details')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#tab-content-stats')).toBeHidden();
        await expect(page.locator('#tab-content-details')).toBeVisible();

        await page.locator('#usage-subtab-report').click();
        await expect(page.locator('#usage-subtab-report')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeVisible();
        await expect(page.locator('#report-query-btn')).toBeVisible();
    });
});
