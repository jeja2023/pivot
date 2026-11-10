/* global window, document, Response, File, DataTransfer, Event */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { chromium, expect } = require('@playwright/test');
test('技能目录浏览器预览和发布携带资源内容，重新选文件后旧配套内容失效', async () => {
    const browser = await chromium.launch({ headless: true }), page = await browser.newPage();
    try {
        await page.setContent('<select id="agent-skill-import-template"></select><input id="agent-skill-import-source" type="file"><input id="agent-skill-import-folder" type="file" multiple webkitdirectory><input id="agent-skill-import-title"><input id="agent-skill-import-description"><select id="agent-skill-import-tools" multiple></select><button id="agent-skill-import-preview">预览</button><button id="agent-skill-import-submit">确认添加</button><pre id="agent-skill-import-review"></pre><p id="agent-skill-import-status"></p>');
        await page.evaluate(() => {
            const modules = {};
            window.API_BASE = '/api';
            window.importRequests = [];
            window.Pivot = { legacy: { currentUser: { id: 1 } }, exposeModule: (name, api) => modules[name] = api, moduleApi: name => modules[name] || {} };
            const tools = ['skill.resources', 'skill.read_resource'].map(name => ({ name, title: name, description: '技能资料', capabilities: ['artifact.read'], risk: 'low', approvalRequired: false }));
            window.apiFetch = async (url, options = {}) => {
                const body = options.body ? JSON.parse(options.body) : null;
                window.importRequests.push({ url, body });
                if (url.endsWith('/import/tools'))
                    return new Response(JSON.stringify({ tools, templates: [] }));
                if (url.endsWith('/inspect'))
                    return new Response(JSON.stringify({ inspection: { identity: { title: '目录技能', description: '带资料的技能' }, compatibility: { fields: [], requirements: [] } } }));
                if (url.endsWith('/preview'))
                    return new Response(JSON.stringify({ proposal: { name: 'imported', markdown: '规范化技能指引', tools, warnings: [], preview: { valid: true, errors: [] }, compatibility: { readiness: { bundledResources: 'available' }, fields: [], requirements: [] } } }));
                if (url.endsWith('/source'))
                    return new Response(JSON.stringify({ version: { id: 51 } }));
                if (url.endsWith('/validate') || url.endsWith('/publish'))
                    return new Response('{}');
                throw new Error(url);
            };
        });
        await page.addScriptTag({ path: path.resolve(__dirname, '../client/chat/agent-skill-import.js') });
        await page.evaluate(async () => {
            const api = window.Pivot.moduleApi('agent.skillImport');
            api.bind({ refresh: async () => {
                } });
            await api.loadTools();
            const files = [['folder/SKILL.md', '---\nname: example\ndescription: 资料技能\n---\n阅读references/rules.md'], ['folder/references/rules.md', '不可丢失的业务依据']];
            const transfer = new DataTransfer();
            for (const [name, text] of files) {
                const file = new File([text], name.split('/').at(-1), { type: 'text/plain' });
                Object.defineProperty(file, 'webkitRelativePath', { value: name });
                transfer.items.add(file);
            }
            const input = document.getElementById('agent-skill-import-folder');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change'));
        });
        await expect(page.locator('#agent-skill-import-status')).toContainText('目录已读取');
        await page.locator('#agent-skill-import-tools').selectOption(['skill.resources', 'skill.read_resource']);
        await page.getByRole('button', { name: '预览', exact: true }).click();
        await expect(page.locator('#agent-skill-import-review')).toContainText('配套资料：已绑定内容摘要');
        await page.getByRole('button', { name: '确认添加', exact: true }).click();
        await expect(page.locator('#agent-skill-import-status')).toContainText('个人技能');
        const sent = await page.evaluate(() => window.importRequests.find(item => item.url.endsWith('/source')).body);
        assert.equal(sent.resources.length, 1);
        assert.equal(Buffer.from(sent.resources[0].content, 'base64').toString('utf8'), '不可丢失的业务依据');
        await page.locator('#agent-skill-import-source').setInputFiles({ name: 'new.md', mimeType: 'text/markdown', buffer: Buffer.from('# 新指引') });
        await expect(page.locator('#agent-skill-import-title')).toHaveValue('目录技能');
        await page.getByRole('button', { name: '预览', exact: true }).click();
        const latest = await page.evaluate(() => window.importRequests.filter(item => item.url.endsWith('/preview')).at(-1).body);
        assert.deepEqual(latest.resources, []);
    }
    finally {
        await browser.close();
    }
});
