const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_DELEGATION_BATCH,
    normalizeDelegationBatchInput,
    normalizeDelegationInput,
    validateDelegationOutput
} = require('../server/services/agent-collaboration');

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

test('batch delegation route, completion handoff, and one-repair boundary remain explicit', () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '../server/routes/agent-delegation-batch.js'), 'utf8');
    const collaboration = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-collaboration.js'), 'utf8');
    const state = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-runtime/run-state.js'), 'utf8');
    const tools = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-tools.js'), 'utf8');
    const delegationTools = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-tools-delegation.js'), 'utf8');
    const detail = fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-detail.js'), 'utf8');
    const actions = fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-actions.js'), 'utf8');

    assert.match(routes, /\/agents\/runs\/:id\/delegate\/batch/);
    assert.match(routes, /normalizeDelegationBatchInput/);
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
