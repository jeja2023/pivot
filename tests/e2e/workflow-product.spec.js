/* global window, document -- 工作流产品完整页面验收 */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

async function openWorkspace(page) {
    const response = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(response.ok()).toBeTruthy();
    await page.goto('/chat');
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAgentDagWorkbench));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench());
    await expect(page.locator('#agent-dag-workbench-modal')).toBeVisible();
    await expect(page.locator('#automation-new-workflow-btn')).toBeVisible();
}

async function createTemplate(page, id = 'table') {
    await page.locator('#automation-new-workflow-btn').click();
    await page.locator(`[data-template="${id}"]`).click();
    await expect(page.locator('#workflow-product-save')).toHaveText('草稿已保存', { timeout: 15000 });
}

async function headers(page) {
    return { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
}

test('真实工作流页面提供模板、画布节点配置、草稿修订和恢复', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click();
    await expect(page.locator('#workflow-product-start')).toContainText('从要完成的工作开始');
    await page.locator('[data-template="table"]').click();
    await expect(page.locator('#agent-dag-editor-canvas')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('analysis'));
    expect(errors, '选择节点时不应出现脚本错误').toEqual([]);
    await expect(page.locator('#agent-dag-node-drawer')).toBeVisible();
    const prompt = page.getByRole('textbox', { name: '提示词（来源标签编辑）' });
    const token = (await prompt.inputValue()).match(/⟦[^⟧]+⟧/)[0];
    await prompt.fill(`请比较以下业务记录并形成摘要。\n${token}`);
    await expect(page.locator('#workflow-product-save')).toHaveText('草稿已保存', { timeout: 15000 });
    const saved = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').current());
    expect(saved.revision).toBeGreaterThan(0);
    await expect(page.getByRole('textbox', { name: '提示词（来源标签编辑）' })).toHaveValue(/比较以下业务记录/);
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/workflow-audit/product-page-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#agent-dag-editor-canvas')).toBeVisible();
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/workflow-audit/product-page-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
});

test('服务器修订允许未完成草稿，冲突拒绝覆盖且发布运行读取线上参数', async ({ page }) => {
    test.setTimeout(90000);
    await openWorkspace(page);
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const key = `test-${Date.now()}`;
    const first = await page.request.put(`/api/agents/workflow-editor/drafts/${key}`, { headers, data: { specText: '{"nodes":[{"tool":""}]}', name: '未完成草稿', expectedRevision: 0 } });
    expect(first.ok(), await first.text()).toBeTruthy();
    const conflict = await page.request.put(`/api/agents/workflow-editor/drafts/${key}`, { headers, data: { specText: '{}', expectedRevision: 0 } });
    expect(conflict.status()).toBe(409);
    const workflow = await page.request.post('/api/agents/workflows', { headers, data: { name: '版本参数回归', dagSpec: { nodes: [
        { id: 'input', tool: 'workflow.input', input: { name: 'oldParameter', type: 'text', required: true } },
        { id: 'output', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.oldParameter}}' }, dependsOn: ['input'] }
    ] } } });
    expect(workflow.ok(), await workflow.text()).toBeTruthy();
    const stored = (await workflow.json()).workflow;
    const published = await page.request.post(`/api/agents/workflows/${stored.id}/publish`, { headers, data: { version: 'current' } });
    expect(published.ok(), await published.text()).toBeTruthy();
    const updated = await page.request.put(`/api/agents/workflows/${stored.id}`, { headers, data: { name: '版本参数回归', expectedVersion: stored.current_version, dagSpec: { nodes: [
        { id: 'input', tool: 'workflow.input', input: { name: 'newParameter', type: 'text', required: true } },
        { id: 'output', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.newParameter}}' }, dependsOn: ['input'] }
    ] } } });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    await page.evaluate(async id => {
        const bridge = window.Pivot.moduleApi('agent.workflowBridge'); await bridge.reload();
        await window.Pivot.moduleApi('agent.workflowRunForm').open(bridge.workflows().find(item => item.id === id));
    }, stored.id);
    await expect(page.locator('[data-product-input="oldParameter"]')).toBeVisible();
    await expect(page.locator('[data-product-input="newParameter"]')).toHaveCount(0);
    await page.locator('[data-product-input="oldParameter"]').fill('线上输入');
    await page.locator('[data-product-form] [type="submit"]').click();
    await expect(page.locator('#workflow-product-results')).toContainText('线上输入', { timeout: 30000 });
});

