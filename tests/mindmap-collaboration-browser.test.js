'use strict';
/* global window, document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const documents = require('../server/services/mindmaps/documents');
const product = require('../server/services/mindmaps/product');
async function account() { return queryOne("INSERT INTO users(username,password_hash,nickname,unit,role,status,created_at) VALUES(?,?,'浏览器协作测试','QA','user','active',NOW()) RETURNING id,username,role,unit", [`collab_${crypto.randomUUID()}`, 'test-hash']); }
test('两个真实浏览器会话断网编辑后收敛，只读与撤权生效，本地撤销不覆盖他人修改', { timeout: 120000 }, async () => {
    const owner = await account(); const editor = await account(); const viewer = await account();
    const created = await documents.save(owner, { tree: { id: 'root', text: '团队计划', children: [{ id: 'a', text: '甲任务' }, { id: 'b', text: '乙任务' }] }, requestKey: `browser:${crypto.randomUUID()}` });
    await product.setSharing(owner, created.id, { enabled: true, expectedVersionId: created.versionId, expectedRevision: 1, members: [{ userId: editor.id, role: 'editor' }, { userId: viewer.id, role: 'viewer' }] });
    const app = express(); const router = express.Router(); app.use(express.json({ limit: '2mb' }));
    const users = new Map([owner, editor, viewer].map(user => [String(user.id), user]));
    require('../server/routes/apps/mindmaps').registerMindmapRoutes(router, { authMiddleware: (req, res, next) => { req.user = users.get(req.get('x-test-user')); if (!req.user) return res.sendStatus(401); next(); } }); app.use('/api', router);
    app.use('/common', express.static(path.resolve('client/common'))); app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/fixture.js', (req, res) => res.type('js').send(`window.Pivot.legacy.currentUser={id:${JSON.stringify(req.get('x-test-user'))}};window.Pivot.legacy.apiFetch=(url,options)=>fetch(url,options);window.Pivot.legacy.showToast=message=>{document.getElementById('toast').textContent=message};window.Pivot.exposeModule('workspaces.apps',{setStoredAppsActiveApp:()=>{}});window.Pivot.moduleApi('apps.mindmaps').show({artifactId:${JSON.stringify(created.id)}}).catch(e=>document.getElementById('toast').textContent=e.message);`));
    app.get('/', (_req, res) => { res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"); res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/chat.workspace.apps.css"><button id="apps-back-btn">返回</button><h3 id="apps-workspace-title"></h3><p id="apps-workspace-desc"></p><div><div id="apps-home-view"></div>${fs.readFileSync(path.resolve('client/chat/partials/workspaces/apps-mindmaps.html'), 'utf8')}</div><p id="toast"></p><script src="/chat/pivot-core.js"></script><script src="/common/vendor/purify.min.js"></script><script src="/chat/safe-html.js"></script><script src="/common/mindmap-document.js"></script><script src="/chat/apps-workbench-mindmaps.js"></script><script src="/fixture.js"></script>`); });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
    const origin = `http://127.0.0.1:${server.address().port}`; const errors = [];
    try {
        const contexts = await Promise.all([owner, editor, viewer].map(user => browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-test-user': String(user.id) } })));
        const pages = await Promise.all(contexts.map(async context => { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await page.locator('#mindmap-canvas .smm-node').first().waitFor(); return page; }));
        const [a, b, reader] = pages;
        assert.ok(await reader.getByRole('button', { name: '保存', exact: true }).isDisabled()); assert.ok(await reader.getByRole('button', { name: '子节点', exact: true }).isDisabled());
        async function edit(page, nodeId, text) {
            await page.locator(`[data-mm-node="${nodeId}"]`).click(); await page.waitForFunction(id => document.querySelector('#mindmap-selection').textContent.includes(id), nodeId === 'a' ? '甲' : '乙');
            await page.locator('#mindmap-node-text').fill(text); await page.getByRole('button', { name: '应用到节点', exact: true }).click(); await page.waitForFunction(text => document.querySelector('#mindmap-outline').textContent.includes(text), text);
        }
        await contexts[1].setOffline(true);
        await edit(b, 'b', '乙方离线修改'); await edit(a, 'a', '甲方在线修改');
        await a.getByRole('button', { name: '保存', exact: true }).click(); await a.waitForFunction(() => document.querySelector('#mindmap-save-status').textContent.includes('已保存'));
        await contexts[1].setOffline(false); await b.getByRole('button', { name: '保存', exact: true }).click();
        await Promise.all([a, b, reader].map(page => page.waitForFunction(() => { const text = document.querySelector('#mindmap-outline').textContent; return text.includes('甲方在线修改') && text.includes('乙方离线修改'); }, null, { timeout: 15000 })));
        const idleVersion = (await documents.get(owner, created.id)).versionId;
        await a.waitForTimeout(4500);
        assert.equal((await documents.get(owner, created.id)).versionId, idleVersion, '仅同步远端内容不能产生新的自动保存版本');
        await a.getByRole('button', { name: '撤销', exact: true }).click(); await a.getByRole('button', { name: '保存', exact: true }).click();
        await b.waitForFunction(() => { const text = document.querySelector('#mindmap-outline').textContent; return text.includes('甲任务') && text.includes('乙方离线修改'); });
        let syncRequests = 0; let resumeSync; let notifySync;
        const arrived = new Promise(resolve => { notifySync = resolve; }); const gate = new Promise(resolve => { resumeSync = resolve; });
        await contexts[0].route('**/api/apps/mindmaps/*/sync?*', async route => { syncRequests++; const response = await route.fetch(); notifySync(); await gate; await route.fulfill({ response }); });
        await arrived; await a.evaluate(() => window.Pivot.moduleApi('apps.mindmaps').suspend()); resumeSync(); await a.waitForTimeout(2500);
        assert.equal(syncRequests, 1, '离开工作区后，延迟响应不能再次启动协作同步');
        await contexts[0].unroute('**/api/apps/mindmaps/*/sync?*');
        const current = await documents.get(owner, created.id); const config = await product.sharing(owner, created.id);
        await product.setSharing(owner, created.id, { enabled: true, expectedVersionId: current.versionId, expectedRevision: config.revision, members: [{ userId: viewer.id, role: 'viewer' }] });
        await b.waitForFunction(() => document.querySelector('#mindmap-save-status').textContent.includes('撤销'), null, { timeout: 15000 });
        assert.ok(await b.getByRole('button', { name: '子节点', exact: true }).isDisabled());
        await assert.rejects(documents.get(editor, created.id), error => error.status === 404); assert.deepEqual(errors, []);
        await b.evaluate(() => window.Pivot.moduleApi('apps.mindmaps').logout());
        assert.equal(await b.locator('#mindmap-outline').textContent(), ''); assert.equal(await b.locator('#mindmap-node-text').inputValue(), ''); assert.equal(await b.locator('#mindmap-dialog-body').textContent(), '');
        for (const page of pages) await page.evaluate(() => window.Pivot.moduleApi('apps.mindmaps').suspend());
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); for (const user of [owner, editor, viewer]) await execute('DELETE FROM users WHERE id=?', [user.id]); }
});
