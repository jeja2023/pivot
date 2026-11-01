'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCapabilityDecision } = require('../server/services/chat-capability-decision');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
const { verifyTaskOutcome } = require('../server/services/agent-verification');

test('绘图网络能力本身不强制外部文献，检索与用户明确要求仍需证据', () => {
    const options = { action: 'agent_run', capabilities: ['network.request'], availability: {} };
    assert.equal(normalizeCapabilityDecision({ routing: { tools: 'task' } }, options).requireEvidence, false);
    assert.equal(normalizeCapabilityDecision({ routing: { knowledge: 'required' } }, options).requireEvidence, true);
    assert.equal(normalizeCapabilityDecision({ acceptance: { requireEvidence: true } }, options).requireEvidence, true);
    assert.equal(normalizeCapabilityDecision({}, { ...options, capabilities: ['network.web_search'] }).requireEvidence, true);
});

test('受控文件和语义验收分别验证，工具输出中的伪造文件名不能代替实际文件', async () => {
    const contract = { deliverables: ['流程图图片'], acceptance: { artifactRequired: true, requireSemanticVerification: true } };
    const input = { run: { id: 'run', model_id: 1 }, user: { id: 5 }, contract, answer: '已生成流程图', observations: [{ output: { artifactId: 1, title: '模型声称的文件' } }] };
    const absent = await verifyAutomaticTask(input, { readyRunArtifacts: async () => [], getModel: async () => { throw new Error('无文件不应调用模型'); } });
    assert.equal(absent.reason, 'artifact_not_materialized');
    assert.ok(verifyTaskOutcome({ taskContract: contract, answer: input.answer, observations: input.observations, semanticVerification: absent }).hardFailures.includes('artifact_required'));
    let prompt;
    const actual = await verifyAutomaticTask(input, { readyRunArtifacts: async () => [{ id: 13, title: '结构图', format: 'svg', content_digest: 'abcd' }], getModel: async () => ({}),
        callModelJson: async (_model, messages) => { prompt = JSON.parse(messages[1].content); return { passed: true, coveredDeliverables: ['流程图图片'], missing: [] }; } });
    assert.equal(prompt.verifiedArtifacts[0].id, 13);
    assert.equal(verifyTaskOutcome({ taskContract: contract, answer: input.answer, semanticVerification: actual }).outcomeStatus, 'verified');
    const unavailable = { ...actual, passed: false, reason: 'verifier_unavailable' };
    const report = verifyTaskOutcome({ taskContract: contract, answer: input.answer, semanticVerification: unavailable });
    assert.equal(report.hardFailures.includes('artifact_required'), false);
    assert.equal(report.hardFailures.includes('deliverables_verified'), true);
});
