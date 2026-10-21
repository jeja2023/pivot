'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { query, queryOne, execute } = require('../server/db/client');
const ledger = require('../server/repositories/chat-conversation-turns');
const { continueConversationTask, getConversationTasks } = require('../server/services/chat-task-continuation');
const { listChatAgentRunsForSession } = require('../server/services/chat-agent-bridge');
const { sendAgentControlMessage, claimAgentControlMessages } = require('../server/services/agent-control');
const { handleChatMemoryRequest } = require('../server/services/chat-memory-actions');
const { retrieveLongTermMemories, listMemories, upsertMemory } = require('../server/services/long-term-memory');
const { selectLearningExamples } = require('../server/services/agent-learning-evaluation');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { buildToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');
const { getAgentLearningSettings, updateAgentLearningSettings } = require('../server/services/agent-learning');
const learningRepository = require('../server/repositories/agent-learning-evaluation');
const { assertMemoryWriteGate } = require('../server/services/long-term-memory/memory-gate');
const { executeChatSource } = require('../server/services/chat-source-tool');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
const { saveAssistantMessage } = require('../server/services/chat-messages');
const { createTaskTransaction, transitionTaskTransaction, recordTaskTransactionVerification, getTaskTransactionForUser } = require('../server/services/agent-task-transactions');

async function fixture(prefix) {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const suffix = `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    await execute('INSERT INTO sessions (id,user_id,title,created_at) VALUES (?,?,?,NOW())', [suffix, user.id, '对话产品回归']);
    return { user, sessionId: suffix, suffix };
}

test('旧版多层续跑链只展示最新任务，验收状态也可恢复显示且保持用户隔离', async () => {
    const { user, sessionId, suffix } = await fixture('continuation-cards');
    const ids = [0, 1, 2].map(index => `resume-${index}-${suffix}`);
    for (let index = 0; index < ids.length; index += 1) {
        const metadata = { chatBridge: { version: 1, sessionId }, ...(index ? { resumedFromRunId: ids[index - 1] } : {}) };
        await execute("INSERT INTO agent_runs (id,user_id,session_id,parent_run_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,'知识问答','检索资料',?,?::jsonb,NOW(),NOW())", [ids[index], user.id, sessionId, ids[index - 1] || null, index === 2 ? 'verifying' : 'needs_input', JSON.stringify(metadata)]);
    }
    assert.deepEqual((await getConversationTasks(sessionId, user.id)).map(run => run.id), [ids[2]]);
    assert.deepEqual((await listChatAgentRunsForSession(sessionId, user.id)).map(run => run.id), [ids[2]]);
    assert.equal((await listChatAgentRunsForSession(sessionId, user.id + 99999)).length, 0);
    assert.equal(await ledger.findTaskContinuation(ids[0], user.id + 99999), null);
});

test('并发请求、租约失效和内容冲突均保持用户消息幂等', async () => {
    const { user, sessionId } = await fixture('turn-idempotency');
    const input = { userId: user.id, sessionId, requestKey: 'retry-one', inputHash: 'a'.repeat(64), content: '请求幂等测试', modelId: null };
    const [left, right] = await Promise.all([ledger.claimTurn(input), ledger.claimTurn(input)]);
    assert.equal([left, right].filter(row => row.busy).length, 1);
    assert.equal(Number(left.user_message_id), Number(right.user_message_id));
    assert.equal((await query('SELECT id FROM messages WHERE session_id = ?', [sessionId])).length, 1);
    await assert.rejects(ledger.claimTurn({ ...input, inputHash: 'b'.repeat(64) }), error => error.code === 'CHAT_REQUEST_CONFLICT');
    const owner = left.busy ? right : left;
    await ledger.releaseTurn(owner);
    const recovered = await ledger.claimTurn(input);
    assert.equal(recovered.busy, undefined);
    assert.equal(Number(recovered.user_message_id), Number(owner.user_message_id));
    assert.equal(await ledger.updateTurn(owner, { status: 'completed' }), 0, '过期持有者不能更新新租约');
    await ledger.releaseTurn(recovered);
});

test('助手答案落库后进程中断，重试从消息唯一关联恢复且不会产生两份答案', async () => {
    const { user, sessionId } = await fixture('assistant-crash-recovery');
    const input = { userId: user.id, sessionId, requestKey: 'answer-recovery', inputHash: 'd'.repeat(64), content: '问答', modelId: null };
    const turn = await ledger.claimTurn(input);
    const options = { userId: user.id, sessionId, conversationTurnId: turn.id, content: '已完成的答案' };
    const [first, duplicate] = await Promise.all([saveAssistantMessage(options), saveAssistantMessage(options)]);
    assert.equal(first.lastInsertRowid, duplicate.lastInsertRowid);
    await ledger.releaseTurn(turn);
    const retry = await ledger.claimTurn(input);
    assert.equal(retry.replay, true);
    assert.equal(Number(retry.assistant_message_id), Number(first.lastInsertRowid));
    assert.equal((await ledger.replayTurn(retry)).content, '已完成的答案');
});

test('补充指令投递同一运行且可恢复，重复投递不重放；跨用户运行拒绝', async () => {
    const { user, sessionId, suffix } = await fixture('continuation');
    const runId = `run-${suffix}`;
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'needs_input',?,NOW(),NOW())", [runId, user.id, sessionId, '报告任务', '分析订单并交付报告', JSON.stringify({ chatBridge: { version: 1, sessionId }, conversationTaskId: 'logical-task' })]);
    let queued = 0;
    const input = { decision: { continuationOf: runId }, user, sessionId, userMessageId: 234, instruction: '这次只给摘要，保留异常依据。' };
    const first = await continueConversationTask(input, { enqueueAgentRun: () => queued++ });
    const retry = await continueConversationTask(input, { enqueueAgentRun: () => queued++ });
    assert.equal(first.run.id, runId);
    assert.equal(retry.run.id, runId);
    assert.equal(first.conversationTaskId, 'logical-task');
    assert.equal(queued, 1);
    assert.equal((await query('SELECT id FROM agent_runs WHERE session_id = ?', [sessionId])).length, 1);
    const claimed = await claimAgentControlMessages(runId, user);
    assert.equal(claimed.length, 0, '等待输入任务在重新排队前已应用控制消息，不能再次领取');
    const row = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId]);
    const revised = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    assert.ok(revised.taskContract.constraints.includes(input.instruction));
    const other = await continueConversationTask({ ...input, user: { id: Number(user.id) + 9999 } });
    assert.equal(other.continued, false);
    await assert.rejects(sendAgentControlMessage({ user: { id: Number(user.id) + 9999 }, toRunId: runId, payload: { instruction: '非法' } }));
});

test('交付验收等待补充信息后，同一 Run 和无副作用事务可正确恢复', async () => {
    const { user, sessionId, suffix } = await fixture('verified-input-resume');
    const runId = `run-${suffix}`;
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'needs_input','{}',NOW(),NOW())", [runId, user.id, sessionId, '报告', '分析订单']);
    const transaction = await createTaskTransaction({ run: { id: runId, user_id: user.id, goal: '分析订单' }, user });
    await transitionTaskTransaction(transaction.id, user, 'executing');
    await recordTaskTransactionVerification(transaction.id, user, { outcomeStatus: 'needs_input', reason: '缺少统计口径' });
    await execute('UPDATE agent_runs SET metadata = ?::jsonb WHERE id = ?', [JSON.stringify({ chatBridge: { version: 1, sessionId }, taskTransactionId: transaction.id, taskContract: { goal: '分析订单' } }), runId]);
    const result = await continueConversationTask({ user, sessionId, userMessageId: 456, instruction: '按本月已付款订单统计，只给摘要', decision: { continuationOf: runId, objective: '分析本月已付款订单', deliverables: ['摘要'], constraints: ['仅统计已付款订单'], requiredCapabilities: ['data.query'] } }, { enqueueAgentRun() {} });
    assert.equal(result.continued, true);
    const resumed = await getTaskTransactionForUser(transaction.id, user);
    assert.equal(resumed.status, 'executing');
    assert.equal(resumed.taskContract.deliverables[0], '摘要');
    assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId])).status, 'queued');
});

test('自然偏好有来源和项目作用域，同类纠正替换旧值，遗忘立即生效', async () => {
    const { user, sessionId, suffix } = await fixture('preference');
    const message = await queryOne("INSERT INTO messages (session_id,user_id,role,content,created_at) VALUES (?,?,'user',?,NOW()) RETURNING id", [sessionId, user.id, '以后报告先列异常']);
    const projectId = `project:${suffix}`;
    const created = await handleChatMemoryRequest({ prompt: '以后报告先列异常，只用于当前项目', user, sessionId, projectId, userMessageId: message.id });
    assert.equal(created.stored, true);
    const list = await listMemories(user.id, { search: sessionId, status: 'active' });
    const memory = list.memories.find(item => item.factKey === 'preference:report:order');
    assert.equal(memory.scope, 'project');
    assert.equal(memory.projectId, projectId);
    assert.ok(memory.sourceMessageIds.map(Number).includes(Number(message.id)));
    assert.equal((await retrieveLongTermMemories(user.id, '报告先列异常', { sessionId, projectId: 'different-project' })).some(item => item.id === memory.id), false);
    const correction = await handleChatMemoryRequest({ prompt: '以后报告先给结论，只用于当前项目', user, sessionId, projectId, userMessageId: message.id });
    assert.equal(correction.stored, true);
    const revised = (await listMemories(user.id, { search: sessionId, status: 'active' })).memories;
    assert.equal(revised.some(item => Number(item.id) === Number(memory.id)), false);
    const forgotten = await handleChatMemoryRequest({ prompt: '忘掉刚才那个偏好', user, sessionId, projectId, userMessageId: message.id });
    assert.equal(forgotten.stored, true);
    assert.equal((await retrieveLongTermMemories(user.id, '报告先给结论', { sessionId, projectId })).some(item => item.factKey === 'preference:report:order'), false);
    const denied = await upsertMemory(user.id, { type: 'preference', content: '报告先给结论', sourceSessionId: sessionId, sourceMessageIds: [message.id] }, { user, skipEmbedding: true, origin: 'automatic' });
    assert.equal(denied.skipped, true, '遗忘来源不能被后台抽取重新建立');
});

test('关闭记忆时自然偏好只作用于当前回复，不能写入长期记录', async () => {
    let writes = 0;
    const result = await handleChatMemoryRequest({ prompt: '以后报告先列异常', user: { id: 1 }, sessionId: 's', userMessageId: 1 }, {
        isLongTermMemoryEnabled: async () => false, getMemoryPolicy: async () => ({ autoCapture: true }),
        applyMemoryIntent: async () => { writes++; }
    });
    assert.equal(result.stored, false);
    assert.equal(writes, 0);
});

test('运行中改为只规划立即暂停并收回能力，旧调度快照不能再写文件', async () => {
    const { user, sessionId, suffix } = await fixture('plan-only-revoke');
    const runId = `run-${suffix}`;
    const metadata = { chatBridge: { version: 1, sessionId }, automaticExecution: {}, capabilityConstraints: { present: true, capabilities: ['filesystem.write_workspace'] } };
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,NOW(),NOW())", [runId, user.id, sessionId, '代码任务', '修复项目代码', JSON.stringify(metadata)]);
    const result = await decideAutomaticChatExecution({ user, userId: user.id, sessionId, userMessageId: 1, agentExecutionAllowed: true, autoExecutionEnabled: true,
        modelContent: '这次先给修改方案，不要改代码', sessionsRepository: { listMessages: async () => [] } }, {
        retrieveLongTermMemories: async () => [], getConversationTasks: async () => [{ id: runId, active: true, status: 'running' }], resolveChatIntent: async () => ({ action: 'plan_only' })
    });
    assert.equal(result.action, 'plan_only');
    const current = await queryOne('SELECT status,metadata FROM agent_runs WHERE id = ?', [runId]);
    assert.equal(current.status, 'needs_input');
    const plan = await buildToolExecutionPlan({ run: { id: runId, metadata }, user,
        tool: { name: 'workspace.patch', source: 'builtin', capabilities: ['filesystem.write_workspace'], input_schema: { type: 'object' } }, input: {} });
    assert.equal(plan.policy.decision, 'denied');
    assert.ok(plan.policy.reasonCodes.includes('conversation_capability_scope'));
});

test('执行指标的首字时延与模型开销可查询，用户不能读取其他账号的指标', async () => {
    const { user, sessionId } = await fixture('execution-metrics');
    const turn = await ledger.claimTurn({ userId: user.id, sessionId, requestKey: 'metrics-check', inputHash: 'c'.repeat(64), content: '普通问题', modelId: null });
    await ledger.updateTurn(turn, { decision: { action: 'direct_answer', policyVersion: 'metrics-test', durationMs: 1 }, outcome: { firstContentMs: 12, routerModelCalls: 0, totalTokens: 20 } });
    const rows = await ledger.getExecutionMetrics(user.id);
    assert.ok(rows.some(row => row.policy_version === 'metrics-test' && Number(row.p95_first_content_ms) === 12 && Number(row.router_model_calls) === 0));
    assert.equal((await ledger.getExecutionMetrics(Number(user.id) + 99999)).length, 0);
    assert.equal(await ledger.currentExecutionScope('not-owned', Number(user.id) + 99999), null);
    await ledger.releaseTurn(turn);
});

test('首轮长附件按页读取真实消息，遗漏资料阻断完成，删除来源后不能继续读取', async () => {
    const { user, sessionId, suffix } = await fixture('long-attachment');
    const original = `分析附件并生成报告\n\n---\n【参考文档: 订单.txt】\n${'已授权订单数据。'.repeat(2500)}\n---`;
    const message = await queryOne("INSERT INTO messages (session_id,user_id,role,content,created_at) VALUES (?,?,'user',?,NOW()) RETURNING id", [sessionId, user.id, original]);
    let captured;
    const decision = await decideAutomaticChatExecution({ user, userId: user.id, sessionId, userMessageId: message.id, agentExecutionAllowed: true, autoExecutionEnabled: true,
        modelContent: original, sessionsRepository: { listMessages: async () => [{ ...message, role: 'user', content: original }] } }, {
        getConversationTasks: async () => [], retrieveLongTermMemories: async () => [], resolveChatIntent: async input => { captured = input; return { action: 'agent_run' }; }
    });
    assert.equal(decision.action, 'agent_run');
    assert.equal(captured.prompt, '分析附件并生成报告\n');
    assert.deepEqual(captured.providedSources, [{ kind: 'inline_attachment', name: '订单.txt', available: true, sourceMessageId: message.id }]);
    const runId = `run-${suffix}`;
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'planning',?,NOW(),NOW())", [runId, user.id, sessionId, '附件分析', '分析附件并生成报告', JSON.stringify({ chatBridge: { version: 1, sessionId, userMessageId: message.id } })]);
    const run = { id: runId };
    const contract = { deliverables: ['报告'], acceptance: { requireCompleteSource: true } };
    assert.equal((await verifyAutomaticTask({ run, user, contract, answer: '完成' })).reason, 'source_not_fully_read');
    let result = await executeChatSource({ offset: 0, limit: 8000 }, user, { run });
    let combined = result.text;
    while (result.nextOffset !== null) {
        result = await executeChatSource({ offset: result.nextOffset, limit: 8000 }, user, { run });
        combined += result.text;
    }
    assert.equal(combined, original);
    const verified = await verifyAutomaticTask({ run, user, contract, answer: '报告' }, { getModel: async () => ({}), callModelJson: async () => '{"passed":true,"coveredDeliverables":["报告"],"missing":[]}' });
    assert.equal(verified.passed, true);
    await assert.rejects(executeChatSource({}, { id: Number(user.id) + 999 }, { run }), error => error.code === 'CHAT_SOURCE_REVOKED');
    await execute('UPDATE messages SET deleted_at = NOW() WHERE id = ?', [message.id]);
    await assert.rejects(executeChatSource({}, user, { run }), error => error.code === 'CHAT_SOURCE_REVOKED');
    assert.equal((await verifyAutomaticTask({ run, user, contract, answer: '完成' })).reason, 'source_revoked');
});

test('经验评测排除来源、重复任务、无关工具和敏感证据', () => {
    const rows = [
        { id: 'source', goal: '原任务', final_answer: '完成', tools: ['a','b'] },
        { id: 'one', goal: '独立任务', final_answer: '核验结论', tools: ['a','b'] },
        { id: 'two', goal: '独立任务', final_answer: '核验结论', tools: ['a','b'] },
        { id: 'other', goal: '其他任务', final_answer: '结论', tools: ['c'] }
    ];
    assert.deepEqual(selectLearningExamples(rows, { tools: ['a','b'] }, 'source').map(row => row.id), ['one']);
});

test('关闭学习推进写入栅栏、立即阻止自动发布，并与正在发布的作业串行化', async () => {
    const { user } = await fixture('learning-gate');
    const original = await getAgentLearningSettings(user.id);
    await updateAgentLearningSettings(user.id, { autoLearning: true, autoActivate: true });
    const before = await assertMemoryWriteGate(user.id);
    let enter;
    let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const publishing = learningRepository.withLearningPublication(user.id, async () => { enter(); await barrier; return 'published'; });
    await entered;
    let disabled = false;
    const disable = updateAgentLearningSettings(user.id, { autoLearning: false }).then(() => { disabled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(disabled, false, '关闭与已开始的发布必须按顺序完成');
    release();
    assert.equal(await publishing, 'published');
    await disable;
    assert.equal((await getAgentLearningSettings(user.id)).autoLearning, false);
    assert.ok((await assertMemoryWriteGate(user.id)).gate.revision > before.gate.revision);
    assert.equal(await learningRepository.withLearningPublication(user.id, async () => 'unexpected'), null);
    await updateAgentLearningSettings(user.id, original);
});
