const assert = require('node:assert/strict');
const { validateDocumentIr } = require('../../server/services/document-ir');
function fixture(layout = 'red_header') {
    const result = validateDocumentIr({ ir_version: '1', doc_type: 'official_document', meta: {
        title: '关于年度检查安排的通知', issuer: '示例市教育局', signoff: '示例市教育局', issued_at: '2026-11-04',
        doc_number: '教办〔2026〕12号', signer: '张某', urgency: '加急', recipient: '各直属单位：',
        security_level: 'confidential', security_period: '★1年', cc: '示例市政府办公室', printer: '示例市教育局办公室', printed_at: '2026-11-05', layout
    }, blocks: [
        { type: 'paragraph', runs: [{ text: '为做好年度检查工作，现将有关安排通知如下。' }] },
        { type: 'heading', level: 1, text: '一、检查安排' },
        { type: 'paragraph', runs: [{ text: '请各单位认真核对材料，并于规定时间反馈工作情况。' }] }
    ] });
    assert.equal(result.valid, true, result.errors.join('；'));
    return result.ir;
}
module.exports = { fixture };
