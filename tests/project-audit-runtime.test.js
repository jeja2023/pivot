'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { createRunState } = require('../server/services/agent-runtime/run-state');
const { createAgentQueue } = require('../server/services/agent-queue');
const { requeueAgentRunAfterLeaseLoss } = require('../server/services/agent-runtime/lease-loss');
const { EXECUTION_LEASE_STATUSES } = require('../server/services/agent-runtime/state-machine');

test('真实队列在核验中续租，不误报租约丢失', async t => {
    const originalInterval = globalThis.setInterval;
    let heartbeat;
    t.mock.method(globalThis, 'setInterval', (fn, delay, ...args) => {
        if (delay === 300000) { heartbeat = fn; return { unref() {} }; }
        return originalInterval(fn, delay, ...args);
    });
    let claimed = false, release;
    const held = new Promise(resolve => { release = resolve; });
    let lost = 0, renewed = 0;
    const queue = createAgentQueue({ instanceId: 'worker', maxConcurrent: 1, getTimestamp: () => new Date().toISOString(),
        getRunUser: async () => ({ id: 7 }), runAgent: async () => held, markRunError: async () => {}, onRunLeaseLost: () => { lost++; },
        dbRunner: { query: async () => claimed ? [] : (claimed = true, [{ id: 'heartbeat', user_id: 7 }]), queryOne: async () => null,
            execute: async (sql, params) => {
                if (sql.includes('SET lock_expires_at')) { if (params.includes('verifying')) { renewed++; return 1; } return 0; }
                return 1;
            } }
    });
    try { await queue.processQueue(); assert.ok(heartbeat); await heartbeat(); assert.equal(lost, 0); assert.equal(renewed, 1); }
    finally { release(); await new Promise(resolve => setImmediate(resolve)); }
});

test('核验中进程退出后恢复为明确失败并保留已有答案', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const id = `audit-recovery-${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,last_heartbeat_at,final_answer) VALUES (?,?,'恢复','恢复','verifying','2000-01-01','已有答案')", [id, user.id]);
    try {
        await execute('UPDATE agent_runs SET last_heartbeat_at=NOW() WHERE id=?', [id]);
        const state = createRunState({ execute, queryOne,
            assertAgentRunStatusTransition: require('../server/services/agent-runtime/state-machine').assertAgentRunStatusTransition });
        assert.equal(await state.updateRunCas(id, ['verifying'], { status: 'error' }, { staleBefore: '2000-01-02' }), 0);
        await execute("UPDATE agent_runs SET last_heartbeat_at='2000-01-01' WHERE id=?", [id]);
        await require('../server/services/agent-runtime').runs.recoverAgentRuns();
        const row = await queryOne('SELECT status,final_answer,completed_at FROM agent_runs WHERE id=?', [id]);
        assert.equal(row.status, 'error'); assert.equal(row.final_answer, '已有答案'); assert.ok(row.completed_at);
    } finally { await execute('DELETE FROM agent_runs WHERE id=?', [id]); }
});

test('核验中丢失租约保留结果并收敛，旧持锁者不能结束新执行者的任务', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const id = `audit-lease-${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,locked_by,final_answer) VALUES (?,?,'核验','核验','verifying','new-owner','已有结果')", [id, user.id]);
    const ended = [];
    const args = { execute, getTimestamp: () => new Date().toISOString(), enqueueAgentRun: () => { throw Error('核验失败不能自动重放'); },
        finalizeTerminalRun: async (...values) => ended.push(values), runId: id };
    try {
        assert.equal(EXECUTION_LEASE_STATUSES.includes('verifying'), true);
        assert.equal(await requeueAgentRunAfterLeaseLoss({ ...args, instanceId: 'old-owner' }), 0);
        assert.equal(await requeueAgentRunAfterLeaseLoss({ ...args, instanceId: 'new-owner', epoch: '9999' }), 0);
        assert.equal(await requeueAgentRunAfterLeaseLoss({ ...args, instanceId: 'new-owner' }), 1);
        const row = await queryOne('SELECT status,final_answer FROM agent_runs WHERE id=?', [id]);
        assert.equal(row.status, 'error'); assert.equal(row.final_answer, '已有结果');
        assert.deepEqual(ended, [[id, 'error']]);
    } finally { await execute('DELETE FROM agent_runs WHERE id=?', [id]); }
});

