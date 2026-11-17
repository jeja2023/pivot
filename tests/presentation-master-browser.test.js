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
    await expect(page.locator('#presentation-master-title')).toHaveValue('');
    await page.locator('#presentation-master-title').fill('测试演示');
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
        await page.locator('.presentation-master-advanced summary').click();
        await page.locator('#presentation-master-budget').fill('800000');
        await page.locator('#presentation-master-material-files').setInputFiles([await word('经营报告.docx', '本期收入120万元，成本80万元。'), await word('风险清单.docx', '风险核对码：END-739。')]);
        await page.locator('#presentation-master-start').click();
        await expect(page.locator('#presentation-master-status')).toContainText('测试制作已接收材料');
        assert.equal(context.requests.length, 1);
        const request = context.requests[0]; assert.equal(request.materials.length, 3); assert.equal(request.template.id, template.id); assert.equal(request.tokenBudget, 800000);
        assert.equal(request.materials[1].title, '经营报告.docx'); assert.match(request.materials[1].text, /收入120万元，成本80万元/);
        assert.match(request.materials[2].text, /END-739/); assert.equal(new Set(request.materials.map(item => item.id)).size, 3);
        await expect.poll(async () => (await fs.readdir(context.directory)).length).toBe(0);
    } finally { await context.close(); }
});

test('关闭后清空新建表单和附件，快捷输入追加内容且不覆盖用户文字', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), dialog = page.getByRole('dialog');
        await page.locator('#presentation-master-purpose').fill('用户已有目的');
        await dialog.getByRole('group', { name: '整稿目的快捷输入' }).getByRole('button', { name: '决策支持' }).click();
        await expect(page.locator('#presentation-master-purpose')).toHaveValue('用户已有目的\n帮助受众了解备选方案、利弊和需要决策的事项。');
        await dialog.getByRole('group', { name: '制作要求快捷输入' }).getByRole('button', { name: '依据材料' }).click();
        await expect(page.locator('#presentation-master-instruction')).toHaveValue(/按材料制作汇报[\s\S]*不编造未提供的事实/);
        await page.locator('#presentation-master-material').fill('之前的材料');
        await page.locator('#presentation-master-material-files').setInputFiles(await word('之前的文件.docx', '内容'));
        await page.locator('.presentation-master-advanced summary').click();
        await page.locator('#presentation-master-budget').fill('500000');
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        for (const id of ['title', 'purpose', 'instruction', 'material', 'audience']) await expect(page.locator('#presentation-master-' + id)).toHaveValue('');
        await expect(page.locator('#presentation-master-material-files')).toHaveValue('');
        await expect(page.locator('#presentation-master-budget')).toHaveValue('1000000');
        await expect(page.locator('#presentation-master-budget')).toBeHidden();
    } finally { await context.close(); }
});

test('新建模板制作任务默认提交一百万累计预算', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        await page.locator('#presentation-master-start').click();
        await expect(page.locator('#presentation-master-status')).toContainText('测试制作已接收材料');
        assert.equal(context.requests[0].tokenBudget, 1000000);
    } finally { await context.close(); }
});

test('切换模板保留正在编辑的内容，重新打开时只恢复可继续的任务状态', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        await page.evaluate(() => window.Pivot.exposeModule('apps.presentations.catalog', { open: async () => {} }));
        await page.getByRole('button', { name: '更换模板' }).click();
        await page.locator('#entry').click();
        await expect(page.locator('#presentation-master-title')).toHaveValue('测试演示');
        await expect(page.locator('#presentation-master-instruction')).toHaveValue('按材料制作汇报，保留原始数字和来源。');
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        let recent = { id: 'fixture-task', status: 'completed' };
        await page.route('**/master/tasks/latest?**', route => route.fulfill({ json: { task: recent } }));
        await page.locator('#entry').click();
        await expect(panel).toContainText('完整制作引擎已登记');
        await expect(page.locator('#presentation-master-title')).toHaveValue('');
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        recent = { id: 'fixture-task', status: 'input_required', request: { presentationId: '', productionProfile: { purpose: '旧任务目的' } }, inputRequest: { question: '请确认方案' } };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: recent } }));
        await page.locator('#entry').click();
        await expect(panel).toContainText('请确认方案');
        await expect(page.locator('#presentation-master-purpose')).toHaveValue('');
    } finally { await context.close(); }
});