test('记录参数可直接编辑表格，宽窄屏与深浅主题保留参数和选择状态', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page); await createTemplate(page);
    const rows = page.locator('#agent-dag-inputs-list');
    await rows.getByRole('spinbutton', { name: '金额，第 1 条' }).fill('0');
    await rows.getByRole('textbox', { name: '地区，第 2 条' }).fill('西南');
    const values = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').inputs());
    expect(values.rows[0].amount).toBe(0); expect(values.rows[1].region).toBe('西南');
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('analysis'));
    for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 960 });
        await page.emulateMedia({ colorScheme: theme });
        await page.evaluate(value => { document.body.classList.toggle('dark-mode', value === 'dark'); }, theme);
        await expect(page.locator('#agent-dag-node-drawer')).toBeVisible();
        await expect(page.getByRole('textbox', { name: '提示词（来源标签编辑）' })).toHaveValue(/业务记录|比较以下记录/);
        const overflow = await page.evaluate(() => {
            const root = document.getElementById('automation-editor-view');
            return { scroll: root.scrollWidth - root.clientWidth, buttons: [...root.querySelectorAll('.agent-dag-library-bar button, #agent-dag-editor-toolbar button')].filter(item => item.getClientRects().length && (item.getBoundingClientRect().right > window.innerWidth + 1 || item.getBoundingClientRect().left < -1)).map(item => item.textContent) };
        });
        expect(overflow, `${theme} ${width}`).toEqual({ scroll: 0, buttons: [] });
        if (theme === 'dark') expect(await page.locator('.workflow-product-modern .agent-dag-inputs-panel').evaluate(item => window.getComputedStyle(item).backgroundColor)).not.toBe('rgb(255, 255, 255)');
        await page.evaluate(() => { document.getElementById('automation-editor-view').scrollTop = 0; });
        await page.screenshot({ path: path.resolve(__dirname, `../../.tmp/workflow-audit/product-qa/live-${theme}-${width}-canvas.png`), fullPage: true });
    }
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').inputs())).toEqual(values);
    const timings = await page.evaluate(() => {
        const samples = [];
        for (let index = 0; index < 8; index++) { const started = window.performance.now(); window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode(index % 2 ? 'analysis' : 'rows'); samples.push(window.performance.now() - started); }
        return { operation: 'select_node', count: samples.length, maxMs: Math.max(...samples), medianMs: [...samples].sort((a, b) => a - b)[4], samples };
    });
    fs.writeFileSync(path.resolve(__dirname, '../../.tmp/workflow-audit/product-interaction-timings.json'), JSON.stringify(timings, null, 2));
    expect(timings.medianMs).toBeLessThan(100);
    expect(errors).toEqual([]);
});

