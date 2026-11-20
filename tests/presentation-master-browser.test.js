/* global window, document */
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
    app.use('/chat', express.static(path.join(root, 'client/chat')));
    app.get('/fixture', (_req, res) => res.send('<!DOCTYPE html><html lang="zh-CN"><body><button id="entry">按模板创建</button><button data-presentation-master-history>完整制作记录</button></body></html>'));
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
    app.post('/api/apps/presentations/master/model-preflight', (_req, res) => res.json({ compatibility: { contextWindow: 256000 } }));
    app.get('/api/apps/presentations/master/tasks/latest', (_req, res) => res.json({ task: null }));
    app.get('/api/apps/presentations/master/tasks/fixture-task', (_req, res) => {
        const task = { id: 'fixture-task', status: 'completed', result: { message: '测试制作已接收材料' } };
        res.json({ task });
    });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const browser = await chromium.launch({ headless: true });
    return {
        browser, directory, requests, url: `http://127.0.0.1:${server.address().port}`, async close() {
            await browser.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
        }
    };
}
async function pageFor(context, viewport = { width: 1366, height: 768 }, colorScheme = 'light', openForm = true) {
    const page = await context.browser.newPage({ viewport, colorScheme, locale: 'en-US' });
    page.setDefaultTimeout(7000);
    await page.goto(context.url + '/fixture');
    for (const file of ['client/common/styles/theme.css', 'client/chat/chat.shell.css', 'client/chat/chat.workspace.apps.css']) await page.addStyleTag({ path: path.join(root, file) });
    await page.evaluate(() => {
        window.fixtureState = { active: null };
        window.fixtureTaskResponses = [];
        window.Pivot = {
            legacy: { currentUser: { id: 1 }, loadSelectableModels: async () => ({ models: [{ id: 1, name: '制作模型' }], defaultModelId: 1 }) }
        };
        window.fixtureHelpers = {
            requestJson: async (url, options = {}) => {
                const response = await fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-user': '1' } });
                const data = await response.json();
                window.fixtureTaskResponses.push(url);
                if (!response.ok) throw new Error(data.error); return data;
            }
        };
    });
    for (const file of ['pivot-core.js', 'apps-model-selector.js', 'apps-workbench-presentation-master.js']) await page.addScriptTag({ url: '/chat/' + file });
    await page.evaluate(template => {
        window.Pivot.moduleApi('apps.presentations.master').bind(window.fixtureState, window.fixtureHelpers);
        document.getElementById('entry').addEventListener('click', () => window.Pivot.moduleApi('apps.presentations.master').open({ operation: 'generate', template }));
    }, template);
    if (openForm) {
        await page.locator('#entry').click();
        await expect(page.locator('#presentation-master-title')).toHaveValue('');
        await page.locator('#presentation-master-title').fill('测试演示');
        await page.locator('#presentation-master-instruction').fill('按材料制作汇报，保留原始数字和来源。');
    }
    return page;
}
async function word(name, text) {
    return { name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] })) };
}

test('文稿状态筛选和标签一致，需处理状态说明如何恢复草稿', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context, undefined, 'light', false);
        await page.addScriptTag({ url: '/chat/apps-workbench-presentations-library.js' });
        const labels = await page.evaluate(() => {
            const filter = document.createElement('select'), table = document.createElement('table'), body = document.createElement('tbody');
            filter.id = 'presentation-library-status';
            body.id = 'presentation-library-table-body';
            table.appendChild(body);
            document.body.append(filter, table);
            const state = { libraryFilters: { status: 'needs_attention' }, documents: [
                { id: 'problem', title: '版式待修', status: 'needs_attention' },
                { id: 'ready', title: '完成稿', status: 'ready' }
            ] };
            window.Pivot.moduleApi('apps.presentations.library').render(state, { templateById: () => null });
            return [...body.querySelectorAll('.presentation-status-pill')].map(pill => ({
                label: pill.textContent, option: [...filter.options].find(option => pill.classList.contains(option.value || 'any'))?.textContent
            }));
        });
        assert.deepEqual(labels, [{ label: '需处理', option: '需处理' }, { label: '已完成', option: '已完成' }]);
        await expect(page.locator('#presentation-library-status')).toHaveValue('needs_attention');
        await expect(page.getByText('需处理', { exact: true }).filter({ visible: true })).toHaveAttribute('title', /修复并保存后可恢复为草稿/);
    } finally { await context.close(); }
});

test('草稿列表直接打开已完成的 PPT Master 初稿并可回到原入口', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context, undefined, 'light', false);
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: {
            id: 'fixture-task', status: 'completed', draftFirst: true, request: { title: '项目测试' },
            result: { files: [{ format: 'pptx', renditionId: 1, filename: '项目测试-初稿.pptx' }] }
        } } }));
        await page.addScriptTag({ url: '/chat/apps-workbench-presentations-library.js' });
        await page.evaluate(() => {
            const table = document.createElement('table'), body = document.createElement('tbody');
            body.id = 'presentation-library-table-body'; table.appendChild(body); document.body.appendChild(table);
            window.Pivot.moduleApi('apps.presentations.library').render({ documents: [
                { id: 'fixture-task', title: '项目测试-初稿', status: 'draft', masterDraft: true, template: { name: 'PPT Master' } }
            ], coverUrls: new Map() }, { templateById: () => null });
            body.addEventListener('click', event => {
                const button = event.target.closest('[data-presentation-action="open-master"]');
                if (button) void window.Pivot.moduleApi('apps.presentations.master').openDraft(button.dataset.presentationId, button);
            });
        });
        const entry = page.getByRole('button', { name: '项目测试-初稿', exact: true });
        await entry.click();
        const dialog = page.getByRole('dialog', { name: '完整制作过程' });
        await expect(dialog).toContainText('初稿已生成');
        await expect(dialog.getByRole('button', { name: '下载初稿（.pptx）' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '编辑已生成页面' })).toBeVisible();
        await entry.evaluate(button => button.replaceWith(button.cloneNode(true)));
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(entry).toBeFocused();
    } finally { await context.close(); }
});

test('PPTX 与源包交付后收起重复快照，缺少对应交付文件时保留恢复入口', async () => {
    const context = await fixture();
    try {
        const pptx = { format: 'pptx', renditionId: 1, filename: '经营回顾-初稿.pptx' };
        const zip = { format: 'zip', renditionId: 2, filename: '经营回顾-项目源包.zip' };
        for (const [status, files, sourceVisible, exportVisible] of [
            ['completed', [pptx, zip], false, false],
            ['completed', [pptx], true, false],
            ['failed', [], true, true]
        ]) {
            const page = await pageFor(context, { width: 390, height: 844 });
            const panel = page.locator('#presentation-master-status');
            await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: {
                id: 'fixture-task', status, draftFirst: true, canPreviewExport: status === 'completed', canRegenerate: true,
                progressSnapshot: { source: { count: 2 }, export: { pendingPages: [] }, passed: { pages: [1, 2] } },
                result: { files }
            } } }));
            await page.locator('#presentation-master-start').click();
            await expect(panel.getByText(status === 'completed' ? '初稿已生成' : '制作未完成', { exact: true })).toBeVisible();
            for (const name of ['下载待核验整稿快照（.pptx）', '下载已通过页面（.pptx）', '将已通过页转存为独立文稿']) {
                await expect(panel.getByRole('button', { name, exact: true })).toHaveCount(Number(exportVisible));
            }
            await expect(panel.getByRole('button', { name: '下载待核验项目源包', exact: true })).toHaveCount(Number(sourceVisible));
            await expect(panel.getByText('自动保存的制作快照', { exact: true })).toHaveCount(Number(sourceVisible || exportVisible));
            if (status === 'completed') {
                for (const name of ['预览初稿', '修改整份初稿', '下载初稿（.pptx）', '编辑已生成页面']) {
                    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
                }
                await expect(panel.getByRole('button', { name: '下载完整项目源包', exact: true })).toHaveCount(Number(files.includes(zip)));
            }
            await page.close();
        }
    } finally { await context.close(); }
});