test('累计预算不足时展示原预算并引导增加，失败后仍可重试恢复', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), submitted = [];
        const failed = { id: 'fixture-task', status: 'failed', recoverable: true, steps: 11, usedTokens: 299001,
            request: { presentationId: '', tokenBudget: 400000, maxSteps: 80 }, error: { code: 'PPT_MASTER_BUDGET_EXHAUSTED', message: '剩余模型预算不足。' },
            usageDiagnostics: [{ step: 11, inputTokens: 1200, outputTokens: 200, inputEstimated: false, outputEstimated: true, inputEstimate: 1300, originalEstimate: 2000, compactedWrites: 1, cumulativeTokens: 299001, breakdown: { initial: 500, history: 700, toolResults: 100, images: 0 } }] };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: failed } }));
        await page.route('**/master/tasks/fixture-task/resume', async route => {
            submitted.push(route.request().postDataJSON());
            await route.fulfill({ status: 503, json: { error: '服务暂不可用，请重试。' } });
        });
        await page.locator('#presentation-master-start').click();
        const panel = page.locator('#presentation-master-status'), budget = page.locator('#presentation-master-budget');
        await expect(panel).toContainText('本任务累计预算为 400000 令牌');
        await expect(budget).toHaveValue('400000');
        await panel.getByText('查看每轮模型用量').click();
        await expect(panel).toContainText('输入 1200，输出 200（估算）');
        await expect(panel).toContainText('初始指引及任务 500，历史消息 700，工具结果 100，图片 0');
        await expect(budget).toBeVisible();
        const resume = panel.getByRole('button', { name: '从检查点继续' });
        await resume.click();
        await expect(panel).toContainText('请先在高级设置中增加累计模型预算');
        assert.equal(submitted.length, 0);
        await budget.fill('800000'); await resume.click();
        await expect(panel).toContainText('服务暂不可用，请重试');
        await expect(resume).toBeEnabled();
        assert.equal(submitted[0].tokenBudget, 800000);
        await resume.click();
        await expect.poll(() => submitted.length).toBe(2);
        failed.request.tokenBudget = 800000;
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        await expect(panel).toContainText('本任务累计预算为 800000 令牌');
        await resume.click();
        await expect(panel).toContainText('请先在高级设置中增加累计模型预算');
        assert.equal(submitted.length, 2);
    } finally { await context.close(); }
});

test('方案确认可直接继续，补充问题要求实际答复，失败保留输入并显示真实预算', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), submitted = [];
        let task = { id: 'fixture-task', status: 'input_required', steps: 3, usedTokens: 59211,
            request: { presentationId: '', tokenBudget: 400000, maxSteps: 80 },
            progress: { message: '是否按方案制作？' }, inputRequest: { kind: 'confirmation', question: '是否按方案制作？', context: '八页汇报方案。' } };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task } }));
        let fail = true;
        await page.route('**/master/tasks/fixture-task/respond', async route => {
            submitted.push(route.request().postDataJSON());
            if (fail) return route.fulfill({ status: 503, json: { error: '确认服务暂不可用，请重试。' } });
            task = { ...task, status: 'working' };
            return route.fulfill({ json: { task } });
        });
        await page.locator('#presentation-master-start').click();
        const panel = page.locator('#presentation-master-status');
        await expect(panel).toContainText('已用约 59,211 令牌；本任务累计预算 400,000 令牌');
        await expect(panel.getByText('是否按方案制作？', { exact: true })).toHaveCount(1);
        for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
            const contextBounds = await panel.locator('.presentation-master-task-context').boundingBox();
            assert(contextBounds.height < 100, '短方案说明不应撑开大块空白');
            await expect(panel.getByRole('button', { name: '确认并继续' })).toBeVisible();
        }
        await panel.getByRole('button', { name: '确认并继续' }).click();
        await expect(panel.getByRole('alert')).toHaveText('确认服务暂不可用，请重试。');
        await expect(panel.getByRole('button', { name: '确认并继续' })).toBeEnabled();
        assert.equal(submitted[0].answer, '确认，按上述方案继续制作。');
        await panel.getByRole('textbox', { name: '对制作方案的实际答复' }).fill('请保留原始金额');
        await panel.getByRole('button', { name: '确认并继续' }).click();
        await expect(panel.getByRole('alert')).toHaveText('确认服务暂不可用，请重试。');
        await expect(panel.getByRole('textbox', { name: '对制作方案的实际答复' })).toHaveValue('请保留原始金额');
        fail = false;
        await panel.getByRole('button', { name: '确认并继续' }).click();
        await expect(panel).toContainText('正在制作中');
        assert.equal(submitted[2].answer, '请保留原始金额');
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        task = { ...task, status: 'input_required', inputRequest: { kind: 'clarification', question: '请提供目标受众。', context: '制作需要受众信息。' } };
        await page.route('**/master/tasks/latest?**', route => route.fulfill({ json: { task } }));
        await page.locator('#entry').click();
        const answer = panel.getByRole('textbox', { name: '对制作方案的实际答复' });
        await panel.getByRole('button', { name: '提交答复并继续' }).click();
        await expect(panel.getByRole('alert')).toHaveText('请先填写具体答复，再继续制作。');
        assert.equal(submitted.length, 3);
        await answer.fill('公司管理层');
        await panel.getByRole('button', { name: '提交答复并继续' }).click();
        await expect(panel).toContainText('正在制作中');
        assert.equal(submitted[3].answer, '公司管理层');
    } finally { await context.close(); }
});

test('英文浏览器下文件选择、数量、清除和系统错误均显示中文，键盘可打开文件选择器', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), dialog = page.getByRole('dialog');
        await expect(page.locator('#presentation-master-status')).toContainText('完整制作引擎已登记');
        await expect(dialog.getByText('未选择任何文件', { exact: true })).toHaveCount(2);
        await expect(dialog.locator('input[type="file"]:visible')).toHaveCount(0);
        const browse = dialog.getByRole('button', { name: '选择文件材料', exact: true });
        await browse.focus();
        await expect(browse).toBeFocused();
        const choosing = page.waitForEvent('filechooser'); await browse.press('Enter');
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
        await page.locator('#presentation-master-title').fill('测试演示');
        await page.locator('#presentation-master-instruction').fill('按材料制作汇报，保留原始数字和来源。');
        await upload.setInputFiles(await word('等待解析.docx', '等待解析'));
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