test('保存失败的本机副本可恢复，真实双窗口修订冲突不会覆盖本地编辑', async ({ page }) => {
    test.setTimeout(90000);
    await openWorkspace(page); await createTemplate(page, 'knowledge');
    const draft = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').current());
    const route = `**/agents/workflow-editor/drafts/${draft.key}`;
    await page.route(route, async handler => { if (handler.request().method() === 'PUT') await handler.fulfill({ status: 503, json: { error: '受控模拟：保存暂不可用' } }); else await handler.continue(); });
    await page.locator('#workflow-product-name').fill('离线保留的业务流程');
    await expect(page.locator('#workflow-product-save')).toHaveText('保存失败，修改仍保留', { timeout: 15000 });
    expect(await page.evaluate(key => JSON.parse(window.localStorage.getItem(`pivot.workflow.draft.${window.Pivot.moduleApi('agent.workflowBridge').userId()}.${key}`)).name, draft.key)).toBe('离线保留的业务流程');
    await page.reload();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAgentDagWorkbench));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench());
    await page.locator('#automation-new-workflow-btn').click();
    await page.locator(`[data-open-draft="${draft.key}"]`).click();
    await expect(page.locator('#workflow-product-recovery')).toBeVisible();
    await page.locator('[data-restore]').click();
    await page.unroute(route);
    await expect(page.locator('#workflow-product-name')).toHaveValue('离线保留的业务流程');
    await expect(page.locator('#workflow-product-save')).toHaveText('草稿已保存', { timeout: 15000 });
    const current = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').current());
    const response = await page.request.put(`/api/agents/workflow-editor/drafts/${draft.key}`, { headers: await headers(page), data: { expectedRevision: current.revision, specText: '{"nodes":[]}', name: '另一窗口的草稿' } });
    expect(response.ok()).toBeTruthy();
    await page.locator('#workflow-product-name').fill('本地尚未解决的冲突');
    await expect(page.locator('#workflow-product-save')).toHaveText('存在冲突', { timeout: 15000 });
    await page.locator('[data-draft-compare]').click();
    await expect(page.locator('#workflow-product-recovery')).toContainText('本地尚未解决的冲突');
    await page.locator('[data-remote]').click();
    await expect(page.locator('#workflow-product-name')).toHaveValue('另一窗口的草稿');
});

test('发布确认固定已审阅版本，并展示真实影响与启动状态', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.evaluate(() => {
        const bridge = window.Pivot.moduleApi('agent.workflowBridge');
        bridge.setName('固定版本发布验收'); bridge.editor().applySpec({ nodes: [{ id: 'output', title: '交付结果', tool: 'workflow.output', input: { name: 'result', value: '已审阅的内容' } }] });
    });
    await page.locator('#workflow-product-publish').click();
    await expect(page.locator('[data-confirm-publish]')).toBeVisible();
    await expect(page.locator('#workflow-product-release')).toContainText('尚未配置计划或事件启动');
    const workflow = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').current());
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().edit(spec => { spec.nodes[0].input.value = '发布面板打开后的继续编辑'; }));
    await page.locator('[data-confirm-publish]').click();
    await expect(page.locator('[data-publish-result]')).toContainText('已发布 V1');
    const result = await page.request.get(`/api/agents/workflows/${workflow.id}/run-context`);
    expect((await result.json()).dagSpec.nodes[0].input.value).toBe('已审阅的内容');
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes[0].input.value)).toBe('发布面板打开后的继续编辑');
    expect(errors).toEqual([]);
});

test('迟到测试结果被隔离，步骤与画布共用复制撤销且隐藏画布不消费快捷键', async ({ page }) => {
    test.setTimeout(90000);
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().applySpec({ nodes: [{ id: 'source', title: '准备文本', tool: 'workflow.template', input: { template: '原文' } }, { id: 'result', title: '输出', tool: 'workflow.output', input: { name: 'result', value: '{{nodes.source.output.text}}' }, dependsOn: ['source'] }] }));
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('source'));
    let complete;
    const waiting = new Promise(resolve => { complete = resolve; });
    let sent; const requestSent = new Promise(resolve => { sent = resolve; });
    await page.route('**/agents/tools/test', async handler => { sent(); await waiting; await handler.fulfill({ json: { output: { text: '旧结果' } } }); });
    await page.locator('[data-pivot-dag-test-node]').click(); await requestSent;
    await page.getByRole('textbox', { name: '模板内容（来源标签编辑）' }).fill('新的输入'); complete();
    await expect(page.locator('[data-pivot-dag-test-node]')).toBeEnabled();
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.dagCore').getNodeTestOutputSnapshots().size)).toBe(0);
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('source'));
    await page.locator('#agent-dag-editor-canvas > .pivot-dag-svg').focus();
    await page.keyboard.press('Control+d');
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes.length)).toBe(3);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes.length)).toBe(2);
});