test('已完成的初稿可查看材料、逐页提纲并返回下载入口', async () => {
    const context = await fixture();
    try {
        const viewport = { width: 390, height: 844 };
        const page = await pageFor(context, viewport), panel = page.locator('#presentation-master-status');
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: {
            id: 'fixture-task', status: 'completed', draftFirst: true,
            checkpointProgress: {
                requirementsLoaded: true,
                materials: [{ title: '经营材料.docx', saved: true, reads: 2, complete: true }],
                plans: [{ stage: 'design', status: 'automatic', summary: '按经营结果组织汇报',
                    pages: [{ title: '经营概况', values: ['已核对事项 3 项'] }, { title: '后续安排', values: [] }] }]
            },
            result: { files: [{ format: 'pptx', renditionId: 1, filename: '经营回顾-初稿.pptx' }] }
        } } }));
        await page.locator('#presentation-master-start').click();
        const outlineButton = panel.getByRole('button', { name: /查看材料与提纲/ });
        await outlineButton.click();
        const dialog = page.getByRole('dialog', { name: '材料与提纲' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('经营材料.docx');
        await expect(dialog).toContainText('已读完整文字快照');
        await expect(dialog.getByText('初稿清单', { exact: true })).toBeVisible();
        await expect(dialog.getByText('共 2 页')).toBeVisible();
        await expect(dialog.getByRole('heading', { name: '经营概况' })).toBeVisible();
        await expect(dialog.getByRole('heading', { name: '后续安排' })).toBeVisible();
        await expect(dialog).toContainText('已核对事项 3 项');
        const bounds = await dialog.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(outlineButton).toBeFocused();
        await expect(panel.getByRole('button', { name: '下载初稿（.pptx）' })).toBeVisible();
    } finally { await context.close(); }
});

test('待核验草稿在失败面板可单独下载，保留继续制作入口', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        await page.evaluate(() => { window.Pivot.api = { fetch: (...args) => fetch(...args) }; });
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({
            json: {
                task: {
                    id: 'fixture-task', status: 'failed', hasReviewDraft: true, recoverable: true, request: { title: '经营回顾', maxSteps: 80 },
                    error: { code: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', message: '交付第 1 页缺少已确认的可见标题。' }
                }
            }
        }));
        await page.route('**/master/tasks/fixture-task/review-draft', route => route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: 'fixture draft' }));
        await page.locator('#presentation-master-start').click();
        await expect(panel.getByRole('button', { name: '从检查点继续' })).toBeVisible();
        await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toHaveCount(0);
        const download = page.waitForEvent('download');
        await panel.getByRole('button', { name: '下载待核验草稿（.pptx）' }).click();
        assert.equal((await download).suggestedFilename(), '经营回顾-待核验草稿.pptx');
        await expect(panel).toContainText('制作未完成');
    } finally { await context.close(); }
});

test('旧制作记录可放大单页并保存，通过历史入口重新打开', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        const name = number => 'review-' + 'a'.repeat(64) + '-' + number + '.png';
        const preview = {
            pages: [{ page: 1, title: '第一页', file: name(1) }, { page: 3, title: '第三页', file: name(3) }],
            failedPages: [{ page: 2 }], exportRevision: 'a'.repeat(64)
        };
        let saved = false;
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({
            json: {
                task: {
                    id: 'fixture-task', status: 'failed', canPreviewExport: !saved, hasSavedReviewPages: saved,
                    request: { title: '旧经营回顾' }, error: { code: 'PPT_MASTER_OPERATION_FAILED', message: '第 2 页需要修复。' }
                }
            }
        }));
        await page.route('**/master/tasks/recent', route => route.fulfill({
            json: {
                tasks: [
                    { id: 'fixture-task', status: 'failed', title: '旧经营回顾', hasSavedReviewPages: saved }
                ]
            }
        }));
        await page.route('**/master/tasks/fixture-task/review-pages', route => {
            assert.equal(route.request().method(), saved ? 'GET' : 'POST');
            return route.fulfill({ json: preview });
        });
        await page.route('**/master/tasks/fixture-task/review-pages/save', route => {
            assert.deepEqual(route.request().postDataJSON(), { exportRevision: preview.exportRevision });
            saved = true;
            return route.fulfill({ json: preview });
        });
        await page.route('**/review-pages/*.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7eQAAAAASUVORK5CYII=', 'base64') }));
        await page.locator('#presentation-master-start').click();
        await expect(panel.getByRole('button', { name: '下载待核验草稿（.pptx）' })).toHaveCount(0);
        await panel.getByRole('button', { name: '查看已通过页面' }).click();
        const selector = panel.getByRole('combobox', { name: '选择已通过的页面' });
        await expect(selector.locator('option')).toHaveCount(2);
        await selector.selectOption('3');
        await expect(panel.getByRole('img', { name: /第 3 页/ })).toBeVisible();
        const open = panel.getByRole('button', { name: '打开单页预览图' });
        await open.click();
        const imageDialog = page.getByRole('dialog', { name: /单页预览.*第 3 页/ });
        await expect(imageDialog.getByRole('img')).toHaveAttribute('src', new RegExp(name(3) + '$'));
        assert.equal(context.browser.contexts().flatMap(context => context.pages()).length, 1);
        await page.keyboard.press('Escape');
        await expect(imageDialog).toHaveCount(0);
        await expect(open).toBeFocused();
        await expect(panel).toContainText('待修复页：2');
        await panel.getByRole('button', { name: '保存已通过页面' }).click();
        await expect(panel).toContainText('已保存到本条制作记录');
        await page.getByRole('dialog', { name: '完整制作过程' }).getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#presentation-master-modal').getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '完整制作记录', exact: true }).click();
        await panel.getByRole('button', { name: /旧经营回顾.*已保存通过页/ }).click();
        await panel.getByRole('button', { name: '查看已保存页面' }).click();
        await expect(panel.getByRole('combobox', { name: '选择已通过的页面' }).locator('option')).toHaveCount(2);
        await expect(panel.getByRole('img', { name: /第 1 页/ })).toBeVisible();
    } finally { await context.close(); }
});

