'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { queryOne, execute, transaction } = require('../server/db/client');
const taskFeedRepository = require('../server/repositories/chat-task-feed');
const { getChatTaskFeed, normalizeFeedOptions } = require('../server/services/chat-task-feed');
const { safeTaskText, approvalSummary, presentTaskEvent } = require('../server/services/chat-task-presentation');
const { recordAgentEvent } = require('../server/services/agent-event-log');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const { createStandaloneArtifact } = require('../server/services/agent-artifacts');
const { createCodeRendition } = require('../server/services/agent-code-renditions');
const { issueDownloadToken, consumeDownloadToken, openRenditionContent } = require('../server/services/agent-artifact-renditions');

async function fixture(status = 'running', metadata = {}) {
    const row = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const user = { ...row, tenant_id: 1 };
    const sessionId = crypto.randomUUID();
    const runId = `feed-${crypto.randomUUID()}`;
    await execute("INSERT INTO sessions (id,user_id,title) VALUES (?,?,'对话过程测试')", [sessionId, user.id]);
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata) VALUES (?,?,?,'数据整理','生成结果',?,?)", [runId, user.id, sessionId, status,
        JSON.stringify({ chatBridge: { version: 1, sessionId }, ...metadata })]);
    return { user, sessionId, runId, async cleanup() {
        await execute('DELETE FROM agent_artifacts WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
    } };
}

test('进度参数拒绝非法游标、冲突方向和无界页大小', () => {
    for (const options of [{ after: '-1' }, { after: '1.2' }, { after: 'abc' }, { after: 0, before: 2 }, { limit: 0 }, { limit: 101 }]) {
        assert.throws(() => normalizeFeedOptions(options), error => error.status === 400);
    }
    assert.equal(normalizeFeedOptions({ after: '0', limit: '40' }).after, 0);
});

test('历史 UUID 产物与缺少版本指针字段仍能读取执行结果，账号归属不放宽', async () => {
    await transaction(async client => {
        await client.execute(`CREATE TEMP TABLE agent_artifacts (
            id UUID PRIMARY KEY, user_id VARCHAR(50), title TEXT, type TEXT, version INTEGER,
            status TEXT, run_id TEXT, updated_at TIMESTAMPTZ) ON COMMIT DROP`);
        await client.execute(`CREATE TEMP TABLE agent_artifact_versions (
            id UUID PRIMARY KEY, artifact_id UUID, version INTEGER) ON COMMIT DROP`);
        const artifactId = crypto.randomUUID();
        await client.execute("INSERT INTO pg_temp.agent_artifacts VALUES (?, '42', '历史结果', 'document', 3, 'active', 'old-run', NOW())", [artifactId]);
        const rows = await taskFeedRepository.listTaskArtifacts('old-run', 42, 1, client);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, artifactId);
        assert.equal(rows[0].version, 3);
        assert.equal((await taskFeedRepository.listTaskArtifacts('old-run', 43, 1, client)).length, 0);
    });
});

test('文件列表单独读取失败不会阻断任务状态、执行记录或停止能力', async () => {
    const result = await getChatTaskFeed('task-with-file-error', { id: 1 }, {}, {
        resolveTenantContext: async () => ({ tenantId: 1, resolvable: true }),
        repository: {
            getTaskSnapshot: async () => ({ id: 'task-with-file-error', user_id: 1, status: 'running', event_seq: 1, has_tool_events: true }),
            listTaskEvents: async () => [{ id: 1, event_seq: 1, event_type: 'tool.started', payload: { tool: 'db.read', operationKey: 'read' } }],
            listTaskArtifacts: async () => { throw Object.assign(new Error('模拟产物列表异常'), { code: '42703' }); }
        }
    });
    assert.equal(result.run.status, 'running');
    assert.equal(result.events.length, 1);
    assert.equal(result.warnings[0].code, 'ARTIFACTS_UNAVAILABLE');
});

