'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
    configuration,
    createPreviewConfig,
    verifyReadTicket,
    createAttachmentPreviewConfig,
    verifyAttachmentReadTicket,
    getAttachmentDocumentType
} = require('../server/services/onlyoffice-preview');
const { extractExcelPreviewData } = require('../server/services/excel-preview');
const XLSX = require('@e965/xlsx');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secret = 'onlyoffice-test-secret-0123456789abcdef';
const env = { PIVOT_ONLYOFFICE_PATH: '/onlyoffice', PIVOT_ONLYOFFICE_PIVOT_URL: 'http://pivot:3000', PIVOT_ONLYOFFICE_JWT_SECRET: secret };
const rendition = { id: 13, format: 'docx', status: 'ready', content_digest: 'a'.repeat(64) };
const user = { id: 5, token_version: 2 };

test('ONLYOFFICE 未启用时保留本地预览，启用后生成受约束的签名只读配置', () => {
    assert.equal(configuration({}), null);
    const config = configuration(env);
    const preview = createPreviewConfig(rendition, user, { config });
    assert.equal(preview.scriptUrl, '/onlyoffice/web-apps/apps/api/documents/api.js');
    assert.equal(preview.editor.editorConfig.mode, 'view');
    assert.equal(preview.editor.document.permissions.edit, false);
    assert.equal(preview.editor.document.permissions.download, false);
    const decoded = jwt.verify(preview.editor.token, secret, { algorithms: ['HS256'] });
    assert.equal(decoded.document.url, preview.editor.document.url);
    const ticket = new URL(preview.editor.document.url).searchParams.get('token');
    const claims = verifyReadTicket(ticket, { config });
    assert.equal(claims.userId, user.id);
    assert.equal(claims.renditionId, rendition.id);
    assert.equal(claims.tokenVersion, user.token_version);
    assert.ok(claims.exp - claims.iat <= 300);
    assert.throws(() => verifyReadTicket(preview.editor.token, { config }));
    assert.throws(() => verifyReadTicket(ticket + 'x', { config }));
    assert.throws(() => createPreviewConfig({ ...rendition, format: 'pdf' }, user, { config }));
    assert.notEqual(createPreviewConfig({ ...rendition, content_digest: 'b'.repeat(64) }, user, { config }).editor.document.key, preview.editor.document.key);
});

test('禁止外部脚本地址、带凭据的回源和弱密钥', () => {
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_PATH: 'https://example.com' }));
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_PIVOT_URL: 'http://user:pass@pivot:3000' }));
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_JWT_SECRET: 'short' }));
});

test('ONLYOFFICE 支持 Word、Excel 和 PPT 附件只读预览配置生成与票据鉴权', () => {
    const config = configuration(env);
    const docxAttachment = { id: 101, file_name: '报告.docx', file_path: 'uploads/5/sess-1/test.docx' };
    const xlsxAttachment = { id: 102, file_name: '数据表.xlsx', file_path: 'uploads/5/sess-1/test.xlsx' };

    assert.equal(getAttachmentDocumentType('test.docx').documentType, 'word');
    assert.equal(getAttachmentDocumentType('test.xlsx').documentType, 'cell');
    assert.equal(getAttachmentDocumentType('test.pptx').documentType, 'slide');
    assert.equal(getAttachmentDocumentType('test.unknown'), null);

    const docxPreview = createAttachmentPreviewConfig(docxAttachment, user, { config });
    assert.equal(docxPreview.editor.documentType, 'word');
    assert.equal(docxPreview.editor.document.fileType, 'docx');
    assert.equal(docxPreview.editor.document.title, '报告.docx');
    assert.equal(docxPreview.editor.editorConfig.mode, 'view');
    assert.equal(docxPreview.editor.document.permissions.edit, false);

    const docxTicket = new URL(docxPreview.editor.document.url).searchParams.get('token');
    const docxClaims = verifyAttachmentReadTicket(docxTicket, { config });
    assert.equal(docxClaims.purpose, 'onlyoffice-attachment-read');
    assert.equal(docxClaims.attachmentId, docxAttachment.id);
    assert.equal(docxClaims.userId, user.id);

    const xlsxPreview = createAttachmentPreviewConfig(xlsxAttachment, user, { config });
    assert.equal(xlsxPreview.editor.documentType, 'cell');
    assert.equal(xlsxPreview.editor.document.fileType, 'xlsx');
    assert.equal(xlsxPreview.editor.document.title, '数据表.xlsx');

    assert.throws(() => createAttachmentPreviewConfig({ id: 103, file_name: 'test.zip' }, user, { config }));
    assert.throws(() => verifyAttachmentReadTicket('invalid-ticket', { config }));
});

test('Excel 本地直接预览服务正确提取工作表与多行多列数据', () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([['姓名', '年龄', '部门'], ['张三', 28, '技术部'], ['李四', 32, '财务部']]);
    const ws2 = XLSX.utils.aoa_to_sheet([['KPI', '得分'], ['Q1', 95]]);
    XLSX.utils.book_append_sheet(wb, ws1, '员工名单');
    XLSX.utils.book_append_sheet(wb, ws2, '绩效统计');

    const tempFile = path.join(os.tmpdir(), `pivot_test_excel_${Date.now()}.xlsx`);
    XLSX.writeFile(wb, tempFile);
    try {
        const result = extractExcelPreviewData(tempFile);
        assert.deepEqual(result.sheetNames, ['员工名单', '绩效统计']);
        assert.equal(result.sheets.length, 2);
        assert.equal(result.sheets[0].name, '员工名单');
        assert.equal(result.sheets[0].rows.length, 3);
        assert.deepEqual(result.sheets[0].rows[0], ['姓名', '年龄', '部门']);
        assert.deepEqual(result.sheets[0].rows[1], ['张三', '28', '技术部']);
        assert.equal(result.sheets[1].name, '绩效统计');
        assert.deepEqual(result.sheets[1].rows[1], ['Q1', '95']);
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
});