test('PPT 制作记录可打开旧草稿并将副本交给原稿编辑器', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context, undefined, undefined, false), panel = page.locator('#presentation-master-status');
        await page.evaluate(() => {
            window.Pivot.api = { fetch: (...args) => fetch(...args) };
            window.Pivot.exposeModule('apps.presentations.native', { open: async source => { window.fixtureNativeSource = source; } });
        });
        await page.route('**/master/tasks/recent', route => route.fulfill({
            json: {
                tasks: [
                    { id: 'old-draft', title: '旧经营回顾', status: 'failed', createdAt: '2026-11-18T06:17:50.000Z' },
                    { id: 'old-empty', title: '未生成稿件', status: 'completed', createdAt: '2026-11-18T05:08:53.000Z' }
                ]
            }
        }));
        await page.route('**/master/tasks/old-draft', route => route.fulfill({
            json: {
                task: {
                    id: 'old-draft', status: 'failed', hasReviewDraft: true, request: { title: '旧经营回顾' }, error: { message: '有页面未通过。' }
                }
            }
        }));
        await page.route('**/master/tasks/old-empty', route => route.fulfill({
            json: {
                task: {
                    id: 'old-empty', status: 'failed', request: { title: '未生成稿件' }, error: { message: '材料读取失败。' }
                }
            }
        }));
        await page.route('**/master/tasks/old-draft/review-draft', route => route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: 'test draft' }));
        await page.route('**/apps/presentations/assets', route => {
            assert.match(route.request().postData(), /test draft/);
            return route.fulfill({ json: { asset: { id: 42 } } });
        });
        const entry = page.getByRole('button', { name: '完整制作记录', exact: true });
        await entry.click();
        const history = page.getByRole('dialog', { name: '完整制作记录', exact: true });
        const detail = page.getByRole('dialog', { name: '完整制作过程', exact: true });
        const form = page.locator('#presentation-master-modal');
        await expect(history).toBeVisible();
        await expect(form).toHaveCount(0);
        assert.deepEqual(await page.evaluate(() => window.fixtureTaskResponses), ['/api/apps/presentations/master/tasks/recent']);
        await expect(panel.locator('.presentation-master-history-row')).toHaveCount(2);
        await expect(panel.locator('.presentation-master-history-count')).toHaveText('共 2 条');
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/history-1366.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/history-390.png') });
        await page.setViewportSize({ width: 1366, height: 768 });
        const empty = panel.getByRole('button', { name: /未生成稿件/ });
        await empty.click();
        await expect(panel).toContainText('没有已保留的待核验 PPTX');
        await expect(panel.getByRole('button', { name: '手动编辑草稿副本' })).toHaveCount(0);
        await detail.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(history).toBeVisible();
        await expect(empty).toBeFocused();
        await expect(form).toHaveCount(0);
        const draft = panel.getByRole('button', { name: /旧经营回顾/ });
        await draft.click();
        await detail.getByRole('button', { name: '手动编辑草稿副本' }).waitFor();
        await page.keyboard.press('Escape');
        await expect(history).toBeVisible();
        await expect(draft).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(history).toHaveCount(0);
        await expect(entry).toBeFocused();
        await entry.click();
        await draft.click();
        await panel.getByRole('button', { name: '手动编辑草稿副本' }).click();
        await expect.poll(() => page.evaluate(() => window.fixtureNativeSource)).toEqual({ sourceAssetId: '42', title: '旧经营回顾-待核验草稿' });
        await expect(page.getByRole('dialog', { name: '完整制作过程' })).toHaveCount(0);
    } finally { await context.close(); }
});

test('逐页核验显示应有数据，提交时只修复勾选页', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        const revision = 'b'.repeat(64);
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({
            json: {
                task: {
                    id: 'fixture-task', status: 'failed', hasReviewDraft: true, recoverable: true, canRepairPages: true, canRegenerate: true, draftRevision: revision,
                    request: { title: '经营回顾', maxSteps: 80 }, pageReview: {
                        passedPages: [1], failedPages: [
                            { page: 2, title: '营收', items: [{ index: 1, text: '收入120万元' }] },
                            { page: 3, title: '成本', items: [{ index: 1, text: '成本80万元' }] }
                        ]
                    }, error: { code: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', message: '第 2 页关键数据待核验。' }
                }
            }
        }));
        let submitted;
        await page.route('**/master/tasks/fixture-task/resume', route => {
            submitted = route.request().postDataJSON();
            return route.fulfill({ json: {} });
        });
        await page.locator('#presentation-master-start').click();
        await expect(panel).toContainText('已通过 1 页');
        await expect(panel).toContainText('收入120万元');
        await expect(panel.getByRole('button', { name: '重新生成整份' })).toBeVisible();
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/page-review-1366.png') });
        await panel.getByRole('checkbox', { name: /第 3 页/ }).uncheck();
        await panel.getByRole('textbox', { name: '本次修改意见（选填）' }).fill('在图表旁补上数值。');
        await panel.getByRole('button', { name: '仅修复所选页面' }).click();
        await expect.poll(() => submitted?.pages).toEqual([2]);
        assert.equal(submitted.draftRevision, revision);
        assert.equal(submitted.repairNote, '在图表旁补上数值。');
    } finally { await context.close(); }
});

test('整份重新生成需经确认，新任务可以返回查看原草稿', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        await page.evaluate(() => { window.Pivot.legacy.showConfirm = async () => window.fixtureRegenerateApproved === true; });
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({
            json: {
                task: {
                    id: 'fixture-task', status: 'failed', canRegenerate: true, hasReviewDraft: true, request: { title: '原稿' }, error: { message: '需要修改。' }
                }
            }
        }));
        let calls = 0;
        await page.route('**/master/tasks/fixture-task/regenerate', route => {
            calls++;
            return route.fulfill({ json: { task: { id: 'new-task' } } });
        });
        await page.route('**/master/tasks/new-task', route => route.fulfill({
            json: {
                task: {
                    id: 'new-task', status: 'completed', regeneratedFrom: 'fixture-task', request: { title: '重生成的新稿' }
                }
            }
        }));
        await page.locator('#presentation-master-start').click();
        const regenerate = panel.getByRole('button', { name: '重新生成整份' });
        await regenerate.click();
        assert.equal(calls, 0);
        await page.evaluate(() => { window.fixtureRegenerateApproved = true; });
        await regenerate.click();
        await expect(panel).toContainText('重生成的新稿');
        assert.equal(calls, 1);
        await panel.getByRole('button', { name: '查看原任务' }).click();
        await expect(panel.getByRole('button', { name: '下载待核验草稿（.pptx）' })).toBeVisible();
    } finally { await context.close(); }
});

test('工作中轮询保留用量展开与停止操作，短暂失败后自动恢复', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        let calls = 0;
        await page.route('**/master/tasks/fixture-task', async route => {
            calls++;
            if (calls === 2) return route.fulfill({ status: 503, json: { error: '临时故障' } });
            return route.fulfill({
                json: {
                    task: {
                        id: 'fixture-task', status: 'working', request: { presentationId: '', tokenBudget: 1000000 },
                        usageDiagnostics: [{ call: 1, step: 1, inputTokens: 10, outputTokens: 2, cumulativeTokens: 12 }]
                    }
                }
            });
        });
        await page.locator('#presentation-master-start').click();
        await panel.getByRole('button', { name: /查看每轮模型用量/ }).click();
        const usageDialog = page.getByRole('dialog', { name: '每轮模型用量明细' });
        await expect(usageDialog).toBeVisible();
        await expect(usageDialog).toContainText('第 1 次模型调用（步骤 1）');
        await expect(panel).toContainText('后台任务可能仍在运行', { timeout: 6000 });
        await expect.poll(() => calls, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
        await expect(usageDialog).toBeVisible();
        await usageDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(usageDialog).toBeHidden();
        await expect(panel.getByRole('button', { name: '停止制作' })).toBeVisible();
        await page.getByRole('dialog', { name: '完整制作过程' }).getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await context.close(); }
});

