'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../canonical-json');
const STAGES = Object.freeze(['opening', 'context', 'problem', 'evidence', 'proposal', 'decision', 'action', 'closing', 'content']);
const RELATIONS = Object.freeze(['none', 'comparison', 'sequence', 'hierarchy', 'causal', 'composition', 'timeline', 'decision']);
const OPERATIONS = Object.freeze(['sum', 'difference', 'ratio', 'percent_change', 'average']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function invalid(message) { const error = new Error(message); error.status = 400; error.code = 'PRESENTATION_SEMANTICS_INVALID'; return error; }
function bounded(value, limit, label, required = false) {
    if (value !== undefined && typeof value !== 'string') throw invalid(`${label}必须是文字。`);
    const text = String(value || '').trim();
    if (text.length > limit || (required && !text)) throw invalid(`${label}为空或超过长度上限。`);
    return text;
}
function id(value, label) { const text = bounded(value, 96, label, true); if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text)) throw invalid(`${label}格式无效。`); return text; }
function enumeration(value, allowed, fallback, label) { if (value === undefined) return fallback; if (!allowed.includes(value)) throw invalid(`${label}无效。`); return value; }
function numeric(value, min, max, fallback, label) { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${label}无效。`); return value; }

function normalizeSlideIntent(value) {
    if (value === undefined) return undefined;
    if (!object(value)) throw invalid('页面目标必须是对象。');
    return {
        purpose: bounded(value.purpose, 600, '页面职责'), takeaway: bounded(value.takeaway, 400, '页面核心结论'),
        stage: enumeration(value.stage, STAGES, 'content', '故事线阶段'), relation: enumeration(value.relation, RELATIONS, 'none', '信息关系'),
        bridgeToNext: bounded(value.bridgeToNext, 400, '与下一页的衔接'),
        durationSeconds: numeric(value.durationSeconds, 0, 1800, 0, '页面讲解时长')
    };
}

function normalizeClaims(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 30) throw invalid('每页论点最多三十条。');
    const ids = new Set();
    return value.map((claim, index) => {
        if (!object(claim)) throw invalid('论点必须是对象。');
        const claimId = id(claim.id || `claim_${index + 1}`, '论点标识');
        if (ids.has(claimId)) throw invalid('同一页面的论点标识重复。');
        ids.add(claimId);
        if (claim.sourceRefs !== undefined && (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length > 20)) throw invalid('论点来源数量无效。');
        if (claim.evidence !== undefined && (!Array.isArray(claim.evidence) || claim.evidence.length > 10)) throw invalid('论点证据数量无效。');
        const evidence = (claim.evidence || []).map(item => {
            if (!object(item)) throw invalid('证据必须是对象。');
            return { sourceId: id(item.sourceId, '证据来源'), quote: bounded(item.quote, 1000, '原文证据', true), locator: bounded(item.locator, 500, '证据定位') };
        });
        const result = { id: claimId, text: bounded(claim.text, 1200, '论点文字', true),
            type: enumeration(claim.type, ['fact', 'calculation', 'assumption', 'recommendation'], 'fact', '论点类型'),
            sourceRefs: [...new Set((claim.sourceRefs || []).map(value => id(value, '论点来源')))], evidence };
        if (claim.basisDigest !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(String(claim.basisDigest))) throw invalid('论点对应的页面内容摘要无效。');
            result.basisDigest = claim.basisDigest;
        }
        if (claim.calculation !== undefined) {
            const calc = claim.calculation;
            if (result.type !== 'calculation' || !object(calc) || !Array.isArray(calc.values) || !calc.values.length || calc.values.length > 20 || calc.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw invalid('推导须提供明确的运算、输入数值与结果。');
            const operation = enumeration(calc.operation, OPERATIONS, undefined, '推导运算');
            if (!operation || (['difference', 'ratio', 'percent_change'].includes(operation) && calc.values.length !== 2)) throw invalid('该推导运算需要两个输入数值。');
            result.calculation = { operation, values: calc.values, result: numeric(calc.result, -Number.MAX_VALUE, Number.MAX_VALUE, undefined, '推导结果'), unit: bounded(calc.unit, 40, '推导单位') };
            if (result.calculation.result === undefined) throw invalid('推导缺少结果。');
        }
        return result;
    });
}

function normalizeProductionProfile(value) {
    if (value === undefined) return undefined;
    if (!object(value)) throw invalid('制作要求必须是对象。');
    for (const key of ['requireCitations', 'requireVisualReview', 'requireOfficeReview']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw invalid('制作检查要求必须是布尔值。');
    return { audience: bounded(value.audience, 240, '受众'), purpose: bounded(value.purpose, 600, '演示目的'),
        consumptionMode: enumeration(value.consumptionMode, ['presentation', 'reading'], 'presentation', '阅读方式'),
        targetDurationSeconds: numeric(value.targetDurationSeconds, 0, 43200, 0, '目标演示时长'),
        minimumBodyFontPt: numeric(value.minimumBodyFontPt, 9, 36, value.consumptionMode === 'reading' ? 12 : 18, '正文最低字号'),
        requireCitations: value.requireCitations === true, requireVisualReview: value.requireVisualReview === true, requireOfficeReview: value.requireOfficeReview === true };
}

function calculate(calculation) {
    const values = calculation.values;
    switch (calculation.operation) {
        case 'sum': return values.reduce((sum, value) => sum + value, 0);
        case 'average': return values.reduce((sum, value) => sum + value, 0) / values.length;
        case 'difference': return values[0] - values[1];
        case 'ratio': return values[1] === 0 ? null : values[0] / values[1];
        case 'percent_change': return values[0] === 0 ? null : (values[1] - values[0]) / Math.abs(values[0]) * 100;
        default: return null;
    }
}
const compact = value => String(value || '').replace(/\s/gu, '');
function numbers(value) { return [...String(value || '').matchAll(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map(match => Number(match[0].replace(/,/g, ''))); }
function sameNumber(a, b) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b)); }

function slideContentDigest(slide) {
    const elements = slide.elements.filter(element => element.visible && !/^pivot(?:Template|Brand|Export)_/.test(element.id)).map(element => {
        const keys = ['id', 'type', 'content', 'shapeType', 'assetRef', 'alt', 'columns', 'rows', 'chartType', 'data', 'title', 'binding', 'diagramType', 'items', 'graph', 'mediaType', 'filename', 'description'];
        return Object.fromEntries(keys.filter(key => element[key] !== undefined).map(key => [key, element[key]]));
    }).sort((a, b) => a.id.localeCompare(b.id));
    return crypto.createHash('sha256').update(canonicalJson({ elements, speakerNotes: slide.speakerNotes, sourceRefs: slide.sourceRefs })).digest('hex');
}

function analyzePresentationSemantics(presentation) {
    const issues = [], receipts = [], sources = new Map(presentation.sources.map(source => [source.id, source]));
    const profile = presentation.metadata.productionProfile || {}, takeaways = new Map();
    let totalDurationSeconds = 0, claimCount = 0, excerptMatches = 0, checkedCalculations = 0;
    const add = (slide, code, message, suggestion, level = 'warning', claimId = '') => issues.push({ level, code, slideId: slide.id, elementId: null, ...(claimId ? { claimId } : {}), message, suggestion });
    for (const slide of presentation.slides) {
        const intent = slide.intent, claims = slide.claims || [];
        totalDurationSeconds += intent?.durationSeconds || 0;
        if (intent?.takeaway) {
            const key = compact(intent.takeaway);
            if (takeaways.has(key) && !['opening', 'closing'].includes(intent.stage)) add(slide, 'STORY_REPEATED_TAKEAWAY', '多个页面使用相同核心结论，请核对各页职责。', '保留事实，合并重复论点或明确每页新增证据。');
            takeaways.set(key, slide.id);
        }
        if (intent?.relation === 'comparison' && !slide.elements.some(element => element.visible && ['table', 'chart'].includes(element.type)) && !/comparison|two-column/.test(slide.layoutId)) add(slide, 'STORY_RELATION_LAYOUT', '页面要求比较，但当前构图未明确呈现对照关系。', '选择对比布局、表格或图表，保留双方的同一比较口径。');
        if (profile.requireCitations && !claims.length && !['cover', 'section'].includes(slide.type)) add(slide, 'CLAIMS_MISSING', '本页尚未登记可核对的论点与证据。', '登记事实、推导、假设或建议；为事实关联具体证据。', 'blocking');
        for (const claim of claims) {
            claimCount++;
            const receipt = { slideId: slide.id, claimId: claim.id, type: claim.type, evidence: [], calculation: 'not_applicable' };
            const refs = [...new Set([...claim.sourceRefs, ...claim.evidence.map(item => item.sourceId)])];
            const factual = ['fact', 'calculation'].includes(claim.type), required = profile.requireCitations ? 'blocking' : 'warning';
            receipt.pageBinding = !claim.basisDigest ? 'not_bound' : claim.basisDigest === slideContentDigest(slide) ? 'current' : 'stale';
            if (factual && receipt.pageBinding !== 'current') add(slide, 'CLAIM_PAGE_BINDING_STALE', receipt.pageBinding === 'stale' ? '页面内容已变化，原论点检查需要重新核对。' : '论点尚未绑定当前页面内容快照。', '核对页面文字、数值和讲稿后重新登记论点依据，排版调整不会导致内容失效。', required, claim.id);
            if (factual && !refs.length) add(slide, 'CLAIM_SOURCE_MISSING', '事实或推导没有关联具体来源。', '关联原始材料；缺少依据时明确标为假设。', required, claim.id);
            if (factual && !claim.evidence.length) add(slide, 'CLAIM_EVIDENCE_MISSING', '论点已登记，尚无可回读的原文证据。', '补充原文摘录及页码、段落或单元格定位。', required, claim.id);
            for (const evidence of claim.evidence) {
                const source = sources.get(evidence.sourceId);
                const snapshotMatch = source?.evidenceSlices?.some(slice => slice.sourceDigest === source.digest && compact(slice.quote).includes(compact(evidence.quote)));
                const status = !source ? 'missing_source' : compact(source.excerpt).includes(compact(evidence.quote)) ? 'excerpt_matched' : snapshotMatch ? 'snapshot_slice_matched' : source.excerptTruncated ? 'outside_saved_excerpt' : 'quote_not_found';
                receipt.evidence.push({ sourceId: evidence.sourceId, locator: evidence.locator || source?.locator || '', status });
                if (status === 'excerpt_matched' || status === 'snapshot_slice_matched') excerptMatches++;
                else add(slide, 'CLAIM_EVIDENCE_UNCONFIRMED', status === 'outside_saved_excerpt' ? '证据超出当前保存的材料摘录，尚未核对原文。' : '登记的证据与当前材料摘录不匹配。', '重新读取授权材料并核对原文与定位，不能仅凭来源标签判为通过。', required, claim.id);
            }
            if (claim.type === 'fact' && claim.evidence.length) {
                const citedNumbers = claim.evidence.flatMap(item => numbers(item.quote));
                if (numbers(claim.text).some(value => !citedNumbers.some(number => sameNumber(number, value)))) add(slide, 'FACT_NUMBER_UNCONFIRMED', '事实论点中的部分数值未在登记的原文证据中找到。', '核对数值和单位换算；属于推导时登记明确计算过程。', required, claim.id);
            }
            if (claim.type === 'calculation') {
                if (!claim.calculation) { receipt.calculation = 'missing'; add(slide, 'CALCULATION_MISSING', '推导缺少可复算的计算过程。', '提供运算、原始数值、结果和单位。', required, claim.id); }
                else {
                    const result = calculate(claim.calculation);
                    receipt.calculation = result === null || !Number.isFinite(result) ? 'undefined' : sameNumber(result, claim.calculation.result) ? 'matched' : 'mismatch';
                    if (receipt.calculation === 'matched') checkedCalculations++;
                    else add(slide, 'CALCULATION_MISMATCH', '推导结果无法由登记的输入数值复算。', '检查零分母、运算顺序、百分比及输入/结果，保持相同单位。', 'blocking', claim.id);
                    const citedNumbers = claim.evidence.flatMap(item => numbers(item.quote));
                    if (claim.calculation.values.some(value => !citedNumbers.some(number => sameNumber(number, value)))) add(slide, 'CALCULATION_INPUT_UNCONFIRMED', '部分计算输入尚未在登记的原文证据中找到。', '补充输入数值的具体来源和口径，计算正确不代表输入已经核实。', required, claim.id);
                }
            }
            receipts.push(receipt);
        }
    }
    if (profile.targetDurationSeconds && totalDurationSeconds > profile.targetDurationSeconds * 1.15) issues.push({ level: 'warning', code: 'STORY_DURATION_EXCEEDED', slideId: null, elementId: null, message: '逐页计划时长超过目标演示时间。', suggestion: '调整故事线和讲解重点，将细节保留到附录或备注。' });
    return { status: issues.some(issue => issue.level === 'blocking') ? 'blocked' : issues.length ? 'warning' : claimCount ? 'passed' : 'not_registered',
        summary: { claims: claimCount, excerptMatches, checkedCalculations, totalDurationSeconds, plannedSlides: presentation.slides.filter(slide => slide.intent).length },
        receipts, issues, scope: '摘录匹配、明确计算和结构检查；不代表事实真实性或论证质量已由人工或视觉模型确认。' };
}

module.exports = { STAGES, RELATIONS, OPERATIONS, normalizeSlideIntent, normalizeClaims, normalizeProductionProfile, analyzePresentationSemantics, calculate, slideContentDigest };
