'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInput, normalizeFindings, completeFindings } = require('../server/services/policy-review/contract');
const { buildIr } = require('../server/services/policy-review/report');
const { validateDocumentIr } = require('../server/services/document-ir');

const base = { title: '材料审查报告', asOf: '2026-11-09', modelId: '1', requestKey: 'abcdefgh', documentIds: [1], materials: [{ title: '申请', text: '申请金额为6200元。' }] };
const clause = { id: 'clause_1', documentId: 1, versionId: 2, articleId: 3, label: '第一条', text: '单笔报销金额不得超过5000元。' };
const materials = [{ id: 'material_1', title: '申请', text: '申请金额为6200元。', digest: 'material-digest' }];
const item = { clauseId: clause.id, status: 'violates', ruleQuote: clause.text, materialEvidence: [{ materialId: 'material_1', quote: materials[0].text }], analysis: '申请超出制度限额。', recommendation: '请核对例外审批。' };

test('创建审查拒绝非法日期、重复制度、超量材料、空输入与异常类型', () => {
    assert.equal(normalizeInput(base).documentIds[0], 1);
    for (const extra of [{ asOf: '2026-02-30' }, { asOf: '2026-13-01' }, { documentIds: [1, 1] }, { materials: {} }, { materials: [] }, { materials: [{ text: 'a'.repeat(60001) }] }, { modelId: '' }]) {
        assert.throws(() => normalizeInput({ ...base, ...extra }), error => error.status === 400);
    }
});

test('制度与材料引用必须逐字对应，虚构来源或缺少材料不会得到符合或不符合', () => {
    const valid = normalizeFindings({ findings: [item] }, [clause], materials)[0];
    assert.equal(valid.status, 'violates'); assert.equal(valid.citationVerified, true);
    assert.equal(valid.materialEvidence[0].charStart, 0);
    for (const patch of [{ ruleQuote: '另一份制度规定6000元。' }, { materialEvidence: [] }, { materialEvidence: [{ materialId: 'other', quote: materials[0].text }] }, { materialEvidence: [{ materialId: 'material_1', quote: '申请金额为4000元。' }] }]) {
        const value = normalizeFindings({ findings: [{ ...item, status: 'meets', ...patch }] }, [clause], materials)[0];
        assert.equal(value.status, 'needs_review'); assert.equal(value.citationVerified, false);
    }
});

test('遗漏、重复和未知条款不能冒充批次完成，未审查条目保留明确占位', () => {
    for (const findings of [[], [item, item], [{ ...item, clauseId: 'unknown' }]]) assert.throws(() => normalizeFindings({ findings }, [clause], materials), error => error.code === 'POLICY_REVIEW_RESPONSE_INVALID');
    const result = completeFindings({ clauses: [clause] }, { findings: [] });
    assert.equal(result[0].origin, 'unreviewed'); assert.equal(result[0].status, 'needs_review');
});

test('报告由实际审查项生成，保留原文、待核实与部分完成提示，超长条文不截断', () => {
    const request = { title: '材料审查报告', asOf: '2026-11-09', scope: '', clauses: [{ ...clause, text: '长条文。'.repeat(6000) }],
        documents: [{ id: 1, title: '测试制度', versionLabel: 'v1', effectiveFrom: '2026-01-01', digest: 'a'.repeat(64) }], materials };
    const ir = buildIr(request, { findings: [], version: 1 }, 'failed');
    const checked = validateDocumentIr(ir);
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
    const text = JSON.stringify(ir);
    assert.match(text, /尚未全部完成/); assert.match(text, /本条尚未完成审查/);
    const joined = ir.blocks.filter(block => block.type === 'paragraph').flatMap(block => block.runs.map(run => run.text)).join('');
    assert.equal((joined.match(/长条文。/g) || []).length, 6000);
});
