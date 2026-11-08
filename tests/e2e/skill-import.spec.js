'use strict';
/* global document, window, apiFetch */
const { expect, test } = require('@playwright/test');
const crypto = require('node:crypto');
const { parseSkillSourceMarkdown } = require('../../server/services/agent-skill-source');

async function requestInPage(page, url, body, method = 'POST') {
    return page.evaluate(async input => {
        const result = await apiFetch(input.url, { method: input.method, headers: { 'Content-Type': 'application/json' }, ...(input.body ? { body: JSON.stringify(input.body) } : {}) });
        return { status: result.status, data: await result.json() };
    }, { url, body, method });
}

test('代码审查模板明确只读边界，缺少连接器时提示授权并拒绝写工具', async ({ page }) => {
    test.setTimeout(90000);
    expect((await page.request.get('/api/agents/skills/import/templates/code-review')).status()).toBe(401);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const unknown = await page.request.get('/api/agents/skills/import/templates/unknown');
    expect(unknown.status()).toBe(422);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="governance"]').click();
    await page.locator('[data-agent-harness-nav="skills"]').click();
    const templates = page.locator('#agent-skill-import-template');
    await expect(templates.locator('option')).toHaveCount(3, { timeout: 15000 });
    await templates.selectOption('code-review');
    await expect(page.locator('#agent-skill-import-title')).toHaveValue('代码变更审查');
    await expect(page.locator('#agent-skill-import-status')).toContainText('暂无可用的工作区只读工具');
    const refused = await requestInPage(page, '/api/agents/skills/import/preview', { templateId: 'code-review', tools: ['rag.search'], markdown: '替换正文' });
    expect(refused.status).toBe(422);
    await expect(page.locator('#agent-skill-import-submit')).toBeDisabled();
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(templates).toBeVisible();
        await expect.poll(() => templates.evaluate(select => {
            const rect = select.getBoundingClientRect();
            return rect.width > 0 && rect.right <= window.innerWidth + 1 && rect.left >= 0;
        })).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    const deviceId = `review-e2e-${Date.now()}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    const sign = text => crypto.sign(null, Buffer.from(text), keys.privateKey).toString('base64');
    const challenge = await requestInPage(page, '/api/agents/local-devices/challenge', { deviceId, purpose: 'register' });
    expect(challenge.status).toBe(201);
    const registered = await requestInPage(page, '/api/agents/local-devices', { deviceId, deviceName: '审查测试设备', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), nonce: challenge.data.nonce, signature: sign(`register:${challenge.data.nonce}:${deviceId}`) });
    expect(registered.status).toBe(201);
    try {
        const heartbeat = await requestInPage(page, '/api/agents/local-devices/challenge', { deviceId, purpose: 'connector' });
        const connected = await requestInPage(page, '/api/mcp/local-device/connector/heartbeat', { deviceId, nonce: heartbeat.data.nonce, signature: sign(`connector:${heartbeat.data.nonce}:${deviceId}`), grants: { local_workspace: { authorized: true, label: '审查测试工作区' } } });
        expect(connected.status).toBe(200);
        await templates.selectOption('');
        await templates.selectOption('code-review');
        await expect(page.locator('#agent-skill-import-tools option')).toHaveCount(8);
        await page.locator('#agent-skill-import-preview').click();
        await expect(page.locator('#agent-skill-import-review')).toContainText('仅供显式选择');
        await expect(page.locator('#agent-skill-import-review')).toContainText('filesystem.read_workspace');
        const createdRequest = page.waitForResponse(response => response.url().endsWith('/api/agents/skills/source') && response.request().method() === 'POST');
        await page.locator('#agent-skill-import-submit').click();
        await expect(page.locator('#agent-skill-import-status')).toContainText('个人技能已添加并发布', { timeout: 45000 });
        const version = (await (await createdRequest).json()).version;
        const exported = await page.request.get(`/api/agents/skills/versions/${version.id}/source`);
        const parsed = parseSkillSourceMarkdown((await exported.json()).markdown).manifest;
        expect(parsed.tools).toHaveLength(8);
        expect(parsed.tools.every(name => /^mcp\.\d+\.workspace\.(inspect|read|search|symbols|definition|references|git_status|git_diff)$/.test(name))).toBe(true);
        expect(parsed.capabilities).toEqual(['filesystem.read_workspace']);
        expect(parsed.importSource.originalFields.metadata.activation).toBe('explicit');
    } finally {
        await requestInPage(page, `/api/agents/local-devices/${deviceId}`, null, 'DELETE');
    }
});

test('技能文件可预览并经原有验证和个人发布流程添加', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await expect(page.locator('#agent-workbench-modal')).toBeVisible();
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="governance"]').click();
    await page.locator('[data-agent-harness-nav="skills"]').click();
    const selector = page.locator('#agent-skill-import-tools');
    await expect(selector.locator('option[value="rag.search"]')).toHaveCount(1, { timeout: 15000 });
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => page.evaluate(() => {
            const modal = document.querySelector('#agent-workbench-modal');
            const form = document.querySelector('.agent-harness-skill-form-wrap');
            const rect = form.getBoundingClientRect();
            return modal.scrollWidth <= modal.clientWidth + 1 && rect.width > 0 && rect.right <= window.innerWidth + 1;
        })).toBe(true);
        await expect(page.locator('#agent-skill-import-preview')).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const denied = await page.request.post('/api/agents/skills/import/preview', { headers: { 'x-csrf-token': csrf }, data: { markdown: '# 操作', title: '无授权工具', tools: ['mcp.999999.fake'] } });
    expect(denied.status()).toBe(422);
    await page.locator('#agent-skill-import-source').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: summary\nallowed-tools: ignored\n---\n\n# 工作指引\n根据授权资料提供摘要。') });
    await page.locator('#agent-skill-import-title').fill('测试资料摘要');
    await selector.selectOption('rag.search');
    await page.locator('#agent-skill-import-preview').click();
    const preview = page.locator('#agent-skill-import-review');
    await expect(preview).toContainText('根据授权资料提供摘要');
    await expect(preview).toContainText('脚本、附件、依赖');
    await expect(preview).toContainText('knowledge.search');
    await expect(preview).toContainText('allowed-tools');
    const createdRequest = page.waitForResponse(response => response.url().endsWith('/api/agents/skills/source') && response.request().method() === 'POST');
    await page.locator('#agent-skill-import-submit').click();
    await expect(page.locator('#agent-skill-import-status')).toContainText('个人技能已添加并发布', { timeout: 45000 });
    await expect(page.locator('#agent-harness-skill-list')).toContainText('测试资料摘要');
    const versions = await page.request.get('/api/agents/skills/versions?limit=100');
    const createdId = (await (await createdRequest).json()).version.id;
    const created = (await versions.json()).data.find(item => String(item.id) === String(createdId));
    expect(created.status).toBe('published');
    const exported = await page.request.get(`/api/agents/skills/versions/${created.id}/source`);
    const markdown = (await exported.json()).markdown;
    expect(markdown).toContain('根据授权资料提供摘要');
    const parsed = parseSkillSourceMarkdown(markdown).manifest;
    expect(parsed['allowed-tools']).toBeUndefined();
    expect(parsed.importSource.originalFields['allowed-tools']).toBe('ignored');
    expect(parsed.tools).toEqual(['rag.search']);
});

test('结构化技能自动识别并保留元数据，宿主扩展与配套文件明确提示待适配', async ({ page }) => {
    test.setTimeout(90000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="governance"]').click();
    await page.locator('[data-agent-harness-nav="skills"]').click();
    const selector = page.locator('#agent-skill-import-tools');
    await expect(selector.locator('option[value="rag.search"]')).toHaveCount(1, { timeout: 15000 });
    const source = { manifest: { name: 'json-report', description: '资料报告指引', context: 'fork', metadata: { author: '示例作者', version: '2.4', license: 'MIT', custom: { category: '报告' } } },
        instructions: '阅读 [参考](references/report.md)，根据资料提供摘要。' };
    await page.locator('#agent-skill-import-source').setInputFiles({ name: 'SKILL.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
    await expect(page.locator('#agent-skill-import-title')).toHaveValue('json-report');
    await expect(page.locator('#agent-skill-import-description')).toHaveValue('资料报告指引');
    await selector.selectOption('rag.search');
    await page.locator('#agent-skill-import-preview').click();
    const review = page.locator('#agent-skill-import-review');
    await expect(review).toContainText('Claude Code 扩展技能');
    await expect(review).toContainText('文件类型：JSON');
    await expect(review).toContainText('完整运行仍需适配');
    await expect(review).toContainText('references/report.md');
    const createdRequest = page.waitForResponse(response => response.url().endsWith('/api/agents/skills/source') && response.request().method() === 'POST');
    await page.locator('#agent-skill-import-submit').click();
    await expect(page.locator('#agent-skill-import-status')).toContainText('个人技能已添加并发布', { timeout: 45000 });
    const version = (await (await createdRequest).json()).version;
    expect(version).toBeTruthy();
    const exported = await page.request.get(`/api/agents/skills/versions/${version.id}/source`);
    const parsed = parseSkillSourceMarkdown((await exported.json()).markdown).manifest;
    expect(parsed.context).toBeUndefined(); expect(parsed.license).toBe('MIT');
    expect(parsed.importSource.container).toBe('json');
    expect(parsed.importSource.originalFields.metadata.custom.category).toBe('报告');
    expect(parsed.capabilities).toEqual(['knowledge.search']);
});
