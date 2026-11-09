'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildWorkingStatePrompt } = require('../server/services/agent-working-state');
const { workingMemoryPacket, evaluateSemanticCompactionRetention } = require('../server/services/agent-context-semantic-compression');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');

function fixture() {
    return { goal: '读取全部资料，核验后交付。', constraints: [{ id: 'permission', text: '只用已授权资料，写入前必须审批。', status: 'active' }],
        pendingWork: [{ id: 'report', text: '交付已核验报告', status: 'pending' }], decisions: [{ id: 'rule', text: '采用现行规则' }], evidence: [
            { id: 'discovery', source: 'tools.search', text: '重复搜索目录'.repeat(100), rawOutputRef: 'artifact-cas://' + 'a'.repeat(64) },
            { id: 'contract', source: 'tools.describe', text: '重复完整工具契约'.repeat(100), rawOutputRef: 'artifact-cas://' + 'b'.repeat(64) },
            { id: 'search-error', source: 'tools.search', text: '当前授权范围内未能找到目标工具，不能扩大范围。', status: 'error' },
            ...Array.from({ length: 16 }, (_, index) => ({ id: `part-${index}`, source: 'mcp.1.read', text: index ? `第${index}段金额${index * 7}` : '首段标记：松鹤合规紫檀；金额9。',
                rawOutputRef: 'artifact-cas://' + String(index).padStart(64, '0') }))
        ] };
}

test('任务摘要精简工具准备全文，保留全部业务事实、约束、交付和原文引用且不改持久状态', () => {
    const state = fixture(), original = globalThis.structuredClone(state);
    const prompt = buildWorkingStatePrompt(state);
    assert(!prompt.includes('重复搜索目录')); assert(!prompt.includes('重复完整工具契约'));
    assert.match(prompt, /不代表业务执行/);
    assert.match(prompt, /只用已授权资料，写入前必须审批/); assert.match(prompt, /交付已核验报告/); assert.match(prompt, /采用现行规则/);
    assert(prompt.includes(state.evidence[2].text));
    for (const evidence of state.evidence.filter(item => item.rawOutputRef)) assert(prompt.includes(evidence.rawOutputRef));
    for (const evidence of state.evidence.filter(item => item.source === 'mcp.1.read')) assert(prompt.includes(evidence.text));
    assert.deepEqual(state, original);
});

test('只在调用方已携带完全相同目标时去重，目标更正、差异和缺失仍完整呈现', () => {
    const state = fixture();
    assert(!buildWorkingStatePrompt(state, { coveredGoal: state.goal }).includes('目标：'));
    assert(!buildWorkingStatePrompt(state, { coveredGoal: ` \n${state.goal}\n ` }).includes('目标：'));
    for (const coveredGoal of ['', '读取部分资料，核验后交付。']) assert(buildWorkingStatePrompt(state, { coveredGoal }).includes(`目标：${state.goal}`));
    assert(buildWorkingStatePrompt({ ...state, goal: '用户已更正的目标。' }, { coveredGoal: state.goal }).includes('用户已更正的目标。'));
});

test('压缩事实包同步精简准备全文，全部证据引用和硬约束保留检查继续通过', () => {
    const state = fixture(), content = workingMemoryPacket(state);
    assert(!content.includes('重复完整工具契约')); assert(!content.includes('重复搜索目录'));
    assert.match(content, /松鹤合规紫檀/);
    const retention = evaluateSemanticCompactionRetention({ messages: [{ role: 'system', content }] }, state, { goal: state.goal });
    assert.equal(retention.passed, true, JSON.stringify(retention));
    assert.equal(retention.evidenceReferenceRetentionRate, 1); assert.equal(retention.constraintRetentionRate, 1);
});

test('JSON规划目标去重后仍在受保护的当前请求中，全部约束和早期业务事实仍可见', () => {
    const state = fixture();
    const messages = buildPlannerMessages(state.goal, [], [], 'standard', { taskWorkingState: state }, { max_input_tokens: 100000, max_tokens: 4096 });
    assert(messages.at(-1).content.includes(state.goal));
    const working = messages.find(message => message.content?.startsWith('PIVOT_TASK_WORKING_STATE_BEGIN'));
    assert(working); assert(!working.content.includes('目标：'));
    assert(working.content.includes(state.constraints[0].text)); assert(working.content.includes(state.evidence[3].text));
    const largeObservations = Array.from({ length: 9 }, () => ({ tool: 'read', output: { text: '无关背景'.repeat(5000) } }));
    const pressured = buildPlannerMessages(state.goal, [], largeObservations, 'standard', { taskWorkingState: state }, { max_input_tokens: 18000, max_tokens: 512 });
    const body = pressured.map(message => message.content).join('\n');
    assert.equal(pressured.contextCompaction.applied, true);
    assert(pressured.at(-1).content.includes(state.goal));
    assert(body.includes(state.constraints[0].text)); assert(body.includes(state.evidence[3].text));
});

test('只精简保留名称对应的成功准备项，业务输出、未知状态和失败原因不按文字内容猜测删除', () => {
    const state = { goal: '保留事实', evidence: [
        { source: 'mcp.1.tools.search', text: '业务资料含tools.search字样，但这是真实查询结果。', status: 'observed' },
        { source: 'tools.describe', text: '当前契约读取已被取消，不能继续执行。', status: 'cancelled' },
        { source: 'tools.search', text: '授权目录暂不可用，不能把空列表当作无工具。', status: 'error' }
    ] };
    const prompt = buildWorkingStatePrompt(state);
    for (const item of state.evidence) assert(prompt.includes(item.text));
});
