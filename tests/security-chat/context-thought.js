// Loaded by security-chat.test.js.
const {
    assert,
    buildContextMeta,
    db,
    estimateTokens,
    getContext,
    test
} = require('../security-helpers');

test('getContext strips assistant thought blocks before sending history to model', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ctx_thought_${suffix}`, 'hash', 'Context Thought Test', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionId = `ctx-thought-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Context Thought Test');

    const userContent = 'please keep literal user markup <thought>not model thought</thought>';
    const assistantContent = '<thought>hidden reasoning</thought>visible answer';
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'user', userContent, estimateTokens(userContent));
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'assistant', assistantContent, estimateTokens(assistantContent));

    try {
        const history = await getContext(sessionId, userId, {});
        const userMessage = history.find(message => message.role === 'user');
        const assistantMessage = history.find(message => message.role === 'assistant');

        assert.equal(userMessage.content, userContent);
        assert.equal(assistantMessage.content, 'visible answer');
        assert.equal(String(assistantMessage.content).includes('hidden reasoning'), false);
        assert.equal(String(assistantMessage.content).includes('<thought>'), false);
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('buildContextMeta excludes assistant thought tokens from context usage', () => {
    const thought = `<thought>${'hidden reasoning '.repeat(300)}</thought>`;
    const content = `${thought}visible answer`;
    const meta = buildContextMeta([{
        role: 'assistant',
        content,
        token_count: estimateTokens(content),
        context_archived: 0,
        is_summary: 0
    }]);

    assert.equal(meta.activeTokens, estimateTokens('visible answer'));
    assert.ok(meta.activeTokens < estimateTokens(content) / 10);
});
