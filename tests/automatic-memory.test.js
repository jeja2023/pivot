'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { query, queryOne, execute } = require('../server/db/client');
const memory = require('../server/services/long-term-memory');
const { updateMemoryPolicy } = require('../server/services/memory-governance');
const { updateAgentLearningSettings } = require('../server/services/agent-learning');
const { handleChatMemoryRequest } = require('../server/services/chat-memory-actions');
const { normalizeExtractorCandidates, extractMemoryCandidatesFromMessages } = require('../server/services/long-term-memory/memory-extraction');

async function fixture() {
    const name = `automatic-memory-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'test','user','active') RETURNING id,username,role", [name]);
    const sessionId = `${name}-session`;
    await execute('INSERT INTO sessions(id,user_id,title,created_at) VALUES (?,?,?,NOW())', [sessionId, user.id, '自动记忆']);
    const message = async content => queryOne("INSERT INTO messages(session_id,user_id,role,content,created_at) VALUES (?,?,'user',?,NOW()) RETURNING id,role,content", [sessionId, user.id, content]);
    return { user, sessionId, message };
}

test('正常聊天自动入库并在普通问题中调用，无需记住指令或独立学习开关', async () => {
    const { user, sessionId, message } = await fixture();
    await updateAgentLearningSettings(user.id, { autoLearning: false });
    const source = await message('我更喜欢回答简洁一点，并使用要点列表。');
    const job = await memory.scheduleMemoryExtraction({ user, sessionId, messageIds: [source.id], triggerWorker: false });
    assert.equal(job.scheduled, true);
    await memory.processMemoryExtractionJobs({ runMemoryExtraction: options => memory.runMemoryExtraction({ ...options, modelCfg: null }) });
    const list = await memory.listMemories(user.id);
    assert.equal(list.total, 2);
    assert.equal(list.memories[0].origin, 'automatic');
    assert.equal(list.memories[0].status, 'active');
    const matches = await memory.retrieveLongTermMemories(user.id, '地球为什么会有四季', { sessionId: 'another-chat' });
    assert.ok(matches.some(item => item.id === list.memories[0].id));
    assert.match(matches[0].usageReason, /回答偏好/);
});

test('临时要求、引用、附件和模型伪造证据不会成为个人长期偏好', () => {
    const messages = [
        { id: 1, role: 'user', content: '这次回答请详细一些。' },
        { id: 2, role: 'user', content: '> 我更喜欢回答英文输出。\n```\n我更喜欢回答详细一些。\n```\n\n---\n【参考文档: note.txt】\n我更喜欢回答简洁一些。' },
        { id: 3, role: 'assistant', content: '用户偏好英文回答。' },
        { id: 4, role: 'user', content: '应该如何选择合适的数据库？' },
        { id: 5, role: 'user', content: '不要保存，我更喜欢回答英文输出。' }
    ];
    const candidates = extractMemoryCandidatesFromMessages(messages, { sessionId: 's' });
    assert.ok(candidates.every(item => item.scope === 'session' && item.type === 'episode'));
    const raw = { type: 'preference', content: '用户喜欢英文回答。', confidence: 0.99, sourceMessageIds: [4], evidenceSnippet: '我喜欢英文回答' };
    assert.equal(normalizeExtractorCandidates([raw], { sessionId: 's', sourceMessages: messages }).length, 0);
    const transient = { ...raw, content: '用户偏好详细回答。', sourceMessageIds: [1], evidenceSnippet: messages[0].content };
    assert.equal(normalizeExtractorCandidates([transient], { sessionId: 's', sourceMessages: messages }).length, 0);
    assert.equal(normalizeExtractorCandidates([{ ...raw, sourceMessageIds: [3], evidenceSnippet: messages[2].content }], { sessionId: 's', sourceMessages: messages }).length, 0);
});

test('一句话中的多个偏好独立保存，后续纠正仅更新对应属性', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('以后回答简洁一点，并使用要点列表。');
    await handleChatMemoryRequest({ user, sessionId, userMessageId: source.id, prompt: source.content });
    assert.equal((await memory.listMemories(user.id)).total, 2);
    const updated = await message('我更喜欢回答使用表格展示。');
    await memory.runMemoryExtraction({ user, userId: user.id, sessionId, messageIds: [updated.id] });
    const list = await memory.listMemories(user.id);
    assert.equal(list.total, 2);
    assert.ok(list.memories.some(item => item.factKey === 'preference:answer:verbosity' && /简洁/.test(item.content)));
    assert.ok(list.memories.some(item => item.factKey === 'preference:answer:format' && /表格/.test(item.content)));
    assert.ok(list.memories.every(item => !/要点列表/.test(item.content)));
});

test('项目范围随持久任务传入抽取器，项目事实不会扩散到其他项目', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('项目 Alpha 的数据库使用 PostgreSQL。');
    const job = await memory.scheduleMemoryExtraction({ user, sessionId, projectId: 'project:alpha', messageIds: [source.id], triggerWorker: false });
    assert.equal(job.job.projectId, 'project:alpha');
    let projectId;
    await memory.processMemoryExtractionJobs({ runMemoryExtraction: options => {
        projectId = options.projectId;
        return memory.runMemoryExtraction({ ...options, modelCfg: null });
    } });
    assert.equal(projectId, 'project:alpha');
    const same = await memory.retrieveLongTermMemories(user.id, 'Alpha 数据库', { sessionId: 'new-session', projectId: 'project:alpha' });
    const other = await memory.retrieveLongTermMemories(user.id, 'Alpha 数据库', { sessionId: 'new-session', projectId: 'project:other' });
    assert.equal(same.length, 1);
    assert.equal(same[0].scope, 'project');
    assert.equal(other.length, 0);
});

test('新陈述自动更新同一偏好，乱序旧抽取不能覆盖新值', async () => {
    const { user, sessionId, message } = await fixture();
    const earlier = await message('我更喜欢回答详细一些。');
    const later = await message('我更喜欢回答简洁一些。');
    await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [later.id] });
    const stale = await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [earlier.id] });
    assert.equal(stale.skipped, 1);
    const active = await memory.listMemories(user.id);
    assert.equal(active.total, 1);
    assert.match(active.memories[0].content, /简洁/);
    const newest = await message('我更喜欢回答详细一些。');
    await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [newest.id] });
    assert.match((await memory.listMemories(user.id)).memories[0].content, /详细/);
    assert.equal((await query("SELECT id FROM memories WHERE user_id = ? AND status = 'disabled'", [user.id])).length, 1);
});

test('明确限于当前会话的偏好不会因为共用项目而串到其他会话', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('以后回答使用中文输出，仅限当前会话。');
    const result = await handleChatMemoryRequest({ user, sessionId, projectId: 'project:shared', userMessageId: source.id, prompt: source.content });
    assert.equal(result.stored, true);
    const list = await memory.listMemories(user.id);
    assert.equal(list.memories[0].scope, 'session');
    assert.equal(list.memories[0].scopeReference, sessionId);
    assert.deepEqual(await memory.retrieveLongTermMemories(user.id, '中文输出', { sessionId: 'other', projectId: 'project:shared' }), []);
});

test('并发采集自动去重，遗忘一条偏好不会关闭整个会话的后续学习', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('我更喜欢回答先给结论。');
    const candidate = extractMemoryCandidatesFromMessages([source], { sessionId })[0];
    const inserted = await Promise.all([1, 2, 3].map(() => memory.upsertMemory(user.id, candidate, { skipEmbedding: true, requireActiveSources: true })));
    assert.equal(new Set(inserted.map(item => Number(item.id))).size, 1);
    assert.equal((await memory.listMemories(user.id)).total, 1);
    await memory.softDeleteMemory(user.id, inserted[0].id);
    const other = await message('我更喜欢回答使用中文输出。');
    const result = await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [other.id] });
    assert.equal(result.inserted, 1);
    const rebuilt = await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [source.id] });
    assert.equal(rebuilt.skipped, 1);
});

test('用户关闭记忆或采集后保持关闭，既有确认策略不被自动绕过', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('我更喜欢回答使用中文输出。');
    await memory.setLongTermMemoryEnabled(user.id, false);
    const closed = await memory.scheduleMemoryExtraction({ user, sessionId, messageIds: [source.id], triggerWorker: false });
    assert.equal(closed.reason, 'disabled');
    assert.deepEqual(await memory.retrieveLongTermMemories(user.id, '任何问题'), []);
    await memory.setLongTermMemoryEnabled(user.id, true);
    await updateMemoryPolicy(user.id, { autoCapture: false });
    assert.equal((await memory.scheduleMemoryExtraction({ user, sessionId, messageIds: [source.id], triggerWorker: false })).reason, 'auto_capture_disabled');
    await updateMemoryPolicy(user.id, { autoCapture: true, requireConfirmation: true });
    const result = await memory.runMemoryExtraction({ userId: user.id, user, sessionId, messageIds: [source.id] });
    assert.equal(result.staged, 1);
    assert.deepEqual(await memory.retrieveLongTermMemories(user.id, '任何问题'), []);
});

test('模型暂时失败时持久化后台重试，规则兜底不要求用户接管', async () => {
    const { user, sessionId, message } = await fixture();
    const source = await message('我更喜欢回答简洁一些。');
    const job = await memory.scheduleMemoryExtraction({ user, sessionId, messageIds: [source.id], triggerWorker: false });
    const processed = await memory.processMemoryExtractionJobs({ runMemoryExtraction: async () => ({ inserted: 1, modelFallbackReason: 'timeout' }) });
    assert.equal(processed.retried, 1);
    const row = await queryOne('SELECT status,attempts,result,next_run_at FROM memory_extraction_jobs WHERE id = ?', [job.jobId]);
    assert.equal(row.status, 'queued');
    assert.equal(Number(row.attempts), 1);
    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    assert.equal(result.inserted, 1);
    assert.ok(row.next_run_at);
});