test('对话事件和审批摘要隐藏凭据、路径与原始推理，只保留事实字段', () => {
    const text = safeTaskText('password=secret-value token=token-value Bearer abcdefghijklmnop postgresql://u:p@db/internal');
    assert.doesNotMatch(text, /secret-value|token-value|abcdefghijklmnop|u:p/);
    assert.doesNotMatch(safeTaskText('文件 C:\\Users\\Private\\secret.txt'), /Users|Private|secret\.txt/);
    assert.equal(presentTaskEvent({ event_type: 'model.delta', payload: { content: '不能公开的内部内容' } }), null);
    const approval = approvalSummary({ tool: 'terminal.runtime', inputHash: 'hash', input: {
        action: 'exec', command: 'python', args: ['token=hidden'], cwd: 'C:\\Users\\Private', password: 'private' }
    });
    const encoded = JSON.stringify(approval);
    assert.doesNotMatch(encoded, /private|token=hidden|C:\\/i);
    assert.equal(approval.title, '运行命令');
    assert.equal(approval.location, '隔离执行环境');
    assert.equal(presentTaskEvent({ id: 'denied', event_seq: 1, event_type: 'tool.denied', payload: { tool: 'workspace.patch' } }).status, 'denied');
    assert.equal(presentTaskEvent({ id: 'uncertain', event_seq: 2, event_type: 'tool.failed', payload: { tool: 'message.send', outcomeMayBeUncertain: true } }).status, 'uncertain');
});

test('轻量任务进度按账号和有效来源会话隔离，并且隐藏模型事件后游标仍前进', async () => {
    const value = await fixture('running', { chatHistory: [{ content: '不得返回的完整历史' }] });
    try {
        const event = (type, payload = {}) => recordAgentEvent({ runId: value.runId, userId: value.user.id, type, payload });
        await event('model.delta', { content: '不得返回的原始模型输出' });
        await event('tool.requested', { tool: 'terminal.runtime', action: 'exec', operationKey: 'one' });
        await event('tool.started', { tool: 'terminal.runtime', action: 'exec', operationKey: 'one' });
        await event('model.delta', { content: 'token=provider-private' });
        await event('tool.completed', { tool: 'terminal.runtime', action: 'exec', operationKey: 'one', durationMs: 1250 });
        const initial = await getChatTaskFeed(value.runId, value.user, { limit: 2 });
        assert.equal(initial.events.length, 2);
        assert.equal(initial.older.hasMore, true);
        assert.equal(initial.events[1].status, 'completed');
        assert.equal(initial.events[1].durationMs, 1250);
        assert.doesNotMatch(JSON.stringify(initial), /不得返回|provider-private|chatHistory/);
        const older = await getChatTaskFeed(value.runId, value.user, { before: initial.older.before, limit: 2 });
        assert.equal(older.events[0].status, 'preparing');
        const hidden = await event('model.delta', { content: '后续隐藏事件' });
        const delta = await getChatTaskFeed(value.runId, value.user, { after: initial.nextAfter });
        assert.equal(delta.events.length, 0);
        assert.equal(delta.nextAfter, Number(hidden.event_seq));
        assert.equal(await getChatTaskFeed(value.runId, { id: Number(value.user.id) + 999999 }), null);
        await assert.rejects(getChatTaskFeed(value.runId, value.user, { after: delta.nextAfter + 1 }), error => error.status === 409);
        await execute('UPDATE sessions SET deleted_at = NOW() WHERE id = ?', [value.sessionId]);
        assert.equal(await getChatTaskFeed(value.runId, value.user), null);
    } finally { await value.cleanup(); }
});

test('历史步骤可分页回看，规划内容不作为内部推理公开', async () => {
    const value = await fixture('needs_input');
    try {
        for (let index = 1; index <= 5; index++) await execute("INSERT INTO agent_steps (run_id,step_index,type,title,output,status) VALUES (?,?,'plan','内部推理标题',?,'success')", [value.runId, index, JSON.stringify({ thought: '不允许公开' })]);
        const feed = await getChatTaskFeed(value.runId, value.user, { limit: 2 });
        assert.equal(feed.legacySteps.length, 2);
        assert.equal(feed.older.hasMore, true);
        assert.equal(feed.pollAfterMs, null);
        assert.doesNotMatch(JSON.stringify(feed), /内部推理标题|不允许公开/);
        const older = await getChatTaskFeed(value.runId, value.user, { limit: 2, beforeStep: feed.older.beforeStep });
        assert.ok(older.legacySteps[1].legacyStepId < feed.legacySteps[0].legacyStepId);
        await recordAgentEvent({ runId: value.runId, userId: value.user.id, type: 'tool.denied', payload: { tool: 'workspace.patch', operationKey: 'denied-one' } });
        const denied = await getChatTaskFeed(value.runId, value.user);
        assert.equal(denied.legacySteps.length, 0);
        assert.equal(denied.events[0].status, 'denied');
    } finally { await value.cleanup(); }
});

