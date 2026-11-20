'use strict';

const { createHash } = require('node:crypto');
const { error } = require('./runtime');

function pendingInput(id, state, fallback = {}) {
    if (!state?.pendingKind) return null;
    let input = state.pendingInput;
    if (!input) {
        try { input = JSON.parse(state.messages?.findLast(message => message.role === 'assistant')?.content || '{}').requestInput; } catch (_) {}
        input ||= fallback;
    }
    if (!input?.question) return null;
    const kind = state.pendingKind, question = String(input.question), context = String(input.context || '');
    const { stage, plan } = input;
    const promptId = createHash('sha256').update(JSON.stringify([id, state.steps, kind, question, context, stage || null, plan || null])).digest('hex');
    return { kind, question, context, promptId, ...(stage && plan ? { stage, plan } : {}) };
}

function planDigest(pending) {
    return createHash('sha256').update(JSON.stringify([pending.question, pending.context])).digest('hex');
}

function isLegacyDirection(pending) {
    return pending?.kind === 'confirmation' && pending.stage === 'direction';
}

function parseDecision(input, pending, { continueDraft = false } = {}) {
    const response = typeof input === 'string' ? { answer: input } : (input || {});
    if (!pending || (response.promptId !== undefined && response.promptId !== pending.promptId)) {
        throw error('当前确认内容已变化，请刷新后核对新方案。', 'PPT_MASTER_CONFIRMATION_CHANGED', 409);
    }
    if (isLegacyDirection(pending) || continueDraft) {
        if (response.decision !== 'continue' || response.promptId !== pending.promptId || response.answer) {
            throw error('初稿已改为自动制作，请刷新后点击「继续制作」。', 'PPT_MASTER_CONFIRMATION_CHANGED', 409);
        }
        return { decision: 'continue', promptId: pending.promptId, answer: '' };
    }
    const decision = response.decision || (pending.kind === 'clarification' ? 'clarify' : 'revise');
    if (!(pending.kind === 'confirmation' ? ['approve', 'revise'] : ['clarify']).includes(decision)) throw error('请选择与当前问题匹配的处理方式。');
    if ((decision === 'approve' || response.decision !== undefined) && response.promptId !== pending.promptId) {
        throw error('请刷新后确认当前方案。', 'PPT_MASTER_CONFIRMATION_CHANGED', 409);
    }
    const answer = typeof response.answer === 'string' ? response.answer.trim() : '';
    if (decision === 'approve' ? Boolean(answer) : !answer || answer.length > 12000) {
        throw error(decision === 'approve' ? '如有修改意见，请选择“提交修改意见”。' : '请提供不超过12000字的明确答复。');
    }
    return { decision, promptId: pending.promptId, answer };
}

module.exports = { pendingInput, parseDecision, planDigest, isLegacyDirection };