test('每轮明细显示失败调用、旧记录和分钟进位，桌面与窄屏均可查看', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const prior = { step: 1, inputTokens: 10, outputTokens: 2, cumulativeTokens: 12, inputEstimate: 10, originalEstimate: 10, compactedWrites: 0 };
        const startedAt = '2026-11-20 15:42:31';
        const task = {
            id: 'fixture-task', status: 'failed', request: { presentationId: '', tokenBudget: 0 },
            usageDiagnostics: [
                { ...prior, call: 1 },
                { ...prior, call: 2, step: 2, outcome: 'model_failed', errorCode: 'PPT_MASTER_MODEL_TIMEOUT',
                    startedAt, durationMs: 119900, inputTokens: null, outputTokens: null },
                { ...prior, call: 3, step: 2, startedAt, durationMs: 59950, outcome: 'citation_placeholder', errorCode: 'PPT_MASTER_CITATION_REVIEW_REQUIRED' },
                { ...prior, call: 4, step: 3, startedAt, durationMs: null, outcome: 'tool_failed', actions: [
                    { action: 'read', path: 'validation/text_calibration.json', unavailable: true },
                    { action: 'run', tool: 'project', subcommand: 'validate', failed: true, exitCode: 1, projectIssues: ['lock'] }
                ] },
                { ...prior, call: 5, step: 4, durationMs: 0, outputTokens: 0, outcome: 'model_failed',
                    errorCode: 'PPT_MASTER_MODEL_CONNECTION', modelFailureKind: 'connection_reset' }
            ]
        };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task } }));
        await page.locator('#presentation-master-start').click();
        await page.locator('#presentation-master-status').getByRole('button', { name: '查看每轮模型用量（共 5 轮）' }).click();
        const dialog = page.getByRole('dialog', { name: '每轮模型用量明细' });
        const failed = dialog.getByRole('listitem').filter({ hasText: '第 2 次模型调用' });
        for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            await expect(dialog.locator('.presentation-master-usage-time')).toHaveText([
                '开始 未记录 · 用时 未记录', '开始 15:42:31 · 用时 2 分钟', '开始 15:42:31 · 用时 1 分钟',
                '开始 15:42:31 · 用时 未记录', '开始 未记录 · 用时 0 毫秒'
            ]);
            await expect(failed).toContainText('模型调用失败');
            await expect(failed).toContainText('异常诊断：模型请求超时。');
            await expect(failed).toContainText('输入 未知，输出 未知，累计已记录 12');
            await expect(failed.locator('.presentation-master-usage-time')).toHaveAttribute('title', '开始时间（北京时间）：' + startedAt + '\n用时：2 分钟');
            const placeholder = dialog.getByRole('listitem').filter({ hasText: '第 3 次模型调用' });
            await expect(placeholder).toContainText('用待核对占位文字继续制作');
            await expect(placeholder).toContainText('压缩 0 条历史写入');
            const project = dialog.getByRole('listitem').filter({ hasText: '第 4 次模型调用' });
            await expect(project).toContainText('记录尚未生成');
            await expect(project).toContainText('项目校验未通过。请核对执行锁。');
            const reset = dialog.getByRole('listitem').filter({ hasText: '第 5 次模型调用' });
            await expect(reset).toContainText('输入 10，输出 0');
            await expect(reset).toContainText('模型连接提前关闭，未收到完整回复');
            const box = await dialog.boundingBox();
            assert(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height);
            assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), '明细弹窗不应横向溢出');
        }
    } finally { await context.close(); }
});

test('必填信息缺失时显示醒目的错误提示，补全后可正常提交并弹出制作过程弹窗', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const formError = page.locator('#presentation-master-form-error');
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        const panel = page.locator('#presentation-master-status');
        for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            await page.locator('#presentation-master-title').fill('');
            await page.locator('#presentation-master-start').click();
            await expect(formError).toHaveText('请填写名称和制作要求，并选择模型。');
            await expect(processDialog).toBeHidden();
            assert.equal(await formError.evaluate(element => window.getComputedStyle(element).color), await formError.evaluate(element => {
                const probe = document.createElement('button');
                probe.className = 'btn-danger'; element.appendChild(probe);
                const color = window.getComputedStyle(probe).color; probe.remove(); return color;
            }));
            await page.locator('#presentation-master-title').fill('测试演示');
        }
        await page.locator('#presentation-master-start').click();
        await expect(processDialog).toBeVisible();
        await expect(panel).toContainText('测试制作已接收材料');
    } finally { await context.close(); }
});

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
        await expect(page.locator('#presentation-master-budget')).toHaveValue('');
        await expect(page.locator('#presentation-master-budget')).toBeHidden();
    } finally { await context.close(); }
});

test('重新打开不查询旧任务并按默认不限新建，旧预算仅主动查看时显示', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const earlier = {
            id: 'earlier-task', status: 'failed', recoverable: true,
            request: { presentationId: '', tokenBudget: 1000000 }, error: { code: 'PPT_MASTER_BUDGET_EXHAUSTED', message: '剩余模型预算不足。' }
        };
        let latestRequests = 0;
        await page.route('**/master/tasks/latest?**', route => { latestRequests++; return route.fulfill({ json: { task: earlier } }); });
        await page.route('**/master/tasks/earlier-task', route => route.fulfill({ json: { task: earlier } }));
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        const panel = page.locator('#presentation-master-status');
        const engineState = page.locator('#presentation-master-engine-state');
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(processDialog).toBeHidden();
        assert.equal(latestRequests, 0);
        await page.getByRole('button', { name: '查看最近制作' }).click();
        await expect(processDialog).toBeVisible();
        await expect(panel).toContainText('本任务累计预算为 1,000,000 令牌');
        assert.equal(latestRequests, 1);
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(processDialog).toBeHidden();
        await expect(page.locator('#presentation-master-budget')).toHaveValue('');
        await page.locator('#presentation-master-title').fill('新的演示');
        await page.locator('#presentation-master-instruction').fill('沿用模板制作新演示。');
        const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/master/tasks'));
        await page.locator('#presentation-master-start').click();
        assert.equal(Object.hasOwn((await sent).postDataJSON(), 'tokenBudget'), false);
        await expect(processDialog).toBeVisible();
        await expect(panel).toContainText('测试制作已接收材料');
        assert.equal(context.requests[0].tokenBudget, 0);
    } finally { await context.close(); }
});

