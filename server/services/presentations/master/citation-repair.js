'use strict';

const { error } = require('./runtime');
const compact = value => value.normalize('NFKC').replace(/\s+/gu, '');
const citationFields = new Set(['page', 'item', 'text', 'path', 'quote', 'correctedText', 'correctedNumber']);
const numericText = value => compact(value).replace(/−|负(?=\d)/gu, '-');
const escapePattern = text => text.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
const numberPattern = /[+-]?\d+(?:,\d{3})*(?:\.\d+)?/g;

function containsValue(source, value) {
    const needle = numericText(value);
    if (!needle) return false;
    const before = /^[+-]?\d/.test(needle) ? '(?<![\\d.+±-])(?<!\\d,)' + (/^\d/.test(needle) ? '\\+?' : '') : '';
    const after = /\d$/.test(needle) ? '(?!\\d|\\.\\d|,\\d{3})' : '';
    return new RegExp(before + escapePattern(needle) + after).test(numericText(source));
}

// 修复轮只在任务已登记的文本来源中查找完整引文，多份材料同时命中时保留人工查证。
async function locateCitation(paths, originalPath, quote, text, readSource) {
    if (!containsValue(quote, text) || !/\p{L}/u.test(text) || (/^[+−-]?\d/u.test(compact(text)) && compact(quote) === compact(text))) return null;
    let found;
    for (const path of paths) {
        if (path === originalPath) continue;
        const source = await readSource(path);
        if (!containsValue(source.normalized, quote)) continue;
        if (found) return null;
        found = { path, quote };
    }
    return found;
}

// 按原指标、单位和限定词核实单个数值变化。同一来源存在不同口径时，仍需明确答复。
function verifiedCorrection(fact, value, raw) {
    if (!value?.source || value.source.path !== fact.path || !raw) return false;
    if ((fact.chart?.series || '') !== (value.chart?.series || '') || (fact.chart?.category || '') !== (value.chart?.category || '')) return false;
    const previous = numericText(fact.text), current = numericText(value.text);
    for (const match of previous.matchAll(numberPattern)) {
        const prefix = previous.slice(0, match.index), suffix = previous.slice(match.index + match[0].length);
        if (!/\p{L}/u.test(prefix) || !current.startsWith(prefix) || !current.endsWith(suffix)) continue;
        if (/^(?:年|月|日|季度)/u.test(suffix)) continue;
        const replacement = current.slice(prefix.length, current.length - suffix.length);
        if (fact.chart && (match[0] !== fact.chart.number || replacement !== value.chart.number)) continue;
        const pattern = new RegExp(escapePattern(prefix) + '(' + numberPattern.source + ')' + escapePattern(suffix)
            + (/\d$/.test(current) ? '(?!\\d|\\.\\d|,\\d{3})' : ''), 'g');
        const candidates = new Set(Array.from(numericText(raw).matchAll(pattern), found => found[0]));
        if (previous !== current && candidates.size === 1 && candidates.has(current)) return true;
    }
    return false;
}

// 仅以同一份原文中唯一、完整的一行还原引文，保留限定词、数字和单位。
function originalLine(source, text) {
    const key = compact(text).replace(/[。.]$/u, '');
    if (!/\p{L}/u.test(key)) return '';
    if (!source.lines) {
        source.lines = new Map();
        const lines = source.raw.split(/\r\n|[\r\n]/u);
        for (const [index, raw] of lines.entries()) {
            const line = raw.trim();
            if (!line || line.length > 350 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(line)) continue;
            const lineKey = compact(line).replace(/[。.]$/u, '');
            const previous = lines[index - 1]?.trimEnd();
            const next = lines[index + 1]?.trimStart();
            const complete = (!previous || /[。！？.!?]$/u.test(previous)) && (!next || /[。.]$/u.test(line));
            source.lines.set(lineKey, complete && !source.lines.has(lineKey) ? line : '');
        }
    }
    const line = source.lines.get(key);
    return line && compact(line).includes(compact(text)) ? line : '';
}

function patchCitationDraft(state, changes) {
    const invalid = () => error('请按最新待核对清单的页码、项号和数据原文提交引用；清单结构变化时请重提完整方案。', 'PPT_MASTER_ACTION_INVALID', 422);
    if (!state.citationDraft || !Array.isArray(changes) || !changes.length || changes.length > 120) throw invalid();
    const pending = new Map((state.citationRepair || []).filter(issue => !issue.missing).map(issue => [issue.page + '/' + issue.item, issue.text]));
    const draft = globalThis.structuredClone(state.citationDraft);
    for (const change of changes) {
        const { page, item, text, path, quote } = change || {};
        if (!Number.isInteger(page) || !Number.isInteger(item) || typeof text !== 'string'
            || typeof path !== 'string' || typeof quote !== 'string' || Object.keys(change).some(field => !citationFields.has(field))) throw invalid();
        const key = page + '/' + item;
        const value = draft.plan.pages[page - 1]?.values[item - 1];
        if (pending.get(key) !== text || value?.text !== text) throw invalid();
        pending.delete(key);
        value.source = { path, quote };
        if (change.correctedText !== undefined) {
            value.text = change.correctedText;
            const use = draft.plan.templateUse;
            if (use?.page === page && use.visibleText === text) use.visibleText = value.text;
        }
        if (change.correctedNumber !== undefined) {
            if (!value.chart) throw invalid();
            value.chart.number = change.correctedNumber;
        }
    }
    return draft;
}

module.exports = { compact, containsValue, locateCitation, verifiedCorrection, originalLine, patchCitationDraft };
