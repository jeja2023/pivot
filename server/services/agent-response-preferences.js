'use strict';

const { responsePreferenceKey } = require('./long-term-memory/memory-candidate-policy');

const scopePriority = { session: 3, project: 2, user: 1, global: 1 };
const stamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : 0;

function resolveResponsePreferences(profile = {}, memories = [], { prompt = '' } = {}) {
    const style = { ...(profile.communicationStyle || {}) };
    const profileStamp = stamp(profile.communicationStyleUpdatedAt);
    const winners = new Map();
    for (const memory of memories) {
        const key = memory.type === 'preference' ? responsePreferenceKey(memory.content) : '';
        if (!key || key.startsWith('preference:report:') && !/报告|report/i.test(prompt)) continue;
        const prior = winners.get(key);
        const rank = scopePriority[memory.scope] || 0;
        if (!prior || rank > (scopePriority[prior.scope] || 0) || rank === (scopePriority[prior.scope] || 0)
            && stamp(memory.updatedAt || memory.updated_at) > stamp(prior.updatedAt || prior.updated_at)) winners.set(key, memory);
    }
    const suppressed = new Set();
    for (const [key, memory] of winners) {
        const dimension = key.split(':').pop();
        const scoped = ['session', 'project'].includes(memory.scope);
        if (!scoped && profileStamp > stamp(memory.updatedAt || memory.updated_at) && ['verbosity', 'language', 'format'].includes(dimension)) {
            suppressed.add(memory.id); continue;
        }
        const text = String(memory.content);
        if (dimension === 'verbosity') {
            if (/简洁|简短|concise/i.test(text)) style.verbosity = 'concise';
            else if (/详细|detail|verbose/i.test(text)) style.verbosity = 'detailed';
        } else if (dimension === 'language') {
            if (/英文|english/i.test(text)) style.language = 'en';
            else if (/中文|chinese/i.test(text)) style.language = 'zh-CN';
        } else if (dimension === 'format') {
            if (/表格|table/i.test(text)) style.format = 'table';
            else if (/列表|要点|bullet/i.test(text)) style.format = 'bullets';
        }
    }
    const selected = memories.filter(memory => {
        const key = memory.type === 'preference' ? responsePreferenceKey(memory.content) : '';
        return !suppressed.has(memory.id) && (!key || winners.get(key) === memory);
    });
    return { profile: { ...profile, communicationStyle: style }, memories: selected };
}

module.exports = { resolveResponsePreferences };