test('新建任务可在桌面和窄屏选择不限累计预算，并显示超过一百万的实际用量', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const dialog = page.getByRole('dialog'), budget = dialog.getByRole('spinbutton', { name: '累计模型预算（令牌，0 为不限）' });
        await dialog.locator('.presentation-master-advanced summary').click();
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({
            json: {
                task: {
                    id: 'fixture-task', status: 'completed',
                    request: { tokenBudget: 0 }, steps: 20, usedTokens: 1200000
                }
            }
        }));
        for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            await expect(budget).toBeVisible();
            assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        }
        for (const invalid of ['-1', '9999']) {
            await budget.fill(invalid);
            await page.locator('#presentation-master-start').click();
            await expect(dialog.getByRole('alert')).toHaveText('累计模型预算请填写 0（不限）或不小于 10000 的整数。');
            assert.equal(context.requests.length, 0);
        }
        await budget.fill('0');
        await page.locator('#presentation-master-start').click();
        await expect(dialog.locator('#presentation-master-status')).toContainText('已用约 1,200,000 令牌。本任务累计预算 不限');
        assert.equal(context.requests[0].tokenBudget, 0);
    } finally { await context.close(); }
});

test('切换模板保留未提交内容，关闭后清空旧任务问题、进度和下载入口', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        const engineState = page.locator('#presentation-master-engine-state');
        const formDialog = page.getByRole('dialog', { name: '完整演示制作' });
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        await page.evaluate(() => window.Pivot.exposeModule('apps.presentations.catalog', { open: async () => { } }));
        await page.getByRole('button', { name: '更换模板' }).click();
        await page.locator('#entry').click();
        await expect(page.locator('#presentation-master-title')).toHaveValue('测试演示');
        await expect(page.locator('#presentation-master-instruction')).toHaveValue('按材料制作汇报，保留原始数字和来源。');
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click();
        let recent = {
            id: 'fixture-task', status: 'completed', result: {
                message: '旧任务已交付',
                files: [{ format: 'pptx', renditionId: 'old', filename: '旧任务.pptx' }]
            }
        };
        await page.route('**/master/tasks/latest?**', route => route.fulfill({ json: { task: recent } }));
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: recent } }));
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(processDialog).toBeHidden();
        await expect(page.locator('#presentation-master-title')).toHaveValue('');
        await page.getByRole('button', { name: '查看最近制作' }).click();
        await expect(processDialog).toBeVisible();
        await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toBeVisible();
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(processDialog).toBeHidden();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(panel).toHaveCount(0);
        recent = { id: 'fixture-task', status: 'input_required', request: { presentationId: '', productionProfile: { purpose: '旧任务目的' } }, inputRequest: { question: '请确认方案' } };
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(processDialog).toBeHidden();
        await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toHaveCount(0);
        await page.getByRole('button', { name: '查看最近制作' }).click();
        await expect(panel).toContainText('请确认方案');
        await expect(page.locator('#presentation-master-purpose')).toHaveValue('');
        await panel.getByRole('textbox', { name: '对制作方案的实际答复' }).fill('未提交的旧答复');
        await page.keyboard.press('Escape');
        await expect(processDialog).toBeHidden();
        await expect(panel).toBeEmpty();
        await page.keyboard.press('Escape');
        await expect(formDialog).toBeHidden();
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(panel.getByRole('textbox')).toHaveCount(0);
    } finally { await context.close(); }
});

test('关闭后迟到的续跑成功响应无法重新查询旧任务或填回新弹窗', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        const engineState = page.locator('#presentation-master-engine-state');
        const formDialog = page.getByRole('dialog', { name: '完整演示制作' });
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        const task = {
            id: 'fixture-task', status: 'failed', recoverable: true, request: { presentationId: '', modelId: '1' },
            error: { code: 'PPT_MASTER_STEP_LIMIT', message: '旧任务已达到轮次上限。' }
        };
        let statusRequests = 0, release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const pending = new Promise(resolve => { entered = resolve; });
        await page.route('**/master/tasks/fixture-task', route => {
            statusRequests++;
            return route.fulfill({ json: { task } });
        });
        await page.route('**/master/tasks/fixture-task/resume', async route => {
            entered();
            await gate;
            await route.fulfill({ json: { task: { ...task, status: 'working' } } });
        });
        await page.locator('#presentation-master-start').click();
        await expect(processDialog).toBeVisible();
        await panel.getByRole('button', { name: '从检查点继续' }).click();
        await pending;
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(processDialog).toBeHidden();
        release();
        await page.waitForFunction(() => window.fixtureTaskResponses.some(url => url.endsWith('/resume')));
        await expect(engineState).toContainText('完整制作引擎已登记');
        await expect(processDialog).toBeHidden();
        await expect(page.locator('#presentation-master-title')).toHaveValue('');
        assert.equal(statusRequests, 1);
    } finally { await context.close(); }
});

test('账号级活动入口能打开并停止另一份文稿的任务', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), panel = page.locator('#presentation-master-status');
        const task = { id: 'other-document-task', status: 'input_required', request: { presentationId: 'other-document', title: '另一份汇报' } };
        await page.route('**/master/tasks/active', route => route.fulfill({ json: { task } }));
        await page.route('**/master/tasks/other-document-task/cancel', route => route.fulfill({ json: { task: { ...task, status: 'cancelled' } } }));
        await page.getByRole('button', { name: '查看进行中的制作' }).click();
        await expect(panel).toContainText('另一份汇报');
        await panel.getByRole('button', { name: '停止制作' }).click();
        await expect(panel).toContainText('已取消');
    } finally { await context.close(); }
});

test('关闭后迟到的旧原稿详情不能覆盖重开后已选择的新原稿', async () => {
    const context = await fixture();
    try {
        const page = await context.browser.newPage();
        await page.setContent('<style>.hidden{display:none!important}</style><button id="native-entry" data-presentation-native-open>原稿编辑</button>');
        await page.evaluate(() => {
            const modules = { 'apps.presentations.nativeProperties': { render: () => null }, 'apps.presentations.nativeGeometry': { scene: () => new Map() } };
            window.Pivot = { legacy: {}, exposeModule: (key, value) => { modules[key] = value; }, moduleApi: key => modules[key] };
            const earlier = new Promise(resolve => { window.finishEarlier = resolve; });
            window.nativeFixture = async url => {
                if (url.endsWith('/info')) return { engine: { enabled: true } };
                if (url.endsWith('/jobs/latest')) return { task: null };
                if (url.endsWith('/documents')) return { documents: [{ id: 'old', title: '甲原稿', current_version: 1 }, { id: 'new', title: '乙原稿', current_version: 1 }] };
                if (url.endsWith('/versions')) return { versions: [{ version: 1 }] };
                const id = url.split('/').at(-1);
                if (id === 'old') { window.loadingEarlier = true; await earlier; window.earlierReturned = true; }
                return { document: { id, title: id === 'old' ? '甲原稿' : '乙原稿', version: 1, currentVersion: 1, manifest: { slides: [{ index: 0, objects: [] }] } } };
            };
        });
        await page.addScriptTag({ path: path.join(root, 'client/chat/apps-workbench-presentation-native.js') });
        await page.evaluate(() => window.Pivot.moduleApi('apps.presentations.native').bind({}, { requestJson: window.nativeFixture }));
        const chooser = page.locator('#presentation-native-documents'), notice = page.locator('#presentation-native-notice');
        const open = () => page.getByRole('button', { name: '打开原稿', exact: true }).click();
        await page.locator('#native-entry').click();
        await chooser.selectOption('old'); await open();
        await page.waitForFunction(() => window.loadingEarlier);
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#native-entry').click();
        await chooser.selectOption('new'); await open();
        await expect(notice).toContainText('乙原稿');
        await page.evaluate(() => window.finishEarlier());
        await page.waitForFunction(() => window.earlierReturned);
        await expect(notice).toContainText('乙原稿');
    } finally { await context.close(); }
});

