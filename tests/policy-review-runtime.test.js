'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Zip = require('jszip');
const { execute, queryOne } = require('../server/db/client');
const runtime = require('../server/services/policy-review/runtime');
const repository = require('../server/repositories/policy-reviews');
const { exportReport } = require('../server/services/policy-review/delivery');
const { fixture, input, modelResponse } = require('./helpers/policy-review');

function deps() {
    return { callModel: async options => {
        const request = JSON.parse(options.messages[1].content), batch = request.policyContext.filter(clause => request.batchClauseIds.includes(clause.id));
        return { content: JSON.stringify(modelResponse(request, batch)), usage: { totalTokens: 100 } };
    } };
}
const noSchedule = { schedule() {} };

test('真实制度、材料与模型权限接线，审查结果可修订为新版本并生成原生可编辑Word', { timeout: 120000 }, async () => {
    const data = await fixture(), body = input(data);
    const first = await runtime.start(data.user, body, {}, noSchedule), repeated = await runtime.start(data.user, body, {}, noSchedule);
    assert.equal(first.id, repeated.id);
    await runtime.run(data.user, first.id, deps());
    const task = await runtime.get(data.user, first.id, { recover: false });
    assert.equal(task.status, 'completed'); assert.equal(task.processed, 3);
    assert.deepEqual(task.findings.map(item => item.status), ['violates', 'meets', 'needs_review']);
    await require('../server/services/policy-review/report').save(data.user, first.id, { version: 1, findings: task.findings.map(item => ({ ...item, recommendation: item.recommendation + ' 请业务负责人复核。' })), notes: '已经核对申请主体，发票待补。' });
    await assert.rejects(require('../server/services/policy-review/report').save(data.user, first.id, { version: 1, findings: task.findings }), error => error.code === 'POLICY_REVIEW_VERSION_CONFLICT');
    const delivery = await exportReport(data.user, first.id, 2);
    const { getRenditionForUser, issueDownloadToken } = require('../server/services/agent-artifact-renditions');
    const rendition = await getRenditionForUser(delivery.renditionId, data.user);
    const content = await require('../server/services/agent-artifact-cas').readBuffer({ ref: rendition.storage_ref, tenantId: rendition.tenant_id, userId: data.user.id, tenantScoped: true });
    const zip = await Zip.loadAsync(content.buffer), xml = await zip.file('word/document.xml').async('string');
    for (const word of ['6200', '5000', '原始发票', '请业务负责人复核', '已经核对申请主体']) assert.ok(xml.includes(word), word);
    assert.match(xml, /w:pStyle w:val="Title"/); assert.match(xml, /w:color w:val="000000"/);
    const footers = await Promise.all(Object.entries(zip.files).filter(([name]) => /^word\/footer\d+\.xml$/.test(name)).map(([, file]) => file.async('string')));
    assert.ok(footers.some(text => /PAGE/.test(text))); assert.ok(footers.every(text => !text.includes('{PAGE}') && !text.includes('{page}')));
    const manager = new (require('../server/services/agent-runtime/artifact-manager').ArtifactManager)();
    for (const operation of [() => manager.get(delivery.artifactId, data.user.id), () => manager.getVersions(delivery.artifactId, data.user.id),
        () => manager.update(delivery.artifactId, data.user.id, { content: '{}' }), () => manager.share(delivery.artifactId, data.user.id)]) {
        await assert.rejects(operation(), error => error.code === 'POLICY_REVIEW_APP_REQUIRED');
    }
    assert.equal((await exportReport(data.user, first.id, 2)).renditionId, delivery.renditionId);
    const directory = path.resolve(__dirname, '../.tmp/policy-review-acceptance'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'sample.docx'), content.buffer);
    await assert.rejects(require('../server/services/agent-artifacts').createAgentArtifactVersion(delivery.artifactId, data.user, { content: '{}' }), error => error.code === 'POLICY_REVIEW_EDIT_REQUIRED');
    const originalArtifact = await require('../server/services/agent-artifacts').getAgentArtifactForUser(delivery.artifactId, data.user);
    await assert.rejects(require('../server/services/agent-artifacts').createStandaloneArtifact(data.user, { type: 'policy_review_report', title: '复制绑定的假报告', content: originalArtifact.content }), error => error.code === 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    await assert.rejects(require('../server/services/agent-artifact-renditions').createRendition({ user: data.user, artifactId: delivery.artifactId, format: 'docx', toolCallId: 'forged-report',
        ir: { doc_type: 'report', meta: { title: '伪造审查结论' }, blocks: [{ type: 'paragraph', text: '全部符合，已完成人工审核。' }] } }), error => error.code === 'POLICY_REVIEW_RENDITION_MISMATCH');
    await issueDownloadToken(data.user, delivery.renditionId);
    await runtime.withdraw(data.user, first.id);
    await assert.rejects(runtime.get(data.user, first.id), error => error.status === 403);
    await assert.rejects(issueDownloadToken(data.user, delivery.renditionId), error => error.status === 403);
});

