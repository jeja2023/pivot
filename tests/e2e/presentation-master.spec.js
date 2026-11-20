'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const Zip = require('jszip');
const sharp = require('sharp');
const fixture = require('../../scripts/test_support/ppt_master_default_model');

test('256K 默认完整制作直接生成初稿，分页读取图片并核验真实PPTX与源包', async ({ page }, testInfo) => {
    test.setTimeout(420000);
    const fixtureEndpoint = process.env.PIVOT_E2E_PPT_MASTER_SERVICE_URL;
    test.skip(process.env.PIVOT_PPT_MASTER_ENABLED !== 'true' && !fixtureEndpoint, '需要已准备的固定版本完整运行镜像');
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } }); expect(login.ok()).toBeTruthy();
    const csrf = () => page.context().cookies().then(cookies => ({ 'x-csrf-token': cookies.find(cookie => cookie.name === 'pivot_csrf_token')?.value }));
    if (fixtureEndpoint) {
        expect(process.env.PIVOT_E2E_ISOLATED).toBe('true');
        const { config } = await (await page.request.get('/api/settings/ppt-master')).json();
        const setup = await page.request.put('/api/settings/ppt-master', { headers: await csrf(), data: {
            revision: config.revision, endpoint: fixtureEndpoint, token: process.env.PIVOT_E2E_PPT_MASTER_SERVICE_TOKEN, enabled: true
        } });
        expect(setup.ok(), await setup.text()).toBeTruthy();
        await expect.poll(async () => {
            const response = await page.request.get('/api/apps/presentations/master/info');
            if (!response.ok()) return false;
            const { engine } = await response.json();
            return engine?.enabled && engine?.checklistReady;
        }, { timeout: 30000 }).toBe(true);
    }
    const modelName = '完整PPT验收-' + Date.now();
    const created = await page.request.post('/api/models', { headers: await csrf(), data: { name: modelName, url: process.env.E2E_MODEL_URL, model_name: 'ppt-master-e2e', context_window_tokens: 256000, max_tokens: 12000, supports_vision: true } }); expect(created.ok()).toBeTruthy();
    const models = (await (await page.request.get('/api/models?limit=100')).json()).data;
    const model = models.find(item => item.name === modelName); expect(model).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    await page.locator('#presentation-create-ai-btn').click();
    await page.locator('#presentation-master-title').fill('完整引擎浏览器验收', { timeout: 15000 });
    await page.locator('#presentation-master-model').selectOption(String(model.id));
    await page.locator('#presentation-master-profile').selectOption('default');
    await page.locator('#presentation-master-pages').fill('3');
    await page.locator('.presentation-master-advanced summary').click();
    await page.locator('#presentation-master-budget').fill('10000');
    await page.locator('#presentation-master-instruction').fill('根据长材料生成正式三页经营复核汇报，保留各段关键数字。五张合成图片仅作材料盘点参考。');
    const material = fixture.longMaterial();
    expect(material.length).toBeGreaterThan(75000);
    await page.locator('#presentation-master-material').fill(material);
    const imageFiles = await Promise.all(['#164bcc', '#29974e', '#bc3716', '#804caf', '#666666'].map(async (background, index) => ({
        name: `image-${index + 1}.png`, mimeType: 'image/png',
        buffer: await sharp({ create: { width: 120, height: 90, channels: 3, background } }).png().toBuffer()
    })));
    await page.locator('#presentation-master-source').setInputFiles(imageFiles);
    const panel = page.locator('#presentation-master-status');
    const requests = [];
    page.on('response', response => { if (response.request().method() === 'POST' && /\/master\/(?:tasks|model-preflight)$/.test(response.url())) requests.push(response); });
    await page.locator('#presentation-master-start').click();
    await expect(page.getByRole('dialog', { name: '完整制作过程' })).toBeVisible();
    await expect.poll(() => requests.length, { timeout: 30000, message: '应先发出模型预检和任务登记请求' }).toBeGreaterThanOrEqual(1);
    const preflight = requests[0];
    expect(preflight.url()).toContain('/model-preflight');
    expect(preflight.ok(), await preflight.text()).toBeTruthy();
    await expect.poll(async () => {
        const denied = await panel.getByRole('alert').textContent({ timeout: 500 }).catch(() => '');
        return denied || requests[1]?.status() || 0;
    }, { timeout: 30000 }).toBe(202);
    const startResponse = requests[1]; expect(startResponse.ok()).toBeTruthy();
    const taskId = (await startResponse.json()).task.id;
    const readTask = async () => (await (await page.request.get('/api/apps/presentations/master/tasks/' + taskId)).json()).task;
    await expect.poll(async () => (await readTask()).status, { timeout: 170000 }).not.toBe('working');
    const initial = await readTask();
    expect(initial.status).toBe('failed');
    expect(['PPT_MASTER_BUDGET_EXHAUSTED', 'CAPABILITY_WORKER_TIMEOUT']).toContain(initial.error?.code);
    expect(initial.recoverable).toBeTruthy();
    await expect(panel.getByRole('button', { name: '从检查点继续' })).toBeVisible();
    await panel.locator('#presentation-master-resume-budget').fill('0');
    const resuming = page.waitForResponse(response => response.url().endsWith('/resume') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '从检查点继续' }).click();
    const resumed = await resuming;
    expect(resumed.ok(), await resumed.text()).toBeTruthy();
    expect((await resumed.json()).task.request.tokenBudget).toBe(0);
    await expect.poll(async () => (await readTask()).status, { timeout: 100000 }).toMatch(/^(?:completed|failed|expired|cancelled)$/);
    const completed = await readTask();
    expect(completed.status, completed.error?.message).toBe('completed');
    await expect(panel).toContainText('已发送 5 / 5 张图片给模型');
    await expect(panel.getByRole('button', { name: '确认并继续' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '下载初稿（.pptx）' })).toBeVisible({ timeout: 100000 });
    const download = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载初稿（.pptx）' }).click();
    const file = await download; const zip = await Zip.loadAsync(await fs.readFile(await file.path()));
    expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
    for (const [index, expected] of fixture.pages.entries()) {
        const actual = await zip.file(`ppt/slides/slide${index + 1}.xml`).async('string');
        expect(actual).toContain(expected.title);
        expect(actual).toContain(expected.fact);
    }
    const sourceDownload = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载完整项目源包' }).click();
    const projectZip = await Zip.loadAsync(await fs.readFile(await (await sourceDownload).path()));
    expect(Object.keys(projectZip.files).some(name => name.includes('/svg_output/slide_01.svg'))).toBeTruthy();
    expect(Object.keys(projectZip.files).some(name => name.endsWith('/analysis/image_analysis.csv'))).toBeTruthy();
    expect(Object.keys(projectZip.files)).not.toContain('forbidden-early-batch.md');
    const task = (await (await page.request.get('/api/apps/presentations/master/tasks/' + taskId)).json()).task;
    expect(task.status).toBe('completed'); expect(task.result.files.map(item => item.format)).toEqual(['pptx', 'zip']);
    expect(task.modelRequest.contextWindow).toBe(256000);
    expect(task.result.checks).toMatchObject({ checkedPages: 3, checkedValues: 3, checklistDigest: expect.any(String) });
    expect(task.milestones.firstApproval).toBeUndefined();
    expect(task.milestones.firstPlan.steps).toBeLessThan(task.milestones.firstPageWrite.steps);
    expect(task.milestones.delivered.usedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(task)).not.toContain('上游权威指引'); expect(task.state).toBeUndefined();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    await page.locator('#presentation-create-ai-btn').click();
    await page.getByRole('button', { name: '查看最近制作' }).click();
    const processDialog = page.getByRole('dialog', { name: '完整制作过程' });
    await expect(processDialog).toBeVisible();
    await expect(page.locator('#presentation-master-status')).toContainText('初稿已生成');
    const evidence = process.env.E2E_PPT_MASTER_EVIDENCE_DIR;
    if (evidence) await fs.mkdir(evidence, { recursive: true });
    const screenshotPath = name => evidence ? path.join(evidence, name) : testInfo.outputPath(name);
    await page.screenshot({ path: screenshotPath('desktop-completed.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(processDialog).toBeVisible();
    expect(await processDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: screenshotPath('mobile-completed.png') });
    await processDialog.getByRole('button', { name: '关闭', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '完整演示制作' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
});
