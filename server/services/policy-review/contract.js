'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../canonical-json');

const TOOL = 'policy.review_report';
const MAX_CLAUSES = 160;
const MAX_TEXT = 60000;
const BATCH_SIZE = 8;
const STATUSES = Object.freeze({ meets: '符合', violates: '不符合', needs_review: '待核实', not_applicable: '不适用' });
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

function invalid(message, status = 400, code = 'POLICY_REVIEW_INVALID') {
    return Object.assign(new Error(message), { status, statusCode: status, code });
}

function bounded(value, max, label, required = true) {
    if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw invalid(`${label}无效或超过长度限制。`);
    return value.replace(/\r\n?/g, '\n').trim();
}

function normalizeInput(input = {}) {
    const title = bounded(input.title || '制度材料审查报告', 100, '报告标题');
    const asOf = bounded(input.asOf || '', 10, '业务日期');
    const date = new Date(asOf + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) throw invalid('请填写有效的业务日期。');
    if (!Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.length > 3
        || input.documentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw invalid('请选择一至三份制度文档。');
    const documentIds = [...new Set(input.documentIds.map(Number))];
    if (documentIds.length !== input.documentIds.length) throw invalid('制度文档不能重复选择。');
    const materialIds = input.materialIds || [];
    if (!Array.isArray(materialIds) || materialIds.length > 4 || materialIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw invalid('材料标识无效，最多四份材料。');
    if (new Set(materialIds.map(Number)).size !== materialIds.length) throw invalid('同一份上传材料不能重复选择。');
    if (!Array.isArray(input.materials || [])) throw invalid('待审材料必须是列表。');
    const materials = (input.materials || []).map((item, index) => ({ id: `material_${index + 1}`, title: bounded(item?.title || '待审材料', 160, '材料名称'),
        text: bounded(item?.text, MAX_TEXT, '待审材料') }));
    if (!Array.isArray(input.materials || []) || materials.length + materialIds.length < 1 || materials.length + materialIds.length > 4) throw invalid('请提交一至四份待审材料。');
    const requestKey = bounded(input.requestKey || '', 100, '创建请求标识');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) throw invalid('创建请求标识无效，请重新操作。');
    return { title, asOf, documentIds, materialIds: [...new Set(materialIds.map(Number))], materials, requestKey,
        scope: bounded(input.scope || '', 1500, '适用范围与审查重点', false), modelId: bounded(String(input.modelId || ''), 160, '执行模型') };
}

function quoteAt(text, quote) {
    if (typeof quote !== 'string' || quote.length < Math.min(4, text.length) || quote.length > 800 || !quote.trim()) return null;
    const start = text.indexOf(quote);
    return start < 0 ? null : { quote, charStart: start, charEnd: start + quote.length };
}

function normalizeFindings(value, clauses, materials) {
    if (!value || !Array.isArray(value.findings) || value.findings.length !== clauses.length) throw invalid('模型没有逐条返回本批审查结果，请重试未完成批次。', 422, 'POLICY_REVIEW_RESPONSE_INVALID');
    const byId = new Map(clauses.map(clause => [clause.id, clause])), seen = new Set();
    return value.findings.map(item => {
        const clause = byId.get(item?.clauseId);
        if (!clause || seen.has(item.clauseId) || !Object.hasOwn(STATUSES, item.status) || !Array.isArray(item.materialEvidence) || item.materialEvidence.length > 4) throw invalid('模型返回了重复、未知条款、无效结论或引用列表。', 422, 'POLICY_REVIEW_RESPONSE_INVALID');
        seen.add(item.clauseId);
        const ruleEvidence = quoteAt(clause.text, item.ruleQuote);
        const raw = item.materialEvidence;
        const materialEvidence = raw.flatMap(evidence => {
            const material = materials.find(source => source.id === evidence?.materialId), quote = material && quoteAt(material.text, evidence.quote);
            return quote ? [{ materialId: material.id, title: material.title, digest: material.digest, ...quote }] : [];
        });
        const materialEvidenceComplete = materialEvidence.length === raw.length;
        const evidenceValid = Boolean(ruleEvidence) && materialEvidenceComplete;
        const verified = evidenceValid && (!['meets', 'violates'].includes(item.status) || materialEvidence.length > 0);
        return { id: clause.id, status: verified ? item.status : 'needs_review',
            analysis: bounded(item.analysis, 3000, '审查说明'), recommendation: bounded(item.recommendation || '', 2000, '处理建议', false),
            ruleEvidence: ruleEvidence ? { documentId: clause.documentId, versionId: clause.versionId, articleId: clause.articleId, label: clause.label, ...ruleEvidence } : null,
            materialEvidence: materialEvidenceComplete ? materialEvidence : [], citationVerified: verified,
            evidenceNote: verified ? '所引片段已与本次制度及材料原文逐字核对；结论仍需业务复核。' : '原文引用不完整或不匹配，已转为待核实；不能据此认定符合或不符合。', origin: 'model' };
    }).sort((a, b) => clauses.findIndex(item => item.id === a.id) - clauses.findIndex(item => item.id === b.id));
}

function completeFindings(request, result) {
    const found = new Map((result.findings || []).map(item => [item.id, item]));
    return request.clauses.map(clause => found.get(clause.id) || { id: clause.id, status: 'needs_review', analysis: '本条尚未完成审查。', recommendation: '',
        ruleEvidence: null, materialEvidence: [], citationVerified: false, evidenceNote: '尚无本条审查结果。', origin: 'unreviewed' });
}

module.exports = { TOOL, MAX_CLAUSES, MAX_TEXT, BATCH_SIZE, STATUSES, digest, invalid, bounded, normalizeInput, normalizeFindings, completeFindings };
