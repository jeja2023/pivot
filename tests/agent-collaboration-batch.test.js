const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_DELEGATION_BATCH,
    normalizeDelegationBatchInput,
    normalizeDelegationInput,
    resolveChildDelegationConstraints,
    validateDelegationOutput
} = require('../server/services/agent-collaboration');
const { childJoinAcceptance } = require('../server/services/agent-tools-collaboration');

test('batch delegation normalizes bounded children and defaults to safe inherited constraints', () => {
    const batch = normalizeDelegationBatchInput({
        title: '风险并行核对',
        tasks: [
            {
                title: '检索资料',
                goal: '检索相关资料并列出明确风险。',
                context: '只关注最近一周的更新。',
                outputSchema: {
                    type: 'object',
                    properties: { risks: { type: 'array', items: { type: 'string' } } },
                    required: ['risks'],
                    additionalProperties: false
                }
            },
            { title: '审阅结论', goal: '审阅已有结论中的证据与遗漏。' }
        ]
    });
    assert.equal(batch.batchTitle, '风险并行核对');
    assert.equal(batch.tasks.length, 2);
    assert.equal(batch.tasks[0].responseFormat, 'json');
    assert.equal(batch.tasks[0].toolPolicy, 'builtin_only');
    assert.equal(batch.tasks[0].approvalPolicy, 'safe_mcp_auto');
    assert.equal(batch.tasks[1].responseFormat, 'markdown');
    assert.throws(
        () => normalizeDelegationBatchInput({ tasks: Array.from({ length: MAX_DELEGATION_BATCH + 1 }, () => ({ goal: '超过上限的协作任务' })) }),
        error => error.code === 'AGENT_DELEGATION_BATCH_LIMIT'
    );
});

test('delegation output contract validates JSON and reports a bounded schema miss', () => {
    const task = normalizeDelegationInput({
        goal: '返回风险列表。',
        outputSchema: {
            type: 'object',
            properties: { risks: { type: 'array', items: { type: 'string' } } },
            required: ['risks'],
            additionalProperties: false
        }
    });
    const valid = validateDelegationOutput('{"risks":["供应商超时"]}', task.outputSchema);
    assert.equal(valid.schemaValid, true);
    assert.deepEqual(valid.value, { risks: ['供应商超时'] });
    const invalid = validateDelegationOutput('{"unknown":true}', task.outputSchema);
    assert.equal(invalid.schemaValid, false);
    assert.match(invalid.issues[0], /必填项|不是契约允许/);
});

test('delegated children inherit parent model, run mode, approval, network and step ceiling without widening tools', () => {
    const parent = {
        parentModelId: 8, parentRunMode: 'audit', parentMaxSteps: 12,
        parentToolPolicy: 'all', parentToolAllowlist: ['rag.search', 'knowledge.list'],
        parentApprovalPolicy: 'safe_mcp_auto', parentNetworkPolicy: { enabled: false }, parentTimeoutMs: 45000, parentToolTimeoutMs: 8000
    };
    const child = resolveChildDelegationConstraints(parent, {
        maxSteps: 50, toolAllowlist: ['rag.search', 'agent.http'], maxTokenBudget: 400,
        approvalPolicy: 'approve_all_mcp', toolPolicy: 'all'
    });
    assert.equal(child.modelId, 8);
    assert.equal(child.runMode, 'audit');
    assert.equal(child.maxSteps, 12);
    assert.deepEqual(child.toolAllowlist, ['rag.search']);
    assert.equal(child.approvalPolicy, 'approve_all_mcp');
    assert.deepEqual(child.networkPolicy, { enabled: false });
    assert.throws(
        () => resolveChildDelegationConstraints(parent, { toolAllowlist: ['agent.http'] }),
        error => error.code === 'AGENT_DELEGATION_TOOL_ALLOWLIST_DISJOINT'
    );
    assert.throws(
        () => resolveChildDelegationConstraints(parent, { modelId: 9 }),
        error => error.code === 'AGENT_DELEGATION_MODEL_ESCALATION'
    );
    assert.throws(
        () => resolveChildDelegationConstraints(parent, { runMode: 'deep' }),
        error => error.code === 'AGENT_DELEGATION_RUN_MODE_ESCALATION'
    );
    const tightened = resolveChildDelegationConstraints({ ...parent, parentToolPolicy: 'all', parentApprovalPolicy: 'approve_all_mcp' }, { toolPolicy: 'builtin_only', approvalPolicy: 'safe_mcp_auto' });
    assert.equal(tightened.toolPolicy, 'builtin_only');
    assert.equal(tightened.approvalPolicy, 'approve_all_mcp');
});

