/* global window, Response */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
test('项目工作台在桌面与窄屏创建、编辑、冲突反馈、任务选取和账号切换保持一致', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1366, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            await page.setContent('<button data-open-projects>项目</button><select id="agent-project-select"></select><select id="agent-context-collections" multiple></select><textarea id="agent-goal-input"></textarea>');
            for (const file of ['client/common/styles/theme.css', 'client/chat/styles/base/modals-forms.css', 'client/chat/styles/workspaces/table-foundation.css', 'client/chat/styles/workspaces/shared.css'])
                await page.addStyleTag({ path: path.join(root, file) });
            await page.evaluate(() => {
                const modules = {};
                window.API_BASE = '/api';
                window.savedProjects = [];
                window.projectRequests = [];
                window.Pivot = { legacy: { currentUser: { id: 1 }, setTaskComposerOpen: () => {
                        }, openAgentRun: async () => {
                        } }, exposeModule: (name, value) => modules[name] = value, moduleApi: name => modules[name] || { openAgentWorkbench: async () => {
                        } }, openArtifact: () => {
                    } };
                window.apiFetch = async (url, options = {}) => {
                    window.projectRequests.push({ url, body: options.body });
                    if (url.includes('context-packs'))
                        return new Response(JSON.stringify({ data: [{ id: 1, name: '项目资料' }] }));
                    if (url.includes('/artifacts'))
                        return new Response(JSON.stringify({ data: [{ id: 9, title: '原始报告' }] }));
                    if (options.method) {
                        const input = JSON.parse(options.body);
                        if (window.projectConflict)
                            return new Response(JSON.stringify({ error: '项目已被其他操作修改，请刷新后重试。' }), { status: 409 });
                        const project = { ...input, id: 'project-example', version: window.savedProjects.length + 1, status: 'active' };
                        window.savedProjects.push(project);
                        return new Response(JSON.stringify({ project }));
                    }
                    if (url.includes('/projects/')) {
                        const project = window.savedProjects.at(-1);
                        return new Response(JSON.stringify({ project, collections: [], artifacts: [], tasks: [], taskTotal: 0, artifactTotal: 0 }));
                    }
                    return new Response(JSON.stringify({ data: window.savedProjects.slice(-1), total: window.savedProjects.length ? 1 : 0 }));
                };
            });
            await page.addScriptTag({ path: path.join(root, 'client/chat/agent-projects.js') });
            await page.getByRole('button', { name: '项目', exact: true }).click();
            await page.getByRole('button', { name: '新建项目', exact: true }).click();
            await page.getByLabel('项目名称', { exact: true }).fill('项目<script>不会执行</script>');
            await page.getByLabel('工作规则', { exact: true }).fill('保留来源与两位小数');
            await page.getByLabel('项目资料范围').selectOption('1');
            await page.getByLabel('关联已有文件').selectOption('9');
            await page.getByRole('button', { name: '添加里程碑' }).click();
            await page.getByLabel('名称', { exact: true }).fill('初稿');
            await page.getByRole('button', { name: '保存项目', exact: true }).click();
            await expect(page.getByRole('heading', { name: '项目<script>不会执行</script>' })).toBeVisible();
            const saved = await page.evaluate(() => window.savedProjects.at(-1));
            assert.deepEqual(saved.collectionIds, [1]);
            assert.deepEqual(saved.artifactIds, [9]);
            assert.equal(saved.milestones[0].title, '初稿');
            assert.equal(await page.locator('#agent-projects-modal script').count(), 0);
            await require('node:fs/promises').mkdir(path.join(root, 'output/agent-upgrade-test-temp'), { recursive: true });
            await page.screenshot({ path: path.join(root, `output/agent-upgrade-test-temp/projects-${width}.png`) });
            const bounds = await page.locator('.agent-projects-dialog').boundingBox();
            assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
            await page.getByRole('button', { name: '编辑项目', exact: true }).click();
            await page.evaluate(() => window.projectConflict = true);
            await page.getByLabel('工作规则', { exact: true }).fill('不能丢失的新输入');
            await page.getByRole('button', { name: '保存项目', exact: true }).click();
            await expect(page.getByRole('alert')).toContainText('其他操作');
            await expect(page.getByLabel('工作规则', { exact: true })).toHaveValue('不能丢失的新输入');
            await page.evaluate(() => {
                window.Pivot.moduleApi('agent.projects').reset();
                window.Pivot.legacy.currentUser = { id: 2 };
            });
            await expect(page.locator('#agent-projects-modal')).toBeHidden();
            assert.equal(await page.locator('#agent-projects-modal').innerText(), '项目空间关闭');
            await page.close();
        }
    }
    finally {
        await browser.close();
    }
});

