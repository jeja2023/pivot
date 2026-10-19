'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');

test('明确委托且具备多步骤交付物时自动进入受控 Agent 处理', () => {
    const decision = classifyChatAutoExecution({
        prompt: '请汇总本周订单，核对异常并生成一份风险报告。'
    });
    assert.equal(decision.action, 'agent_run');
    assert.equal(decision.reasonCode, 'explicit_delegated_task');
    assert.ok(decision.confidence >= 0.74);
    assert.equal(decision.intent, 'delegate');
    assert.equal(decision.nextAction, 'create_agent_run');
    assert.deepEqual(decision.evidenceRefs, ['current_message']);
    assert.equal(decision.allowMcp, false);
    const crmDecision = classifyChatAutoExecution({
        prompt: '请查询 CRM 中本周订单，核对异常并生成风险报告。'
    });
    assert.equal(crmDecision.allowMcp, true, '明确委托外部能力只开放已有授权能力候选，实际调用仍由运行时审批');
    assert.deepEqual(crmDecision.requiredCapabilities, ['data.read']);
});

test('探索、创作和明确只规划请求保持普通回答或计划路径', () => {
    assert.equal(classifyChatAutoExecution({ prompt: '解释一下如何分析订单异常。' }).action, 'direct_answer');
    assert.equal(classifyChatAutoExecution({ prompt: '写一封订单异常通知邮件。' }).action, 'direct_answer');
    assert.equal(classifyChatAutoExecution({ prompt: '先给出订单风险处理方案，不要执行。' }).action, 'plan_only');
});

test('有连续上下文的明确续接可自动恢复任务处理，但停用开关立即回退直答', () => {
    const decision = classifyChatAutoExecution({
        prompt: '继续按刚才的方案处理。',
        history: [{ role: 'user', content: '请汇总本周订单，核对异常并生成风险报告。' }]
    });
    assert.equal(decision.action, 'agent_run');
    assert.equal(decision.reasonCode, 'contextual_task_continuation');
    assert.equal(classifyChatAutoExecution({ prompt: '请汇总订单并生成报告。', enabled: false }).action, 'direct_answer');
});

test('自然语言停止指令路由到现有任务控制，而不是生成普通回答', () => {
    const decision = classifyChatAutoExecution({ prompt: '停止当前任务' });
    assert.equal(decision.action, 'control');
    assert.equal(decision.control, 'stop');
    assert.equal(
        classifyChatAutoExecution({ prompt: '停止当前任务的功能应该如何实现？' }).action,
        'direct_answer',
        '讨论任务控制功能不能误触取消正在运行的任务'
    );
});
