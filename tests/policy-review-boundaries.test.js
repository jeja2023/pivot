'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { queryOne, execute } = require('../server/db/client');
const runtime = require('../server/services/policy-review/runtime');
const repository = require('../server/repositories/policy-reviews');
const { fixture, input, modelResponse } = require('./helpers/policy-review');
const noSchedule = { schedule() {} };

test('在途取消立即中断信号，迟到响应不得完成；执行中制度修改不能形成可读结论', { timeout: 60000 }, async () => {
    for (const revoke of [false, true]) {
        const source = await fixture(), task = await runtime.start(source.user, input(source), {}, noSchedule);
        let started, finish, signal;
        const reached = new Promise(resolve => { started = resolve; });
        const running = runtime.run(source.user, task.id, { callModel: async options => {
            signal = options.signal; started();
            await new Promise(resolve => { finish = resolve; });
            const request = JSON.parse(options.messages[1].content);
            return { content: JSON.stringify(modelResponse(request, request.policyContext)), usage: { totalTokens: 100 } };
        } });
        await reached;
        if (revoke) await execute("UPDATE regulation_documents SET status='archived' WHERE id=?", [source.documentId]);
        else { await runtime.cancel(source.user, task.id); assert.equal(signal.aborted, true); }
        finish(); await running;
        const row = await repository.read(source.user, task.id);
        assert.equal(row.status, revoke ? 'failed' : 'cancelled');
        assert.equal(row.result_json.findings.length, 0); assert.equal(row.result_json.modelCalls, 1);
    }
});

test('续跑不改写已完成批次与人工备注，新版本不能复用旧版本导出', { timeout: 60000 }, async () => {
    const source = await fixture(9), task = await runtime.start(source.user, input(source), {}, noSchedule);
    let calls = 0;
    const callModel = async options => {
        calls++; if (calls === 2) throw new Error('模拟故障');
        const request = JSON.parse(options.messages[1].content);
        return { content: JSON.stringify(modelResponse(request, request.policyContext.filter(item => request.batchClauseIds.includes(item.id)))), usage: { totalTokens: 100 } };
    };
    await runtime.run(source.user, task.id, { callModel });
    const partial = await runtime.get(source.user, task.id, { recover: false });
    const edited = partial.findings.map(item => ({ ...item, recommendation: item.origin === 'unreviewed' ? '' : '已由业务人员核对，请补材料。' }));
    await require('../server/services/policy-review/report').save(source.user, task.id, { version: 1, findings: edited, notes: '已核对部分记录。' });
    const first = await require('../server/services/policy-review/delivery').exportReport(source.user, task.id, 2);
    await repository.resume(source.user, task.id);
    await runtime.run(source.user, task.id, { callModel });
    const completed = await runtime.get(source.user, task.id, { recover: false });
    assert.equal(completed.version, 3); assert.equal(completed.notes, '已核对部分记录。');
    assert.equal(completed.findings[0].recommendation, '已由业务人员核对，请补材料。');
    const second = await require('../server/services/policy-review/delivery').exportReport(source.user, task.id, 3);
    assert.notEqual(second.artifactId, first.artifactId);
    await assert.rejects(require('../server/services/policy-review/delivery').exportReport(source.user, task.id, 2), error => error.code === 'POLICY_REVIEW_VERSION_CONFLICT');
});

test('上传材料沿用文档提取，空白扫描PDF拒绝；材料修改和撤回阻止旧报告读取', { timeout: 60000 }, async () => {
    const source = await fixture(), directory = path.join(process.env.DATA_DIR, 'policy-material-fixture');
    await fs.mkdir(directory, { recursive: true });
    const textFile = path.join(directory, '申请.txt'); await fs.writeFile(textFile, '本次报销金额为6200元。已取得部门负责人书面批准。');
    const material = await require('../server/services/policy-review/materials').extract(source.user, { path: textFile, originalname: '申请.txt', mimetype: 'text/plain', size: 100 });
    const body = input(source, { materials: [], materialIds: [material.id] });
    const task = await runtime.start(source.user, body, {}, noSchedule);
    await require('../server/services/agent-artifacts').createAgentArtifactVersion(material.id, source.user, { content: JSON.stringify({ title: '申请.txt', text: '本次申请已经修改。' }) });
    await assert.rejects(runtime.get(source.user, task.id), error => error.code === 'POLICY_REVIEW_SOURCE_CHANGED');
    await execute("UPDATE agent_artifacts SET status='deleted' WHERE id=?", [material.id]);
    await assert.rejects(runtime.get(source.user, task.id), error => error.status === 403);
    const pdf = await PDFDocument.create(); pdf.addPage(); const pdfFile = path.join(directory, '扫描件.pdf'); await fs.writeFile(pdfFile, await pdf.save());
    await assert.rejects(require('../server/services/policy-review/materials').extract(source.user, { path: pdfFile, originalname: '扫描件.pdf', mimetype: 'application/pdf', size: 1000 }), error => error.code === 'POLICY_REVIEW_MATERIAL_INCOMPLETE');
});

test('私有模型、调用预算和上下文边界始终生效，发现与契约准备不冒充审查交付', { timeout: 60000 }, async () => {
    const source = await fixture();
    const outsider = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,unit,role,status", [`policy-bound-${Date.now()}`]);
    await assert.rejects(runtime.start(outsider, input(source), {}, noSchedule), error => error.code === 'POLICY_REVIEW_MODEL_UNAVAILABLE');
    await execute('UPDATE models SET context_window_tokens=4096 WHERE id=?', [source.modelId]);
    await assert.rejects(runtime.start(source.user, input(source, { materials: [{ title: '长材料', text: '这是一段需要完整读取的材料。'.repeat(1200) }] }), {}, noSchedule), error => error.code === 'POLICY_REVIEW_CONTEXT_LIMIT');
    await execute('UPDATE models SET context_window_tokens=131072 WHERE id=?', [source.modelId]);
    const task = await runtime.start(source.user, input(source), {}, noSchedule);
    await execute("UPDATE tool_tasks SET status='failed',result_json=result_json||jsonb_build_object('modelCalls',40) WHERE id=?", [task.id]);
    await assert.rejects(runtime.resume(source.user, task.id), error => error.code === 'POLICY_REVIEW_BUDGET');
    const parentId = `policy-parent-${Date.now()}`;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,max_token_budget,total_tokens) VALUES (?,?,'审查','审查材料','running',1000,1000)", [parentId, source.user.id]);
    const bounded = await runtime.start(source.user, input(source), { run: { id: parentId }, budget: { limits: { max_steps: 8, max_tokens_total: 8000 }, counts: { steps: 3, tokens_total: 1000 } } }, noSchedule);
    const record = await repository.read(source.user, bounded.id);
    assert.deepEqual(record.input_request.limits, { modelCalls: 5, tokens: 7000 });
    let parentCalls = 0;
    await runtime.run(source.user, bounded.id, { callModel: async () => { parentCalls++; throw new Error('不得执行'); } });
    assert.equal(parentCalls, 0); assert.equal((await repository.read(source.user, bounded.id)).status, 'failed');
    const tools = require('../server/services/agent-tools').getBuiltInToolDefinitions(source.user);
    const definition = tools.find(tool => tool.name === 'policy.review_report');
    assert.ok(definition); assert.match(definition.description, /尚未|不是审查|登记成功不是/);
    const contract = require('../server/services/agent-contracts').normalizeToolContract(definition);
    assert.equal(require('../server/services/agent-tool-discovery-scope').filterRunToolCatalog([contract], { metadata: { chatBridge: { mcpEnabled: false } } }).length, 1);
});
