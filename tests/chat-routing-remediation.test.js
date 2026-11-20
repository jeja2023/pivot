'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { queryOne, query, execute } = require('../server/db/client');
const { createChatFixture, startChatRouteServer, startFakeUpstream, writeSseChunks, postChat } = require('./security-chat/chat-route-harness');
const { getDecisionFailureDetails } = require('../server/services/decision-failure-details');
const { flushPendingDecisionObservability } = require('../server/services/decision-observability');
const { recordModelTokenUsage } = require('../server/services/models');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');

async function insertTask(fixture, title, status = 'running', hours = 0, capabilities = []) {
    const id = randomUUID();
    await execute(`INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?::jsonb,NOW() - (?::int * INTERVAL '1 hour'),NOW())`,
    [id, fixture.userId, fixture.sessionId, title, title, status, JSON.stringify({ chatBridge: {}, capabilityConstraints: { present: true, capabilities } }), hours]);
    return id;
}

function replyToChat(req, res, { intent, intentStatus = 200, track = () => {} } = {}) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        const input = JSON.parse(body);
        const isIntent = input.messages?.some(message => String(message.content).includes('你是对话下一步决策器'));
        track(isIntent ? 'intent' : 'answer');
        if (input.stream) return writeSseChunks(res, { chunks: ['合成回答'] });
        const content = isIntent ? JSON.stringify(intent) : '合成回答';
        res.writeHead(isIntent ? intentStatus : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(intentStatus !== 200 && isIntent ? { error: { message: '合成模型拒绝请求' } } : { choices: [{ message: { content } }] }));
    });
}

const directIntent = { action: 'direct_answer', objective: '核对合成材料', routing: { knowledge: 'none', tools: 'none' } };
const currentStatus = async id => (await queryOne('SELECT status FROM agent_runs WHERE id = ?', [id])).status;

test('聊天按名称控制任务并查询全部活动记录，模型停用和额度用完也可停止或暂停', async () => {
    const fixture = createChatFixture({ prefix: 'task_control_gate' });
    const server = await startChatRouteServer({ fixture, agentExecutionEnabled: false });
    const send = (content, requestId = randomUUID()) => postChat(server.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content, clientRequestId: requestId });
    try {
        const target = await insertTask(fixture, '日报汇总', 'running', 24);
        const other = await insertTask(fixture, '资料整理', 'running', 20);
        for (let n = 0; n < 12; n++) await insertTask(fixture, '已归档资料', 'completed', 2);
        await execute("UPDATE models SET status = 'disabled' WHERE id = ?", [fixture.modelId]);
        const first = await send('停止当前任务');
        assert.ok(first.events.some(event => event.content?.includes('指出要停止的任务名称')));
        const unknown = await send('停止「其他任务」');
        assert.ok(unknown.events.some(event => event.content?.includes('没有找到这个活动任务')));
        assert.equal(await currentStatus(target), 'running');
        const requestId = randomUUID();
        const result = await send('请停止日报汇总任务', requestId);
        assert.ok(result.events.some(event => event.content?.includes('已停止')));
        assert.equal(await currentStatus(target), 'cancelled');
        assert.equal(await currentStatus(other), 'running');
        assert.ok((await send('请停止日报汇总任务', requestId)).events.some(event => event.content?.includes('已停止')));
        const duplicate = await insertTask(fixture, '资料整理');
        const ambiguous = await send('暂停「资料整理」任务');
        assert.ok(ambiguous.events.some(event => event.content?.includes('多项活动任务使用此名称')));
        assert.equal(await currentStatus(other), 'running');
        assert.equal(await currentStatus(duplicate), 'running');
        await send('stop "' + duplicate + '"');
        assert.equal(await currentStatus(duplicate), 'cancelled');
        await execute("UPDATE models SET status = 'active', daily_token_limit = 1 WHERE id = ?", [fixture.modelId]);
        await recordModelTokenUsage(fixture.userId, fixture.modelId, 2, 'chat');
        const paused = await send('暂停当前任务');
        assert.ok(paused.events.some(event => event.content?.includes('已暂停')));
        assert.equal(await currentStatus(other), 'needs_input');
    } finally { await server.close(); fixture.cleanup(); }
});

test('行内代码和围栏代码仅用于解释，独立撤销指令才修改活动任务', async () => {
    const upstream = await startFakeUpstream({ handler: (req, res) => replyToChat(req, res, { intent: directIntent }) });
    const fixture = createChatFixture({ prefix: 'task_control_quote', upstreamUrl: upstream.url });
    const server = await startChatRouteServer({ fixture });
    try {
        const runId = await insertTask(fixture, '整理合成材料', 'running', 0, ['network.web_search']);
        const send = content => postChat(server.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content });
        const scope = async () => (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])).metadata.capabilityConstraints;
        for (const input of ['请解释 `不要联网` 这句话的含义。', '请解释下列内容。\n```\n不要联网\n```', '请解释 ``不要联网``。']) {
            assert.equal((await send(input)).errorEvent, undefined);
            assert.equal((await scope()).excludeWeb, undefined);
        }
        assert.equal((await query('SELECT message_type FROM agent_control_messages WHERE to_run_id = ?', [runId])).length, 0);
        await send('不要联网。');
        assert.equal((await scope()).excludeWeb, true);
        assert.deepEqual((await query('SELECT message_type FROM agent_control_messages WHERE to_run_id = ?', [runId])).map(row => row.message_type), ['steer']);
    } finally { await server.close(); await upstream.close(); await flushPendingDecisionObservability(); fixture.cleanup(); }
});

