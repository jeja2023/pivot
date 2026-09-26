'use strict';

/* 用户说“记住/忘记/更正”时的受限解释器。它只生成并执行固定动作，绝不让
 * 自然语言自行指定跨用户记录、策略开关或任意 SQL。 */
const {
    MEMORY_STATUS,
    getMemoryById,
    listMemories,
    softDeleteMemory,
    updateMemory,
    upsertMemory
} = require('./long-term-memory');

function intentError(message, code = 'MEMORY_INTENT_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function clean(value, max = 1200) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseMemoryIntent(text) {
    const source = clean(text, 2400);
    if (source.length < 4) throw intentError('请说明要记住、忘记或更正的内容。');
    const correct = source.match(/^(?:请|帮我)?(?:更正|改正|修改)\s*(.+?)\s*(?:为|成|改成)\s*(.+)$/u);
    if (correct) return { action: 'correct', query: clean(correct[1], 400), content: clean(correct[2], 1200) };
    const forget = source.match(/^(?:请|帮我)?(?:忘记|不要再用|不再记住|停止记住|别再记住)\s*(.*)$/u);
    if (forget) return { action: 'forget', query: clean(forget[1] || '', 400), content: '' };
    const remember = source.match(/^(?:请|帮我)?(?:记住|记下|以后记住|以后按)\s*(.+)$/u);
    if (remember) return { action: 'remember', query: '', content: clean(remember[1], 1200) };
    throw intentError('目前可识别“记住… / 忘记… / 更正 A 为 B”三类记忆指令。', 'MEMORY_INTENT_UNSUPPORTED');
}

async function previewMemoryIntent(user, text, options = {}) {
    const intent = parseMemoryIntent(text);
    let candidates = [];
    if (intent.action !== 'remember') {
        const explicitId = Number.parseInt(options.memoryId ?? options.memory_id, 10);
        let listed = await listMemories(user.id, { status: MEMORY_STATUS.active, search: intent.query, limit: 8, offset: 0 });
        if ((!listed.memories || listed.memories.length === 0) && intent.query) {
            const tokens = intent.query.split(/\s+/).filter(Boolean);
            if (tokens.length > 1) {
                for (const token of tokens) {
                    if (token.length >= 2) {
                        const tokenMatch = await listMemories(user.id, { status: MEMORY_STATUS.active, search: token, limit: 8, offset: 0 });
                        if (tokenMatch.memories && tokenMatch.memories.length > 0) {
                            listed = tokenMatch;
                            break;
                        }
                    }
                }
            }
        }
        if ((!listed.memories || listed.memories.length === 0) && Number.isInteger(explicitId) && explicitId > 0) {
            const memory = await getMemoryById(user.id, explicitId);
            if (memory && memory.status === MEMORY_STATUS.active) {
                listed = { memories: [memory] };
            }
        }
        candidates = (listed.memories || []).map(memory => ({
            id: Number(memory.id), content: clean(memory.content, 240), type: memory.type || 'preference', updatedAt: memory.updatedAt || memory.updated_at || null
        }));
    }
    const needsSelection = intent.action !== 'remember' && candidates.length !== 1;
    const actionLabel = { remember: '保存为长期记忆', forget: '忘记这条记忆', correct: '更正这条记忆' }[intent.action];
    return {
        action: intent.action,
        actionLabel,
        content: intent.content,
        query: intent.query,
        candidates,
        requiresSelection: needsSelection,
        canConfirm: intent.action === 'remember' || candidates.length > 0,
        summary: intent.action === 'remember'
            ? `将“${intent.content.slice(0, 120)}”保存为受治理的个人记忆。`
            : candidates.length
                ? `找到 ${candidates.length} 条可能的记忆；确认后只会操作你选择的一条。`
                : '没有找到可操作的活跃记忆；请换一种更具体的描述。'
    };
}

async function applyMemoryIntent(user, input = {}) {
    const text = input.text || input.intent || '';
    const selectedId = Number.parseInt(input.memoryId ?? input.memory_id, 10);
    const intent = parseMemoryIntent(text);
    const preview = await previewMemoryIntent(user, text, { memoryId: selectedId });
    if (!preview.canConfirm) throw intentError('没有找到可确认的记忆，请先调整描述。', 'MEMORY_INTENT_TARGET_NOT_FOUND', 404);
    if (intent.action === 'remember') {
        const created = await upsertMemory(user.id, {
            content: intent.content, type: 'preference', scope: 'user', salience: 0.8, confidence: 0.9,
            origin: 'explicit', assertedBy: 'user',
            sourceSessionId: input.sourceSessionId || input.source_session_id || null
        }, { user, confirmed: true, explicit: true, origin: 'explicit', assertedBy: 'user' });
        if (created?.skipped) throw intentError('该内容不符合当前记忆策略或可能包含敏感信息。', 'MEMORY_INTENT_BLOCKED', 422);
        return { action: intent.action, result: created, message: created.merged ? '已合并到现有个人记忆。' : '已保存为个人长期记忆。' };
    }
    const candidate = preview.candidates.find(item => Number(item.id) === selectedId)
        || (preview.candidates.length === 1 ? preview.candidates[0] : null);
    if (!candidate) throw intentError('请从当前账号的候选记忆中选择一条。', 'MEMORY_INTENT_SELECTION_REQUIRED', 422);
    if (intent.action === 'forget') {
        const changed = await softDeleteMemory(user.id, candidate.id, { reason: 'user_forget' });
        if (!changed) throw intentError('记忆已不存在或无权操作。', 'MEMORY_INTENT_TARGET_NOT_FOUND', 404);
        return { action: intent.action, memoryId: candidate.id, message: '已忘记这条记忆，并会抑制同一来源的自动重建。' };
    }
    const memory = await updateMemory(user.id, candidate.id, { content: intent.content }, { user });
    if (!memory) throw intentError('记忆已不存在或无权操作。', 'MEMORY_INTENT_TARGET_NOT_FOUND', 404);
    return { action: intent.action, memory, memoryId: candidate.id, message: '已更正这条记忆，下一次任务会使用新内容。' };
}

module.exports = { applyMemoryIntent, previewMemoryIntent };
