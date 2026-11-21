'use strict';

const { estimateMessagesTokens } = require('../../context-budget');

function jsonMessage(message, prefix) {
    if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(prefix)) return null;
    try { return JSON.parse(message.content); } catch (_) { return null; }
}

function reduceRead(entry, ranges) {
    const result = entry?.result;
    if (!ranges || entry.error || typeof result?.text !== 'string' || !result.text) return entry;
    const start = result.offset ?? 0;
    if (!Number.isSafeInteger(start) || start < 0) return entry;
    const points = Array.from(result.text), end = start + points.length;
    const uncovered = [];
    let cursor = start;
    for (const range of ranges) {
        const from = Math.max(start, range.offset), to = Math.min(end, range.offset + range.points.length);
        if (to <= from || range.points.slice(from - range.offset, to - range.offset).join('') !== points.slice(from - start, to - start).join('')) continue;
        if (from > cursor) uncovered.push({ offset: cursor, text: points.slice(cursor - start, from - start).join('') });
        cursor = to;
    }
    if (cursor === start) return entry;
    if (cursor < end) uncovered.push({ offset: cursor, text: points.slice(cursor - start).join('') });
    const { text: _text, ...meta } = result;
    return { ...entry, result: { ...meta, ...(uncovered.length ? { uncovered } : {}),
        note: '重叠部分见本轮指引或所选模板规范。其余正文按原文件字符偏移列在 uncovered 中。' } };
}

function compactReads(messages, phaseRanges) {
    const documents = new Map(), copies = new Map();
    for (const message of messages) {
        const item = jsonMessage(message, '{');
        if (item?.runtimeDocument && typeof item.text === 'string') {
            const ranges = phaseRanges?.get(message) || (!item.phase && [{ offset: item.offset ?? 0, points: Array.from(item.text) }]);
            if (ranges) documents.set(item.runtimeDocument, ranges);
        }
        const spec = item?.selectedTemplateSpec;
        if (typeof spec?.text === 'string' && spec.path) {
            const ranges = [{ offset: 0, points: Array.from(spec.text) }];
            documents.set(spec.path + '/templates/design_spec.md', ranges);
            copies.set('selected-template/templates/design_spec.md', ranges);
        }
    }
    return messages.map(message => {
        const batch = jsonMessage(message, '[');
        if (!Array.isArray(batch)) return message;
        const revised = batch.map(entry => reduceRead(entry, (entry?.action === 'read_runtime' ? documents
            : entry?.action === 'read' ? copies : null)?.get(entry?.result?.path)));
        return revised.some((entry, i) => entry !== batch[i]) ? { ...message, content: JSON.stringify(revised) } : message;
    });
}

function fitReferenceMessages(messages, budget, phaseRanges) {
    let view = compactReads(messages, phaseRanges), estimate = estimateMessagesTokens(view);
    if (estimate <= budget) return view;
    // 可分页回读的宿主文档按需发送。始终从原观察重算，避免已折叠的分页失去唯一可见正文。
    const priority = doc => doc.runtimeDocument === 'workflows/routing.md' ? 0 : doc.runtimeDocument === 'SKILL.md' ? 1 : 2;
    const candidates = messages.map((message, index) => ({ index, doc: jsonMessage(message, '{') }))
        .filter(({ doc }) => doc?.runtimeDocument && typeof doc.text === 'string')
        .sort((a, b) => priority(a.doc) - priority(b.doc) || b.doc.text.length - a.doc.text.length);
    const prepared = [...messages];
    for (const { index, doc } of candidates) {
        const { text: _text, ...metadata } = doc;
        prepared[index] = { ...messages[index], content: JSON.stringify({ ...metadata,
            note: '按本轮窗口暂收起指引正文。需要本阶段步骤时使用 read_runtime 按路径和字符偏移分页读取。' }) };
        const next = compactReads(prepared, phaseRanges), size = estimateMessagesTokens(next);
        if (size >= estimate) { prepared[index] = messages[index]; continue; }
        view = next;
        estimate = size;
        if (size <= budget) break;
    }
    return view;
}

module.exports = { fitReferenceMessages };
