'use strict';

const { error } = require('./runtime');

const supplementPath = /^user-supplement:[1-9]\d{0,2}$/;

function getSupplement(state, path) {
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
    if (!state.userSupplements?.length) return '';
    return '当前任务的用户补充来源：' + state.userSupplements.map(entry => entry.path).join('、')
        + '。需要原文时用 read 按 path 读取。用户确认或明确提供的事实可用对应来源编号引用，指令、疑问及假设不可当作已确认事实。';
}

module.exports = { getSupplement, registerSupplement, readSupplement, supplementGuidance };
