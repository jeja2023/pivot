'use strict';

const { error } = require('./runtime');

const supplementPath = /^user-supplement:[1-9]\d{0,2}$/;

function getSupplement(state, path) {
    if (path === 'previous-plan.json' && state.previousPlan) return { path, text: JSON.stringify(state.previousPlan) };
    if (path === 'previous-supplements.json' && state.inheritedSupplementCount) {
        return { path, text: JSON.stringify(state.userSupplements.slice(0, state.inheritedSupplementCount).map(({ path, text, kind }) => ({ path, text, kind }))) };
    }
    if (typeof path !== 'string' || !supplementPath.test(path)) return undefined;
    return state.userSupplements?.find(entry => entry.path === path);
}

function registerSupplement(state, text, kind, promptId = '') {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(text)) {
        throw error('补充说明包含无效字符，请核对后重新提交。', 'PPT_MASTER_SUPPLEMENT_INVALID', 422);
    }
    const entries = state.userSupplements ||= [];
    if (entries.length >= 80 || entries.reduce((size, entry) => size + entry.text.length, text.length) > 120000) {
        throw error('本任务的补充说明已达保存上限，请保留现有成果后新建任务。', 'PPT_MASTER_SUPPLEMENT_LIMIT', 422);
    }
    const path = 'user-supplement:' + (entries.length + 1);
    entries.push({ path, text, kind, step: state.steps, ...(promptId ? { promptId } : {}) });
    return path;
}

function readSupplement(entry, { offset = 0, length = 12000 }) {
    const chars = Array.from(entry.text), start = Math.min(offset, chars.length);
    const end = Math.min(start + length, chars.length);
    return { path: entry.path, text: chars.slice(start, end).join(''), offset: start,
        nextOffset: end < chars.length ? end : null, totalChars: chars.length };
}

function supplementGuidance(state) {
    const pending = Object.entries(state.revisionReadOffsets || {}).filter(([, offset]) => offset != null);
    return [state.previousPlan && '沿用原清单和已确认的修订，根据本次要求重提清单。事实引文仍须核对原材料或用户补充来源。',
        pending.length && ('提交修订清单前用 read 继续读取 ' + pending.map(([path, offset]) => path + ' offset=' + offset).join('、')),
        state.userSupplements?.length && ('当前任务的用户补充来源：' + state.userSupplements.map(entry => entry.path).join('、')
            + '。按顺序用 read 核对与本稿相关的答复及修订。用户明确提供的事实可引用原编号，修改意见、疑问和假设不能充作事实。')].filter(Boolean).join('\n');
}

function prepareRevisionSources(state) {
    if (state.revisionReadOffsets || !state.previousPlan && !state.inheritedSupplementCount) return;
    state.revisionReadOffsets = {};
    for (const path of ['previous-supplements.json', 'previous-plan.json']) {
        const entry = getSupplement(state, path);
        if (!entry) continue;
        const page = readSupplement(entry, { length: 2400 });
        state.revisionReadOffsets[path] = page.nextOffset;
        state.messages.push({ role: 'user', content: JSON.stringify({ previousDraftSource: page }) });
    }
}

function recordRevisionRead(state, action, observation) {
    if (action.action !== 'read' || !Object.hasOwn(state.revisionReadOffsets || {}, action.path)) return;
    const offset = state.revisionReadOffsets[action.path], result = observation.result;
    if (offset == null || observation.error || result?.path !== action.path || result.offset > offset) return;
    if (result.nextOffset === null || result.nextOffset > offset) state.revisionReadOffsets[action.path] = result.nextOffset;
}

module.exports = { getSupplement, registerSupplement, readSupplement, supplementGuidance, prepareRevisionSources, recordRevisionRead };
