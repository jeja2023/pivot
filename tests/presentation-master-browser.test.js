/* global window, document, Option */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');
const { Document, Packer, Paragraph } = require('docx');
const { createPresentationsRouter } = require('../server/routes/apps/presentations');
const { createSafeUpload } = require('../server/upload');
const root = path.resolve(__dirname, '..');
const template = { type: 'runtime', id: 'master-style-consulting-decision', name: '咨询决策' };

async function fixture() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-master-form-'));
    const app = express(), requests = [];
    app.use(express.json());
    app.get('/fixture', (_req, res) => res.send('<!DOCTYPE html><html lang="zh-CN"><body><button id="entry">按模板创建</button></body></html>'));
    const authMiddleware = (req, res, next) => {
        if (req.headers['x-fixture-user'] !== '1') return res.status(401).json({ error: '请先登录。' });
        req.user = { id: 1 }; next();
    };
    const router = createPresentationsRouter({ authMiddleware, uploadLimiter: (_req, _res, next) => next(), upload: createSafeUpload({ root: directory, fileSize: 10 * 1024 * 1024 }) });
    const extraction = router.stack.find(layer => layer.route?.path === '/apps/presentations/materials/extract');
    // 只挂载真实材料路由，制作任务使用受控响应，避免依赖模型或数据库。
    app.post('/api' + extraction.route.path, ...extraction.route.stack.map(layer => layer.handle));
    app.post('/api/apps/presentations/master/tasks', (req, res) => {
        requests.push(require('../server/services/presentations/master/contract').normalize(req.body));
        res.json({ task: { id: 'fixture-task' } });
    });
    app.get('/api/apps/presentations/master/info', (_req, res) => res.json({ engine: { enabled: true } }));
    app.get('/api/apps/presentations/master/tasks/latest', (_req, res) => res.json({ task: null }));
    app.get('/api/apps/presentations/master/tasks/fixture-task', (_req, res) => {
        const task = { id: 'fixture-task', status: 'completed', result: { message: '测试制作已接收材料' } };
        res.json({ task });
    });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const browser = await chromium.launch({ headless: true });
    return { browser, directory, requests, url: `http://127.0.0.1:${server.address().port}`, async close() {
        await browser.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
    } };
}
async function pageFor(context, viewport = { width: 1366, height: 768 }, colorScheme = 'light') {
    const page = await context.browser.newPage({ viewport, colorScheme, locale: 'en-US' });
    page.setDefaultTimeout(7000);
    await page.goto(context.url + '/fixture');
    for (const file of ['client/common/styles/theme.css', 'client/chat/chat.shell.css', 'client/chat/chat.workspace.apps.css']) await page.addStyleTag({ path: path.join(root, file) });
    await page.evaluate(() => {
        const modules = {};
        window.fixtureState = { active: null };
        window.Pivot = { legacy: { currentUser: { id: 1 }, PivotAppModels: { refresh: async (_app, id) => document.getElementById(id).replaceChildren(new Option('制作模型', '1')) } },
            exposeModule: (name, value) => modules[name] = value, moduleApi: name => modules[name] };
        window.fixtureHelpers = { requestJson: async (url, options = {}) => {
            const response = await fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-user': '1' } });
            const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
        } };
    });
    for (const file of ['apps-workbench-presentation-goals.js', 'apps-workbench-presentation-master-form.js', 'apps-workbench-presentation-master.js']) await page.addScriptTag({ path: path.join(root, 'client/chat', file) });
    await page.evaluate(template => {
        window.Pivot.moduleApi('apps.presentations.master').bind(window.fixtureState, window.fixtureHelpers);
        document.getElementById('entry').addEventListener('click', () => window.Pivot.moduleApi('apps.presentations.master').open({ operation: 'generate', template }));
    }, template);
    await page.locator('#entry').click();
    await page.locator('#presentation-master-instruction').fill('按材料制作汇报，保留原始数字和来源。');
    return page;
}
async function word(name, text) {
    return { name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] })) };
}

test('模板制作通过真实上传解析两份Word材料，合并补充文字并保留固定模板和完整正文', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const anonymous = await page.request.post(context.url + '/api/apps/presentations/materials/extract'); assert.equal(anonymous.status(), 401);
        await page.locator('#presentation-master-material').fill('补充说明：金额均为万元。');
        await page.locator('#presentation-master-material-files').setInputFiles([await word('经营报告.docx', '本期收入120万元，成本80万元。'), await word('风险清单.docx', '风险核对码：END-739。')]);
        await page.locator('#presentation-master-start').click();
        await expect(page.locator('#presentation-master-status')).toContainText('测试制作已接收材料');
        assert.equal(context.requests.length, 1);
        const request = context.requests[0]; assert.equal(request.materials.length, 3); assert.equal(request.template.id, template.id);
        assert.equal(request.materials[1].title, '经营报告.docx'); assert.match(request.materials[1].text, /收入120万元，成本80万元/);
        assert.match(request.materials[2].text, /END-739/); assert.equal(new Set(request.materials.map(item => item.id)).size, 3);
        await expect.poll(async () => (await fs.readdir(context.directory)).length).toBe(0);
    } finally { await context.close(); }
});

