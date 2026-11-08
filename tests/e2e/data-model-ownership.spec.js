/* global window */
'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

async function login(page, username, password) {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
}
async function modeling(page) {
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
    await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => { await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js'); await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' }); });
}

test('通过双方真实页面完成模型交接并在移动端核对影响与责任', async ({ page, browser, baseURL }) => {
    test.setTimeout(90000);
    const suffix = Date.now().toString(36), username = `bi_receiver_${suffix}`, password = 'Receiver123';
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, 'admin', process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await modeling(page);
    const recipient = await page.evaluate(async input => {
        return (await window.Pivot.legacy.PivotDataAnalysis.fetchJson('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: input.username, password: input.password, nickname: '交接接收人', unit: 'QA', role: 'user' }) })).user;
    }, { username, password });
    await page.locator('#data-analysis-file').setInputFiles({ name: `ownership-${suffix}.csv`, mimeType: 'text/csv', buffer: Buffer.from('编号,金额\n01,10.25\n02,20.75\n') });
    await expect(page.locator('#data-analysis-dataset-table-body')).toContainText(`ownership-${suffix}`, { timeout: 20000 });
    const datasetId = await page.evaluate(async id => {
        const app = window.Pivot.legacy.PivotDataAnalysis;
        const dataset = app.state.datasets.find(item => item.name.startsWith('ownership-'));
        await app.fetchJson(`${app.API}/datasets/${dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: dataset.name, scope: 'shared', allowedUserIds: String(id) }) });
        return dataset.id;
    }, recipient.id);
    await page.locator('[data-data-analysis-tab="modeling"]').click();
    await page.locator('[data-modeling-action="create"]').click();
    const form = page.locator('#modeling-dialog-form');
    await form.locator('[name="modeling_name"]').fill(`交接验收 ${suffix}`);
    await form.locator('[name="modeling_businessOwner"]').fill('原业务人'); await form.locator('[name="modeling_maintenanceContact"]').fill('原维护人');
    await form.locator('[name="modeling_factDatasetId"]').selectOption(datasetId);
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-title')).toHaveText(`交接验收 ${suffix}`);
    await page.locator('.modeling-more summary').click();
    await page.locator('[data-modeling-action="transfer"]').click();
    await form.locator('[name="modeling_recipientId"]').selectOption(String(recipient.id));
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-dialog-title')).toHaveText('确认模型交接影响');
    await form.locator('[name="modeling_businessOwner"]').fill('新业务人'); await form.locator('[name="modeling_maintenanceContact"]').fill('新维护人');
    await form.locator('[name="modeling_reason"]').fill('验收离岗交接'); await form.locator('[name="modeling_confirm"]').check();
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#data-analysis-modeling-dialog')).toBeHidden();
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
    try {
        const receiverPage = await context.newPage(); await login(receiverPage, username, password); await modeling(receiverPage);
        await receiverPage.locator('[data-data-analysis-tab="modeling"]').click();
        await receiverPage.locator('[data-modeling-action="transfers"]').click();
        await receiverPage.locator('[data-modeling-action="open-transfer"]').first().click();
        await expect(receiverPage.locator('#modeling-dialog-body')).toContainText('验收离岗交接');
        const receiverForm = receiverPage.locator('#modeling-dialog-form');
        await receiverForm.locator('[name="modeling_sources"]').check(); await receiverForm.locator('[name="modeling_personalScope"]').check();
        await receiverForm.locator('[name="modeling_credentials"]').check(); await receiverForm.locator('[name="modeling_pausedPlans"]').check(); await receiverForm.locator('[name="modeling_contacts"]').check();
        await receiverForm.locator('[name="modeling_comment"]').fill('已核对来源、共享、凭据、计划和责任');
        const output = path.resolve(__dirname, '../../output/bi-modeling'); await fs.mkdir(output, { recursive: true });
        await receiverPage.screenshot({ path: path.join(output, 'ownership-mobile.png'), fullPage: true });
        const bounds = await receiverPage.locator('.modeling-dialog').boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
        await receiverForm.locator('[type="submit"]').click();
        await expect(receiverPage.locator('#data-analysis-modeling-dialog')).toBeHidden();
        await expect(receiverPage.locator('#modeling-list-content')).toContainText(`交接验收 ${suffix}`);
        await receiverPage.locator('[data-modeling-action="select"]').first().click();
        await expect(receiverPage.locator('#modeling-status')).toContainText('所有者可编辑');
        await expect(receiverPage.locator('[data-modeling-action="basic"]')).toBeEnabled();
        await page.locator('[data-modeling-action="back"]').click(); await page.locator('[data-modeling-action="refresh-list"]').click();
        await expect(page.locator('#modeling-list-content')).not.toContainText(`交接验收 ${suffix}`);
    } finally { await context.close(); }
});
