'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    compactAgentContextMessages,
    evaluateSemanticCompactionRetention
} = require('../server/services/agent-context-semantic-compression');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-context-compression-regression.json'), 'utf8'));

function stateFor(fixture) {
    return {
        goal: fixture.goal,
        constraints: fixture.constraints.map((text, index) => ({ id: `${fixture.id}-c${index + 1}`, text, status: 'active' })),
        pendingWork: fixture.pendingWork.map((text, index) => ({ id: `${fixture.id}-p${index + 1}`, text, status: 'pending' })),
        decisions: [{ id: `${fixture.id}-d1`, text: '按受控流程执行', status: 'active' }],
        evidence: fixture.evidenceRefs.map((rawOutputRef, index) => ({ id: `${fixture.id}-e${index + 1}`, text: '原始证据已存入受控存储', rawOutputRef, status: 'observed' }))
    };
}

function messagesFor(fixture) {
    const history = Array.from({ length: 15 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `第 ${index + 1} 轮历史：${fixture.constraints.join('；')}。${'低价值叙述 '.repeat(420)}`
    }));
    const observations = Array.from({ length: 9 }, (_, index) => ({
        role: 'assistant',
        content: [
            'PIVOT_MCP_TOOL_RESULT_BEGIN',
            `执行观察 ${index + 1}：`,
            JSON.stringify({
                step: index + 1,
                tool: 'workspace.search',
                output: {
                    text: `${fixture.goal} 的工具大输出：${'扫描数据 '.repeat(1800)}`,
                    rawOutputRef: fixture.evidenceRefs[0]
                }
            }),
            'PIVOT_MCP_TOOL_RESULT_END'
        ].join('\n')
    }));
    return [
        { role: 'system', content: '系统策略：遵守权限和审批。' },
        ...history,
        ...observations,
        { role: 'user', content: fixture.goal }
    ];
}

test('frozen semantic-context regression set retains hard facts and evidence references', () => {
    const reports = fixtures.map(fixture => {
        const state = stateFor(fixture);
        const result = compactAgentContextMessages(messagesFor(fixture), { inputBudget: 6000, taskWorkingState: state });
        const report = evaluateSemanticCompactionRetention(result, state, fixture);
        assert.equal(report.passed, true, `${fixture.id}: ${report.issues.join(', ')}`);
        assert.equal(report.blockingLoss, false, fixture.id);
        assert.equal(report.constraintRetentionRate, 1, fixture.id);
        assert.equal(report.pendingRetentionRate, 1, fixture.id);
        assert.equal(report.evidenceReferenceRetentionRate, 1, fixture.id);
        return report;
    });
    const constraintRetention = reports.reduce((sum, report) => sum + report.constraintRetentionRate, 0) / reports.length;
    const blockingLosses = reports.filter(report => report.blockingLoss).length;
    assert.ok(constraintRetention >= 0.98, `约束保持率 ${constraintRetention} 未达到冻结回归门槛`);
    assert.equal(blockingLosses, 0, '冻结回归集不得丢失阻塞项');
});