test('preset collaboration roles are enforced as monotonic runtime policies', () => {
    const parent = {
        parentModelId: 8, parentRunMode: 'standard', parentMaxSteps: 40, parentMaxTokenBudget: 80000,
        parentToolPolicy: 'all', parentToolAllowlist: [], parentApprovalPolicy: 'approve_all_mcp', parentNetworkPolicy: { enabled: true }
    };
    const reviewer = resolveChildDelegationConstraints(parent, {
        role: 'reviewer', toolPolicy: 'all', approvalPolicy: 'approve_all_mcp', maxSteps: 30, maxTokenBudget: 60000
    });
    assert.equal(reviewer.toolPolicy, 'builtin_only');
    assert.equal(reviewer.approvalPolicy, 'approve_all_mcp');
    assert.equal(reviewer.maxSteps, 8);
    assert.equal(reviewer.maxTokenBudget, 20000);
    assert.deepEqual(reviewer.rolePolicy, {
        id: 'reviewer-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 8, maxTokenBudget: 20000
    });
    const custom = resolveChildDelegationConstraints(parent, { role: 'custom', maxTokenBudget: 90000 });
    assert.equal(custom.maxTokenBudget, 80000, '自定义角色也不能突破父级 Token 上限');
    assert.equal(custom.rolePolicy, null);
});

test('organization role policy snapshot can tighten a child without widening parent constraints', () => {
    const parent = {
        parentModelId: 8, parentRunMode: 'standard', parentMaxSteps: 40, parentMaxTokenBudget: 80000,
        parentToolPolicy: 'all', parentToolAllowlist: [], parentApprovalPolicy: 'approve_all_mcp', parentNetworkPolicy: { enabled: true },
        rolePolicies: { reviewer: { id: 'reviewer-org-v2', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 5, maxTokenBudget: 10000 } }
    };
    const reviewer = resolveChildDelegationConstraints(parent, { role: 'reviewer', maxSteps: 30, maxTokenBudget: 70000 });
    assert.deepEqual(reviewer.rolePolicy, { id: 'reviewer-org-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 5, maxTokenBudget: 10000 });
    assert.equal(reviewer.maxSteps, 5);
    assert.equal(reviewer.maxTokenBudget, 10000);
});

test('Supervisor join accepts only a completed child with an independent verified report and final answer', () => {
    assert.deepEqual(
        childJoinAcceptance({ status: 'completed', final_answer: '交付完成', verification_outcome_status: 'verified', handoff_status: 'acknowledged' }),
        { terminal: true, accepted: true, verificationOutcome: 'verified', handoffStatus: 'acknowledged', rejectionReason: '' }
    );
    const missingReport = childJoinAcceptance({ status: 'completed', final_answer: '交付完成' });
    assert.equal(missingReport.terminal, true);
    assert.equal(missingReport.accepted, false);
    assert.match(missingReport.rejectionReason, /VerificationReport/);
    const partial = childJoinAcceptance({ status: 'partial', final_answer: '部分结果', verification_outcome_status: 'partial' });
    assert.equal(partial.accepted, false);
    assert.match(partial.rejectionReason, /partial/);
    const pendingHandoff = childJoinAcceptance({ status: 'completed', final_answer: '交付完成', verification_outcome_status: 'verified', handoff_status: 'pending' });
    assert.equal(pendingHandoff.accepted, false);
    assert.match(pendingHandoff.rejectionReason, /尚未由 Supervisor 持久应用/);
    assert.equal(childJoinAcceptance({ status: 'completed', final_answer: '交付完成', verification_outcome_status: 'verified', handoff_status: 'delivered' }).accepted, false);
    assert.equal(childJoinAcceptance({ status: 'completed', final_answer: '交付完成' }, { taskVerification: { outcomeStatus: 'verified' }, collaboration: { handoffStatus: 'acknowledged' } }).accepted, false);
});

test('batch delegation route, completion handoff, and one-repair boundary remain explicit', () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '../server/routes/agent-delegation-batch.js'), 'utf8');
    const agentRoutes = fs.readFileSync(path.resolve(__dirname, '../server/routes/agents.js'), 'utf8');
    const collaboration = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-collaboration.js'), 'utf8');
    const state = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-runtime/run-state.js'), 'utf8');
    const tools = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-tools.js'), 'utf8');
    const delegationTools = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-tools-delegation.js'), 'utf8');
    const detail = fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-detail.js'), 'utf8');
    const actions = fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-actions.js'), 'utf8');

    assert.match(routes, /\/agents\/runs\/:id\/delegate\/batch/);
    assert.match(routes, /normalizeDelegationBatchInput/);
    assert.match(routes, /resolveChildDelegationConstraints\(context, task\)/);
    assert.match(agentRoutes, /resolveChildDelegationConstraints\(context, delegation\)/);
    assert.match(routes, /cancelAgentRun\(child\.id, req\.user\)/);
    assert.match(collaboration, /repairAttempt\s*\|\|\s*0\)\s*<\s*1/);
    assert.match(collaboration, /kind:\s*'delegation_completion'/);
    assert.match(collaboration, /sendAgentControlMessage/);
    assert.match(state, /recordCollaboratorCompletion\(runId, targetStatus\)/);
    assert.match(tools, /outputSchema: \{ type: 'object', description: '可选 JSON Schema/);
    assert.match(tools, /outputSchema: \{ type: 'object', description: '可选 JSON Schema/);
    assert.match(delegationTools, /AGENT_DELEGATE_OUTPUT_INVALID/);
    assert.match(detail, /data-agent-delegate-batch/);
    assert.match(actions, /delegateBatchFromAgentRun/);
    assert.match(actions, /\/delegate\/batch/);
});
