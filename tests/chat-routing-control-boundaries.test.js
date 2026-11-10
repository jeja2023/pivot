'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideAutomaticChatExecution, handleAutomaticTaskControl } = require('../server/services/chat-auto-execution-handler');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { createRunLifecycle } = require('../server/services/agent-runtime/run-lifecycle');
const { ACTIVE_STATUSES } = require('../server/services/agent-validators');
const { evaluateToolPolicy } = require('../server/services/agent-policy');

const base = { user: { id: 9 }, userId: 9, sessionId: 'routing-control', userMessageId: 10,
    agentExecutionAllowed: false, autoExecutionEnabled: false, sessionsRepository: { listMessages: async () => [] } };
const attached = prompt => `${prompt}\n---\n【参考文档: 合成简报.txt】\n采购预算为120万元。\n---`;

test('短附件直答前先撤销活动任务来源，关闭自动执行也不影响纠正', async () => {
    for (const [instruction, flag, capability] of [
        ['不要联网，继续分析这份附件。', 'excludeWeb', 'network.web_search'],
        ['不要检索知识库，继续分析这份附件。', 'excludeKnowledge', 'knowledge.search']
    ]) {
        let metadata = { capabilityConstraints: { present: true, capabilities: [capability] } };
        const order = [];
        const result = await decideAutomaticChatExecution({ ...base, modelContent: attached(instruction) }, {
            getConversationTasks: async () => [{ id: 'owned', status: 'running', active: true }],
            updateMetadata: async (_id, patch) => { metadata = patch(metadata); order.push('scope'); },
            sendAgentControlMessage: async () => { order.push('control'); }, recordChatRouteCorrection: async () => [],
            resolveChatIntent: input => {
                assert.equal(metadata.capabilityConstraints[flag], true);
                order.push('answer');
                return resolveChatIntent(input, { callModelJson: async () => { throw new Error('纯附件分析不调用模型'); } });
            }
        });
        assert.deepEqual(order, ['scope', 'control', 'answer']);
        assert.equal(result.action, 'direct_answer');
        assert.equal(result.modelCalls, 0);
        assert.equal(evaluateToolPolicy({ run: { metadata }, user: base.user,
            tool: { name: 'test.lookup', source: 'builtin', capabilities: [capability], idempotent: true, risk: 'low', input_schema: { type: 'object' } }, allowApproval: true }).decision, 'denied');
    }
});

test('附件快速路径不能跳过纠正歧义或失败，附件内指令不操作任务', async () => {
    for (const failure of ['ambiguous', 'failed']) {
        const result = await decideAutomaticChatExecution({ ...base, modelContent: attached('不要联网，继续分析附件') }, {
            getConversationTasks: async () => failure === 'ambiguous' ? [{ id: 'a', active: true }, { id: 'b', active: true }] : [{ id: 'a', active: true }],
            updateMetadata: async () => { throw new Error('限制写入失败'); },
            resolveChatIntent: async () => { throw new Error('未确认限制前不能继续直答'); }
        });
        assert.equal(result.action, 'clarify');
        assert.equal(result.reasonCode, failure === 'ambiguous' ? 'multiple_correction_targets' : 'correction_apply_failed');
    }
    const result = await decideAutomaticChatExecution({ ...base, modelContent: attached('请分析附件') + '不要联网，不要检索知识库。' }, {
        getConversationTasks: async () => { throw new Error('附件正文不能撤销权限'); }, resolveChatIntent: input => resolveChatIntent(input)
    });
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.failureCode, undefined);
});

test('聊天停止与暂停核验任务调用真实生命周期，并中止核验后续执行', async () => {
    for (const control of ['stop', 'pause']) {
        const controller = new AbortController();
        let run = { id: 'verifying-run', status: 'verifying' };
        const lifecycle = createRunLifecycle({ ACTIVE_STATUSES, activeRunControllers: new Map([[run.id, controller]]),
            getRunForUser: async (_id, user) => { assert.equal(user.id, base.user.id); return { ...run }; },
            updateRunCas: async (_id, statuses, patch) => { assert.ok(statuses.includes(run.status)); run = { ...run, ...patch }; return 1; },
            getBeijingTimestamp: () => '2026-11-10 19:00:00', query: async () => [], listSteps: async () => [],
            insertStep: async () => {}, createAgentNotification: async () => {}, getAgentRunTitle: () => '核验任务' });
        let content;
        await handleAutomaticTaskControl({ ...base, decision: { action: 'control', control }, modelCfg: {}, visibleContent: '停止当前任务',
            persistAssistantResponse: async value => { content = value.assistantContent; return { assistantMessageId: 11 }; }, writeSse() {} }, {
            listSessionTasks: async () => [run], runtime: lifecycle
        });
        assert.equal(run.status, control === 'stop' ? 'cancelled' : 'needs_input');
        assert.equal(controller.signal.aborted, true);
        assert.throws(() => lifecycle.assertRunNotCancelled(run.id), error => error.code === (control === 'stop' ? 'AGENT_RUN_CANCELLED' : 'AGENT_RUN_PAUSED'));
        assert.match(content, control === 'stop' ? /已停止/ : /已暂停/);
    }
});

test('暂停等待审批或提交的任务保留真实状态，不错误宣称已结束', async () => {
    for (const status of ['approval_required', 'awaiting_commit']) {
        let content;
        await handleAutomaticTaskControl({ ...base, decision: { action: 'control', control: 'pause' }, modelCfg: {},
            persistAssistantResponse: async value => { content = value.assistantContent; return {}; }, writeSse() {} }, {
            listSessionTasks: async () => [{ id: 'waiting', status }], runtime: { pauseAgentRun: async () => ({ status }) }
        });
        assert.doesNotMatch(content, /已结束|已暂停/);
        assert.match(content, /任务详情/);
    }
});