test('停滞详情显示重复动作的归档坐标，连续工具失败显示脱敏操作摘要', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        let failed = {
            id: 'fixture-task', status: 'failed', recoverable: true, steps: 11, usedTokens: 100000,
            request: { presentationId: '', tokenBudget: 0, maxSteps: 80 },
            error: { code: 'PPT_MASTER_NO_PROGRESS', message: '多轮读取未取得新结果。' },
            actionRetries: 3, lastActionCorrection: 'PPT_MASTER_ACTION_INVALID',
            actionSummary: { writes: 0, lastActions: [{ action: 'read_history', failed: false }] },
            inspectionDiagnostic: { action: 'read_history', archive: 2, index: 18, offset: 12000 },
            usageDiagnostics: [
                {
                    call: 1, step: 1, inputTokens: 20785, outputTokens: 45, cumulativeTokens: 20830, inputEstimate: 45011, originalEstimate: 44217, compactedWrites: 0,
                    outcome: 'retry', errorCode: 'PPT_MASTER_ACTION_INVALID'
                },
                {
                    call: 2, step: 1, inputTokens: 21763, outputTokens: 38, cumulativeTokens: 42631, inputEstimate: 47641, originalEstimate: 46847, compactedWrites: 0,
                    outcome: 'productive', actions: [{ action: 'read_runtime', path: 'workflows/generate-pptx.md', offset: 0, nextOffset: 24000 }, { action: 'write', path: 'svg_output/slide_01.svg', confirmed: true }]
                },
                {
                    call: 3, step: 2, inputTokens: 24515, outputTokens: 39, cumulativeTokens: 67185, inputEstimate: 53857, originalEstimate: 53063, compactedWrites: 1,
                    outcome: 'tool_failed', skippedActions: 1, actions: [{ action: 'run', tool: 'text_measure', subcommand: 'calibrate', failed: true, exitCode: 2 }]
                }
            ]
        };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: failed } }));
        await page.route('**/master/tasks/fixture-task/resume', route => {
            failed = {
                ...failed, error: { code: 'PPT_MASTER_TOOL_REPEATED_FAILURE', message: '制作工具连续执行失败。' },
                actionSummary: { writes: 0, lastActions: [{ action: 'run', failed: true }], lastFailure: { action: 'run', tool: 'text_measure', exitCode: 2 } }
            };
            return route.fulfill({ json: { task: failed } });
        });
        await page.locator('#presentation-master-start').click();
        const panel = page.locator('#presentation-master-status');
        await expect(panel).toContainText('已修正模型动作 3 次。最近原因：动作格式、参数或阶段不符。');
        await expect(panel).toContainText('重复检查：回读历史 · 归档 2，消息 18 · 偏移 12000');
        await expect(panel).toContainText('本步工作（第 2 步）：执行工具 · 文字排版校准（字体字号校准） · 未通过（退出码 2）（其余 1 项因前序失败未执行）。');
        await expect(panel).toContainText('轮次异常记录（共 2 轮，最近在第 3 轮 / 步骤 2）：工具动作未通过：执行工具 · 文字排版校准（字体字号校准） · 未通过（退出码 2）；同批后续 1 项动作已停止。');
        await panel.getByRole('button', { name: /查看每轮模型用量/ }).click();
        const usageDialog = page.getByRole('dialog', { name: '每轮模型用量明细' });
        await expect(usageDialog).toContainText('动作修正重试');
        await expect(usageDialog).toContainText('异常诊断：动作格式、参数或阶段不符，宿主已自动要求模型修正重试。');
        await expect(usageDialog).toContainText('本轮工作：读取指引 · 默认生成流程指引 · 偏移 0→24000；写入文件 · 第 1 页矢量稿 · 已确认写入');
        await expect(usageDialog).toContainText('异常诊断：工具动作未通过：执行工具 · 文字排版校准（字体字号校准） · 未通过（退出码 2）；同批后续 1 项动作已停止。');
        await usageDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '从检查点继续' }).click();
        await expect(panel).toContainText('最近失败：执行工具 · text_measure · 退出码 2');
    } finally { await context.close(); }
});

test('失败检查点可查看材料读取范围和已保存提纲，也能区分尚未形成方案', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        let failed = {
            id: 'fixture-task', status: 'failed', recoverable: true, steps: 9, usedTokens: 100000,
            request: { presentationId: '', tokenBudget: 0, maxSteps: 80 },
            error: { code: 'PPT_MASTER_PHASE_LIMIT', message: '本阶段尚未提交方案。' },
            checkpointProgress: {
                requirementsLoaded: true, materials: [
                    { title: '情况报告.docx', saved: true, reads: 1, failedReads: 0, totalChars: 12000, contiguous: 6000, complete: false }
                ], plans: []
            }
        };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: failed } }));
        await page.route('**/master/tasks/fixture-task/resume', route => {
            failed = {
                ...failed, checkpointProgress: {
                    ...failed.checkpointProgress, plans: [
                        { stage: 'direction', status: 'approved', summary: '按经营结果组织汇报', pages: [] },
                        {
                            stage: 'design', status: 'citation_review', summary: '两页草稿', pages: [
                                { title: '经营概况', values: ['已核对事项 3 项'] }, { title: '后续安排', values: [] }
                            ]
                        }
                    ]
                },
                citationReview: { items: [{ location: '第 1 页第 1 项', title: '经营概况', text: '已核对事项 3 项',
                    reason: '关键数据未完整出现在引文中，请核对数字、单位及原文范围。' }] }
            };
            return route.fulfill({ json: { task: failed } });
        });
        await page.locator('#presentation-master-start').click();
        const panel = page.locator('#presentation-master-status');
        await panel.getByRole('button', { name: /查看材料与提纲/ }).click();
        const checkpointDialog = page.getByRole('dialog', { name: '材料与提纲' });
        await expect(checkpointDialog).toBeVisible();
        const dialogBox = await checkpointDialog.boundingBox();
        const viewport = page.viewportSize();
        assert(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= viewport.height, JSON.stringify({ viewport, dialogBox }));
        await expect(checkpointDialog).toContainText('情况报告.docx');
        await expect(checkpointDialog).toContainText('从开头已连续读取 6,000 / 12,000 字符');
        await expect(checkpointDialog.getByText('检查点中还没有已保存的方案或逐页提纲。')).toBeVisible();
        await expect(panel.getByText('从开头已连续读取 6,000 / 12,000 字符')).toHaveCount(0);
        await checkpointDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(checkpointDialog).toBeHidden();
        await panel.getByRole('button', { name: '从检查点继续' }).click();
        await expect(panel).toContainText('待核对的引文');
        await expect(panel).toContainText('关键数据未完整出现在引文中，请核对数字、单位及原文范围。');
        await expect(panel.getByRole('button', { name: /有已保存方案/ })).toBeVisible();
        await panel.getByRole('button', { name: /查看材料与提纲/ }).click();
        await expect(checkpointDialog).toBeVisible();
        await expect(checkpointDialog).toContainText('沟通方向');
        await expect(checkpointDialog).toContainText('已确认');
        await expect(checkpointDialog).toContainText('逐页提纲');
        await expect(checkpointDialog).toContainText('引文待核对');
        await expect(checkpointDialog).toContainText('共 2 页');
        await expect(checkpointDialog).toContainText('第 2 页');
        await expect(checkpointDialog).toContainText('后续安排');
        await checkpointDialog.getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await context.close(); }
});

