'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    approveTaskDraft,
    buildTaskDraftPlan,
    createTaskDraft,
    startTaskDraft
} = require('../server/services/agent-task-drafts');

function createStore() {
    const drafts = new Map();
    const events = [];
    const user = { id: 91, username: 'draft-user', default_model_id: 'model-draft' };
    const now = () => new Date();

    const queryOne = async (sql, params = []) => {
        if (/SELECT id FROM sessions/i.test(sql)) return params[0] === 'chat-draft-session' ? { id: params[0] } : null;
        if (/INSERT INTO agent_task_drafts/i.test(sql)) {
            const [id, userId, sessionId, title, goal, status, revision, planJson, policyJson, planDigest, policyDigest] = params;
            const row = {
                id, user_id: userId, session_id: sessionId, title, goal, status, revision,
                plan_json: planJson, policy_snapshot: policyJson, plan_digest: planDigest, policy_digest: policyDigest,
                approved_at: null, run_id: null, expires_at: new Date(Date.now() + 86_400_000), created_at: now(), updated_at: now()
            };
            drafts.set(id, row);
            return row;
        }
        if (/SELECT \* FROM agent_task_drafts/i.test(sql)) {
            const row = drafts.get(params[0]) || null;
            return row && Number(row.user_id) === Number(params[1]) ? row : null;
        }
        if (/SET status = 'approved'/i.test(sql)) {
            const row = drafts.get(params[0]);
            row.status = 'approved'; row.approved_at = now(); row.updated_at = now();
            return row;
        }
        if (/SET status = 'starting'/i.test(sql)) {
            const row = drafts.get(params[0]);
            if (!row || row.status !== 'approved') return null;
            row.status = 'starting'; row.updated_at = now();
            return row;
        }
        if (/SET status = 'run_created'/i.test(sql)) {
            const row = drafts.get(params[1]);
            if (!row || row.status !== 'starting') return null;
            row.status = 'run_created'; row.run_id = params[0]; row.updated_at = now();
            return row;
        }
        if (/SET status = 'approved', updated_at/i.test(sql)) {
            const row = drafts.get(params[0]);
            if (row?.status === 'starting') row.status = 'approved';
            return row || null;
        }
        throw new Error(`未预期的 queryOne SQL 语句：${sql}`);
    };
    const execute = async (sql, params = []) => {
        if (/INSERT INTO agent_task_draft_events/i.test(sql)) {
            events.push({ id: params[0], draftId: params[1], revision: params[2], eventType: params[4], eventData: JSON.parse(params[5]) });
            return 1;
        }
        throw new Error(`未预期的 execute SQL 语句：${sql}`);
    };
    const db = {
        queryOne,
        execute,
        query: async sql => {
            if (/FROM messages/i.test(sql)) return [{ role: 'user', content: '此前的会话上下文' }];
            throw new Error(`未预期的 query SQL 语句：${sql}`);
        },
        transaction: async fn => await fn({ queryOne, execute }),
        resolveModel: async modelId => ({ id: modelId || 'model-draft', name: 'Draft Model' })
    };
    return { db, drafts, events, user };
}

test('task draft planner is deterministic, bounded, and declares no planning-time tool execution', () => {
    const plan = buildTaskDraftPlan({ goal: '梳理本周发布风险并给出可核验的修复建议', title: '发布风险梳理', modelId: 'model-1' });
    assert.equal(plan.planner.type, 'deterministic_safe_baseline');
    assert.equal(plan.resources.discovery.includes('本次规划未调用任何工具'), true);
    assert.equal(plan.budget.toolPolicy, 'builtin_only');
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.clarification.required, false);

    const unclear = buildTaskDraftPlan({ goal: '看看', title: '看看', modelId: 'model-1' });
    assert.equal(unclear.clarification.required, true);
});

test('task draft requires explicit review confirmation before it creates exactly one controlled chat Agent Run', async () => {
    const { db, events, user } = createStore();
    const draft = await createTaskDraft(user, {
        sessionId: 'chat-draft-session',
        title: '发布风险梳理',
        goal: '梳理本周发布风险并给出可核验的修复建议',
        modelId: 'model-draft'
    }, db);
    assert.equal(draft.status, 'ready_for_review');
    assert.equal(events.map(event => event.eventType).join(','), 'created');

    await assert.rejects(
        () => startTaskDraft(user, draft.id, { revision: draft.revision, planDigest: draft.planDigest }, { ...db, createAgentRun: async () => ({ id: 'must-not-run' }) }),
        error => error.code === 'AGENT_TASK_DRAFT_APPROVAL_REQUIRED'
    );

    const approved = await approveTaskDraft(user, draft.id, { revision: draft.revision, planDigest: draft.planDigest }, db);
    assert.equal(approved.status, 'approved');
    const createdRuns = [];
    const started = await startTaskDraft(user, approved.id, { revision: approved.revision, planDigest: approved.planDigest }, {
        ...db,
        createAgentRun: async input => {
            createdRuns.push(input);
            return { id: 'task-draft-run-1', title: input.title, status: 'queued' };
        }
    });
    assert.equal(started.status, 'run_created');
    assert.equal(started.runId, 'task-draft-run-1');
    assert.equal(createdRuns.length, 1);
    assert.equal(createdRuns[0].toolPolicy, 'builtin_only');
    assert.equal(createdRuns[0].metadata.taskDraft.planDigest, approved.planDigest);
    assert.equal(createdRuns[0].metadata.chatBridge.source, 'chat_task_draft');
    assert.equal(createdRuns[0].metadata.chatBridge.mcpEnabled, false);
    assert.deepEqual(events.map(event => event.eventType), ['created', 'approved', 'starting', 'run_created']);

    const idempotent = await startTaskDraft(user, approved.id, { revision: approved.revision, planDigest: approved.planDigest }, { ...db, createAgentRun: async () => ({ id: 'second-run' }) });
    assert.equal(idempotent.runId, 'task-draft-run-1');
});
