'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
if (process.env.PIVOT_E2E_DEBUG === 'true') test.beforeEach(({ page }) => {
    page.on('pageerror', error => console.error(`浏览器页面异常：${error.message}`));
});

async function login(page) {
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
}

test('PPT 保存失败时返回列表保留编辑，重试成功后才能离开并恢复最新正文', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    const created = page.waitForResponse(response => response.url().endsWith('/api/apps/presentations') && response.request().method() === 'POST');
    await page.locator('#presentation-create-blank-btn').click();
    const id = (await (await created).json()).presentation.id;
    await expect(page.locator('#presentation-title-input')).toBeVisible();
    await page.route(`**/api/apps/presentations/${id}/content`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存服务暂时不可用，请重试。' }) }) : route.continue());
    await page.locator('#presentation-title-input').fill('保存失败仍应保留的最新稿');
    await page.locator('#presentation-back-to-library-btn').click();
    await expect(page.locator('#presentation-save-state')).toContainText('保存失败');
    await expect(page.locator('#presentation-title-input')).toHaveValue('保存失败仍应保留的最新稿');
    await expect(page.locator('#presentation-editor')).toBeVisible();
    await page.unroute(`**/api/apps/presentations/${id}/content`);
    await page.locator('#presentation-back-to-library-btn').click();
    await expect(page.locator('#presentation-library')).toBeVisible();
    await page.locator(`[data-presentation-action="open"][data-presentation-id="${id}"]`).first().click();
    await expect(page.locator('#presentation-title-input')).toHaveValue('保存失败仍应保留的最新稿');
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator('#presentation-back-to-library-btn')).toBeVisible();
    }
});

test('现有模型从界面创建、检查质量、保存关联、汇总、修改与删除形成完整流程', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.evaluate(async () => {
        window.Pivot.legacy.showConfirm = async () => true;
        await window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'data-analysis' });
    });
    const sources = [];
    for (const [name, csv] of [['foundation-sales.csv', '部门,金额\n甲,1200\n乙,200\n'], ['foundation-regions.csv', '部门,负责人\n甲,张三\n乙,李四\n']]) {
        const imported = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/datasets') && response.request().method() === 'POST', { timeout: 20_000 });
        await page.locator('#data-analysis-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
        const response = await imported; expect(response.ok()).toBeTruthy(); sources.push((await response.json()).dataset.id);
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText(name.replace('.csv', ''));
        await expect(page.locator('.data-analysis-panel')).not.toHaveClass(/is-busy/);
    }
    await page.locator('[data-data-analysis-tab="governance"]').click();
    await page.locator('#data-analysis-open-model-modal').click();
    await page.locator('#data-analysis-model-name').fill('可靠性验收模型');
    await page.locator('#data-analysis-model-description').fill('关联订单和负责人');
    const created = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/models') && response.request().method() === 'POST');
    await page.locator('#data-analysis-model-create').click();
    const model = (await (await created).json()).model;
    await page.locator('#data-analysis-open-model-modal').click();
    await page.locator(`#data-analysis-models [data-analysis-model-select="${model.id}"]`).click();
    await page.locator('#data-analysis-open-relation').click();
    await page.locator('#data-analysis-relation-left-dataset').selectOption(sources[0]);
    await page.locator('#data-analysis-relation-right-dataset').selectOption(sources[1]);
    await page.locator('#data-analysis-relation-left-field').selectOption('c_1');
    await page.locator('#data-analysis-relation-right-field').selectOption('c_1');
    await page.locator('#data-analysis-model-relation-run').click();
    await expect(page.locator('#data-analysis-relation-quality')).toContainText('100.0%');
    await page.locator('#data-analysis-model-relation-save').click();
    await expect(page.locator('#data-analysis-relation-modal')).toBeHidden();
    await expect(page.locator('#data-analysis-model-relations')).toContainText('多对一');
    await page.locator('#data-analysis-model-dimension').selectOption(JSON.stringify({ datasetId: sources[1], fieldKey: 'c_2' }));
    await page.locator('#data-analysis-model-measure').selectOption(JSON.stringify({ datasetId: sources[0], fieldKey: 'c_2' }));
    await page.locator('#data-analysis-model-aggregation').selectOption('sum');
    await page.locator('#data-analysis-model-analyze').click();
    await expect(page.locator('#data-analysis-model-query-result')).toContainText('1200');
    await expect(page.locator('#data-analysis-model-query-result')).toContainText('张三');
    await page.locator('[data-analysis-model-edit-relation]').click();
    await page.locator('#data-analysis-relation-join-type').selectOption('inner');
    await page.locator('#data-analysis-model-relation-save').click();
    await expect(page.locator('#data-analysis-model-relations')).toContainText('内关联');
    await page.locator('#data-analysis-model-edit').click();
    await page.locator('#data-analysis-model-name').fill('修改后的可靠性模型');
    await page.locator('#data-analysis-model-create').click();
    await page.locator('#data-analysis-open-model-modal').click();
    await expect(page.locator('#data-analysis-models')).toContainText('修改后的可靠性模型');
    await page.locator('[data-analysis-model-delete-relation]').click();
    await expect(page.locator('#data-analysis-model-relations')).toContainText('暂未配置关联');
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator('#data-analysis-model-delete')).toBeVisible();
        const modal = page.locator('#data-analysis-model-modal .modal');
        expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBeTruthy();
    }
    await page.locator('#data-analysis-model-delete').click();
    await expect(page.locator(`#data-analysis-models [data-analysis-model-select="${model.id}"]`)).toHaveCount(0);
});
