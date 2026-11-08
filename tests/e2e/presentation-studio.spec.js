'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs/promises');
const { normalizePresentation } = require('../../server/services/presentations/presentation-schema');

test('原生形状、调整参数、图示连接和故事线可编辑并保存，刷新后恢复', async ({ page }) => {
    test.setTimeout(90000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const content = normalizePresentation({ title: 'PPT制作升级验收', slides: [{ id: 's1', elements: [
        { id: 'title', type: 'text', x: 88, y: 58, width: 1100, height: 80, content: { text: '选择原生形状并编辑几何参数' }, style: { fontSize: 36 } },
        { id: 'arrow', type: 'shape', shapeType: 'rightArrow', x: 180, y: 250, width: 600, height: 240, style: { fill: '#DDECF9', stroke: '#1769AA' } }
    ] }, { id: 's2', elements: [
        { id: 'diagram', type: 'diagram', diagramType: 'cycle', x: 120, y: 160, width: 1000, height: 450, items: ['规划', '执行', '复盘'], style: { fontSize: 24 } }
    ] }] });
    const created = await page.request.post('/api/apps/presentations', { headers, data: { title: content.title, templateId: 'executive-clean', content } });
    expect(created.ok()).toBeTruthy(); const document = (await created.json()).presentation;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(id => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations', presentationId: id }), document.id);
    await expect(page.locator('#presentation-title-input')).toHaveValue(content.title);
    const arrow = page.locator('#presentation-stage [data-presentation-element-id="arrow"]');
    await arrow.click();
    await expect(page.locator('#presentation-shape-type option')).toHaveCount(187);
    await page.locator('[data-presentation-shape-adjust="adj1"]').fill('25');
    await page.locator('#presentation-shape-type').selectOption('hexagon');
    const read = async () => (await (await page.request.get(`/api/apps/presentations/${document.id}`)).json()).presentation;
    await expect.poll(async () => (await read()).content.slides[0].elements.find(item => item.id === 'arrow').shapeType).toBe('hexagon');
    await page.locator('#presentation-shape-type').selectOption('rightArrow');
    await page.locator('[data-presentation-shape-adjust="adj1"]').fill('25');
    await page.locator('[data-presentation-panel="story"]').click();
    await page.locator('#presentation-story-audience').fill('经营负责人');
    await page.locator('#presentation-story-page-purpose').fill('说明执行步骤');
    await page.locator('#presentation-story-takeaway').fill('保留原生编辑能力');
    await page.locator('#presentation-story-stage').selectOption('proposal');
    await page.locator('#presentation-story-duration').fill('5');
    await page.locator('#presentation-story-save').click();
    await expect.poll(async () => (await read()).content.metadata.productionProfile?.audience).toBe('经营负责人');
    await page.locator('.presentation-slide-thumb[data-presentation-slide-id="s2"]').click();
    await page.locator('[data-presentation-panel="properties"]').click();
    await page.locator('#presentation-stage [data-presentation-element-id="diagram"]').click();
    await expect(page.locator('[data-presentation-diagram-edge]')).toHaveCount(3);
    await page.locator('[data-presentation-diagram-node="node_1"]').fill('统筹规划');
    await page.locator('#presentation-diagram-type').selectOption('hierarchy');
    await expect.poll(async () => (await read()).content.slides[1].elements.find(item => item.id === 'diagram').items[0]).toBe('统筹规划');
    // 未改变连接关系时，循环不能仅改名为层级图。
    expect((await read()).content.slides[1].elements.find(item => item.id === 'diagram').diagramType).toBe('cycle');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(id => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations', presentationId: id }), document.id);
    await page.locator('#presentation-stage [data-presentation-element-id="arrow"]').click();
    await expect(page.locator('[data-presentation-shape-adjust="adj1"]')).toHaveValue('25');
    await page.locator('[data-presentation-panel="story"]').click();
    await expect(page.locator('#presentation-story-audience')).toHaveValue('经营负责人');
    await expect(page.locator('#presentation-story-takeaway')).toHaveValue('保留原生编辑能力');
    await page.locator('[data-presentation-panel="issues"]').click();
    await page.locator('#presentation-production-review-btn').click();
    await expect(page.locator('#presentation-production-task-status')).toContainText('最终PPTX', { timeout: 30000 });
    await expect(page.locator('#presentation-issues-list')).toContainText('原生文件核验通过');
    await page.locator('[data-presentation-panel="story"]').click();
    const output = path.resolve('artifacts/presentation-studio-acceptance/browser'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'story-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#presentation-story-panel').screenshot({ path: path.join(output, 'story-mobile.png') });
    const remoteHeaders = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const remoteResponse = await page.request.post(`/api/apps/presentations/${document.id}/remote-sessions`, { headers: remoteHeaders, data: { ttlMinutes: 5 } });
    expect(remoteResponse.ok()).toBeTruthy(); const remoteSession = await remoteResponse.json();
    const display = await page.context().newPage(); display.on('pageerror', error => errors.push(error.message));
    await display.goto(remoteSession.displayUrl);
    await expect(display.locator('#status')).toContainText('已连接');
    const displayedArrow = display.locator('#stage .shape img[alt="向右箭头"]');
    await expect(displayedArrow).toHaveCount(1);
    await expect(displayedArrow).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('#presentation-title-input').fill('远程更新使用最新草稿');
    await expect(display.locator('#title')).toContainText('远程更新使用最新草稿', { timeout: 10000 });
    await display.close();
    const closeHeaders = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    expect((await page.request.delete(`/api/apps/presentations/remote-sessions/${remoteSession.session.id}`, { headers: closeHeaders })).ok()).toBeTruthy();
    expect(errors).toEqual([]);
});
