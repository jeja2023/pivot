const { assert, db, getBeijingTimestamp, test } = require('../security-helpers');
const { sql } = require('../../server/db/statements');

const {
    countActualRegulationArticles,
    createRegulationAnnotation,
    createSavedSearch,
    deriveRegulationTitleFromFilename,
    deriveRegulationVersionLabelFromFilename,
    getRegulationDocumentDetail,
    listRegulationDocuments,
    listRegulationFacets,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listSavedSearches,
    parseRegulationArticles,
    findSimilarRegulationArticles,
    recordRegulationAccess,
    searchRegulationArticles,
    updateRegulationDocument
} = require('../../server/services/regulations');

test('regulation upload title prefers filename and strips trailing version date', () => {
    const companyLaw = '\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u516c\u53f8\u6cd5';
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '_20240101.pdf'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '_20240101.doc'), companyLaw);
    assert.equal(deriveRegulationTitleFromFilename(companyLaw + '\uff0820240101\uff09.docx'), companyLaw);
    // 分隔日期写法：2024-01-01 / 2024.01.01 / 2024年01月01日
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
    // 分隔日期写法同样可识别为版本号
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
    // 实际条数按「第X条」计算，长条被切片也只算一条
    assert.equal(countActualRegulationArticles(articles), 2);
    // 头部（章节标题/目录/序言）保留为「前言」，但不计入实际条数
    assert.ok(articles.some(a => a.articleLabel === '\u524d\u8a00' && a.content.includes('\u7b2c\u4e00\u7ae0')));
    const clause1 = articles.find(a => a.articleLabel === '\u7b2c\u4e00\u6761');
    assert.ok(clause1 && clause1.content.startsWith('\u7b2c\u4e00\u6761'));
    assert.ok(articles.some(a => a.articleLabel === '\u7b2c\u4e8c\u6761'));
});

test('regulation document update can edit current version label', async () => {
    const now = getBeijingTimestamp();
    const docInfo = db.prepare(`
        INSERT INTO regulation_documents (
            title, category, issuing_body, jurisdiction, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, created_at, updated_at
        ) VALUES (?, '行业规范', '测试机构', '全国', 'active', NULL, 0, 0, 1, 1, ?, ?)
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

    await updateRegulationDocument({ documentId: docId, userId: 1, patch: { versionLabel: '2024 revision' } });

    const version = db.prepare('SELECT version_label FROM regulation_versions WHERE id = ?').get(versionId);
    assert.equal(version.version_label, '2024 revision');
    const detail = await getRegulationDocumentDetail(docId, { includeArchived: true });
    assert.equal(detail.document.current_version_label, '2024 revision');
});

test('regulation list, facets, search and saved searches work correctly', async () => {
    const facets = await listRegulationFacets({ includeArchived: true });
    assert.ok(Array.isArray(facets.categories));
    assert.ok(Array.isArray(facets.jurisdictions));

    const docs = await listRegulationDocuments({ query: 'Test', includeArchived: true });
    assert.ok(Array.isArray(docs.data));

    const saved = await createSavedSearch({ userId: 1, name: 'My Search', query: 'Regulation' });
    assert.ok(saved && saved.id);
    assert.equal(saved.name, 'My Search');

    const searches = await listSavedSearches({ userId: 1 });
    assert.ok(searches.some(s => s.id === saved.id));

    const matches = await searchRegulationArticles({ query: 'Test' });
    assert.ok(Array.isArray(matches));
});

test('regulation vectors and collaboration queries use PostgreSQL-compatible columns', async () => {
    const now = getBeijingTimestamp();
    const docId = sql(`
        INSERT INTO regulation_documents (
            title, category, issuing_body, jurisdiction, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, created_at, updated_at
        ) VALUES (?, '测试分类', '测试机构', '全国', 'active', NULL, 0, 0, 1, 1, ?, ?)
    `).run('PostgreSQL compatibility regulation', now, now).lastInsertRowid;
    const versionId = sql(`
        INSERT INTO regulation_versions (
            document_id, version_label, source_name, source_path, source_size,
            source_hash, source_format, extracted_text, summary, article_count,
            uploaded_by_user, created_at, updated_at
        ) VALUES (?, 'v1', 'compatibility.txt', 'uploads/regulations/compatibility.txt', 0, '', 'txt', '', '', 0, 1, ?, ?)
    `).run(docId, now, now).lastInsertRowid;
    sql('UPDATE regulation_documents SET current_version_id = ?, version_count = 1 WHERE id = ?').run(versionId, docId);

    const insertArticle = sql(`
        INSERT INTO regulation_articles (
            document_id, version_id, sort_order, article_label, article_title, content, embedding, created_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?)
    `);
    const sourceArticleId = insertArticle.run(docId, versionId, 1, '第一条', '向量源条文', '[1,0,0]', now).lastInsertRowid;
    const candidateArticleId = insertArticle.run(docId, versionId, 2, '第二条', '向量候选条文', '[0.9,0.1,0]', now).lastInsertRowid;

    const similar = await findSimilarRegulationArticles({ articleId: sourceArticleId, limit: 10 });
    assert.ok(similar.some(article => Number(article.article_id) === Number(candidateArticleId)));

    const annotation = await createRegulationAnnotation({ articleId: sourceArticleId, userId: 1, content: '兼容性批注' });
    assert.ok(annotation?.id);
    const annotations = await listRegulationAnnotations({ articleId: sourceArticleId });
    assert.equal(annotations.length, 1);
    assert.ok(Object.hasOwn(annotations[0], 'user_name'));
    assert.strictEqual(annotations[0].user_email, null);

    await recordRegulationAccess({ userId: 1, documentId: docId, action: 'view', detail: 'compatibility check' });
    const accessLogs = await listRegulationAccessLogs({ documentId: docId });
    assert.equal(accessLogs.total, 1);
    assert.ok(Object.hasOwn(accessLogs.data[0], 'user_name'));
});
