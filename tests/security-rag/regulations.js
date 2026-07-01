const { assert, db, getBeijingTimestamp, test } = require('../security-helpers');

const {
    countActualRegulationArticles,
    deriveRegulationTitleFromFilename,
    deriveRegulationVersionLabelFromFilename,
    getRegulationDocumentDetail,
    parseRegulationArticles,
    updateRegulationDocument
} = require('../../server/services/regulations');

test('regulation upload title prefers filename and strips trailing version date', () => {
    const companyLaw = '\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u516c\u53f8\u6cd5';
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '_20240101.pdf'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '_20240101.doc'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '\uff0820240101\uff09.docx'), companyLaw);
    // \u5206\u9694\u65e5\u671f\u5199\u6cd5\uff1a2024-01-01 / 2024.01.01 / 2024\u5e7401\u670801\u65e5
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '_2024-01-01.pdf'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + ' 2024.01.01.pdf'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '2024\u5e7401\u670801\u65e5.pdf'), companyLaw);

    const titleWithYear = '\u6d4b\u8bd52024\u5e74\u7ba1\u7406\u529e\u6cd5';
    assert.equal(deriveRegulationTitleFromFilename(titleWithYear + '-20250101\u4fee\u8ba2\u7248.pdf'), titleWithYear);
});

test('regulation version label auto-detected from filename version date', () => {
    const companyLaw = '\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u516c\u53f8\u6cd5';
    assert.equal(deriveRegulationVersionLabelFromFilename(companyLaw + '_20240101.doc'), '2024\u5e7401\u670801\u65e5');
    assert.equal(deriveRegulationVersionLabelFromFilename(companyLaw + '\uff0820231229\uff09.docx'), '2023\u5e7412\u670829\u65e5');
    // \u5206\u9694\u65e5\u671f\u5199\u6cd5\u540c\u6837\u53ef\u8bc6\u522b\u4e3a\u7248\u672c\u53f7
    assert.equal(deriveRegulationVersionLabelFromFilename(companyLaw + '_2024-01-01.pdf'), '2024\u5e7401\u670801\u65e5');
    assert.equal(deriveRegulationVersionLabelFromFilename(companyLaw + '2024\u5e7401\u670801\u65e5.pdf'), '2024\u5e7401\u670801\u65e5');
    assert.equal(deriveRegulationVersionLabelFromFilename(companyLaw + '.pdf'), '');
});

test('regulation article parsing counts legal articles instead of long-content chunks', () => {
    const longClause = '\u5185\u5bb9'.repeat(500);
    const text = [
        '\u7b2c\u4e00\u7ae0 \u603b\u5219',
        '\u7b2c\u4e00\u6761 \u4e3a\u89c4\u8303\u7ba1\u7406\uff0c\u5236\u5b9a\u672c\u529e\u6cd5\u3002' + longClause,
        '\u7b2c\u4e8c\u6761 \u672c\u529e\u6cd5\u9002\u7528\u4e8e\u5168\u4f53\u5458\u5de5\u3002'
    ].join('\n');

    const articles = parseRegulationArticles(text, { docTitle: '\u5458\u5de5\u7ba1\u7406\u529e\u6cd5' });
    // \u5b9e\u9645\u6761\u6570\u6309\u300c\u7b2cX\u6761\u300d\u8ba1\u7b97\uff0c\u957f\u6761\u88ab\u5207\u7247\u4e5f\u53ea\u7b97\u4e00\u6761
    assert.equal(countActualRegulationArticles(articles), 2);
    // \u9996\u90e8\uff08\u7ae0\u8282\u6807\u9898/\u76ee\u5f55/\u5e8f\u8a00\uff09\u4fdd\u7559\u4e3a\u300c\u524d\u8a00\u300d\uff0c\u4f46\u4e0d\u8ba1\u5165\u5b9e\u9645\u6761\u6570
    assert.ok(articles.some(a => a.articleLabel === '\u524d\u8a00' && a.content.includes('\u7b2c\u4e00\u7ae0')));
    const clause1 = articles.find(a => a.articleLabel === '\u7b2c\u4e00\u6761');
    assert.ok(clause1 && clause1.content.startsWith('\u7b2c\u4e00\u6761'));
    assert.ok(articles.some(a => a.articleLabel === '\u7b2c\u4e8c\u6761'));
});

test('regulation document update can edit current version label', () => {
    const now = getBeijingTimestamp();
    const docInfo = db.prepare(`
        INSERT INTO regulation_documents (
            title, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, created_at, updated_at
        ) VALUES (?, 'active', NULL, 0, 0, 1, 1, ?, ?)
    `).run('Test Regulation', now, now);
    const docId = docInfo.lastInsertRowid;
    const versionInfo = db.prepare(`
        INSERT INTO regulation_versions (
            document_id, version_label, source_name, source_path, source_size,
            source_hash, source_format, extracted_text, summary, article_count,
            uploaded_by_user, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, '', 'txt', '', '', 0, 1, ?, ?)
    `).run(docId, 'v1', 'test.txt', 'uploads/regulations/test.txt', now, now);
    const versionId = versionInfo.lastInsertRowid;
    db.prepare('UPDATE regulation_documents SET current_version_id = ?, version_count = 1 WHERE id = ?').run(versionId, docId);

    updateRegulationDocument({ documentId: docId, userId: 1, patch: { versionLabel: '2024 revision' } });

    const version = db.prepare('SELECT version_label FROM regulation_versions WHERE id = ?').get(versionId);
    assert.equal(version.version_label, '2024 revision');
    const detail = getRegulationDocumentDetail(docId, { includeArchived: true });
    assert.equal(detail.document.current_version_label, '2024 revision');
});
