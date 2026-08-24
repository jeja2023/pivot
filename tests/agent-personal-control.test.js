const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentProfileContext, normalizeAgentProfile } = require('../server/services/agent-profile');
const { classifyMemory, normalizeMemoryGovernance, parsePolicy } = require('../server/services/memory-governance');
const { normalizeProposalInput } = require('../server/services/agent-evolution');
const { serializeFeedback } = require('../server/services/agent-feedback');

test('personal Agent profile is normalized into bounded, explicit fields', () => {
    const profile = normalizeAgentProfile({
        displayName: '  林工  ',
        workHabits: ['先列结论', '先列结论', 'x'.repeat(300)],
        communicationStyle: { tone: 'concise' },
        memoryPolicy: { blockedCategories: ['fact', 'invalid'] }
    });
    assert.equal(profile.displayName, '林工');
    assert.deepEqual(profile.workHabits.slice(0, 2), ['先列结论', 'x'.repeat(120)]);
    assert.equal(profile.communicationStyle.tone, 'concise');
    assert.deepEqual(profile.memoryPolicy.blockedCategories, ['fact']);
    assert.match(buildAgentProfileContext(profile), /PIVOT_AGENT_PROFILE_BEGIN/);
});

test('memory governance classifies sensitive data and temporary context safely', () => {
    assert.equal(classifyMemory({ type: 'episode', content: '本轮讨论的临时上下文' }), 'temporary');
    assert.equal(classifyMemory({ type: 'fact', content: 'password: secret-value' }), 'sensitive');
    assert.equal(normalizeMemoryGovernance({ type: 'episode' }).retentionMode, 'session');
    assert.equal(parsePolicy({ blockedCategories: ['preference', 'unknown'] }).blockedCategories.length, 1);
});

test('evolution proposals require a supported kind and structured change', () => {
    assert.deepEqual(normalizeProposalInput({ kind: 'preference', title: '默认简洁', proposedChange: { communicationStyle: { verbosity: 'concise' } } }).kind, 'preference');
    assert.throws(() => normalizeProposalInput({ kind: 'code', title: '越权', proposedChange: {} }), /只能是/);
});

test('feedback serialization keeps correction and tool failure signals', () => {
    const feedback = serializeFeedback({ id: 1, user_id: 2, run_id: 'run-1', outcome: 'success', rating: 5, correction: '补充来源', tool_failures: '[{"tool":"rag.search","count":2}]', metadata: '{}', source: 'user' });
    assert.equal(feedback.outcome, 'success');
    assert.equal(feedback.toolFailures[0].tool, 'rag.search');
    assert.equal(feedback.correction, '补充来源');
});