test('真实队列认领后的启动拒绝阻断模型动作，启动事件只属于本次执行尝试', async () => {
    let claimed = false;
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const events = [];
    let modelCalls = 0;
    const state = createRunState({ dispatchPreLifecycleHook: async request => { events.push(request); return { denied: true }; } });
    const queue = createAgentQueue({ instanceId: 'audit-worker', maxConcurrent: 1, getTimestamp: () => new Date().toISOString(),
        getRunUser: async () => ({ id: 7 }), markRunError: async () => finish(),
        dbRunner: { query: async () => claimed ? [] : (claimed = true, [{ id: 'audit-start', user_id: 7, realtime_lease_epoch: '42' }]),
            queryOne: async () => null, execute: async () => 1 },
        runAgent: async (id, user, execution) => { await state.startClaimedRun({ id, status: 'running' }, user, execution); modelCalls++; }
    });
    queue.enqueueRun('audit-start');
    await completed;
    assert.equal(modelCalls, 0);
    assert.equal(events.length, 1);
    assert.match(events[0].eventKey, /attempt:42:pre$/);
});

test('真实执行器在读取模型或业务来源前调用启动拒绝，拒绝不触发自动重试', async () => {
    const { createAgentRunner } = require('../server/services/agent-runtime/run-execution');
    let modelCalls = 0, hooks = 0;
    const run = { id: 'runner-start-hook', user_id: 7, status: 'running' };
    const state = createRunState({ dispatchPreLifecycleHook: async () => { hooks++; return { denied: true }; } });
    const runner = createAgentRunner({ activeRunControllers: new Map(), taskBudgetsBySignal: new WeakMap(),
        assertRunUserActive: async () => {}, getRunForUser: async () => run, startClaimedRun: state.startClaimedRun,
        getRunnableModelForUserAsync: async () => { modelCalls++; throw Error('拒绝启动后不得读取模型'); },
        logger: { warn() {}, error() {} }, getRunStatus: async () => run.status, isRunCancelled: () => false,
        queryOne: async () => ({ retry_limit: 3, retry_count: 0 }), normalizePositiveInt: value => Number(value),
        TERMINAL_STATUSES: new Set(['error']), getBeijingTimestamp: () => new Date().toISOString(),
        updateRun: async (_id, fields) => Object.assign(run, fields), createAgentNotification: async () => {}, syncAgentTraceFromRun: async () => {}
    });
    await runner.runAgent(run.id, { id: 7 }, { leaseEpoch: '43' });
    assert.equal(hooks, 1); assert.equal(modelCalls, 0); assert.equal(run.status, 'error');
    assert.match(run.error_message, /启动检查拒绝/);
});

test('故障切换选用模型经过真实状态服务写回数据库', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const id = `audit-model-${crypto.randomUUID()}`;
    const model = await queryOne("INSERT INTO models(user_id,name,model_name,url,status) VALUES (?,'降级模型','audit-fallback','https://synthetic.invalid','active') RETURNING id,url,model_name,name", [user.id]);
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status) VALUES (?,?,'降级','降级','planning')", [id, user.id]);
    try {
        const state = createRunState({ execute, queryOne });
        assert.equal(await state.updateRun(id, { chosen_model_id: model.id }), 1);
        assert.equal(Number((await queryOne('SELECT chosen_model_id FROM agent_runs WHERE id=?', [id])).chosen_model_id), Number(model.id));
        await execute("UPDATE agent_runs SET status='completed' WHERE id=?", [id]);
        const quality = require('../server/services/agent-model-quality');
        // PostgreSQL 保留微秒而 JS 时钟只保留毫秒，样本必须明确早于本次统计截止。
        await execute("INSERT INTO agent_verifications(id,run_id,user_id,outcome_status,report,created_at,updated_at) VALUES (?,?,?,'verified',?::jsonb,NOW()-INTERVAL '1 second',NOW())",
            [id, id, user.id, JSON.stringify({ executionModelIdentity: quality.modelQualityIdentity(model) })]);
        const profile = (await quality.getModelQualityProfiles(user)).find(item => item.modelId === Number(model.id));
        assert.ok(profile, JSON.stringify(await queryOne(`SELECT r.status,r.chosen_model_id,m.model_name,m.url,v.created_at,
            v.created_at <= ?::timestamptz AS in_window, v.report,
            encode(sha256(convert_to(m.url || chr(10) || COALESCE(NULLIF(m.model_name,''),m.name,''),'UTF8')),'hex') AS expected_identity
            FROM agent_runs r JOIN models m ON m.id=r.chosen_model_id JOIN agent_verifications v ON v.run_id=r.id WHERE r.id=?`, [new Date().toISOString(), id])));
        assert.equal(profile.samples, 1); assert.equal(profile.verified, 1);
    } finally { await execute('DELETE FROM agent_runs WHERE id=?', [id]); await execute('DELETE FROM models WHERE id=?', [model.id]); }
});