test('里程碑弹窗支持打开填报、确定并入、二次编辑、删除及无障碍按键关闭', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await page.setContent('<button data-open-projects>项目</button><select id="agent-project-select"></select><select id="agent-context-collections" multiple></select><textarea id="agent-goal-input"></textarea>');
        for (const file of ['client/common/styles/theme.css', 'client/chat/styles/base/modals-forms.css', 'client/chat/styles/workspaces/table-foundation.css', 'client/chat/styles/workspaces/shared.css'])
            await page.addStyleTag({ path: path.join(root, file) });
        await page.evaluate(() => {
            const modules = {};
            window.API_BASE = '/api';
            window.savedProjects = [];
            window.Pivot = {
                legacy: { currentUser: { id: 1 } },
                exposeModule: (name, value) => modules[name] = value,
                moduleApi: name => modules[name] || {}
            };
            window.apiFetch = async (url, options = {}) => {
                if (url.includes('context-packs'))
                    return new Response(JSON.stringify({ data: [{ id: 1, name: '项目资料' }] }));
                if (url.includes('/artifacts'))
                    return new Response(JSON.stringify({ data: [] }));
                if (options.method === 'POST') {
                    const input = JSON.parse(options.body);
                    const project = { ...input, id: 'proj-modal-1', version: 1, status: 'active' };
                    window.savedProjects.push(project);
                    return new Response(JSON.stringify({ project }));
                }
                if (url.includes('/projects/')) {
                    return new Response(JSON.stringify({ project: window.savedProjects.at(-1), collections: [], artifacts: [], tasks: [], taskTotal: 0, artifactTotal: 0 }));
                }
                return new Response(JSON.stringify({ data: window.savedProjects, total: window.savedProjects.length }));
            };
        });
        await page.addScriptTag({ path: path.join(root, 'client/chat/agent-projects.js') });
        await page.getByRole('button', { name: '项目', exact: true }).click();
        await page.getByRole('button', { name: '新建项目', exact: true }).click();
        await page.getByLabel('项目名称', { exact: true }).fill('弹窗交互验证项目');

        // 1. 点击添加里程碑弹出子弹窗
        await page.getByRole('button', { name: '添加里程碑' }).click();
        await expect(page.locator('.agent-projects-milestone-dialog')).toBeVisible();
        await expect(page.locator('.agent-projects-milestone-dialog h4')).toHaveText('添加里程碑');

        // 2. 填写字段
        await page.getByLabel('名称', { exact: true }).fill('阶段一完成');
        await page.getByLabel('到期日期').fill('2026-12-31');
        await page.getByLabel('人工确认或阻塞说明').fill('需要架构师签名');

        // 3. 点击弹窗内确定按钮
        await page.locator('.agent-projects-milestone-dialog').getByRole('button', { name: '确定', exact: true }).click();
        await expect(page.locator('.agent-projects-milestone-dialog')).toBeHidden();

        // 4. 主页面生成卡片
        const card = page.locator('.agent-projects-milestone-card');
        await expect(card).toBeVisible();
        await expect(card.locator('.agent-projects-milestone-card-title')).toHaveText('阶段一完成');
        await expect(card).toContainText('到期：2026-12-31');
        await expect(card).toContainText('说明：需要架构师签名');

        // 5. 点击卡片上的编辑按钮，子弹窗回填并修改
        await card.getByRole('button', { name: '编辑', exact: true }).click();
        await expect(page.locator('.agent-projects-milestone-dialog h4')).toHaveText('编辑里程碑');
        await expect(page.getByLabel('名称', { exact: true })).toHaveValue('阶段一完成');
        await page.getByLabel('名称', { exact: true }).fill('阶段一终稿完成');
        await page.locator('.agent-projects-milestone-dialog').getByRole('button', { name: '保存修改', exact: true }).click();
        await expect(page.locator('.agent-projects-milestone-dialog')).toBeHidden();
        await expect(card.locator('.agent-projects-milestone-card-title')).toHaveText('阶段一终稿完成');

        // 6. 测试 Esc 键关闭弹窗
        await page.getByRole('button', { name: '添加里程碑' }).click();
        await expect(page.locator('.agent-projects-milestone-dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.agent-projects-milestone-dialog')).toBeHidden();

        // 7. 删除里程碑
        await card.getByRole('button', { name: '删除', exact: true }).click();
        await expect(card).toBeHidden();
        await expect(page.locator('.agent-projects-empty-milestones')).toContainText('暂无里程碑');

        await page.close();
    } finally {
        await browser.close();
    }
});
