'use strict';

const { error } = require('./runtime');
const { createHash } = require('node:crypto');
const { checklistLimits } = require('./checklist-limits');
const { exactDecimal } = require('../presentation-decimal');
const CITATION_REVIEW_REQUIRED = 'PPT_MASTER_CITATION_REVIEW_REQUIRED';
const compact = value => value.normalize('NFKC').replace(/\s+/gu, '');
const citationFields = new Set(['id', 'page', 'item', 'text', 'path', 'quote', 'correctedText', 'correctedNumber']);
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

const unitScale = { 亿元: 8, 万元: 4, 千元: 3, 元: 0, '%': 0 };
const exactUnitValue = /(?<![\dA-Za-z.,+±\-$€£¥])([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(亿元|万元|千元|元|%)/gu;

function normalizeDisplayUnits(text) {
    return numericText(text).replace(exactUnitValue, (_, number, unit) => {
        // 只移动十进制小数点，避免浮点运算把实际不同的值判成等值。
        const [whole, fraction = ''] = number.replace(/^[+-]|,/g, '').split('.');
        const at = whole.length + unitScale[unit];
        const digits = whole + fraction;
        const integer = digits.slice(0, at).padEnd(at, '0').replace(/^0+(?=\d)/, '');
        const remainder = digits.slice(at).replace(/0+$/, '');
        return (number.startsWith('-') ? '-' : '') + integer + (remainder ? '.' + remainder : '') + (unit === '%' ? '%' : '元');
    });
}

function matchesDisplayedValue(source, value) {
    return containsValue(source, value) || containsValue(normalizeDisplayUnits(source), normalizeDisplayUnits(value));
}

function matchesChartNumber(text, value) {
    const expected = exactDecimal(value);
    const candidates = numericText(text).matchAll(/(?<![\d.,+±-])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\d|\.\d|,\d)/gu);
    return [...candidates].some(match => exactDecimal(match[0]) === expected);
}

function pauseCitationReview(state) {
    state.citationPause = true;
    const [first] = state.citationRepair;
    return error(`最终页面清单有 ${state.citationRepair.length} 项引文待核对。${first.location}：${first.reason} 请在检查点补充原文、提交修改意见或切换模型后继续。`, CITATION_REVIEW_REQUIRED, 422);
}

function canUseCitationDraft(citationDraft, citationIssues) {
    return Boolean(citationDraft?.plan && citationIssues?.length && citationIssues.every(({ page, item, text, missing, titleClaim }) => {
        const target = citationDraft.plan.pages[page - 1];
        return !missing && (titleClaim ? target && matchesDisplayedValue(target.title, text) : target?.values[item - 1]?.text === text);
    }));
}

function draftWithCitationPlaceholders({ citationDraft, citationIssues }) {
    if (!canUseCitationDraft(citationDraft, citationIssues)) return null;
    const plan = globalThis.structuredClone(citationDraft.plan);
    const { titleWithoutUnverifiedClaims } = require('./title-evidence');
    for (const { page, item, text, titleClaim } of citationIssues) {
        const target = plan.pages[page - 1];
        const placeholder = `数据待核对（第 ${item} 项）`;
        const use = plan.templateUse;
        if (item && use?.page === page && use.visibleText === text) use.visibleText = placeholder;
        if (item) target.values[item - 1] = { text: placeholder };
        if (titleClaim || matchesDisplayedValue(target.title, text)) {
            const safeTitle = titleWithoutUnverifiedClaims(target, text) || `第 ${page} 页（关键数据待核对）`;
            if (use?.page === page && use.visibleText === target.title) use.visibleText = safeTitle;
            target.title = safeTitle;
        }
    }
    return { ...citationDraft, context: plan.summary, plan };
}

// 修复轮只在任务已登记的文本来源中查找完整引文，多份材料同时命中时保留人工查证。
async function locateCitation(paths, originalPath, quote, text, readSource) {
    if (!matchesDisplayedValue(quote, text) || !/\p{L}/u.test(text) || (/^[+−-]?\d/u.test(compact(text)) && normalizeDisplayUnits(quote) === normalizeDisplayUnits(text))) return null;
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

// 只有已找到的短引文和完整数据确实落在同一条唯一原文时，才自动补长。
function extendCitation(source, quote, text) {
    const line = originalLine(source, text);
    const anchor = compact(quote);
    const start = source.normalized.indexOf(anchor);
    if (start < 0 || source.normalized.indexOf(anchor, start + 1) >= 0) return '';
    if (line && containsValue(line, quote)) return line;
    // 只扩到完整且与显示值等价的句子，保留原文边界及限定词。
    for (const raw of source.raw.split(/(?<=[。！？；])|\r?\n[ \t]*\r?\n/u)) {
        const candidate = raw.trim();
        const body = candidate.replace(/^(?:[-*]\s+)/u, '').replace(/[。！？；]$/u, '');
        if (candidate && candidate.length <= 350 && !/[\u0000-\u001f\u007f]/u.test(candidate)
            && containsValue(candidate, quote) && matchesDisplayedValue(body, text) && matchesDisplayedValue(text, body)) return candidate;
    }
    return '';
}

function citationId({ page, item, title, text }) {
    return createHash('sha256').update(JSON.stringify([page, item, title, text])).digest('hex').slice(0, 20);
}

function patchCitationDraft(state, changes) {
    const invalid = () => Object.assign(error('没有命中最新待核对清单的有效修正。请使用当前条目 id、来源路径及连续原文。', 'PPT_MASTER_ACTION_INVALID', 422),
        { correctionKind: 'citation_patch' });
    if (!state.citationDraft || !Array.isArray(changes) || !changes.length || changes.length > checklistLimits(state).total) throw invalid();
    const pending = (state.citationRepair || []).filter(issue => !issue.missing && !issue.titleClaim);
    const byId = new Map(pending.map(issue => [citationId(issue), issue]));
    const byPosition = new Map(pending.map(issue => [issue.page + '/' + issue.item, issue]));
    const draft = globalThis.structuredClone(state.citationDraft);
    const candidates = new Map();
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Object.keys(change).some(field => !citationFields.has(field))) continue;
        const { id, page, item, text, path, quote, correctedText, correctedNumber } = change;
        const issue = id === undefined
            ? (Number.isInteger(page) && Number.isInteger(item) && byPosition.get(page + '/' + item))
            : byId.get(id);
        if (!issue || (id === undefined || text !== undefined) && issue.text !== text
            || page !== undefined && page !== issue.page || item !== undefined && item !== issue.item) continue;
        const value = draft.plan.pages[issue.page - 1]?.values[issue.item - 1];
        if (value?.text !== issue.text || typeof path !== 'string' || path.length > 140 || typeof quote !== 'string' || quote.length > 350
            || correctedText !== undefined && (typeof correctedText !== 'string' || !correctedText.trim() || correctedText.length > 120 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(correctedText))
            || correctedNumber !== undefined && (!value.chart || typeof correctedNumber !== 'string' || correctedNumber.length > 48 || !/^[+-]?\d+(?:\.\d+)?$/.test(correctedNumber))) continue;
        if (value.chart && !matchesChartNumber(correctedText ?? value.text, correctedNumber ?? value.chart.number)) continue;
        const key = citationId(issue);
        candidates.set(key, candidates.has(key) ? null : { issue, value, change });
    }
    const edits = [...candidates.values()].filter(Boolean);
    if (!edits.length) throw invalid();
    for (const { issue, value, change: { path, quote, correctedText, correctedNumber } } of edits) {
        value.source = { path, quote };
        if (correctedText !== undefined) {
            value.text = correctedText;
            const use = draft.plan.templateUse;
            if (use?.page === issue.page && use.visibleText === issue.text) use.visibleText = value.text;
        }
        if (correctedNumber !== undefined) value.chart.number = correctedNumber;
    }
    return { draft, edits: edits.map(({ issue }) => issue), ignored: changes.length - edits.length };
}

module.exports = { compact, containsValue, matchesDisplayedValue, matchesChartNumber, locateCitation, verifiedCorrection, originalLine, extendCitation, patchCitationDraft,
    pauseCitationReview, canUseCitationDraft, draftWithCitationPlaceholders, citationId, CITATION_REVIEW_REQUIRED };
