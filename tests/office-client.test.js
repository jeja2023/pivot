'use strict';
/* global window, document */
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');

test('脑图编辑器可增删节点并提交新版本，节点文字不会注入 DOM', { timeout: 30000 }, async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium, {}) });
    try {
        const page = await browser.newPage();
        await page.setContent('<div id="editor"></div>');
        await page.evaluate(() => {
            window.Pivot = { modules: {}, exposeModule(name, api) { this.modules[name] = api; }, moduleApi(name) { return name === 'agent.artifacts' ? { openVersions: async () => {} } : this.modules[name]; } };
            window.API_BASE = '/api'; window.showToast = () => {};
            window.apiFetch = async (_url, options) => { window.saved = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; };
        });
        await page.addScriptTag({ path: path.resolve('client/chat/mindmap-editor.js') });
        await page.evaluate(() => window.Pivot.modules['chat.mindmapEditor'].mount(document.querySelector('#editor'), { id: 1, type: 'mindmap', content: JSON.stringify({ id: 'root', text: '<script>危险</script>', children: [] }) }));
        assert.equal(await page.locator('#editor script').count(), 0);
        await page.getByRole('button', { name: '添加子节点' }).click();
        assert.equal(await page.locator('#editor input').count(), 2);
        await page.locator('#editor input').nth(1).fill('执行阶段');
        await page.getByRole('button', { name: '保存脑图并生成新图形' }).click();
        await page.waitForFunction(() => Boolean(window.saved));
        assert.equal(await page.evaluate(() => window.saved.tree.children[0].text), '执行阶段');
        await page.getByRole('button', { name: '删除分支' }).click();
        assert.equal(await page.locator('#editor input').count(), 1);
    } finally { await browser.close(); }
});
