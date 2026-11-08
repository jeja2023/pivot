/* global window -- 设置分页与监控弹窗事件隔离回归。 */
const { test, expect } = require('@playwright/test');

async function openSettings(page) {
    const login = await page.request.post('/api/auth/login', {
        data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
    });
    expect(login.ok()).toBeTruthy();
    await page.goto('/chat');
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'logs', restore: false }));
}

for (const width of [1280, 390]) {
    test(`设置页分页不会打开监控失败明细（${width}px）`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        const pages = { logs: [], users: [], memories: [] };
        let failureCalls = 0;
        await page.route('**/api/stats/observability/decision-failures?*', route => {
            failureCalls++;
            return route.fulfill({ json: { items: [], total: 0 } });
        });
        for (const [tab, endpoint] of [['logs', 'admin/logs'], ['users', 'admin/users'], ['memories', 'memories']]) {
            await page.route(`**/api/${endpoint}?*`, route => {
                const params = new URL(route.request().url()).searchParams;
                const current = tab === 'memories'
                    ? Number(params.get('offset')) / Number(params.get('limit')) + 1
                    : Number(params.get('page'));
                pages[tab].push(current);
                const item = { id: current, username: '分页回归用户', role: 'user', action: '分页回归', details: `第${current}页`, content: `第${current}页`, type: 'fact', status: 'active' };
                return route.fulfill({ json: { data: [item], memories: [item], total: 60 } });
            });
        }
        await openSettings(page);
        const modal = page.locator('#monitor-failure-modal');
        await expect(modal).toHaveClass(/hidden/);
        for (const tab of ['logs', 'users', 'memories']) {
            await page.locator(`#tab-${tab}`).click();
            const pager = page.locator(`#pagination-${tab}`);
            const lastPage = tab === 'users' ? 4 : 3;
            await expect(pager).toContainText(`第 1 / ${lastPage} 页`);
            for (const [label, target] of [['下一页', 2], ['末页', lastPage], ['上一页', lastPage - 1], ['首页', 1]]) {
                const calls = pages[tab].length;
                await pager.getByRole('button', { name: label, exact: true }).click();
                await expect(pager).toContainText(`第 ${target} / ${lastPage} 页`);
                expect(pages[tab].slice(calls)).toEqual([target]);
                await expect(modal).toHaveClass(/hidden/);
                expect(failureCalls).toBe(0);
            }
        }
    });

    test(`监控失败明细翻页每次只请求一次（${width}px）`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        const requests = [];
        await page.route('**/api/stats/observability/decision-failures?*', route => {
            const params = new URL(route.request().url()).searchParams;
            requests.push({ kind: params.get('kind'), offset: Number(params.get('offset')) });
            return route.fulfill({ json: { items: [], total: 60 } });
        });
        await openSettings(page);
        for (const kind of ['delivery', 'provider']) {
            await page.evaluate(kind => window.Pivot.moduleApi('settings.monitorDashboard').loadFailureDetails(kind), kind);
            const modal = page.locator('#monitor-failure-modal');
            const pager = modal.locator('#monitor-failure-pagination');
            await expect(modal).toBeVisible();
            for (const [label, target] of [['下一页', 2], ['末页', 3], ['上一页', 2], ['首页', 1]]) {
                const calls = requests.length;
                await pager.getByRole('button', { name: label, exact: true }).click();
                await expect(pager).toContainText(`第 ${target} / 3 页`);
                expect(requests.slice(calls)).toEqual([{ kind, offset: (target - 1) * 20 }]);
            }
            if (kind === 'provider') await page.keyboard.press('Escape');
            else await modal.getByRole('button', { name: '关闭明细弹窗' }).click();
            await expect(modal).toHaveClass(/hidden/);
        }
    });
}

test('备用分页仅响应监控弹窗内的按钮', async ({ page }) => {
    const requests = [];
    await page.route('**/api/stats/observability/decision-failures?*', route => {
        const params = new URL(route.request().url()).searchParams;
        requests.push({ kind: params.get('kind'), offset: Number(params.get('offset')) });
        return route.fulfill({ json: { items: [], total: 60 } });
    });
    await openSettings(page);
    await page.evaluate(() => {
        const outside = window.document.createElement('button');
        outside.dataset.monitorFailurePage = '2';
        window.document.body.append(outside);
        outside.click();
        outside.remove();
        window.Pivot.legacy.renderWorkspacePagination = undefined;
        window.Pivot.moduleApi('chat.ui').renderWorkspacePagination = undefined;
    });
    expect(requests).toEqual([]);
    const modal = page.locator('#monitor-failure-modal');
    await expect(modal).toHaveClass(/hidden/);
    await page.evaluate(() => window.Pivot.moduleApi('settings.monitorDashboard').loadFailureDetails('provider'));
    const pager = modal.locator('#monitor-failure-pagination');
    await expect(pager.locator('[data-monitor-failure-page]')).toHaveCount(4);
    for (const [label, target] of [['下一页', 2], ['末页', 3], ['上一页', 2], ['首页', 1]]) {
        const calls = requests.length;
        await pager.getByRole('button', { name: label, exact: true }).click();
        await expect(pager).toContainText(`第 ${target} / 3 页`);
        expect(requests.slice(calls)).toEqual([{ kind: 'provider', offset: (target - 1) * 20 }]);
    }
    await modal.getByRole('button', { name: '关闭明细弹窗' }).click();
    await expect(modal).toHaveClass(/hidden/);
});