test('影子判断成功或故障都保留用户显式检索，真实来源排除优先', async () => {
    const originalMode = process.env.PIVOT_CHAT_INTENT_MODE;
    const originalRouteShadow = process.env.PIVOT_CHAT_ROUTE_SHADOW_MODE;
    process.env.PIVOT_CHAT_INTENT_MODE = 'shadow';
    process.env.PIVOT_CHAT_ROUTE_SHADOW_MODE = 'false';
    let intentStatus = 200;
    let lookups = 0;
    const requests = [];
    const upstream = await startFakeUpstream({ handler: (req, res) => replyToChat(req, res, { intent: directIntent, intentStatus, track: request => requests.push(request) }) });
    const fixture = createChatFixture({ prefix: 'route_shadow', upstreamUrl: upstream.url });
    const server = await startChatRouteServer({ fixture, isRagEnabled: () => true, retrieveContext: async () => { lookups++; return { text: '', hits: [] }; } });
    try {
        for (const testCase of [{ mode: 'shadow', status: 200 }, { mode: 'shadow', status: 401 }, { mode: 'active', status: 401, shadow: true }]) {
            process.env.PIVOT_CHAT_INTENT_MODE = testCase.mode;
            process.env.PIVOT_CHAT_ROUTE_SHADOW_MODE = String(Boolean(testCase.shadow));
            intentStatus = testCase.status;
            const before = lookups;
            const response = await postChat(server.port, { sessionId: fixture.sessionId, modelId: fixture.modelId,
                content: '请依据公司资料查找审核要求。', ragPreference: 'enabled', routeOverrides: { forceRag: true } });
            assert.equal(response.errorEvent, undefined);
            assert.ok(lookups > before);
        }
        assert.equal(requests.filter(kind => kind === 'intent').length, 3);
        const before = lookups;
        await postChat(server.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content: '不要检索知识库。',
            ragPreference: 'enabled', routeOverrides: { forceRag: true } });
        assert.equal(lookups, before);
    } finally {
        if (originalMode === undefined) delete process.env.PIVOT_CHAT_INTENT_MODE; else process.env.PIVOT_CHAT_INTENT_MODE = originalMode;
        if (originalRouteShadow === undefined) delete process.env.PIVOT_CHAT_ROUTE_SHADOW_MODE; else process.env.PIVOT_CHAT_ROUTE_SHADOW_MODE = originalRouteShadow;
        await server.close(); await upstream.close(); await flushPendingDecisionObservability(); fixture.cleanup();
    }
});

test('同轮的意图与下一步审计使用可信租户，历史读取超时只登记一条脱敏错误', async () => {
    const upstream = await startFakeUpstream({ handler: (req, res) => replyToChat(req, res, { intent: { ...directIntent, routing: { knowledge: 'required', tools: 'none' } } }) });
    const fixture = createChatFixture({ prefix: 'route_tenant', upstreamUrl: upstream.url });
    const server = await startChatRouteServer({ fixture, agentExecutionEnabled: true });
    const slug = randomUUID();
    const org = await queryOne("INSERT INTO organizations (name,slug,status) VALUES ('合成组织',?,'active') RETURNING id", [slug]);
    const team = await queryOne("INSERT INTO teams (organization_id,name,slug,status) VALUES (?,'合成团队',?,'active') RETURNING id", [org.id, slug]);
    try {
        await execute("INSERT INTO team_members (team_id,user_id,role,status) VALUES (?,?,'member','active')", [team.id, fixture.userId]);
        const response = await postChat(server.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content: '请查询公司内部审核制度。', ragPreference: 'auto' });
        assert.equal(response.errorEvent, undefined);
        await flushPendingDecisionObservability();
        const before = await query('SELECT scenario,tenant_id FROM decision_records WHERE user_id = ? AND session_id = ?', [fixture.userId, fixture.sessionId]);
        assert.equal(before.filter(row => row.scenario === 'chat.execution').length, 2);
        assert.ok(before.some(row => row.scenario === 'chat.next_step'));
        assert.ok(before.every(row => Number(row.tenant_id) === Number(org.id)));
        const decision = await decideAutomaticChatExecution({ user: fixture.user, userId: fixture.userId, sessionId: fixture.sessionId,
            modelContent: '请核对合成资料中的交付明细。', sessionsRepository: { listMessages: () => new Promise(() => {}) }
        }, { config: { mode: 'active', rolloutPercent: 100, timeoutMs: 120 } });
        assert.equal(decision.failureStage, 'history');
        assert.equal(decision.textOnlyFallback, true);
        await flushPendingDecisionObservability();
        const details = await getDecisionFailureDetails({ kind: 'provider', limit: 100 });
        const events = details.items.filter(item => item.decisionId === decision.decisionId);
        assert.equal(events.length, 1);
        assert.equal(events[0].reasonCode, 'intent_timeout');
        assert.equal(events[0].failureStage, 'history');
        assert.ok(events[0].timing.historyMs > 0);
        assert.equal(JSON.stringify(events).includes('合成资料中的交付明细'), false);
    } finally {
        await server.close(); await upstream.close(); fixture.cleanup();
        await execute('DELETE FROM organizations WHERE id = ?', [org.id]);
    }
});
