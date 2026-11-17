/* global window -- 浏览器回调在页面上下文运行。 */
'use strict';
const { test, expect } = require('@playwright/test');

for (const width of [1366,390]) test(`审查修复：${width}宽度按需加载知识与项目，首次失败可重试`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const requested=[];
    page.on('request',request=>requested.push(new URL(request.url()).pathname));
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-container')).toBeHidden();
    for(const file of ['knowledge-product.js','knowledge-wiki.js','agent-projects.js'])expect(requested).not.toContain('/chat/'+file);
    await page.evaluate(()=>window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench());
    await expect(page.locator('#knowledge-workbench-modal')).toBeVisible();
    expect(requested).toContain('/chat/knowledge-product.js');expect(requested).toContain('/chat/knowledge-wiki.js');
    await page.route('**/chat/agent-projects.js*',route=>route.abort(),{times:1});
    await page.evaluate(()=>window.Pivot.moduleApi('agent.projects').open());
    await page.evaluate(()=>window.Pivot.moduleApi('agent.projects').open());
    await expect(page.locator('#agent-projects-modal')).toBeVisible();
    await expect(page.locator('#agent-projects-title')).toHaveText('项目空间');
});
