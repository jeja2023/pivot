'use strict';
const { diffChars, diffWordsWithSpace, diffArrays } = require('diff');

function compareDocuments(before, after, mode = 'character') {
    if (typeof before !== 'string' || typeof after !== 'string' || before.length > 30000 || after.length > 30000) {
        throw Object.assign(new Error('文档比较只接受不超过 30000 字符的文本。'), { status: 413 });
    }
    if (!['character', 'word'].includes(mode)) throw Object.assign(new Error('比较模式无效。'), { status: 400 });
    const parts = (mode === 'word' ? diffWordsWithSpace : diffChars)(before, after, { timeout: 1000, maxEditLength: 6000 });
    if (!parts) throw Object.assign(new Error('文档差异过于复杂，请分章节比较。'), { status: 422 });
    let oldOffset = 0, newOffset = 0;
    const changes = parts.map(part => {
        const item = { type: part.added ? 'add' : part.removed ? 'delete' : 'same', text: part.value, beforeStart: oldOffset, afterStart: newOffset };
        if (!part.added) oldOffset += part.value.length;
        if (!part.removed) newOffset += part.value.length;
        return { ...item, beforeEnd: oldOffset, afterEnd: newOffset };
    });
    const oldParagraphs = before.split('\n'), newParagraphs = after.split('\n');
    const paragraphParts = diffArrays(oldParagraphs, newParagraphs, { timeout: 300, maxEditLength: 2000 }) || [];
    let oldIndex = 0, newIndex = 0;
    const removed = [], added = [];
    for (const part of paragraphParts) for (const text of part.value) {
        if (part.removed) removed.push({ text, index: oldIndex++ });
        else if (part.added) added.push({ text, index: newIndex++ });
        else { oldIndex++; newIndex++; }
    }
    // 只认唯一且完全相同的移动段落，不把重复条款或改写误判为移动。
    const moves = removed.filter(item => item.text.trim() && oldParagraphs.filter(text => text === item.text).length === 1
        && newParagraphs.filter(text => text === item.text).length === 1).map(item => {
        const match = added.find(other => other.text === item.text);
        return match ? { text: item.text, fromParagraph: item.index + 1, toParagraph: match.index + 1 } : null;
    }).filter(Boolean);
    return { mode, offsetUnit: 'utf16', changes, moves, changed: changes.filter(part => part.type !== 'same').length };
}

function comparisonIr(comparison, title = '文档修订对照') {
    let id = 0;
    const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const runs = comparison.changes.map(part => ({ text: part.text, ...(part.type === 'same' ? {} : {
        revision: { type: part.type === 'add' ? 'insert' : 'delete', id: ++id, author: 'Pivot 文档比较', date }
    }) }));
    // 按换行拆段，不截断文本；过多碎片交给 IR 上限明确拒绝。
    const blocks = [{ type: 'paragraph', runs: [] }];
    for (const run of runs) {
        const pieces = run.text.split('\n');
        pieces.forEach((text, index) => {
            if (index) {
                if (run.revision) blocks.at(-1).paragraphRevision = { ...run.revision, id: ++id };
                blocks.push({ type: 'paragraph', runs: [] });
            }
            if (text) blocks.at(-1).runs.push({ ...run, text, ...(run.revision ? { revision: { ...run.revision, id: ++id } } : {}) });
        });
    }
    return { ir_version: '1', doc_type: 'report', meta: { title: String(title).slice(0, 120) }, blocks };
}

module.exports = { compareDocuments, comparisonIr };
