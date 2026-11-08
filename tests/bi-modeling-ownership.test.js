'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute, query, transaction } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const legacy = require('../server/services/data-analysis/semantic-models');
const models = require('../server/services/data-analysis/bi/models');
const ownership = require('../server/services/data-analysis/bi/ownership');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const confirmations = ['sources', 'personalScope', 'credentials', 'pausedPlans', 'contacts'];
process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true';
process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomBytes(6).toString('hex'), users = [];
    for (const kind of ['owner', 'recipient', 'stranger']) users.push(await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,unit,status", [`bi_handover_${kind}_${suffix}`]));
    const [owner, recipient, stranger] = users;
    const fact = await datasets.createDatasetFromRows({ user: owner, name: '交接订单', rows: [{ 编号: '01', 地区: '北', 金额: '10.25' }, { 编号: '02', 地区: '南', 金额: '20.75' }] });
    let model;
    try {
        model = await legacy.saveDataModel({ user: owner, body: { modelKind: 'production', name: '交接模型', factDatasetId: fact.id, businessOwner: '原业务人', maintenanceContact: '原维护人' } });
        model = await models.saveProductionDraft({ user: owner, modelId: model.id, body: { expectedVersion: 1, definition: { ...model.definition, grainDescription: '一条订单', nodes: [{ ...model.definition.nodes[0], grainKeys: ['c_1'] }],
            dimensions: [{ id: 'region', nodeId: 'fact', fieldKey: 'c_2' }], metrics: [{ id: 'amount', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_3' }, currency: 'CNY' }] } } });
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(recipient.id), fact.id]);
        await run({ owner, recipient, stranger, fact, model, suffix });
    } finally {
        if (model) {
            await execute('DELETE FROM agent_schedules WHERE user_id=ANY(?::bigint[])', [users.map(user => user.id)]);
            await execute('DELETE FROM agent_workflow_versions WHERE workflow_id IN (SELECT id FROM agent_workflows WHERE user_id=?)', [owner.id]);
            await execute('DELETE FROM agent_workflows WHERE user_id=?', [owner.id]);
            await execute('DELETE FROM analysis_refresh_schedules WHERE user_id=ANY(?::bigint[])', [users.map(user => user.id)]);
            await execute('DELETE FROM analysis_dashboards WHERE user_id=ANY(?::bigint[])', [users.map(user => user.id)]);
            await execute('DELETE FROM analysis_model_transfers WHERE model_id=?', [model.id]);
            await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE model_id=?)', [model.id]);
            await execute('DELETE FROM analysis_query_jobs WHERE model_id=?', [model.id]);
            await execute('DELETE FROM analysis_model_data_bindings WHERE model_id=?', [model.id]);
            await execute('DELETE FROM analysis_data_model_checks WHERE model_id=?', [model.id]);
            await execute('DELETE FROM analysis_data_model_versions WHERE model_id=?', [model.id]);
            for (const user of users) {
                await execute('DELETE FROM analysis_source_manifests WHERE user_id=?', [user.id]);
                await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [user.id]);
                await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [user.id]);
            }
            await execute('DELETE FROM analysis_audit_events WHERE model_id=?', [model.id]);
            await execute('DELETE FROM analysis_data_models WHERE id=?', [model.id]);
        }
        for (const user of users) await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
}

async function requested(owner, recipient, model) {
    const preview = await ownership.previewTransfer({ user: owner, modelId: model.id, body: { recipientId: Number(recipient.id) } });
    const body = { recipientId: Number(recipient.id), expectedVersion: preview.impact.version, impactHash: preview.impactHash, businessOwner: '新业务人', maintenanceContact: '新维护人', reason: '原维护人员离岗', requestKey: crypto.randomUUID() };
    const transfer = await ownership.requestTransfer({ user: owner, modelId: model.id, body });
    return { transfer, body };
}
const accept = (user, id, comment = '核对完成，同意接任') => ownership.decideTransfer({ user, id, body: { action: 'accepted', comment, confirmations } });

test('模型交接必须双方同意，原数据集和历史口径保持原归属，重复响应可重放', { timeout: 60000 }, () => fixture(async ({ owner, recipient, stranger, model, fact }) => {
    const { transfer, body } = await requested(owner, recipient, model);
    assert.equal((await ownership.requestTransfer({ user: owner, modelId: model.id, body })).id, transfer.id);
    const replay = await Promise.all([1, 2].map(() => ownership.requestTransfer({ user: owner, modelId: model.id, body })));
    assert.equal(replay[0].id, replay[1].id);
    await assert.rejects(ownership.requestTransfer({ user: owner, modelId: model.id, body: { ...body, reason: '更换请求内容' } }), error => error.code === 'ANALYSIS_MODEL_REQUEST_CONFLICT');
    await assert.rejects(ownership.getTransfer(stranger, transfer.id), error => error.status === 404);
    await assert.rejects(accept(owner, transfer.id), error => error.status === 404);
    await assert.rejects(ownership.decideTransfer({ user: recipient, id: transfer.id, body: { action: 'accepted', comment: '未核对', confirmations: [] } }), error => error.code === 'ANALYSIS_MODEL_TRANSFER_INVALID');
    assert.equal(Number((await queryOne('SELECT user_id FROM analysis_data_models WHERE id=?', [model.id])).user_id), Number(owner.id));
    assert.equal((await ownership.getTransfer(recipient, transfer.id)).unchanged, true);
    const result = await accept(recipient, transfer.id);
    assert.equal(result.status, 'accepted'); assert.equal((await accept(recipient, transfer.id)).id, result.id);
    assert.equal((await ownership.requestTransfer({ user: owner, modelId: model.id, body })).status, 'accepted');
    const current = (await models.getProductionModel(recipient, model.id)).model;
    assert.equal(current.isOwner, true); assert.equal(current.scope, 'personal'); assert.equal(current.version, model.version + 1); assert.equal(current.businessOwner, '新业务人');
    assert.equal(Number((await queryOne('SELECT user_id FROM analysis_datasets WHERE id=?', [fact.id])).user_id), Number(owner.id));
    await assert.rejects(models.getProductionModel(owner, model.id), error => error.status === 404);
    await assert.rejects(execute("UPDATE analysis_model_transfers SET decision_comment='篡改' WHERE id=?", [transfer.id]), /不可改写/);
    assert.deepEqual((await query("SELECT action FROM analysis_audit_events WHERE model_id=? AND action LIKE 'model_transfer_%' ORDER BY created_at", [model.id])).map(row => row.action), ['model_transfer_requested', 'model_transfer_accepted']);
}));

test('接收人必须在申请及接受时具备当前来源和字段权限，历史发布版本也在核验范围', { timeout: 90000 }, () => fixture(async ({ owner, recipient, stranger, model, fact }) => {
    await assert.rejects(ownership.previewTransfer({ user: owner, modelId: model.id, body: { recipientId: Number(stranger.id) } }), error => error.code === 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE');
    const checked = await jobs.createModelCheck({ user: owner, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    await jobs.publishModel({ user: owner, modelId: model.id, body: { expectedVersion: model.version, checkId: checked.check.id, requestKey: crypto.randomUUID(), warningAcceptance: [] } });
    model = (await models.getProductionModel(owner, model.id)).model;
    // 草稿不再引用金额；历史版本仍依赖该字段，接收人不能借当前草稿绕开历史权限。
    model = await models.saveProductionDraft({ user: owner, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, metrics: [{ id: 'count', type: 'count' }] } } });
    await execute("INSERT INTO analysis_field_governance(user_id,dataset_id,field_key,logical_type,sensitivity,status) VALUES (?,?,?,'auto','restricted','active')", [owner.id, fact.id, 'c_3']);
    await assert.rejects(ownership.previewTransfer({ user: owner, modelId: model.id, body: { recipientId: Number(recipient.id) } }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await execute("UPDATE analysis_field_governance SET sensitivity='internal' WHERE dataset_id=?", [fact.id]);
    const { transfer } = await requested(owner, recipient, model);
    await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]);
    await assert.rejects(accept(recipient, transfer.id), error => error.code === 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE');
    assert.equal((await queryOne('SELECT status FROM analysis_model_transfers WHERE id=?', [transfer.id])).status, 'requested');
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(recipient.id), fact.id]);
    await execute("UPDATE users SET status='disabled' WHERE id=?", [recipient.id]);
    await assert.rejects(accept(recipient, transfer.id), error => error.status === 404);
    await execute("UPDATE users SET status='active' WHERE id=?", [recipient.id]);
    const oldVersion = await queryOne('SELECT semantic_hash,published_by FROM analysis_data_model_versions WHERE model_id=? AND version=1', [model.id]);
    await accept(recipient, transfer.id);
    assert.deepEqual(await queryOne('SELECT semantic_hash,published_by FROM analysis_data_model_versions WHERE model_id=? AND version=1', [model.id]), oldVersion);
    const run = await jobs.createModelQuery({ user: recipient, modelId: model.id, body: { publishedVersion: 1, metrics: ['amount'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(recipient, run.id)).result.total.values.amount.value, '31.00');
}));

test('修订变化、活动任务和双人并发交接均不能越过交接栅栏', { timeout: 60000 }, () => fixture(async ({ owner, recipient, model }) => {
    let { transfer } = await requested(owner, recipient, model);
    await models.saveProductionDraft({ user: owner, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, grainDescription: '更新后的订单粒度' } } });
    await assert.rejects(accept(recipient, transfer.id), error => error.code === 'ANALYSIS_MODEL_TRANSFER_CHANGED');
    await ownership.decideTransfer({ user: owner, id: transfer.id, body: { action: 'cancelled', comment: '重新预览' } });
    ({ transfer } = await requested(owner, recipient, model));
    const job = await jobs.createModelCheck({ user: owner, modelId: model.id, body: { expectedVersion: model.version + 1, requestKey: crypto.randomUUID() } });
    await assert.rejects(accept(recipient, transfer.id), error => error.code === 'ANALYSIS_MODEL_TRANSFER_BUSY');
    await jobs.cancelModelJob(owner, job.job.id);
    const another = (await requested(owner, recipient, model)).transfer;
    const competing = await Promise.allSettled([accept(recipient, transfer.id), accept(recipient, another.id)]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
}));

test('交接精确暂停原主体的模型刷新与工作流计划，计划变化要求重新确认', { timeout: 60000 }, () => fixture(async ({ owner, recipient, model }) => {
    const dashboard = crypto.randomUUID(), item = crypto.randomUUID(), schedule = crypto.randomUUID();
    await execute('INSERT INTO analysis_dashboards(id,user_id,name) VALUES (?,?,?)', [dashboard, owner.id, '交接仪表盘']);
    // 保存消费者需要正式运行；这里只登记已有组件元数据以验证调度依赖，不制造查询结果。
    await execute("INSERT INTO analysis_dashboard_items(id,dashboard_id,user_id,source_type,model_id,published_version,title,config_json) VALUES (?,?,?,'model',?,1,'模型组件','{}')", [item, dashboard, owner.id, model.id]);
    await execute('INSERT INTO analysis_refresh_schedules(id,user_id,dashboard_id,name,next_run_at) VALUES (?,?,?,?,NOW())', [schedule, owner.id, dashboard, '模型刷新计划']);
    const dag = { nodes: [{ id: 'query', type: 'tool', toolName: 'analysis.modelQuery', input: { modelId: model.id } }] };
    const agent = await queryOne("INSERT INTO agent_schedules(user_id,name,goal,run_config) VALUES (?,?,?,?) RETURNING id", [owner.id, '模型工作流计划', '测试', JSON.stringify({ runMode: 'dag', dagSpec: dag })]);
    const workflow = await queryOne('INSERT INTO agent_workflows(user_id,name) VALUES (?,?) RETURNING id', [owner.id, '已关联工作流']);
    const workflowVersion = await queryOne('INSERT INTO agent_workflow_versions(workflow_id,version,dag_spec,created_by) VALUES (?,1,?,?) RETURNING id', [workflow.id, JSON.stringify(dag), owner.id]);
    await execute('UPDATE agent_workflows SET current_version_id=? WHERE id=?', [workflowVersion.id, workflow.id]);
    const linked = await queryOne('INSERT INTO agent_schedules(user_id,name,goal,run_config) VALUES (?,?,?,?) RETURNING id', [owner.id, '关联模型计划', '测试', JSON.stringify({ runMode: 'dag', workflowId: Number(workflow.id), workflowVersion: 'current' })]);
    const unrelated = await queryOne("INSERT INTO agent_schedules(user_id,name,goal,run_config) VALUES (?,?,?,?) RETURNING id", [owner.id, '其他计划', '测试', '{}']);
    let { transfer } = await requested(owner, recipient, model);
    assert.equal(transfer.impact.plans.length, 3);
    await execute('UPDATE agent_schedules SET name=? WHERE id=?', ['调整后的计划', agent.id]);
    await assert.rejects(accept(recipient, transfer.id), error => error.code === 'ANALYSIS_MODEL_TRANSFER_CHANGED');
    ({ transfer } = await requested(owner, recipient, model));
    await accept(recipient, transfer.id);
    assert.equal((await queryOne('SELECT status FROM analysis_refresh_schedules WHERE id=?', [schedule])).status, 'paused');
    assert.equal((await queryOne('SELECT status FROM agent_schedules WHERE id=?', [agent.id])).status, 'paused');
    assert.equal((await queryOne('SELECT status FROM agent_schedules WHERE id=?', [linked.id])).status, 'paused');
    assert.equal((await queryOne('SELECT status FROM agent_schedules WHERE id=?', [unrelated.id])).status, 'active');
}));

test('系统管理员只能为停用所有者发起受控交接，原生到期刷新计划停止使用停用身份', { timeout: 60000 }, () => fixture(async ({ owner, recipient, stranger, fact, model }) => {
    const admin = await queryOne("SELECT id,username,role,status FROM users WHERE username='admin'");
    assert.ok(admin);
    await assert.rejects(ownership.previewTransfer({ user: admin, modelId: model.id, body: { recipientId: Number(recipient.id) } }), error => error.status === 404);
    const id = crypto.randomUUID();
    await execute("INSERT INTO analysis_refresh_schedules(id,user_id,dataset_id,name,next_run_at) VALUES (?,?,?,?,NOW()-INTERVAL '1 minute')", [id, owner.id, fact.id, '停用计划']);
    await execute("UPDATE users SET status='disabled' WHERE id=?", [owner.id]);
    let tick;
    const scheduleRunner = require('../server/services/data-analysis/governance').startAnalysisRefreshRunner({ setTimeoutFn: callback => { tick = callback; return { unref() {} }; }, clearTimeoutFn: () => {} });
    await tick(); await scheduleRunner.stop();
    assert.equal((await queryOne('SELECT status,next_run_at FROM analysis_refresh_schedules WHERE id=?', [id])).status, 'paused');
    await assert.rejects(ownership.previewTransfer({ user: stranger, modelId: model.id, body: { recipientId: Number(recipient.id) } }), error => error.status === 404);
    const { transfer } = await requested(admin, recipient, model);
    assert.equal(transfer.ownerId, Number(owner.id)); assert.equal(transfer.initiatorId, Number(admin.id));
    await accept(recipient, transfer.id);
    assert.equal((await models.getProductionModel(recipient, model.id)).model.isOwner, true);
}));

test('超过七天的交接请求拒绝接受，失去来源权限仍可拒绝或撤回请求', { timeout: 60000 }, () => fixture(async ({ owner, recipient, fact, model }) => {
    const { transfer } = await requested(owner, recipient, model), expiredId = `transfer_${crypto.randomUUID()}`;
    await execute(`INSERT INTO analysis_model_transfers(id,model_id,owner_id,initiator_id,recipient_id,expected_version,impact_hash,impact_json,business_owner,maintenance_contact,reason,request_key,request_hash,expires_at)
        SELECT ?,model_id,owner_id,initiator_id,recipient_id,expected_version,impact_hash,impact_json,business_owner,maintenance_contact,reason,?,?,NOW()-INTERVAL '1 minute' FROM analysis_model_transfers WHERE id=?`, [expiredId, crypto.randomUUID(), crypto.randomUUID(), transfer.id]);
    await assert.rejects(accept(recipient, expiredId), error => error.code === 'ANALYSIS_MODEL_TRANSFER_EXPIRED');
    await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]);
    assert.equal((await ownership.getTransfer(recipient, transfer.id)).unchanged, false);
    assert.equal((await ownership.decideTransfer({ user: recipient, id: transfer.id, body: { action: 'rejected', comment: '来源权限不足，拒绝接任' } })).status, 'rejected');
    assert.equal((await ownership.decideTransfer({ user: owner, id: expiredId, body: { action: 'cancelled', comment: '过期后撤回' } })).status, 'cancelled');
}));

test('交接 HTTP 接口绑定当前身份和完整确认，旧会话撤销后不能读取交接记录', { timeout: 60000 }, () => fixture(async ({ owner, recipient, stranger, model }) => {
    const express = require('express'), http = require('node:http'), auth = require('../server/auth');
    const app = express(); app.use(express.json());
    require('../server/routes/apps/data-analysis-model-routes').registerDataAnalysisModelRoutes(app, { authMiddleware: auth.authMiddleware });
    app.use((error, _req, res, _next) => { res.status(error.status || 500).json({ code: error.code, error: error.message }); });
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const tokens = new Map([owner, recipient, stranger].map(user => [user.id, auth.generateAccessToken(user, { sessionIp: '127.0.0.1' })]));
    const call = async (user, path, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, json: await response.json(), headers: response.headers };
    };
    try {
        const preview = await call(owner, `/models/${model.id}/transfer-preview`, { recipientId: Number(recipient.id) });
        assert.equal(preview.status, 200); assert.match(preview.headers.get('cache-control'), /no-store/);
        const body = { recipientId: Number(recipient.id), expectedVersion: preview.json.impact.version, impactHash: preview.json.impactHash, businessOwner: '接收业务人', maintenanceContact: '接收维护人', reason: 'HTTP交接', requestKey: crypto.randomUUID() };
        const created = await call(owner, `/models/${model.id}/transfers`, body); assert.equal(created.status, 201);
        const id = created.json.transfer.id;
        assert.equal((await call(stranger, `/model-transfers/${id}`)).status, 404);
        assert.equal((await call(recipient, `/model-transfers/${id}/decision`, { action: 'accepted', comment: '接受', confirmations: [] })).status, 400);
        assert.equal((await call(recipient, `/model-transfers/${id}/decision`, { action: 'accepted', comment: '核验完成', confirmations })).status, 200);
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [recipient.id]);
        assert.equal((await call(recipient, '/model-transfers')).status, 401);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('草稿写入持有行锁时交接等待相同授权栅栏，提交修订后明确拒绝旧影响摘要', { timeout: 60000 }, () => fixture(async ({ owner, recipient, model }) => {
    const { transfer } = await requested(owner, recipient, model);
    let entered, release;
    const acquired = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const writing = transaction(async trx => {
        await require('../server/repositories/analysis-production-models').lock(trx, { userId: owner.id, modelId: model.id, expectedVersion: model.version });
        entered(); await gate;
        await trx.execute('UPDATE analysis_data_models SET version=version+1 WHERE id=?', [model.id]);
    });
    await acquired;
    let settled = false;
    const transferring = accept(recipient, transfer.id).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
        await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(settled, false);
    } finally { release(); }
    await writing;
    assert.equal((await transferring).error.code, 'ANALYSIS_MODEL_TRANSFER_CHANGED');
    assert.equal((await queryOne('SELECT status FROM analysis_model_transfers WHERE id=?', [transfer.id])).status, 'requested');
}));
