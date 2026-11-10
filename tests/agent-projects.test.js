'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const projects = require('../server/services/agent-projects');
const { resolveAgentContextPack } = require('../server/services/agent-context-packs');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
let user, other, model;
const projectIds = [], runIds = [];
test.before(async () => {
    user = await queryOne("SELECT id,role,unit FROM users WHERE username='admin'");
    other = await queryOne("INSERT INTO users(username,password_hash,status) VALUES (?,'hash','active') RETURNING id", [`projects-${process.pid}-${Date.now()}`]);
    model = await queryOne("INSERT INTO models(user_id,name,url,model_name,status) VALUES (?,'项目模型','http://127.0.0.1:65530/v1','fixture','active') RETURNING id", [user.id]);
});
test.after(async () => {
    for (const id of runIds)
        await execute('DELETE FROM agent_runs WHERE id=?', [id]);
    for (const id of projectIds)
        await execute('DELETE FROM agent_projects WHERE id=?', [id]);
    await execute('DELETE FROM models WHERE id=?', [model.id]);
    await execute('DELETE FROM users WHERE id=?', [other.id]);
});
const input = () => ({ title: '项目验收', instructions: '数字保留两位小数；先核对来源。', collectionIds: [], artifactIds: [], milestones: [{ id: 'first', title: '形成初稿', status: 'pending' }] });
async function create() {
    const item = await projects.save(user, null, input());
    projectIds.push(item.id);
    return item;
}
test('项目私有、修订冲突、归档与里程碑依据均由服务端校验', async () => {
    const item = await create();
    await assert.rejects(()=>projects.save(user,item.id,null),error=>error.status===400);
    assert.equal(item.milestones[0].title, '形成初稿');
    await assert.rejects(() => projects.detail(other, item.id), error => error.status === 404);
    await assert.rejects(() => projects.save(user, item.id, { expectedVersion: 0, title: '旧修订' }), error => error.status === 409);
    await assert.rejects(() => projects.save(user, item.id, { expectedVersion: 1, milestones: [{ title: '完成', status: 'completed' }] }), /确认依据/);
    await assert.rejects(() => projects.save(user, item.id, { expectedVersion: 1, collectionIds: ['1abc'] }), /无效/);
    const results = await Promise.allSettled([projects.save(user, item.id, { expectedVersion: 1, title: '修改一' }), projects.save(user, item.id, { expectedVersion: 1, title: '修改二' })]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const archived = await projects.save(user, item.id, { expectedVersion: 2, status: 'archived' });
    await assert.rejects(() => resolveAgentContextPack(user, { projectId: archived.id }), /归档/);
    assert.equal((await projects.list(other, {})).total, 0);
});
test('任务工厂冻结项目规则和资料范围，项目任务与产物汇总共用当前身份', async () => {
    const project = await create();
    const context = await resolveAgentContextPack(user, { projectId: project.id });
    assert.equal(context.pack.project.instructions, project.instructions);
    const run = await createAgentRunFactory({})({ user, modelId: model.id, goal: '按项目规则生成结果', contextConfig: { projectId: project.id }, metadata: { autoPersonalSkill: false } });
    runIds.push(run.id);
    assert.equal(run.metadata.projectContextPack.project.id, project.id);
    const messages = buildPlannerMessages(run.goal, [], [], 'standard', { projectContextPack: run.metadata.projectContextPack });
    assert(messages.some(item => String(item.content).includes(project.instructions)));
    await projects.save(user, project.id, { expectedVersion: 1, instructions: '新规则' });
    assert.equal(run.metadata.projectContextPack.project.instructions, project.instructions);
    const detail = await projects.detail(user, project.id);
    assert.equal(detail.taskTotal, 1);
    assert.equal(detail.tasks[0].id, run.id);
    await assert.rejects(() => projects.save(user, project.id, { expectedVersion: 2, milestones: [{ title: '完成', status: 'completed', runId: run.id }] }), /尚未核验/);
    await execute("UPDATE agent_runs SET status='completed' WHERE id=?", [run.id]);
    await execute("INSERT INTO agent_verifications(id,run_id,user_id,outcome_status) VALUES(?,?,?,'verified')", [`verify-${run.id}`, run.id, user.id]);
    const updated = await projects.save(user, project.id, { expectedVersion: 2, milestones: [{ title: '完成', status: 'completed', runId: run.id }] });
    assert.equal(updated.milestones[0].completionSource, 'verified_run');
});
test('真实HTTP项目接口拒绝匿名、跨账号和旧会话，写入仍受修订约束', async () => {
    const express = require('express'), http = require('node:http');
    const { register, login, authMiddleware } = require('../server/auth');
    const suffix = `${process.pid}-${Date.now()}`, password = 'ProjectTest123!';
    const first = await register(`prja-${suffix}`, password, '项目用户', 'QA', 'user'), second = await register(`prjb-${suffix}`, password, '其它用户', 'QA', 'user');
    const loginA = await login(`prja-${suffix}`, password, { clientIp: '127.0.0.1' }), loginB = await login(`prjb-${suffix}`, password, { clientIp: '127.0.0.1' });
    const app = express();
    app.use(express.json());
    require('../server/routes/agent-projects')(app, { authMiddleware, logAction: () => {
        } });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/agents/projects`;
    const request = (token, suffix = '', options = {}) => fetch(base + suffix, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    try {
        assert.equal((await fetch(base)).status, 401);
        const response = await request(loginA.accessToken, '', { method: 'POST', body: JSON.stringify(input()) });
        assert.equal(response.status, 201);
        const project = (await response.json()).project;
        assert.equal((await request(loginB.accessToken, `/${project.id}`)).status, 404);
        assert.equal((await request(loginA.accessToken, `/${project.id}`, { method: 'PUT', body: JSON.stringify({ expectedVersion: 0, title: '覆盖' }) })).status, 409);
        assert.equal((await request(loginA.accessToken, '?limit=1000')).status, 400);
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [first.id]);
        assert.equal((await request(loginA.accessToken)).status, 401);
    }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await execute('DELETE FROM users WHERE id IN (?,?)', [first.id, second.id]);
    }
});
test('独立核验收到冻结的完整项目规则，不能只检查任务标题而漏掉项目约束', async () => {
    const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
    const instructions = '项目规则'.repeat(500) + '最后一条规则也必须核对';
    let seen;
    const result = await verifyAutomaticTask({ run: { id: 'project-verify', model_id: 1, metadata: { projectContextPack: { project: { title: '业务项目', instructions, milestones: [] } } } }, user: { id: 1 }, contract: { acceptance: {}, deliverables: [] }, answer: '结果', observations: [] }, {
        getModel: async () => ({ max_input_tokens: 16000 }), resolveMemoryEvidence: async () => ({ current: true, memories: [] }), resolveObservations: async () => [],
        callModelJson: async (_model, messages) => {
            seen = JSON.parse(messages[1].content);
            return { passed: false, coveredDeliverables: [], missing: ['未遵守项目规则'] };
        }
    });
    assert.equal(seen.projectContext.instructions, instructions);
    assert.equal(result.passed, false);
});
test('项目配置进入个人导出和明确擦除，其他账号项目不受影响', async () => {
    const item = await projects.save(other, null, input());
    const { exportAgentPersonalData, deleteAgentPersonalData } = require('../server/services/agent-data');
    const exported = await exportAgentPersonalData(other);
    assert.equal(exported.projects.find(row => row.id === item.id).instructions, input().instructions);
    await deleteAgentPersonalData(other);
    await assert.rejects(() => projects.current(other, item.id), error => error.status === 404);
    assert((await projects.list(user, {})).total > 0);
});
test('持续目标保存、预览与触发绑定项目，归档后不能继续接纳新运行', async () => {
    const service = require('../server/services/agent-goals'), project = await create();
    let request;
    service.configureAgentGoals({ createAgentRun: async (input) => {
            request = input;
            return { id: 'project-goal-fixture' };
        }, createAgentNotification: async () => {
        } });
    const created = await service.createAgentGoal(user, { title: '项目目标', goal: '完成项目资料核验', triggerSpec: { type: 'manual' }, authorizationSpec: { modelId: model.id, projectId: project.id } });
    try {
        await service.previewAgentGoal(user, { title: '项目预览', goal: '检查项目规则', triggerSpec: { type: 'manual' }, authorizationSpec: { modelId: model.id, projectId: project.id } });
        assert.equal(request.contextConfig.projectId, project.id);
        await service.runAgentGoalNow(created.goal, user, { triggerType: 'manual' });
        assert.equal(request.contextConfig.projectId, project.id);
        await projects.save(user, project.id, { expectedVersion: 1, status: 'archived' });
        await assert.rejects(() => service.runAgentGoalNow(created.goal, user, { triggerType: 'manual' }), /归档/);
    }
    finally {
        await execute('DELETE FROM agent_goals WHERE id=?', [created.goal.id]);
    }
});
test('资料范围与关联文件在保存、运行和展示时复查，不因项目引用扩大权限', async () => {
    const { createKnowledgeCollection } = require('../server/services/rag-documents');
    const own = await createKnowledgeCollection({ userId: user.id, name: `项目范围-${Date.now()}` }), foreign = await createKnowledgeCollection({ userId: other.id, name: `外部范围-${Date.now()}` });
    const artifacts = require('../server/services/agent-artifacts');
    const artifact = await artifacts.createStandaloneArtifact(user, { type: 'document', title: '项目来源', content: JSON.stringify({ ir_version: '1', doc_type: 'report', meta: { title: '来源' }, blocks: [{ type: 'paragraph', runs: [{ text: '项目材料' }] }] }) });
    try {
        await assert.rejects(() => projects.save(user, null, { ...input(), collectionIds: [foreign.id] }), /撤权|不可访问/);
        const project = await projects.save(user, null, { ...input(), collectionIds: [own.id], artifactIds: [artifact.id] });
        projectIds.push(project.id);
        await assert.rejects(() => resolveAgentContextPack(user, { projectId: project.id, collectionIds: [foreign.id] }), /超出项目/);
        assert.deepEqual((await resolveAgentContextPack(user, { projectId: project.id })).contextConfig.collectionIds, [own.id]);
        await execute("UPDATE agent_artifacts SET status='deleted' WHERE id=?", [artifact.id]);
        await assert.rejects(() => resolveAgentContextPack(user, { projectId: project.id }), /文件已失效/);
        assert.equal((await projects.detail(user, project.id)).artifacts[0].available, false);
        await execute('UPDATE knowledge_collections SET deleted_at=NOW() WHERE id=?', [own.id]);
        await assert.rejects(() => resolveAgentContextPack(user, { projectId: project.id }), /资料已撤权/);
        assert.equal((await projects.detail(user, project.id)).collections[0].available, false);
        assert.equal((await projects.save(user, project.id, { expectedVersion: 1, status: 'archived' })).status, 'archived');
    }
    finally {
        await execute('DELETE FROM agent_artifacts WHERE id=?', [artifact.id]);
        await execute('DELETE FROM knowledge_collections WHERE id IN (?,?)', [own.id, foreign.id]);
    }
});
