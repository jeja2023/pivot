'use strict';

const { contentText, normalizeMemoryContent, normalizeScopeReference } = require('./memory-utils');

// 只从用户自己的陈述学习；附件、代码与引用中的要求不能变成用户习惯。
function memoryUserText(value) {
    const text = contentText(value).split(/\n---\s*\n【参考文档/)[0]
        .replace(/```[\s\S]*?(?:```|$)/g, '')
        .split('\n').filter(line => !/^\s*>/.test(line)).join('\n').trim();
    return /(?:不要|别|无需|不必)(?:长期)?(?:记住|保存|存储)|do not (?:remember|store)/i.test(text) ? '' : text;
}

function isTemporaryInstruction(text = '') {
    return /(?:这次|本次|这轮|本轮|这一次|仅本次|暂时|临时|今天先|for this (?:task|reply)|just this time)/i.test(text)
        && !/(?:以后|今后|长期|一直|每次|from now on|always)/i.test(text);
}

function responsePreferenceKey(content = '') {
    const text = String(content);
    if (!/(?:回答|回复|报告|输出|表达|摘要|response|answer|report)/i.test(text)
        && !/^(?:用户偏好[：:]?|我(?:更)?(?:喜欢|偏好)|以后|今后|默认|请)?\s*(?:用)?(?:中文|英文|简洁|简短|详细|先给结论)(?:一点|些|一些|为主)?[。！!\s]*$/i.test(text)
        && !/\b(?:concise|verbose)\b/i.test(text)) return '';
    const subject = /报告|report/i.test(text) ? 'report' : 'answer';
    const dimension = /中文|英文|语言|language|english|chinese/i.test(text) ? 'language'
        : /先|开头|顺序|first|before/i.test(text) ? 'order'
            : /简洁|简短|详细|篇幅|concise|verbose|brevity|detail/i.test(text) ? 'verbosity'
                : /表格|列表|格式|要点|table|bullet|format/i.test(text) ? 'format' : '';
    return dimension ? `preference:${subject}:${dimension}` : '';
}

function inferCandidateScope(type, evidence, context = {}) {
    const sessionId = normalizeScopeReference(context.sessionId);
    const projectId = normalizeScopeReference(context.projectId);
    if (/(?:只|仅)(?:用于|在|限于?)(?:当前|这个|本)会话/.test(evidence)) return { scope: 'session', scopeReference: sessionId, projectId: '' };
    const projectOnly = /(?:项目|系统|模块|客户|团队).{0,30}(?:报告|回答|输出|格式|口径|偏好)|(?:这个|当前|本)(?:项目|系统)|仅用于.*项目|只.*项目|for this project/i.test(evidence);
    const personal = type === 'preference' || /(?:我|本人)(?:的|是|在|负责|使用|常用|从事)|\b(?:I am|my role|I work)\b/i.test(evidence);
    if (type !== 'episode' && personal && !projectOnly) return { scope: 'user', scopeReference: '', projectId: '' };
    // 缺少可信项目绑定时收窄到来源会话，不能让模型自行指定其他项目。
    return type !== 'episode' && projectId
        ? { scope: 'project', scopeReference: projectId, projectId }
        : { scope: 'session', scopeReference: sessionId, projectId: '' };
}

function applyAutomaticCandidatePolicy(candidate, evidence, context = {}) {
    const content = normalizeMemoryContent(candidate.content);
    if (/[？?]|(?:假设|例如|比如)|\b(?:what if|for example)\b/i.test(evidence)) return null;
    if (/(?:不要|别|无需|不必)(?:长期)?(?:记住|保存|存储)|do not (?:remember|store)/i.test(evidence)) return null;
    if (candidate.type !== 'episode' && isTemporaryInstruction(evidence)) return null;
    if (candidate.confidence < 0.65 && candidate.type !== 'episode') return null;
    const scope = inferCandidateScope(candidate.type, context.scopeEvidence || evidence, context);
    if (scope.scope !== 'user' && !scope.scopeReference) return null;
    return { ...candidate, ...scope, sourceSessionId: context.sessionId || null,
        factKey: candidate.type === 'preference' ? responsePreferenceKey(content) || candidate.factKey : candidate.factKey };
}

function isGeneralResponsePreference(memory = {}) {
    return memory.type === 'preference' && ['user', 'global'].includes(memory.scope)
        && (responsePreferenceKey(memory.content).startsWith('preference:answer:'));
}

function splitResponsePreference(content = '') {
    if (!responsePreferenceKey(content)) return [content];
    const subject = /报告|report/i.test(content) ? '报告' : '回答';
    const parts = String(content).split(/[，,]|(?:并且|同时|并)(?=(?:且)?(?:使用|用|先|保持|尽量))/).map(part => part.trim()).filter(Boolean);
    const keys = parts.map(part => responsePreferenceKey(`${subject}${part}`));
    if (parts.length < 2 || keys.some(key => !key) || new Set(keys).size < 2) return [content];
    return parts.map(part => responsePreferenceKey(part) ? part : `用户偏好：${subject}${part}`);
}

function dedupeAutomaticCandidates(candidates = []) {
    const byKey = new Map();
    for (const candidate of candidates) {
        const attribute = candidate.factKey || candidate.content;
        const key = `${candidate.scope}:${candidate.scopeReference}:${candidate.projectId}:${candidate.type}:${attribute}`;
        const previous = byKey.get(key);
        const latest = item => Math.max(0, ...(item?.sourceMessageIds || []));
        if (!previous || latest(candidate) >= latest(previous)) byKey.set(key, candidate);
    }
    return [...byKey.values()].slice(0, 8);
}

function shouldIgnoreStaleCandidate(existing, candidate = {}, origin = '') {
    if (!existing || !['automatic', 'learning'].includes(origin)) return false;
    let previousIds = existing.source_message_ids;
    if (typeof previousIds === 'string') {
        try { previousIds = JSON.parse(previousIds); } catch (_) { previousIds = []; }
    }
    const previous = Math.max(0, ...(Array.isArray(previousIds) ? previousIds : []).map(Number).filter(Number.isFinite));
    const current = Math.max(0, ...(candidate.sourceMessageIds || []).map(Number).filter(Number.isFinite));
    return current <= previous || (!previous && existing.origin === 'explicit');
}

module.exports = { memoryUserText, isTemporaryInstruction, responsePreferenceKey, applyAutomaticCandidatePolicy, isGeneralResponsePreference, shouldIgnoreStaleCandidate, splitResponsePreference, dedupeAutomaticCandidates };
