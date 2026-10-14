const assert = require('node:assert/strict');
const test = require('node:test');

const {
    characterErrorRate,
    evaluateGoldenCase,
    summarizeGoldenResults
} = require('../server/services/document-processing/quality-evaluation');

const CATEGORY_SPECS = Object.freeze([
    ['中文印刷公文', 8, 4], ['中英混排公文', 6, 4], ['文号日期金额', 6, 4], ['原生扫描混合', 6, 4],
    ['有线表格', 6, 3], ['合并表头表格', 4, 3], ['拍摄倾斜扫描', 6, 3], ['低对比扫描', 4, 3],
    ['双栏图文', 4, 3], ['页眉页脚', 4, 3], ['手写印章遮挡', 3, 3], ['公式特殊符号', 3, 3]
]);

const OCR_GOLDEN_CASES = Object.freeze(CATEGORY_SPECS.flatMap(([category, documents, pages]) => Array.from({ length: documents }, (_item, index) => ({
    id: `${category}-${String(index + 1).padStart(2, '0')}`,
    category,
    pages,
    expected: {
        text: `第${index + 1}份${category}样本 原始文本`,
        fields: category === '文号日期金额' ? { documentNumber: `测试文号${index + 1}`, issueDate: '2026年10月13日', amount: '100.00元' } : {},
        readingOrder: ['block-1', 'block-2'],
        maxCer: category.includes('低对比') || category.includes('手写') ? 0.1 : 0.03
    }
}))));

test('OCR 黄金夹具覆盖 60 份脱敏材料和不少于 200 个计划页面', () => {
    assert.equal(OCR_GOLDEN_CASES.length, 60);
    assert.ok(OCR_GOLDEN_CASES.reduce((sum, item) => sum + item.pages, 0) >= 200);
    assert.equal(new Set(OCR_GOLDEN_CASES.map(item => item.category)).size, 12);
    assert.ok(OCR_GOLDEN_CASES.every(item => item.expected.text && item.expected.readingOrder.length));
});

test('OCR 质量评估计算字符错误率 关键字段和阅读顺序', () => {
    assert.equal(characterErrorRate('第一条', '第一条'), 0);
    assert.ok(characterErrorRate('第一条', '第二条') > 0);
    const result = evaluateGoldenCase({
        expected: { text: '第一条 测试', fields: { documentNumber: '测试文号1' }, readingOrder: ['a', 'b'], maxCer: 0.03 },
        actual: { text: '第一条 测试', fields: { documentNumber: '测试文号1' }, readingOrder: ['a', 'b'] }
    });
    assert.equal(result.pass, true);
    const summary = summarizeGoldenResults([result]);
    assert.equal(summary.passed, 1);
    assert.equal(summary.averageCer, 0);
});

module.exports = { OCR_GOLDEN_CASES };