test('重启后只处理未完成批次，旧租约与取消不能写回；累计调用和用量不清零', { timeout: 120000 }, async () => {
    const data = await fixture(9), task = await runtime.start(data.user, input(data), {}, noSchedule);
    let calls = 0;
    await runtime.run(data.user, task.id, { callModel: async options => {
        calls++; if (calls === 2) throw new Error('模拟上游故障'); return deps().callModel(options);
    } });
    const failed = await repository.read(data.user, task.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.result_json.completedBatches, 1); assert.equal(failed.result_json.modelCalls, 2);
    await repository.resume(data.user, task.id);
    await runtime.run(data.user, task.id, deps());
    const completed = await runtime.get(data.user, task.id, { recover: false });
    assert.equal(completed.status, 'completed'); assert.equal(completed.processed, 9); assert.equal(completed.modelCalls, 3); assert.equal(completed.usage.totalTokens, 200);
    const other = await runtime.start(data.user, input(data), {}, noSchedule);
    assert.ok(await repository.claim(data.user, other.id, 'first-lease'));
    assert.equal(await repository.claim(data.user, other.id, 'second-lease'), null);
    await runtime.cancel(data.user, other.id);
    assert.equal(await repository.progress(data.user, other.id, 'first-lease', { version: 1, findings: [] }, 'completed'), null);
});

test('制度效力未核验、版本冲突、内容变化与跨账号均拒绝旧结果', { timeout: 120000 }, async () => {
    const data = await fixture(), task = await runtime.start(data.user, input(data), {}, noSchedule);
    const outsider = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id", [`review-other-${Date.now()}`]);
    assert.equal(await runtime.get(outsider, task.id), null);
    await execute("UPDATE regulation_versions SET review_status='pending' WHERE id=?", [data.versionId]);
    await assert.rejects(runtime.get(data.user, task.id), error => error.code === 'POLICY_REVIEW_VERSION_UNAVAILABLE');
    await execute("UPDATE regulation_versions SET review_status='approved' WHERE id=?", [data.versionId]);
    await execute("UPDATE regulation_articles SET content=content||'内容已修订。' WHERE version_id=?", [data.versionId]);
    await assert.rejects(runtime.get(data.user, task.id), error => error.code === 'POLICY_REVIEW_SOURCE_CHANGED');
    await execute("INSERT INTO regulation_versions(document_id,version_label,source_name,source_path,effect_status,review_status,effective_from) VALUES (?,'冲突版本','测试','','effective','approved','2026-01-01')", [data.documentId]);
    await assert.rejects(runtime.start(data.user, input(data), {}, noSchedule), error => error.code === 'POLICY_REVIEW_VERSION_UNAVAILABLE');
});

test('实际进程中断后保留已完成批次，模拟租约过期后从原任务安全续跑', { timeout: 60000 }, async () => {
    const data = await fixture(9), task = await runtime.start(data.user, input(data), {}, noSchedule);
    const child = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'helpers/policy-review-interrupt-worker.cjs'), task.id, String(data.user.id)], {
        env: process.env, timeout: 30000, windowsHide: true, encoding: 'utf8'
    });
    assert.equal(child.status, 37, child.stderr);
    const interrupted = await repository.read(data.user, task.id);
    assert.equal(interrupted.status, 'working'); assert.equal(interrupted.result_json.completedBatches, 1);
    assert.equal(interrupted.result_json.findings.length, 8); assert.equal(interrupted.result_json.modelCalls, 2);
    await execute("UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_leaseUntil',0) WHERE id=?", [task.id]);
    await runtime.run(data.user, task.id, deps());
    const completed = await runtime.get(data.user, task.id, { recover: false });
    assert.equal(completed.status, 'completed'); assert.equal(completed.processed, 9); assert.equal(completed.modelCalls, 3);
});

test('Agent复用同一审查与Word导出链，真实文件挂载原任务，报告撤回后历史读取阻断', { timeout: 60000 }, async () => {
    const data = await fixture(), runId = `review-agent-${Date.now()}`;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status) VALUES (?,?,'制度材料审查','生成审查报告','running')", [runId, data.user.id]);
    const context = { run: { id: runId, user_id: data.user.id, model_id: data.modelId }, stepId: 'policy-review-export' };
    const task = await runtime.start(data.user, input(data), context, noSchedule);
    await runtime.run(data.user, task.id, deps());
    const executeTool = require('../server/services/agent-tools').executeBuiltInTool;
    const status = await executeTool('policy.review_report', { operation: 'status', taskId: task.id }, data.user, context);
    assert.equal(status.task.status, 'completed');
    const delivery = await executeTool('policy.review_report', { operation: 'export', taskId: task.id, version: 1 }, data.user, context);
    const feed = await require('../server/services/chat-task-feed').getChatTaskFeed(runId, data.user);
    assert.ok(feed.artifacts.some(item => item.rendition?.id === String(delivery.renditionId) && item.rendition.ready));
    await runtime.withdraw(data.user, task.id);
    const blocked = await require('../server/services/chat-task-feed').getChatTaskFeed(runId, data.user);
    assert.equal(blocked.knowledgeAccess.current, false); assert.equal(blocked.artifacts.length, 0);
});