test('实际关联产物可读取正确字节，过期后不再显示可下载，缺失核验不冒充通过', async () => {
    const value = await fixture('completed');
    try {
        const artifact = await createStandaloneArtifact(value.user, { type: 'code', title: '结果.txt', content: '实际生成的文件内容。' });
        await execute('UPDATE agent_artifacts SET run_id = ? WHERE id = ?', [value.runId, artifact.id]);
        const { rendition } = await createCodeRendition({ user: value.user, artifactId: artifact.id, filename: '结果.txt', content: '实际生成的文件内容。', language: 'txt', runId: value.runId });
        const feed = await getChatTaskFeed(value.runId, value.user);
        assert.equal(feed.artifacts.length, 1);
        assert.equal(feed.artifacts[0].rendition.ready, true);
        assert.equal(feed.verification.status, 'unknown');
        const issued = await issueDownloadToken(value.user, rendition.id);
        const authorized = await consumeDownloadToken(value.user, issued.token);
        const { stream } = await openRenditionContent(authorized, value.user);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString('utf8'), '实际生成的文件内容。');
        await execute('UPDATE agent_artifact_renditions SET expires_at = ? WHERE id = ?', ['2020-01-01 00:00:00', rendition.id]);
        assert.equal((await getChatTaskFeed(value.runId, value.user)).artifacts[0].rendition.ready, false);
    } finally { await value.cleanup(); }
});

test('真实工具开始、检查点复用、重试与暂存操作保持不同生命周期', async () => {
    const events = [];
    let release;
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ input, decision: 'allow' }),
        beginAgentToolCheckpoint: async () => ({ replay: false }), completeAgentToolCheckpoint: async () => {},
        failAgentToolCheckpoint: async () => true, issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => null, recordAgentEvent: async event => events.push(event.type)
    });
    const operation = orchestrator.execute({ run: { id: 'fixture-tool-run', user_id: 1 }, tool: { name: 'db.read', idempotent: true },
        execute: async () => { entered(); await barrier; return { count: 1 }; } });
    await ready;
    assert.ok(events.includes('tool.started'));
    assert.ok(!events.includes('tool.completed'));
    release();
    await operation;
    assert.ok(events.indexOf('tool.completed') > events.indexOf('tool.started'));
    const replayEvents = [];
    const replay = createToolOrchestrator({ enforceToolPolicy: ({ input }) => ({ input }),
        beginAgentToolCheckpoint: async () => ({ replay: true, output: '缓存结果' }),
        recordAgentEvent: async event => replayEvents.push(event.type) });
    assert.equal(await replay.execute({ run: { id: 'cached-run', user_id: 1 }, tool: { name: 'db.read' }, execute() { throw new Error('禁止重复执行'); } }), '缓存结果');
    assert.ok(replayEvents.includes('tool.replayed'));
    assert.ok(!replayEvents.includes('tool.started'));
    const stagedEvents = [];
    const staged = createToolOrchestrator({ enforceToolPolicy: ({ input }) => ({ input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }), completeAgentToolCheckpoint: async () => {},
        issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => ({ effect: { id: 'effect-one', effectType: 'send', status: 'staged' }, plan: { commitMode: 'approval' } }),
        recordAgentEvent: async event => stagedEvents.push(event.type) });
    assert.equal((await staged.execute({ run: { id: 'staged-run', user_id: 1 }, tool: { name: 'message.send' },
        execute() { throw new Error('外部操作在提交前不能执行'); } })).staged, true);
    assert.ok(stagedEvents.includes('transaction.effect_staged'));
    assert.ok(!stagedEvents.includes('tool.started'));
    const retryEvents = [];
    let attempt = 0;
    const retry = createToolOrchestrator({ enforceToolPolicy: ({ input }) => ({ input }),
        beginAgentToolCheckpoint: async () => ({ replay: false, attempt: ++attempt }), completeAgentToolCheckpoint: async () => {},
        failAgentToolCheckpoint: async () => true, issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => null, recordAgentEvent: async event => retryEvents.push(event) });
    const request = { run: { id: 'retry-run', user_id: 1 }, tool: { name: 'db.query', idempotent: true }, context: { operationKey: 'retry-operation' } };
    await assert.rejects(retry.execute({ ...request, execute() { throw new Error('首次读取失败'); } }));
    await retry.execute({ ...request, execute: async () => ({ rows: [{ secret: '不会进入事件' }] }) });
    const starts = retryEvents.filter(event => event.type === 'tool.started');
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].eventKey, starts[1].eventKey);
    const done = retryEvents.find(event => event.type === 'tool.completed');
    assert.match(done.payload.resultSummary, /1 条记录/);
    assert.doesNotMatch(JSON.stringify(done.payload), /不会进入事件/);
});