test('字段选择显示类型与样例并无损插入来源，双节点对齐不会清空测试', async ({ page }) => {
    test.setTimeout(90000);
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.evaluate(() => {
        const bridge = window.Pivot.moduleApi('agent.workflowBridge');
        bridge.editor().applySpec({ nodes: [
            { id: 'source', title: '准备数据', tool: 'workflow.template', input: { template: '示例' }, outputSchema: { type: 'object', properties: { text: { type: 'string', title: '正文' }, rows: { type: 'array', title: '业务记录' }, count: { type: 'number', title: '记录数' } } } },
            { id: 'target', title: '生成文本', tool: 'workflow.template', input: { template: '请根据以下资料处理：' }, dependsOn: ['source'] }
        ], layout: { source: { x: 0, y: 0 }, target: { x: 400, y: 100 } } });
        const core = window.Pivot.moduleApi('agent.dagCore'); core.setDagNodeTestContext(bridge.spec(), {}); core.setDagNodeTestOutput('source', { output: { text: '可用正文', rows: [{ 数量: 0 }], count: 0 }, source: 'mock' });
    });
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('target'));
    await page.locator('#agent-dag-editor-inspector .workflow-product-source').getByRole('button', { name: '选择数据' }).click();
    await expect(page.locator('[data-pivot-dag-var-expr="{{nodes.source.output.rows}}"]')).toBeDisabled();
    await expect(page.locator('[data-pivot-dag-var-expr="{{nodes.source.output.count}}"]')).toContainText('0');
    await page.locator('[data-pivot-dag-var-expr="{{nodes.source.output.text}}"]').click();
    await expect(page.getByRole('textbox', { name: '模板内容（来源标签编辑）' })).toHaveValue(/⟦准备数据 → 文本结果⟧/);
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes.find(node => node.id === 'target').input.template)).toContain('{{nodes.source.output.text}}');
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNodes(['source', 'target']));
    await page.locator('#agent-dag-editor-toolbar summary').filter({ hasText: '操作' }).click();
    await page.getByRole('menuitem', { name: '水平居中对齐', exact: true }).click();
    const aligned = await page.evaluate(() => { const spec = window.Pivot.moduleApi('agent.workflowBridge').spec(); return { x1: spec.layout.source.x, x2: spec.layout.target.x, snapshots: window.Pivot.moduleApi('agent.dagCore').getNodeTestOutputSnapshots().size }; });
    expect(aligned.x1).toBe(aligned.x2); expect(aligned.snapshots).toBe(1);
});

test('就地测试与发布运行保留各自结果，纯表格交付按表格显示', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.evaluate(() => {
        const bridge = window.Pivot.moduleApi('agent.workflowBridge'); bridge.setName('表格交付验收');
        bridge.editor().applySpec({ nodes: [
            { id: 'source', title: '准备摘要', tool: 'workflow.template', input: { template: '实际步骤结果' } },
            { id: 'output', title: '交付业务表格', tool: 'workflow.output', input: { name: 'result', value: [{ 数量: 0, 通过: false }], presentation: 'table' }, dependsOn: ['source'] }
        ] });
    });
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().selectNode('source')); await page.locator('[data-pivot-dag-test-node]').click();
    await expect(page.locator('#workflow-product-results')).toContainText('实际步骤结果', { timeout: 15000 });
    await page.locator('#workflow-product-run').click();
    try { await expect(page.locator('#workflow-product-results .data-table')).toBeVisible({ timeout: 20000 }); }
    catch (_) { throw new Error(`表格运行未完成：${await page.locator('#workflow-product-status').innerText()}；${await page.locator('#workflow-product-results').innerText()}；页面错误：${errors.join('；')}`); }
    await expect(page.locator('#workflow-product-results .data-table')).toContainText('false');
    await expect(page.locator('[data-result-history] option')).toHaveCount(2);
    await page.locator('[data-result-history]').selectOption({ index: 0 });
    await expect(page.locator('#workflow-product-results')).toContainText('实际步骤结果');
    expect(errors).toEqual([]);
});

