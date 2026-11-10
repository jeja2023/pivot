/* global window, document */
'use strict';

const { test, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

async function openModeling(page, fileName) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench());
    await page.evaluate(async () => { await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js'); await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' }); });
    await page.locator('#data-analysis-file').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from('订单,金额\na,100\nb,100.00\nc,00100\nd,200\ne,9\nf,20\n') });
    await expect(page.locator('#data-analysis-dataset-table-body')).toContainText(fileName.replace('.csv', ''), { timeout: 20000 });
    await page.locator('[data-data-analysis-tab="modeling"]').click();
    await page.locator('[data-modeling-action="create"]').click();
    const form = page.locator('#modeling-dialog-form');
    await form.locator('[name="modeling_name"]').fill(fileName.replace('.csv', '模型'));
    await form.locator('[name="modeling_factDatasetId"]').selectOption({ label: fileName.replace('.csv', '') });
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-title')).toHaveText(fileName.replace('.csv', '模型'));
    return form;
}

test('节点任务通过真实表单完成数值筛选、聚合、物化、重开与正式模型衔接', async ({ page }) => {
    test.setTimeout(150000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const form = await openModeling(page, 'node-governance.csv');
    await page.locator('[data-canvas-operator="filter"]').click();
    await page.locator('[data-flow-cond-field="0"]').selectOption('金额');
    await page.locator('[data-flow-cond-op="0"]').selectOption('neq');
    await page.locator('[data-flow-cond-val="0"]').fill('100');
    await page.locator('#modeling-drawer [data-modeling-action="preview-node"]').click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('输出 3 行', { timeout: 20000 });
    await page.locator('[data-modeling-action="close-preview"]').click();
    await page.locator('[data-modeling-graph-node="fact"]').click();
    await page.locator('[data-canvas-operator="aggregate"]').click();
    await page.locator('[data-flow-agg-groups]').selectOption([]);
    await page.locator('[data-flow-agg-fn="0"]').selectOption('min');
    await page.locator('[data-flow-agg-field="0"]').selectOption('金额');
    await page.locator('[data-flow-agg-alias="0"]').fill('最小金额');
    await page.locator('[data-flow-add-agg]').click();
    await page.locator('[data-flow-agg-fn="1"]').selectOption('max');
    await page.locator('[data-flow-agg-field="1"]').selectOption('金额');
    await page.locator('[data-flow-agg-alias="1"]').fill('最大金额');
    await page.locator('[data-modeling-action="save"]').click();
    await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    await page.locator('#modeling-drawer [data-modeling-action="preview-node"]').click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('最小金额', { timeout: 20000 });
    const values = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.previewData.rows[0]);
    expect(Number(values['最小金额'])).toBe(9); expect(Number(values['最大金额'])).toBe(200);
    const aggregateId = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.selectedNodeId);
    await page.locator('[data-modeling-action="close-preview"]').click();
    await page.locator('[data-modeling-graph-node="fact"]').click();
    await page.locator('[data-canvas-operator="sql"]').click();
    await page.locator('#modeling-flow-sql-editor').fill('SELECT SUM(a.range*b.range) AS "合计" FROM input_1 CROSS JOIN range(1000000000) a CROSS JOIN range(1000000000) b');
    await page.locator('#modeling-drawer [data-modeling-action="preview-node"]').click();
    await page.waitForFunction(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.nodeJob?.status === 'running');
    await page.locator('[data-modeling-action="cancel-node-job"]').click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('节点任务已取消', { timeout: 15000 });
    await page.locator('[data-modeling-action="close-preview"]').click();
    await page.locator(`[data-modeling-action="node-select"][data-modeling-id="${aggregateId}"]`).click();
    await page.locator('[data-canvas-action="arrange"]').click();
    await page.locator('[data-canvas-action="fit"]').click();
    await page.locator('[data-modeling-action="save"]').click();
    await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    await page.locator('#modeling-drawer [data-modeling-action="materialize-node"]').click();
    await form.locator('[name="modeling_datasetName"]').fill('端到端金额汇总');
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#data-analysis-modeling-dialog')).toBeHidden({ timeout: 20000 });
    await expect(page.locator('#modeling-preview-dock')).toContainText('已生成数据集「端到端金额汇总」');
    const saved = await page.evaluate(() => { const state = window.Pivot.legacy.PivotDataAnalysis.modeling.state; return { modelId: state.selected.id, jobId: state.nodeJob.id, datasetId: state.nodeJob.result.dataset.id }; });
    await page.locator('[data-modeling-action="back"]').click();
    await page.locator(`[data-modeling-action="select"][data-modeling-id="${saved.modelId}"]`).click();
    await page.locator('[data-modeling-action="show-node-jobs"]').click();
    await page.locator('#modeling-node-job').selectOption(saved.jobId);
    await expect(page.locator('#modeling-preview-dock')).toContainText('已生成数据集「端到端金额汇总」');
    const artifacts = path.resolve(__dirname, '../../output/bi-modeling-governance'); await fs.mkdir(artifacts, { recursive: true });
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'node-output-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#modeling-preview-dock .modeling-preview-table-wrap').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'node-output-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-modeling-action="create-from-output"]').click();
    await expect(form.locator('[name="modeling_factDatasetId"]')).toHaveValue(saved.datasetId);
    await form.locator('[name="modeling_name"]').fill('基于输出的正式模型');
    await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-title')).toHaveText('基于输出的正式模型');
    expect(await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.draft.nodes[0].datasetId)).toBe(saved.datasetId);
    expect(errors).toEqual([]);
});

test('目录通过统一分页器跨页检索，服务端筛选后的总数与空状态一致', async ({ page }) => {
    test.setTimeout(90000);
    await openModeling(page, 'directory-governance.csv');
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_e2e_/);
    const { execute } = require('../../server/db/client');
    const modelId = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.selected.id);
    await execute(`INSERT INTO analysis_data_models(id,user_id,name,description,version,model_kind,definition_json,semantic_hash,business_owner,maintenance_contact,updated_at)
        SELECT ?||n,user_id,'分页模型'||n,'浏览器目录验证',version,model_kind,definition_json,semantic_hash,business_owner,maintenance_contact,NOW()-n*INTERVAL '1 second'
        FROM analysis_data_models CROSS JOIN generate_series(1,22) n WHERE id=?`, [`model_page_${crypto.randomUUID().replaceAll('-', '')}_`, modelId]);
    await page.locator('[data-modeling-action="back"]').click();
    await page.locator('#modeling-search').fill('分页模型');
    await expect(page.locator('#modeling-list-pagination')).toContainText('共 22 条');
    await expect(page.locator('#modeling-list-content tbody tr')).toHaveCount(10);
    await page.locator('#modeling-list-pagination').getByRole('button', { name: '末页', exact: true }).click();
    await expect(page.locator('#modeling-list-pagination')).toContainText('第 3 / 3 页');
    await expect(page.locator('#modeling-list-content tbody tr')).toHaveCount(2);
    await page.locator('#modeling-search').fill('分页模型22');
    await expect(page.locator('#modeling-list-pagination')).toContainText('共 1 条');
    await expect(page.locator('#modeling-list-content tbody')).toContainText('分页模型22');
    await page.locator('#modeling-ownership').selectOption('shared');
    await expect(page.locator('#modeling-list-content')).toContainText('没有匹配筛选条件的模型');
    await page.locator('#modeling-ownership').selectOption('mine');
    await expect(page.locator('#modeling-list-content tbody')).toContainText('分页模型22');
});
