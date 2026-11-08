/* global window, document */
'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

test('一体化画布、单圆点节点、右侧弹出抽屉、内置算子与函数 SQL 及节点实时预览完整验收', async ({ page }) => {
    test.setTimeout(120000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill('admin'); await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'); await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
    const artifactRoot = path.resolve(__dirname, '../../output/bi-modeling-canvas'); await fs.mkdir(artifactRoot, { recursive: true });
    await expect(page.locator('[data-app-id="data-modeling"]')).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: path.join(artifactRoot, 'apps-center.png'), fullPage: true });
    await page.locator('[data-app-id="data-modeling"]').click();
    await expect(page.locator('#apps-workspace-title')).toHaveText('数据建模');
    await expect(page.locator('.data-analysis-sidebar')).toBeHidden();
    await expect(page.locator('#modeling-list')).toBeVisible();
    await page.screenshot({ path: path.join(artifactRoot, 'modeling-list-desktop.png'), fullPage: true });
    await page.locator('[data-modeling-action="goto-analysis"]').click();
    await expect(page.locator('#apps-workspace-title')).toHaveText('数据分析');
    await expect(page.locator('.data-analysis-sidebar')).toBeVisible();
    for (const [name, csv] of [['canvas-orders.csv', '订单,地区码,金额\n1,N,10.25\n2,S,20.50\n'], ['canvas-regions.csv', '地区码,地区名称\nN,北区\nS,南区\n']]) {
        await page.locator('#data-analysis-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText(name.replace('.csv', ''), { timeout: 20000 });
    }
    await page.locator('[data-data-analysis-tab="modeling"]').click();
    await expect(page.locator('#apps-workspace-title')).toHaveText('数据建模');
    await expect(page.locator('.data-analysis-sidebar')).toBeHidden();
    await page.locator('[data-modeling-action="create"]').click();
    const form = page.locator('#modeling-dialog-form');
    await form.locator('[name="modeling_name"]').fill('可视化订单模型');
    await form.locator('[name="modeling_businessOwner"]').fill('业务负责人'); await form.locator('[name="modeling_maintenanceContact"]').fill('维护联系人');
    await form.locator('[name="modeling_factDatasetId"]').selectOption({ label: 'canvas-orders' }); await form.locator('[type="submit"]').click();
    await expect(page.locator('#modeling-title')).toHaveText('可视化订单模型');

    // 验证已移除人为分隔的四步导航栏，且初始状态右侧抽屉收起不占用画布
    await expect(page.locator('.modeling-steps-nav')).toHaveCount(0);
    await expect(page.locator('#modeling-drawer')).toHaveCount(0);

    // 验证主表卡片仅保留单一输出圆点，绝不在节点上按字段逐行打点
    await expect(page.locator('[data-canvas-node="fact"][data-canvas-port]')).toHaveCount(1);

    await page.locator('[data-modeling-action="node"]').click();
    await form.locator('[name="modeling_grainDescription"]').fill('每行一个订单'); await form.locator('[name="modeling_grainKeys"]').selectOption('c_1'); await form.locator('[type="submit"]').click();

    // 拖入维度表，验证维度表仅有一个左侧输入点和一个右侧输出点
    const palette = page.locator('[data-canvas-dataset]').filter({ hasText: 'canvas-regions' });
    await expect(palette).toHaveAttribute('draggable', 'true');
    await palette.dragTo(page.locator('#modeling-graph'), { targetPosition: { x: 420, y: 80 } });
    await expect(page.locator('#modeling-dialog-title')).toHaveText('添加维度表');
    await form.locator('[name="modeling_grainKeys"]').selectOption('c_1'); await form.locator('[type="submit"]').click();
    await expect(page.locator('[data-modeling-graph-node]')).toHaveCount(2);
    const dimensionId = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.draft.nodes.find(node => node.role === 'dimension').id);
    const dimension = page.locator(`[data-modeling-graph-node="${dimensionId}"]`);
    await expect(page.locator(`[data-canvas-node="${dimensionId}"][data-canvas-port="in"]`)).toHaveCount(1);
    await expect(page.locator(`[data-canvas-node="${dimensionId}"][data-canvas-port="out"]`)).toHaveCount(1);

    // 单圆点连线并自动推荐关联字段配对
    const source = page.locator('[data-canvas-node="fact"][data-canvas-port="out"]');
    const target = page.locator(`[data-canvas-node="${dimensionId}"][data-canvas-port="in"]`);
    const connect = async () => {
        const left = await source.boundingBox(), right = await target.boundingBox();
        await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2); await page.mouse.down();
        await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2, { steps: 16 }); await page.mouse.up();
    };
    await connect();
    await expect(page.locator('#modeling-dialog-title')).toHaveText('添加关联');
    await expect(form.locator('[name="modeling_leftKey0"]')).toHaveValue('c_2'); await expect(form.locator('[name="modeling_rightKey0"]')).toHaveValue('c_1');
    expect(await page.locator('[data-modeling-graph-relation]').count()).toBe(0);
    await page.locator('[data-modeling-action="close-dialog"]').last().click();
    expect(await page.locator('[data-modeling-graph-relation]').count()).toBe(0);
    await connect(); await form.locator('[type="submit"]').click();
    await expect(page.locator('[data-modeling-graph-relation]')).toHaveCount(1);

    // 点击节点弹出右侧抽屉，支持字段搜索筛选与关闭抽屉
    await page.locator('[data-modeling-graph-node="fact"]').click();
    await expect(page.locator('#modeling-drawer')).toBeVisible();
    await page.locator('#modeling-field-search').fill('金额');
    await expect(page.locator('#modeling-drawer-field-list .modeling-field-item')).toHaveCount(1);
    await page.locator('[data-modeling-action="close-drawer"]').click();
    await expect(page.locator('#modeling-drawer')).toHaveCount(0);

    await page.locator('[data-modeling-action="save"]').click(); await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    const semanticBefore = await page.evaluate(async () => {
        const m = window.Pivot.legacy.PivotDataAnalysis.modeling;
        return JSON.stringify((await m.request(`/models/${m.state.selected.id}`)).model.definition);
    });

    // 验证节点拖动、Escape 取消与重开保留布局且不改变语义定义
    const before = await dimension.getAttribute('transform'), header = dimension.locator('.modeling-canvas-heading'), headerBox = await header.boundingBox();
    await page.mouse.move(headerBox.x + 20, headerBox.y + 5); await page.mouse.down(); await page.mouse.move(headerBox.x + 80, headerBox.y + 55, { steps: 8 });
    await page.keyboard.press('Escape'); await page.mouse.up(); await expect(dimension).toHaveAttribute('transform', before);
    await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    const moveBox = await dimension.locator('.modeling-canvas-heading').boundingBox();
    await page.mouse.move(moveBox.x + 20, moveBox.y + 5); await page.mouse.down(); await page.mouse.move(moveBox.x + 90, moveBox.y + 45, { steps: 8 }); await page.mouse.up();
    await expect(page.locator('#modeling-save-state')).toHaveText('未保存');
    await page.locator('[data-modeling-action="save"]').click(); await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    const savedLayout = await dimension.getAttribute('transform'); expect(savedLayout).not.toBe(before);
    const modelId = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.modeling.state.selected.id);
    await page.locator('[data-modeling-action="back"]').click(); await page.locator(`[data-modeling-action="select"][data-modeling-id="${modelId}"]`).click();
    await expect(page.locator(`[data-modeling-graph-node="${dimensionId}"]`)).toHaveAttribute('transform', savedLayout);
    expect(await page.evaluate(async () => { const m = window.Pivot.legacy.PivotDataAnalysis.modeling; return JSON.stringify((await m.request(`/models/${m.state.selected.id}`)).model.definition); })).toBe(semanticBefore);

    // 方向键微调节点位置
    const keyboardBefore = await page.evaluate(id => ({ ...window.Pivot.legacy.PivotDataAnalysis.modeling.state.canvasLayout[id] }), dimensionId);
    await dimension.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    await expect(dimension).toHaveAttribute('transform', `translate(${keyboardBefore.x + 10},${keyboardBefore.y + 10})`);
    expect(await page.evaluate(() => JSON.stringify(window.Pivot.legacy.PivotDataAnalysis.modeling.state.draft))).toBe(semanticBefore);

    // 验证内置算子（筛选 -> 函数计算 -> 自定义 SQL）串联及节点到节点实时运行预览
    await page.locator('[data-modeling-graph-node="fact"]').click();
    await page.locator('[data-canvas-operator="filter"]').click();
    await expect(page.locator('#modeling-drawer')).toBeVisible();
    await page.locator('[data-flow-cond-field="0"]').selectOption('金额');
    await page.locator('[data-flow-cond-op="0"]').selectOption('gt');
    await page.locator('[data-flow-cond-val="0"]').fill('15');
    await page.locator('#modeling-drawer [data-modeling-action="preview-node"]').click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('上游 2 行 → 输出 1 行', { timeout: 15000 });
    await expect(page.locator('#modeling-preview-dock')).toContainText('20.5');

    // 在筛选节点后继续串联内置函数计算算子与自定义 SQL 算子，并对比流转链路各步预览
    await page.locator('[data-canvas-operator="formula"]').click();
    await page.locator('[data-flow-formula-name="0"]').fill('加倍金额');
    await page.locator('[data-flow-formula-expr="0"]').fill('');
    await page.locator('[data-flow-insert-fn]').first().click();
    await page.locator('[data-flow-formula-expr="0"]').fill('ROUND(TRY_CAST("金额" AS DOUBLE) * 2, 2)');
    await page.locator('[data-canvas-operator="sql"]').click();
    await page.locator('#modeling-flow-sql-editor').fill('SELECT "订单", "加倍金额" FROM input_1');
    await page.locator('#modeling-drawer [data-modeling-action="preview-node"]').click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('41', { timeout: 15000 });
    await expect(page.locator('.modeling-preview-steps .modeling-step-chip')).toHaveCount(4);
    await page.locator('.modeling-preview-steps .modeling-step-chip').first().click();
    await expect(page.locator('#modeling-preview-dock')).toContainText('共 2 行', { timeout: 15000 });
    await page.locator('[data-modeling-action="close-drawer"]').click();

    await page.locator('[data-modeling-action="save"]').click(); await expect(page.locator('#modeling-save-state')).toHaveText('已保存');

    // 关联线回车编辑与删除重建
    const edge = page.locator('[data-modeling-graph-relation]'); await edge.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#modeling-dialog-title')).toHaveText('编辑关联'); await form.locator('[name="modeling_joinType"]').selectOption('inner'); await form.locator('[type="submit"]').click();
    await expect(edge).toContainText('内关联');
    await edge.focus(); await page.keyboard.press('Delete'); await page.locator('#confirm-ok-btn').click();
    await expect(page.locator('[data-modeling-graph-relation]')).toHaveCount(0);
    await source.focus(); await page.keyboard.press('Enter'); await target.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#modeling-dialog-title')).toHaveText('添加关联');
    await form.locator('[name="modeling_joinType"]').selectOption('inner'); await form.locator('[type="submit"]').click();
    await expect(page.locator('[data-modeling-graph-relation]')).toHaveCount(1);

    await page.locator('[data-canvas-action="arrange"]').click();
    await page.locator('[data-canvas-action="fit"]').click();
    await page.locator('[data-modeling-action="save"]').click(); await expect(page.locator('#modeling-save-state')).toHaveText('已保存');
    await page.screenshot({ path: path.join(artifactRoot, 'desktop.png'), fullPage: true });

    // 打开右侧算子抽屉截取桌面端完整效果
    await page.locator('[data-modeling-graph-node^="flow_formula_"]').click();
    await page.screenshot({ path: path.join(artifactRoot, 'desktop-drawer-preview.png'), fullPage: true });
    await page.locator('[data-modeling-action="close-drawer"]').click();

    // 窄屏响应式与归档只读保护
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-modeling-action="relation"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(artifactRoot, 'mobile.png'), fullPage: true });
    await page.locator('.modeling-graph-container').scrollIntoViewIfNeeded();
    await page.locator('[data-canvas-action="fit"]').click();
    await page.screenshot({ path: path.join(artifactRoot, 'mobile-canvas.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.locator('.modeling-more summary').click();
    await page.locator('[data-modeling-action="archive"]').click();
    await page.locator('#confirm-ok-btn').click();
    await expect(page.locator('#modeling-status')).toContainText('已归档');
    await expect(page.locator('[data-canvas-action="arrange"]')).toBeDisabled();
    const readOnly = await page.evaluate(() => JSON.stringify(window.Pivot.legacy.PivotDataAnalysis.modeling.state.canvasLayout));
    await page.locator('[data-modeling-graph-node="fact"]').focus(); await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => JSON.stringify(window.Pivot.legacy.PivotDataAnalysis.modeling.state.canvasLayout))).toBe(readOnly);
    expect(errors).toEqual([]);
});