test('从未同步的新草稿也能从本机找回，未完成 JSON 原文可保存并继续修正', async ({ page }) => {
    test.setTimeout(90000);
    await openWorkspace(page);
    await page.route('**/agents/workflow-editor/drafts/*', async handler => { if (handler.request().method() === 'PUT') await handler.fulfill({ status: 503, json: { error: '离线保存测试' } }); else await handler.continue(); });
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.locator('#workflow-product-name').fill('尚未同步的原始草稿');
    await page.evaluate(() => {
        const specEl = document.getElementById('agent-dag-spec');
        specEl.value = '{"nodes":[';
        specEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#workflow-product-save')).toHaveText('保存失败，修改仍保留', { timeout: 15000 });
    const draft = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').current());
    await page.reload();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAgentDagWorkbench));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench());
    await page.locator('#automation-new-workflow-btn').click(); await page.locator(`[data-open-draft="${draft.key}"]`).click();
    await expect(page.locator('#workflow-product-name')).toHaveValue('尚未同步的原始草稿');
    await expect.poll(() => page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').current()?.key)).toBe(draft.key);
    expect(await page.evaluate(() => document.getElementById('agent-dag-spec').value)).toBe('{"nodes":[');
    await expect(page.locator('#workflow-product-run')).toBeDisabled();
    await page.unroute('**/agents/workflow-editor/drafts/*');
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowDrafts').flush());
    const saved = await page.request.get(`/api/agents/workflow-editor/drafts/${draft.key}`);
    expect((await saved.json()).draft.spec_text).toBe('{"nodes":[');
});

test('复杂分支大纲与 AI 变更可撤销', async ({ page }) => {
    test.setTimeout(90000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page);
    await page.locator('#automation-new-workflow-btn').click(); await page.locator('[data-start-blank]').click();
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').editor().applySpec({ nodes: [
        { id: 'condition', title: '检查条件', tool: 'workflow.condition', input: { value: true, operator: 'is_true' } },
        { id: 'yes', title: '满足条件处理', tool: 'workflow.template', input: { template: '是' }, dependsOn: ['condition'] },
        { id: 'no', title: '未满足处理', tool: 'workflow.template', input: { template: '否' }, dependsOn: ['condition'] },
        { id: 'join', title: '合并报告', tool: 'workflow.output', joinMode: 'any_active', input: { name: 'result', value: '完成' }, dependsOn: ['yes', 'no'] }
    ], edges: [{ from: 'condition', to: 'yes', route: 'true' }, { from: 'condition', to: 'no', route: 'false' }, { from: 'yes', to: 'join', route: 'default' }, { from: 'no', to: 'join', route: 'default' }] }));
    await expect(page.locator('#agent-dag-editor-canvas')).toBeVisible();
    const count = await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes.length);
    expect(count).toBe(4);
    await page.evaluate(() => { window.Pivot.legacy._cachedAgentModels = [{ id: 1, name: '受控测试模型' }]; });
    await page.route('**/agents/workflow-editor/propose', handler => handler.fulfill({ json: { name: 'AI 草稿', plan: '仅建议增加交付内容，不执行。', spec: { nodes: [{ id: 'ai', tool: 'workflow.output', title: 'AI 结果', input: { name: 'result', value: '建议内容' } }] } } }));
    await page.evaluate(() => window.Pivot.moduleApi('agent.workflowAuthoring').describe());
    await page.locator('[data-author-prompt]').fill('修改为一个结果输出'); await page.locator('[data-author-propose]').click();
    await expect(page.locator('[data-author-plan]')).toContainText('仅建议');
    await page.locator('[data-author-apply]').click();
    expect(await page.evaluate(() => window.Pivot.moduleApi('agent.workflowBridge').spec().nodes[0].id)).toBe('ai');
    expect(errors).toEqual([]);
});
