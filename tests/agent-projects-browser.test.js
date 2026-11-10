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