test('累计预算不足时展示原预算，续跑可提高上限或改为不限', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), submitted = [];
        const failed = {
            id: 'fixture-task', status: 'failed', recoverable: true, steps: 11, usedTokens: 299001,
            request: { presentationId: '', tokenBudget: 400000, maxSteps: 80 }, error: { code: 'PPT_MASTER_BUDGET_EXHAUSTED', message: '剩余模型预算不足。' },
            actionSummary: { writes: 2, lastWrittenPath: 'project/spec_lock.md', failedWrites: 1, lastActions: [{ action: 'write', failed: true }] },
            modelRequest: { contextWindow: 256000, configuredInputLimit: 220000, inputEstimate: 1300, outputLimit: 12000, timeoutSeconds: 300 },
            usageDiagnostics: [{ step: 11, inputTokens: 1200, outputTokens: 200, inputEstimated: false, outputEstimated: true, inputEstimate: 1300, originalEstimate: 2000, compactedWrites: 1, cumulativeTokens: 299001, breakdown: { initial: 500, history: 700, toolResults: 100, images: 0 } }]
        };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task: failed } }));
        await page.route('**/master/tasks/fixture-task/resume', async route => {
            const input = route.request().postDataJSON();
            submitted.push(input);
            if (input.tokenBudget !== 0) return route.fulfill({ status: 503, json: { error: '服务暂不可用，请重试。' } });
            failed.request.tokenBudget = 0;
            failed.error = { code: 'PPT_MASTER_STEP_LIMIT', message: '已达到执行轮次上限。' };
            await route.fulfill({ json: { task: failed } });
        });
        await page.locator('#presentation-master-start').click();
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        const formDialog = page.getByRole('dialog', { name: '完整演示制作' });
        const engineState = page.locator('#presentation-master-engine-state');
        const panel = page.locator('#presentation-master-status');
        const budget = panel.locator('#presentation-master-resume-budget');
        await expect(processDialog).toBeVisible();
        await expect(panel).toContainText('本任务累计预算为 400,000 令牌');
        await expect(panel).toContainText('错误代码 PPT_MASTER_BUDGET_EXHAUSTED');
        await expect(panel).toContainText('已确认直接写入 2 次。最近写入 project/spec_lock.md。写入失败 1 次。最近工具动作包括写入文件未完成。');
        await expect(panel).toContainText('单轮窗口 256,000，配置输入上限 220,000，预计输入 1,300，本轮输出上限 12,000 令牌。');
        await expect(panel).toContainText('请求时限 300 秒。');
        await expect(panel.locator('.presentation-master-resume-panel')).toBeVisible();
        const resumeBoundsDesktop = await panel.getByRole('button', { name: '从检查点继续' }).boundingBox();
        const panelBoundsDesktop = await panel.boundingBox();
        assert(resumeBoundsDesktop.width < panelBoundsDesktop.width * 0.5, '桌面端从检查点继续按钮不应拉伸占满整行');
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/resume-1366.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await processDialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/resume-390.png') });
        await expect(budget).toHaveValue('');
        await panel.getByRole('button', { name: /查看每轮模型用量/ }).click();
        const usageDialog = page.getByRole('dialog', { name: '每轮模型用量明细' });
        await expect(usageDialog).toBeVisible();
        await expect(usageDialog).toContainText('输入 1200，输出 200（估算）');
        await expect(usageDialog).toContainText('初始指引及任务 500，历史消息 700，工具结果 100，图片 0');
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/usage-390.png') });
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/usage-1366.png') });
        await usageDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(usageDialog).toBeHidden();
        await expect(budget).toBeVisible();
        const resume = panel.getByRole('button', { name: '从检查点继续' });
        await resume.click();
        await expect(panel).toContainText('请先提高续跑累计模型预算');
        assert.equal(submitted.length, 0);
        await budget.fill('800000'); await resume.click();
        await expect(panel).toContainText('服务暂不可用，请重试');
        await expect(resume).toBeEnabled();
        await expect(budget).toHaveValue('800000');
        assert.equal(submitted[0].tokenBudget, 800000);
        await resume.click();
        await expect.poll(() => submitted.length).toBe(2);
        failed.request.tokenBudget = 800000;
        await page.route('**/master/tasks/latest?**', route => route.fulfill({ json: { task: failed } }));
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await page.getByRole('button', { name: '查看最近制作' }).click();
        await expect(panel).toContainText('本任务累计预算为 800,000 令牌');
        await expect(budget).toHaveValue('');
        await resume.click();
        await expect(panel).toContainText('请先提高续跑累计模型预算');
        assert.equal(submitted.length, 2);
        await budget.fill('0');
        await resume.click();
        await expect(panel).toContainText('本任务累计预算 不限');
        assert.equal(submitted[2].tokenBudget, 0);
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#entry').click();
        await expect(engineState).toContainText('完整制作引擎已登记');
        await page.getByRole('button', { name: '查看最近制作' }).click();
        await expect(panel).toContainText('本任务累计预算 不限');
        await expect(budget).toHaveValue('');
    } finally { await context.close(); }
});

test('旧沟通方向检查点只显示继续制作，后续仍确认最终清单', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context);
        const promptId = 'c'.repeat(64);
        let inputRequest = { kind: 'continue', promptId, question: '已保留当前制作进度，可以继续准备最终页面清单。' };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: {
            task: { id: 'fixture-task', status: 'input_required', inputRequest }
        } }));
        await page.route('**/master/tasks/fixture-task/respond', route => {
            assert.deepEqual(route.request().postDataJSON(), { answer: '', decision: 'continue', promptId });
            inputRequest = { kind: 'confirmation', stage: 'design', question: '是否批准最终清单？', promptId: 'd'.repeat(64),
                plan: { pages: [{ title: '项目概况', values: [] }] } };
            return route.fulfill({ json: { task: { id: 'fixture-task', status: 'working' } } });
        });
        await page.locator('#presentation-master-start').click();
        const panel = page.locator('#presentation-master-status');
        await expect(panel).toContainText('可继续制作');
        await expect(panel.getByRole('textbox', { name: '对制作方案的实际答复' })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: '确认并继续' })).toHaveCount(0);
        await panel.getByRole('button', { name: '继续制作', exact: true }).click();
        await expect(panel).toContainText('确认最终页面与关键数据清单');
        await expect(panel.getByRole('button', { name: '确认并继续' })).toBeVisible();
    } finally { await context.close(); }
});