test('英文浏览器下文件选择、数量、清除和系统错误均显示中文，键盘可打开文件选择器', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), dialog = page.getByRole('dialog');
        await expect(dialog.getByText('未选择任何文件', { exact: true })).toHaveCount(2);
        await expect(dialog.locator('input[type="file"]:visible')).toHaveCount(0);
        const browse = dialog.getByRole('button', { name: '选择文件材料', exact: true });
        await browse.focus();
        const choosing = page.waitForEvent('filechooser'); await page.keyboard.press('Enter');
        await (await choosing).setFiles([await word('经营报告.docx', '收入120万元。'), await word('风险清单.docx', '暂无新增风险。')]);
        await expect(dialog.locator('#presentation-master-material-files-selection')).toHaveText('已选择2个文件：经营报告.docx、风险清单.docx');
        await dialog.getByRole('button', { name: '清除文件材料', exact: true }).click();
        await expect(page.locator('#presentation-master-material-files')).toHaveValue('');
        await expect(dialog.locator('#presentation-master-material-files-selection')).toHaveText('未选择任何文件');
        await expect(browse).toBeFocused();
        await expect(dialog).not.toContainText(/Choose Files|No file chosen|MiB/);
        await page.route('**/materials/extract', route => route.abort('failed'));
        await page.locator('#presentation-master-material-files').setInputFiles(await word('经营报告.docx', '收入120万元。'));
        await page.locator('#presentation-master-start').click();
        await expect(page.locator('#presentation-master-status')).toContainText('处理未完成，请检查文件、网络或服务连接后重试。');
    } finally { await context.close(); }
});

test('空白、超长和取消读取不会提交不完整材料，失败保留填写内容供重试', { timeout: 20000 }, async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), upload = page.locator('#presentation-master-material-files');
        for (const file of [await word('空白材料.docx', ''), { name: '超长材料.txt', mimeType: 'text/plain', buffer: Buffer.from('甲'.repeat(120001)) }]) {
            await upload.setInputFiles(file); await page.locator('#presentation-master-start').click();
            await expect(page.locator('#presentation-master-status')).toContainText(/未能.*提取|超过十二万字/);
            await expect(page.locator('#presentation-master-instruction')).toHaveValue('按材料制作汇报，保留原始数字和来源。');
            assert.equal(context.requests.length, 0);
        }
        await expect.poll(async () => (await fs.readdir(context.directory)).length).toBe(0);
        let release, entered;
        const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
        await page.route('**/materials/extract', async route => { entered(); await gate; await route.fulfill({ json: { material: { text: '迟到的材料' } } }).catch(() => {}); });
        await upload.setInputFiles(await word('等待解析.docx', '等待解析'));
        await page.locator('#presentation-master-start').click(); await started;
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); release();
        await expect(page.locator('#presentation-master-start')).toHaveText('开始制作'); assert.equal(context.requests.length, 0);
        await page.locator('#entry').click();
        await expect(page.locator('#presentation-master-start')).toBeEnabled();
        let releaseOwner, enteredOwner;
        const ownerGate = new Promise(resolve => releaseOwner = resolve), ownerStarted = new Promise(resolve => enteredOwner = resolve);
        await page.unroute('**/materials/extract');
        await page.route('**/materials/extract', async route => { enteredOwner(); await ownerGate; await route.fulfill({ json: { material: { text: '原账号材料' } } }); });
        await page.locator('#presentation-master-start').click(); await Promise.race([ownerStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('切换账号测试未进入材料读取')), 5000))]);
        await page.evaluate(() => window.Pivot.legacy.currentUser = { id: 2 }); releaseOwner();
        await expect(page.locator('#presentation-master-start')).toHaveText('开始制作'); assert.equal(context.requests.length, 0);
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await page.locator('#entry').click();
        await expect(page.locator('#presentation-master-material-files')).toHaveValue('');
        await expect(page.locator('#presentation-master-instruction')).toHaveValue('');
    } finally { await context.close(); }
});

test('模板制作弹窗在桌面、笔记本和窄屏保持底部按钮可见，支持明暗主题与键盘关闭', async () => {
    const context = await fixture();
    try {
        const output = path.join(root, 'output/presentation-master-form'); await fs.mkdir(output, { recursive: true });
        for (const colorScheme of ['light', 'dark']) for (const viewport of [{ width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
            const page = await pageFor(context, viewport, colorScheme), dialog = page.getByRole('dialog');
            if (colorScheme === 'dark') await page.evaluate(() => document.body.classList.add('dark-mode'));
            const bounds = await dialog.boundingBox(), button = await page.locator('#presentation-master-start').boundingBox();
            await page.screenshot({ path: path.join(output, `${colorScheme}-${viewport.width}-bounds.png`) });
            assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, JSON.stringify({ viewport, bounds }));
            assert(button.y >= 0 && button.y + button.height <= viewport.height);
            assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
            await expect(page.locator('#presentation-master-budget')).toBeHidden();
            await page.locator('.presentation-master-advanced summary').click();
            await expect(page.locator('#presentation-master-budget')).toBeVisible();
            await page.locator('#presentation-master-budget').fill('160000');
            await page.locator('.presentation-master-advanced summary').click();
            await page.locator('.workspace-modal-body').evaluate(element => element.scrollTop = 0);
            await page.screenshot({ path: path.join(output, `${colorScheme}-${viewport.width}.png`) });
            await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.locator('#entry')).toBeFocused();
            await page.close();
        }
    } finally { await context.close(); }
});
