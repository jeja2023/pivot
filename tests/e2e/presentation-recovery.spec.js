'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Zip = require('jszip');
const fixture = require('../../scripts/test_support/ppt_master_default_model');
const engineLock = require('../../config/ppt-master-engine.json');

const API = '/api/apps/presentations';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const csrf = async context => ({ 'x-csrf-token': (await context.cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value });
const post = async (page, url, data) => page.request.post(url, { headers: await csrf(page.context()), data });

async function member(page, browser, models, engine = false) {
    expect((await post(page, '/api/auth/login', { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD })).ok()).toBeTruthy();
    if (engine) {
        const { config } = await (await page.request.get('/api/settings/ppt-master')).json();
        const response = await page.request.put('/api/settings/ppt-master', { headers: await csrf(page.context()), data: {
            revision: config.revision, endpoint: process.env.PIVOT_E2E_PPT_MASTER_SERVICE_URL,
            token: process.env.PIVOT_E2E_PPT_MASTER_SERVICE_TOKEN, enabled: true
        } });
        expect(response.ok(), await response.text()).toBeTruthy();
    }
    const username = 'ppt_recover_' + Date.now().toString(36), password = 'PptRecovery-test123!';
    const created = await post(page, '/api/admin/users', { username, password, nickname: 'PPT恢复验收', role: 'user' });
    expect(created.ok(), await created.text()).toBeTruthy();
    for (const name of models) {
        const response = await post(page, '/api/models', { name, url: process.env.E2E_MODEL_URL, model_name: name,
            scope: 'global', context_window_tokens: 256000, max_tokens: 16000 });
        expect(response.ok(), await response.text()).toBeTruthy();
    }
    const config = (await (await page.request.get('/api/models?limit=100')).json()).data;
    const ids = models.map(name => String(config.find(item => item.name === name).id));
    const context = await browser.newContext();
    const user = await context.newPage();
    expect((await post(user, '/api/auth/login', { username, password })).ok()).toBeTruthy();
    await user.goto('/chat', { waitUntil: 'domcontentloaded' });
    await openWorkbench(user);
    return { user, ids };
}

async function openWorkbench(page) {
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
}

for (const [name, style, title] of [['咨询决策', 'consulting-decision', '收入已核定，成本仍待复核'], ['学术研究', 'academic-research', '研究问题与经营复核方法']]) {
    test(name + '模板确认后自动修正错误金额，下载修订稿', async ({ page, browser }) => {
        test.setTimeout(240000);
        test.skip(!process.env.PIVOT_E2E_PPT_MASTER_SERVICE_URL, '需要本地独立 PPT Master 服务');
        const { user, ids } = await member(page, browser, ['ppt-master-automatic-e2e-' + style], true);
        const info = await user.request.get(API + '/master/info');
        expect(info.ok()).toBeTruthy();
        expect((await info.json()).engine).toMatchObject({
            revision: engineLock.revision, version: engineLock.skillVersion, currentExportReady: true, pageRepairReady: true
        });
        await user.getByRole('button', { name: '模板库', exact: true }).click();
        await user.locator('#presentation-catalog-tabs [data-catalog-group="engine"]').click();
        const row = user.locator('#presentation-catalog-body tr').filter({ hasText: name });
        await expect(row.getByRole('cell', { name: engineLock.skillVersion, exact: true })).toBeVisible();
        await row.getByRole('button', { name: '预览 ' + name, exact: true }).click();
        const preview = user.locator('.presentation-catalog-preview');
        await expect(preview.getByRole('img', { name: name + ' · 风格示例' })).toBeVisible();
        await preview.getByRole('button', { name: '使用此制作模板' }).click();
        await user.locator('#presentation-master-title').fill(name + '经营复核');
        await user.locator('#presentation-master-instruction').fill('按所选模板和提供的材料制作三页经营汇报。');
        await user.locator('#presentation-master-material').fill(fixture.pages.map(item => item.fact).join('\n'));
        await user.locator('#presentation-master-pages').fill('3');
        await user.locator('#presentation-master-model').selectOption(ids[0]);
        const starting = user.waitForResponse(r => r.url().endsWith('/master/tasks') && r.request().method() === 'POST');
        await user.locator('#presentation-master-start').click();
        const started = await starting;
        expect(started.status(), await started.text()).toBe(202);
        const { task: { id } } = await started.json();
        const read = async () => (await (await user.request.get(API + '/master/tasks/' + id)).json()).task;
        const panel = user.locator('#presentation-master-status');
        for (const stage of ['direction', 'design']) {
            await expect.poll(async () => { const t = await read(); return t.error?.message || t.inputRequest?.stage; }, { timeout: 60000 }).toBe(stage);
            if (stage === 'design') expect((await read()).inputRequest.plan.templateUse.visibleText).toBe(title);
            await panel.getByRole('button', { name: '确认并继续' }).click();
        }
        await expect.poll(async () => (await read()).status, { timeout: 120000 }).toMatch(/^(completed|failed)$/);
        const done = await read();
        expect(done.status, done.error?.message || done.inputRequest?.question).toBe('completed');
        expect(done.result.checks).toMatchObject({ checkedPages: 3, checkedValues: 3, preservation: { pages: [2] }, templateSpecDigest: expect.any(String) });
        async function download(label) {
            const event = user.waitForEvent('download');
            await panel.getByRole('button', { name: label }).click();
            return fs.readFile(await (await event).path());
        }
        const bytes = await download('下载演示文件（.pptx）');
        const sources = await Zip.loadAsync(await download('下载完整项目源包'));
        const original = await sources.file(/\/exports\/final\.pptx$/)[0].async('nodebuffer');
        const revised = await sources.file(/\/exports\/repair-[^/]+\.pptx$/)[0].async('nodebuffer');
        const installed = sources.file(new RegExp('/templates/design_spec\\.style\\.' + style + '\\.md$'));
        expect(installed).toHaveLength(1);
        expect(sha256(original)).toBe(done.result.checks.preservation.sha256);
        expect(sha256(bytes)).toBe(done.result.checks.currentExportSha256);
        expect(bytes.equals(revised)).toBeTruthy();
        const oldFile = await Zip.loadAsync(original), finalFile = await Zip.loadAsync(bytes);
        expect(await oldFile.file('ppt/slides/slide2.xml').async('string')).toContain('全年核定成本90.25万元');
        expect(await finalFile.file('ppt/slides/slide1.xml').async('string')).toContain(title);
        const repaired = await finalFile.file('ppt/slides/slide2.xml').async('string');
        expect(repaired).toContain('全年核定成本80.25万元');
        expect(repaired).not.toContain('全年核定成本90.25万元');
        if (process.env.E2E_PPT_MASTER_EVIDENCE_DIR) {
            await fs.mkdir(process.env.E2E_PPT_MASTER_EVIDENCE_DIR, { recursive: true });
            await fs.writeFile(path.join(process.env.E2E_PPT_MASTER_EVIDENCE_DIR, name + '经营复核.pptx'), bytes);
        }
    });
}

test('普通用户从文稿库回看标准制作的五页草稿，编辑后只补原大纲缺页', async ({ page, browser }) => {
    test.setTimeout(140000);
    const { user, ids } = await member(page, browser, ['ppt-standard-recovery-fail-e2e', 'ppt-standard-recovery-finish-e2e']);
    await user.getByRole('button', { name: '模板库', exact: true }).click();
    await user.getByRole('row', { name: /咨询式简报/ }).getByRole('button', { name: '按此模板创建', exact: true }).click();
    await user.locator('#presentation-create-topic').fill('标准制作断点验收');
    await user.locator('#presentation-create-pages').fill('7');
    await user.locator('#presentation-create-model').selectOption(ids[0]);
    await user.locator('#presentation-create-submit-btn').click();
    await expect(user.locator('#presentation-outline-confirm-btn')).toBeVisible({ timeout: 30000 });
    const failed = user.waitForResponse(response => response.url().endsWith('/ai/slides') && response.request().method() === 'POST');
    await user.locator('#presentation-outline-confirm-btn').click();
    const failure = await failed;
    expect(failure.status(), await failure.text()).toBe(422);
    const id = failure.request().postDataJSON().draftId;
    await expect(user.getByRole('button', { name: '补齐缺页' })).toBeVisible({ timeout: 30000 });
    const doc = async () => (await (await user.request.get(API + '/' + id)).json()).presentation;
    expect((await doc()).generation.pending.map(item => item.id)).toEqual(['outline_page_6', 'outline_page_7']);
    expect((await post(page, API + '/' + id + '/ai/fill-missing', { model: ids[1] })).status()).toBe(404);
    expect((await post(user, API + '/' + id + '/export', { format: 'pptx' })).status()).toBe(409);
    await user.reload({ waitUntil: 'domcontentloaded' });
    await openWorkbench(user);
    await expect(user.getByText('待补齐 2 页', { exact: true })).toBeVisible();
    await user.getByRole('button', { name: '标准制作断点验收', exact: true }).click();
    await user.locator('[data-presentation-panel="story"]').click();
    await user.locator('#presentation-story-takeaway').fill('用户修改后的第一页面');
    await user.locator('#presentation-story-save').click();
    await expect.poll(async () => (await doc()).content.slides[0].intent?.takeaway).toBe('用户修改后的第一页面');
    const savedPage = (await doc()).content.slides[0];
    await user.locator('[data-presentation-panel="ai"]').click();
    await user.locator('#presentation-ai-model').selectOption(ids[1]);
    const filling = user.waitForResponse(response => response.url().endsWith('/ai/fill-missing') && response.request().method() === 'POST');
    await user.getByRole('button', { name: '补齐缺页' }).click();
    const filled = await filling;
    expect(filled.ok(), await filled.text()).toBeTruthy();
    await expect(user.getByRole('button', { name: '补齐缺页' })).toBeHidden({ timeout: 40000 });
    const complete = await doc();
    expect(complete.generation.pending).toEqual([]);
    expect(complete.content.slides.map(slide => slide.id)).toEqual(Array.from({ length: 7 }, (_, index) => 'outline_page_' + (index + 1)));
    expect(complete.content.slides[0]).toEqual(savedPage);
});

test('普通用户回看完整制作快照，下载通过页并从原任务继续正式交付', async ({ page, browser }) => {
    test.setTimeout(240000);
    test.skip(!process.env.PIVOT_E2E_PPT_MASTER_SERVICE_URL, '需要本地独立 PPT Master 服务');
    const { user, ids } = await member(page, browser, ['ppt-master-recovery-e2e', 'ppt-master-recovery-finish-e2e'], true);
    await user.getByRole('button', { name: 'AI 自由设计', exact: true }).click();
    await user.locator('#presentation-master-title').fill('完整制作断点验收', { timeout: 25000 });
    await user.locator('#presentation-master-instruction').fill('按已确认材料制作三页经营汇报');
    await user.locator('#presentation-master-material').fill(fixture.pages.map(item => item.fact).join('\n'));
    await user.locator('#presentation-master-pages').fill('3');
    await user.locator('#presentation-master-model').selectOption(ids[0]);
    const start = user.waitForResponse(response => response.url().endsWith('/master/tasks') && response.request().method() === 'POST');
    await user.locator('#presentation-master-start').click();
    const response = await start;
    expect(response.status(), await response.text()).toBe(202);
    const { task: { id } } = await response.json();
    const read = async () => (await (await user.request.get(API + '/master/tasks/' + id)).json()).task;
    const panel = user.locator('#presentation-master-status');
    for (const heading of ['确认沟通方向', '确认最终页面与关键数据清单']) {
        await expect(panel).toContainText(heading, { timeout: 90000 });
        await panel.getByRole('button', { name: '确认并继续' }).click();
    }
    await expect.poll(async () => (await read()).status, { timeout: 120000 }).toBe('failed');
    expect((await read()).progressSnapshot).toMatchObject({ source: { count: 3 },
        export: { passedPages: [1, 3], pendingPages: [2] }, passed: { pages: [1, 3] } });
    expect((await page.request.get(API + '/master/tasks/' + id + '/snapshots/passed')).status()).toBe(404);
    await user.reload({ waitUntil: 'domcontentloaded' });
    await openWorkbench(user);
    await user.getByRole('button', { name: '完整制作记录' }).click();
    const history = user.getByRole('dialog', { name: '完整制作记录', exact: true });
    const detailDialog = user.getByRole('dialog', { name: '完整制作过程', exact: true });
    const record = history.getByRole('button', { name: /完整制作断点验收.*已保存制作快照/ });
    await expect(user.locator('#presentation-master-modal')).toHaveCount(0);
    await record.click();
    await expect(panel).toContainText('待核验页：2');
    await detailDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(record).toBeFocused();
    await record.click();
    const download = user.waitForEvent('download');
    await panel.getByRole('button', { name: '下载已通过页面（.pptx）' }).click();
    const archive = await Zip.loadAsync(await fs.readFile(await (await download).path()));
    const slides = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    expect(slides).toHaveLength(2);
    expect(await archive.file(slides[0]).async('string')).toContain(fixture.pages[0].title);
    expect(await archive.file(slides[1]).async('string')).toContain(fixture.pages[2].title);
    await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toHaveCount(0);
    const importing = user.waitForResponse(response => response.url().endsWith('/native/jobs') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '将已通过页转存为独立文稿' }).click();
    const imported = await importing;
    expect(imported.ok(), await imported.text()).toBeTruthy();
    const { task: nativeTask } = await imported.json();
    const readNative = async () => (await (await user.request.get(API + '/native/jobs/' + nativeTask.id)).json()).task;
    await expect.poll(async () => (await readNative()).status, { timeout: 90000 }).toMatch(/^(completed|failed)$/);
    const native = await readNative();
    expect(native.status, native.error?.message).toBe('completed');
    const independent = await (await user.request.get(API + '/native/documents/' + native.result.documentId)).json();
    expect(independent.document.manifest.slides).toHaveLength(2);
    await user.getByRole('dialog', { name: '原稿编辑与离线视频' }).getByRole('button', { name: '关闭', exact: true }).click();
    await user.getByRole('button', { name: '完整制作记录' }).click();
    await user.getByRole('button', { name: /完整制作断点验收.*已保存制作快照/ }).click();
    await panel.locator('#presentation-master-resume-model').selectOption(ids[1]);
    const resuming = user.waitForResponse(response => response.url().endsWith('/resume') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '从检查点继续' }).click();
    const resumed = await resuming;
    expect(resumed.ok(), await resumed.text()).toBeTruthy();
    expect((await resumed.json()).task.request.modelId).toBe(ids[1]);
    await expect.poll(async () => (await read()).status, { timeout: 90000 }).toMatch(/^(completed|failed)$/);
    const completed = await read();
    expect(completed.status, completed.error?.message).toBe('completed');
    expect(completed.result.checks.checkedPages).toBe(3);
});