test('方案确认可直接继续，补充问题要求实际答复，失败保留输入并显示真实预算', async () => {
    const context = await fixture();
    try {
        const page = await pageFor(context), submitted = [];
        let task = {
            id: 'fixture-task', status: 'input_required', steps: 3, usedTokens: 59211,
            request: { presentationId: '', tokenBudget: 400000, maxSteps: 80 },
            progress: { message: '是否按方案制作？' }, inputRequest: {
                kind: 'confirmation', stage: 'design', question: '是否按方案制作？', context: '八页汇报方案。',
                plan: { pages: [{ title: '1. 离线机房 AI 运行环境搭建', values: [{ text: '搭建现代化 AI 运行环境', source: { path: 'inputs/material-1.md', quote: '通过这套流程搭建出 RTX 2080 Ti 加速环境' } }] }] }, promptId: 'a'.repeat(64)
            }
        };
        await page.route('**/master/tasks/fixture-task', route => route.fulfill({ json: { task } }));
        let fail = true;
        await page.route('**/master/tasks/fixture-task/respond', async route => {
            submitted.push(route.request().postDataJSON());
            if (fail) return route.fulfill({ status: 503, json: { error: '确认服务暂不可用，请重试。' } });
            task = { ...task, status: 'working' };
            return route.fulfill({ json: { task } });
        });
        await page.locator('#presentation-master-start').click();
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        const panel = page.locator('#presentation-master-status');
        await expect(processDialog.getByRole('button', { name: '返回配置' })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: '停止制作' })).toHaveClass(/btn-danger-outline/);
        await expect(panel).toContainText('已用约 59,211 令牌。本任务累计预算 400,000 令牌');
        await expect(panel.getByText('是否按方案制作？', { exact: true })).toHaveCount(1);
        for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
            const contextBounds = await panel.locator('.presentation-master-task-context').boundingBox();
            assert(contextBounds.height < 100, '短方案说明不应撑开大块空白');
            await expect(panel.getByRole('button', { name: '确认并继续' })).toBeVisible();
            await expect(panel.getByRole('button', { name: '提交修改意见' })).toBeVisible();
        }
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/confirm-1366.png') });
        await panel.getByRole('button', { name: '确认并继续' }).click();
        await expect(panel.getByRole('alert')).toHaveText('确认服务暂不可用，请重试。');
        await expect(panel.getByRole('button', { name: '确认并继续' })).toBeEnabled();
        assert.deepEqual(submitted[0], { answer: '', decision: 'approve', promptId: 'a'.repeat(64) });
        const actionsBar = panel.locator('.presentation-master-confirm-actions');
        await expect(actionsBar).not.toHaveClass(/has-draft-reply/);
        await panel.getByRole('textbox', { name: '对制作方案的实际答复' }).fill('请保留原始金额');
        await expect(actionsBar).toHaveClass(/has-draft-reply/);
        await page.screenshot({ path: path.join(root, 'output/presentation-master-form/confirm-has-reply-1366.png') });
        await panel.getByRole('button', { name: '确认并继续' }).click();
        await expect(panel.getByRole('alert')).toHaveText('请提交已填写的修改意见，或清空意见后确认。');
        assert.equal(submitted.length, 1);
        await panel.getByRole('button', { name: '提交修改意见' }).click();
        await expect(panel.getByRole('alert')).toHaveText('确认服务暂不可用，请重试。');
        await expect(panel.getByRole('textbox', { name: '对制作方案的实际答复' })).toHaveValue('请保留原始金额');
        fail = false;
        await panel.getByRole('button', { name: '提交修改意见' }).click();
        await expect(panel).toContainText('正在制作中');
        assert.equal(submitted[2].answer, '请保留原始金额');
        assert.equal(submitted[2].decision, 'revise');
        await page.getByRole('dialog', { name: '完整制作过程' }).getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('dialog', { name: '完整演示制作' }).getByRole('button', { name: '关闭', exact: true }).click();
        task = { ...task, status: 'input_required', inputRequest: { kind: 'clarification', question: '请提供目标受众。', context: '制作需要受众信息。' } };
        await page.route('**/master/tasks/latest?**', route => route.fulfill({ json: { task } }));
        await page.locator('#entry').click();
        await page.getByRole('button', { name: '查看最近制作' }).click();
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
        const page = await pageFor(context), dialog = page.getByRole('dialog', { name: '完整演示制作' });
        await expect(page.locator('#presentation-master-engine-state')).toContainText('完整制作引擎已登记');
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
        const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
        const formDialog = page.getByRole('dialog', { name: '完整演示制作' });
        for (const file of [await word('空白材料.docx', ''), { name: '超长材料.txt', mimeType: 'text/plain', buffer: Buffer.from('甲'.repeat(120001)) }]) {
            await upload.setInputFiles(file); await page.locator('#presentation-master-start').click();
            await expect(processDialog).toBeVisible();
            await expect(page.locator('#presentation-master-status')).toContainText(/未能.*提取|超过十二万字/);
            await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
            await expect(page.locator('#presentation-master-instruction')).toHaveValue('按材料制作汇报，保留原始数字和来源。');
            assert.equal(context.requests.length, 0);
        }
        await expect.poll(async () => (await fs.readdir(context.directory)).length).toBe(0);
        let release, entered;
        const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
        await page.route('**/materials/extract', async route => { entered(); await gate; await route.fulfill({ json: { material: { text: '迟到的材料' } } }).catch(() => { }); });
        await upload.setInputFiles(await word('等待解析.docx', '等待解析'));
        await page.locator('#presentation-master-start').click(); await started;
        await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click(); release();
        await expect(page.locator('#presentation-master-start')).toHaveCount(0); assert.equal(context.requests.length, 0);
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
        if (await processDialog.isVisible()) await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await formDialog.getByRole('button', { name: '关闭', exact: true }).click(); await page.locator('#entry').click();
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
            await page.route('**/master/tasks/fixture-task', route => route.fulfill({
                json: {
                    task: {
                        id: 'fixture-task', status: 'working', steps: 6, usedTokens: 155395,
                        request: { presentationId: '', tokenBudget: 160000, title: '测试演示' },
                        progress: { message: '已归档较早的工具结果，正在继续制作。' },
                        usageDiagnostics: [{ call: 1, step: 6, inputTokens: 80679, outputTokens: 2100, cumulativeTokens: 155395, inputEstimate: 80679, originalEstimate: 92000, compactedWrites: 2 }]
                    }
                }
            }));
            await page.locator('#presentation-master-start').click();
            const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
            await expect(processDialog).toBeVisible();
            await expect(page.locator('#presentation-master-status')).toContainText('正在制作中');
            const processBounds = await processDialog.boundingBox();
            assert(processBounds.x >= 0 && processBounds.y >= 0 && processBounds.x + processBounds.width <= viewport.width && processBounds.y + processBounds.height <= viewport.height, JSON.stringify({ viewport, processBounds }));
            assert(await processDialog.evaluate(element => element.scrollWidth <= element.clientWidth));
            await page.screenshot({ path: path.join(output, `${colorScheme}-${viewport.width}-process.png`) });
            await page.keyboard.press('Escape'); await expect(processDialog).toBeHidden(); await expect(page.locator('#presentation-master-start')).toBeFocused();
            await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.locator('#entry')).toBeFocused();
            await page.close();
        }
    } finally { await context.close(); }
});
