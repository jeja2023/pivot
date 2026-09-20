const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { createAgentWorkflow } = require('../server/services/agent-workflows');
const { configureAgentTriggers, listWorkflowTriggerEvents, replayWorkflowTriggerEvent } = require('../server/services/agent-triggers');

test('触发事件诊断仅对所属用户可见，默认不返回完整输入快照', async () => {
    const suffix = Date.now().toString(36);
    const owner = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', '触发器所有者', '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai') RETURNING id`, [`trigger_owner_${suffix}`]);
    const other = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', '其他用户', '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai') RETURNING id`, [`trigger_other_${suffix}`]);
    let workflowId = null;
    let triggerId = null;
    try {
        const workflow = await queryOne(`INSERT INTO agent_workflows (user_id, name, created_at, updated_at) VALUES (?, '触发事件工作流', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai') RETURNING id`, [owner.id]);
        workflowId = workflow.id;
        const trigger = await queryOne(`INSERT INTO agent_workflow_triggers (user_id, workflow_id, name, trigger_type, status, config_json, created_at, updated_at) VALUES (?, ?, '诊断触发器', 'webhook', 'active', '{}', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai') RETURNING id`, [owner.id, workflowId]);
        triggerId = trigger.id;
        await execute(`INSERT INTO agent_workflow_trigger_events (id, trigger_id, event_type, status, input_json, source_meta_json, goal, created_at, updated_at) VALUES (?, ?, 'webhook', 'dispatched', ?, '{}', '处理订单', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')`, [`te_${suffix}`, triggerId, JSON.stringify({ orderNo: 'A-001', customer: '受控数据' })]);
        const events = await listWorkflowTriggerEvents(triggerId, { id: owner.id });
        assert.equal(events.length, 1);
        assert.equal(events[0].inputSummary.keyCount, 2);
        assert.equal(Object.hasOwn(events[0], 'inputs'), false);
        assert.equal(await listWorkflowTriggerEvents(triggerId, { id: other.id }), null);
    } finally {
        if (triggerId) await execute('DELETE FROM agent_workflow_triggers WHERE id = ?', [triggerId]);
        if (workflowId) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflowId]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
});

test('成功触发事件可重放为新运行，并保留原事件关联和新幂等键', async () => {
    const suffix = Date.now().toString(36);
    const userRow = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', '触发器重放者', '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [`trigger_replay_${suffix}`]);
    const user = { id: userRow.id, role: 'user', unit: '研发部' };
    let workflow = null;
    let triggerId = null;
    let replayRunId = null;
    try {
        workflow = await createAgentWorkflow(user, {
            name: '触发重放工作流',
            dagSpec: { nodes: [{ id: 'output', tool: 'workflow.output', input: { name: 'answer', value: 'ok' } }] }
        });
        await execute('UPDATE agent_workflows SET published_version_id = ? WHERE id = ?', [workflow.current_version_id, workflow.id]);
        const trigger = await queryOne(`
            INSERT INTO agent_workflow_triggers (user_id, workflow_id, name, trigger_type, status, config_json, created_at, updated_at)
            VALUES (?, ?, '重放触发器', 'webhook', 'active', '{}', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')
            RETURNING id
        `, [user.id, workflow.id]);
        triggerId = trigger.id;
        const originalEventId = `te_source_${suffix}`;
        await execute(`
            INSERT INTO agent_workflow_trigger_events (id, trigger_id, event_type, status, dedupe_key, input_json, source_meta_json, goal, created_at, updated_at)
            VALUES (?, ?, 'webhook', 'dispatched', 'trigger:source', ?, '{"source":"test"}', '重放订单', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')
        `, [originalEventId, triggerId, JSON.stringify({ orderNo: 'A-002', accessToken: 'should-not-be-persisted-in-replay-audit' })]);
        configureAgentTriggers({
            createAgentRun: async () => {
                replayRunId = `trigger-replay-run-${suffix}`;
                await execute(`
                    INSERT INTO agent_runs (id, user_id, goal, run_mode, status, created_at, updated_at)
                    VALUES (?, ?, '重放订单', 'dag', 'queued', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')
                `, [replayRunId, user.id]);
                return { id: replayRunId, deduplicated: false };
            }
        });
        const result = await replayWorkflowTriggerEvent(originalEventId, user);
        assert.equal(result.run.id, replayRunId);
        const replayedEvent = await queryOne('SELECT replay_of_event_id, status, run_id, dedupe_key, input_json FROM agent_workflow_trigger_events WHERE replay_of_event_id = ?', [originalEventId]);
        assert.equal(replayedEvent.replay_of_event_id, originalEventId);
        assert.equal(replayedEvent.status, 'dispatched');
        assert.equal(replayedEvent.run_id, replayRunId);
        assert.match(replayedEvent.dedupe_key, /^trigger:.+:replay:/);
        const replayInputs = typeof replayedEvent.input_json === 'string' ? JSON.parse(replayedEvent.input_json) : replayedEvent.input_json;
        assert.equal(replayInputs.accessToken, '[已脱敏]');
    } finally {
        if (replayRunId) await execute('DELETE FROM agent_runs WHERE id = ?', [replayRunId]);
        if (triggerId) await execute('DELETE FROM agent_workflow_triggers WHERE id = ?', [triggerId]);
        if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