test('普通用户补充事实、核对重排清单，并在引文失败后继续原任务', async ({ page, browser }) => {
    test.setTimeout(240000);
    test.skip(!process.env.PIVOT_E2E_PPT_MASTER_SERVICE_URL, '需要本地独立 PPT Master 服务');
    const { user, ids } = await member(page, browser, ['ppt-master-citations-e2e'], true);
    await user.getByRole('button', { name: '模板库', exact: true }).click();
    await user.locator('#presentation-catalog-tabs [data-catalog-group="engine"]').click();
    await user.locator('#presentation-catalog-body tr').filter({ hasText: '咨询决策' }).getByRole('button', { name: '使用此制作模板' }).click();
    await expect(user.locator('#presentation-master-template-note')).toContainText('咨询决策');
    await user.locator('#presentation-master-title').fill('引文补充断点验收');
    await user.locator('#presentation-master-instruction').fill('按已确认材料制作三页经营汇报');
    await user.locator('#presentation-master-material').fill(fixture.pages.map(item => item.fact).join('\n'));
    await user.locator('#presentation-master-pages').fill('3');
    await user.locator('#presentation-master-model').selectOption(ids[0]);
    const starting = user.waitForResponse(response => response.url().endsWith('/master/tasks') && response.request().method() === 'POST');
    await user.locator('#presentation-master-start').click();
    const started = await starting;
    expect(started.status(), await started.text()).toBe(202);
    const { task: { id } } = await started.json();
    const route = API + '/master/tasks/' + id;
    const read = async () => (await (await user.request.get(route)).json()).task;
    const panel = user.locator('#presentation-master-status');
    await expect(panel).toContainText('确认沟通方向', { timeout: 90000 });
    await panel.getByRole('button', { name: '确认并继续' }).click();
    await expect(panel).toContainText('请补充项目预算及其单位。', { timeout: 90000 });
    await panel.getByRole('textbox', { name: '对制作方案的实际答复' }).fill('经核实，项目预算80万元。');
    await panel.getByRole('button', { name: '提交答复并继续' }).click();
    await expect(panel).toContainText('用户补充 1', { timeout: 90000 });
    const proposal = await read();
    expect(proposal.request.template?.type).toBe('runtime');
    expect(proposal.inputRequest.plan.pages[0].values.map(value => value.text)).toEqual(['项目预算80万元', fixture.pages[0].fact]);
    expect(proposal.inputRequest.plan.pages[0].values[0].source.path).toBe('user-supplement:1');
    await panel.getByRole('button', { name: '确认并继续' }).click();
    await expect(panel).toContainText('待核对的引文', { timeout: 90000 });
    await expect(panel).toContainText('第 2 页第 1 项');
    const failed = await read();
    expect(failed.error.code).toBe('PPT_MASTER_CITATION_REVIEW_REQUIRED');
    expect(failed.progressSnapshot.passed.pages).toEqual([1, 3]);
    const partial = await user.request.get(route + '/snapshots/passed');
    expect(partial.ok()).toBeTruthy();
    await panel.getByRole('button', { name: '从检查点继续' }).click();
    await expect(panel).toContainText('请补充可核对的事实、填写修改意见，或切换制作模型后继续。');
    const unchanged = await read();
    expect(unchanged.usedTokens).toBe(failed.usedTokens);
    expect(unchanged.usageDiagnostics.length).toBe(failed.usageDiagnostics.length);
    await user.reload({ waitUntil: 'domcontentloaded' });
    await openWorkbench(user);
    await user.getByRole('button', { name: '完整制作记录' }).click();
    await user.getByRole('button', { name: /引文补充断点验收.*已保存制作快照/ }).click();
    await panel.getByRole('textbox', { name: '补充说明或修改意见（选填）' }).fill('复核后确认，全年决算成本80.25万元。');
    await panel.getByRole('button', { name: '从检查点继续' }).click();
    await expect(panel).toContainText('用户补充 2', { timeout: 90000 });
    const revised = await read();
    expect(revised.status).toBe('input_required');
    expect(revised.inputRequest.plan.pages[1].values[0].source.path).toBe('user-supplement:2');
    expect(await (await user.request.get(route + '/snapshots/passed')).body()).toEqual(await partial.body());
    await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toHaveCount(0);
    await panel.getByRole('button', { name: '确认并继续' }).click();
    await expect(panel.getByRole('button', { name: '下载演示文件（.pptx）' })).toBeVisible({ timeout: 90000 });
    expect((await read()).result.checks).toMatchObject({ checkedPages: 3, checkedValues: 4 });
    const download = user.waitForEvent('download');
    await panel.getByRole('button', { name: '下载演示文件（.pptx）' }).click();
    const file = await Zip.loadAsync(await fs.readFile(await (await download).path()));
    const repaired = await file.file('ppt/slides/slide2.xml').async('string');
    expect(repaired).toContain('全年决算成本80.25万元');
    expect(repaired).not.toContain('全年核定成本90.25万元');
});
