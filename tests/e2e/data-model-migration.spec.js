/* global window */
'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

test('从旧探索真实页面创建正式草稿、固定来源对照、发布并明确切换一个旧视图', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill('admin'); await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'); await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
    await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => { await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js'); await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' }); });
    for (const [name, text] of [['migration-orders.csv', '编号,部门,金额\n01,a,10.25\n02,b,20.75\n03,x,5.00\n'], ['migration-departments.csv', '编号,名称\na,甲\nb,乙\n']]) {
        await page.locator('#data-analysis-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText(name.replace('.csv', ''), { timeout: 20000 });
    }
    const fixture = await page.evaluate(async () => {
        const app = window.Pivot.legacy.PivotDataAnalysis;
        const fact = app.state.datasets.find(item => item.name === 'migration-orders'), dim = app.state.datasets.find(item => item.name === 'migration-departments');
        const call = (suffix, body) => app.fetchJson(`${app.API}${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const { model } = await call('/models', { name: '旧订单关联探索' });
        await call(`/models/${model.id}/relations`, { expectedVersion: model.version, leftDatasetId: fact.id, rightDatasetId: dim.id, leftFieldKey: 'c_2', rightFieldKey: 'c_1', joinType: 'left', cardinality: 'many_to_one' });
        await call(`/datasets/${fact.id}/metrics`, { name: '原订单金额', metricConfig: { aggregation: 'sum', fieldKey: 'c_3' }, unit: '元' });
        const { view } = await call(`/datasets/${fact.id}/views`, { name: '待切换的旧视图', viewType: 'query', config: { sql: 'SELECT * FROM data' } });
        return { factId: fact.id, oldId: model.id, viewId: view.id };
    });
    await page.locator('[data-data-analysis-tab="modeling"]').click();
    await page.locator('[data-modeling-action="migrate"]').click();
    const form = page.locator('#modeling-dialog-form');
    await form.locator('[name="modeling_name"]').fill('迁移正式订单');
    await form.locator('[name="modeling_migrationFact"]').selectOption(fixture.factId);
    await form.locator('[name="modeling_migrationGrain"]').selectOption('c_1');
    await form.locator('[name="modeling_grainDescription"]').fill('每行一条订单');
    await form.locator('[name="modeling_businessOwner"]').fill('订单业务人'); await form.locator('[name="modeling_maintenanceContact"]').fill('模型维护人');
    await form.locator('[name="modeling_confirmMigration"]').check(); await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-title')).toHaveText('迁移正式订单');
    await page.locator('[data-modeling-action="check"]').click();
    await expect(page.locator('#modeling-dialog-title')).toHaveText('检查与旧探索对照');
    await form.locator('[name="modeling_comparisonDimensions"]').selectOption({ label: 'migration-orders · 部门' });
    await form.locator('[name="modeling_comparisonMetrics"]').selectOption(['records', 'legacy_metric_0']); await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-content')).toContainText('完整检查通过', { timeout: 20000 });
    await expect(page.locator('#modeling-content')).toContainText('所选范围一致'); await expect(page.locator('#modeling-content')).toContainText('36.00');
    const output = path.resolve(__dirname, '../../output/bi-modeling'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'migration-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#modeling-content section').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'migration-mobile.png'), fullPage: true });
    expect(await page.locator('#modeling-content').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(391);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-modeling-action="publish"]').click();
    const warnings = form.locator('input[type="checkbox"][name^="modeling_warning"]');
    for (let index = 0; index < await warnings.count(); index++) { await warnings.nth(index).check(); await form.locator(`[name="modeling_reason${index}"]`).fill('确认原有未匹配范围，保留左关联'); }
    await form.locator('[name="modeling_confirm"]').check(); await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-version')).toContainText('发布 v1');
    await page.locator('[data-modeling-action="analyze"]').click(); await page.locator('#modeling-query-mode').selectOption('published');
    await page.locator('#modeling-query-dimensions').selectOption({ label: 'migration-orders · 部门' }); await page.locator('#modeling-query-metrics').selectOption('legacy_metric_0');
    await page.locator('[data-modeling-action="run-published"]').click(); await expect(page.locator('#modeling-run-result')).toContainText('36.00', { timeout: 20000 });
    await page.locator('[data-modeling-action="save-view"]').click(); await form.locator('[name="modeling_viewId"]').selectOption(fixture.viewId);
    await form.locator('[name="modeling_viewName"]').fill('已切换订单视图'); await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-dialog-error')).toContainText('明确确认');
    await form.locator('[name="modeling_confirmMigration"]').check(); await form.locator('[type="submit"]').click();
    await expect(page.locator('#data-analysis-modeling-dialog')).toBeHidden();
    const result = await page.evaluate(async input => { const app = window.Pivot.legacy.PivotDataAnalysis; return { view: (await app.fetchJson(`${app.API}/views/${input.viewId}`)).view, old: (await app.fetchJson(`${app.API}/models/${input.oldId}`)).model }; }, fixture);
    expect(result.view.sourceType).toBe('model'); expect(result.view.name).toBe('已切换订单视图'); expect(result.old.modelKind).toBe('exploration'); expect(errors).toEqual([]);
});
