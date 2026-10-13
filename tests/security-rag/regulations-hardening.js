const { assert, db, getBeijingTimestamp, test } = require('../security-helpers');
const {
    buildRegulationAiContext,
    buildRegulationQaReportIr,
    buildRegulationSearchExcerpt,
    createRegulationAnnotation,
    deleteRegulationDocument,
    diffRegulationVersions,
    getRegulationCitationGraph,
    getRegulationDocumentDetail,
    getRegulationVersionById,
    findRegulationVersionEffectiveOn,
    getReadableRegulationArticle,
    getRegulationIndexRetryDelayMs,
    queueRegulationLibraryReindex,
    isRegulationEmbeddingErrorRetryable,
    listRegulationDocuments,
    listRegulationCategoryFolders,
    listRegulationFolderDocumentSelection,
    listDeletedRegulationDocuments,
    listRegulationBookmarks,
    listRegulationAiAnswerLogs,
    listRegulationObligations,
    listRegulationQualitySummary,
    listRegulationSubscriptions,
    mergeRegulationCandidates,
    parseRegulationArticles,
    rebuildRegulationCrossLinks,
    saveRegulationAliases,
    searchRegulationArticles
    , restoreRegulationDocument
    , saveRegulationBookmark
    , deleteRegulationBookmark
    , recordRegulationAiAnswer
    , updateRegulationDocument
    , requestRegulationVersionReindex
    , updateRegulationVersionGovernance
    , createRegulationObligation
    , reviewRegulationObligation
    , subscribeToRegulation
    , unsubscribeFromRegulation
} = require('../../server/services/regulations');
const { extractRegulationLinks } = require('../../server/services/regulations/links');
const { normalizeRegulationIssuingBodies } = require('../../server/services/regulations/shared');
const { validateDocumentIr } = require('../../server/services/document-ir');

function createDocument(title, { category = '审查分类', issuingBody = '', jurisdiction = '全国', status = 'active' } = {}) {
    const now = getBeijingTimestamp();
    return Number(db.prepare(`
        INSERT INTO regulation_documents (
            title, category, issuing_body, jurisdiction, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 1, 1, ?, ?)
    `).run(title, category, issuingBody, jurisdiction, status, now, now).lastInsertRowid);
}

function addVersion(documentId, versionLabel, articles, extractedText = '') {
    const now = getBeijingTimestamp();
    const versionId = Number(db.prepare(`
        INSERT INTO regulation_versions (
            document_id, version_label, source_name, source_path, source_size, source_hash, source_format,
            extracted_text, summary, article_count, uploaded_by_user, created_at, updated_at
        ) VALUES (?, ?, 'hardening.txt', 'uploads/regulations/hardening.txt', 0, '', 'txt', ?, '', ?, 1, ?, ?)
    `).run(documentId, versionLabel, extractedText, articles.length, now, now).lastInsertRowid);
    const articleIds = articles.map((article, index) => Number(db.prepare(`
        INSERT INTO regulation_articles (
            document_id, version_id, sort_order, article_label, article_title, content, embedding, created_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?)
    `).run(documentId, versionId, index + 1, article.label || '第一条', article.content, article.embedding || null, now).lastInsertRowid));
    db.prepare(`
        UPDATE regulation_documents
        SET current_version_id = ?, version_count = version_count + 1, article_count = ?, updated_at = ?
        WHERE id = ?
    `).run(versionId, articles.length, now, documentId);
    return { versionId, articleIds };
}

test('法规默认读取范围一致排除归档和已删除内容，并允许管理员显式查看归档', async () => {
    const archived = createDocument('归档范围审查法规', { status: 'archived' });
    const archivedVersion = addVersion(archived, 'v1', [{ content: '第一条 归档范围审查正文' }]);
    const deleted = createDocument('删除范围审查法规');
    const deletedVersion = addVersion(deleted, 'v1', [{ content: '第一条 删除范围审查正文' }]);
    await deleteRegulationDocument({ documentId: deleted, userId: 1 });

    assert.equal(await getRegulationDocumentDetail(archived), null);
    assert.ok(await getRegulationDocumentDetail(archived, { includeArchived: true }));
    assert.equal(await getRegulationDocumentDetail(deleted, { includeArchived: true }), null);
    assert.equal(await getReadableRegulationArticle(archivedVersion.articleIds[0]), null);
    assert.equal(await getReadableRegulationArticle(deletedVersion.articleIds[0], { includeArchived: true }), null);
    assert.equal(await createRegulationAnnotation({ articleId: deletedVersion.articleIds[0], userId: 1, content: '不应写入' }), null);
    assert.ok(!(await listRegulationDocuments({ query: '归档范围审查法规' })).data.some(doc => Number(doc.id) === archived));
    assert.ok((await listRegulationDocuments({ query: '归档范围审查法规', includeArchived: true })).data.some(doc => Number(doc.id) === archived));
    assert.equal((await searchRegulationArticles({ query: '归档范围审查正文' })).length, 0);
    assert.ok((await searchRegulationArticles({ query: '归档范围审查正文', includeArchived: true })).some(article => Number(article.document_id) === archived));
});

test('法规软删除可由管理员从回收站恢复，并重新进入默认目录', async () => {
    const documentId = createDocument('回收站恢复法规');
    addVersion(documentId, 'v1', [{ content: '第一条 回收站正文。' }]);
    await deleteRegulationDocument({ documentId, userId: 1 });
    assert.ok((await listDeletedRegulationDocuments()).data.some(item => Number(item.id) === documentId));
    const restored = await restoreRegulationDocument({ documentId, userId: 1 });
    assert.equal(restored.status, 'active');
    assert.ok((await listRegulationDocuments({ query: '回收站恢复法规' })).data.some(item => Number(item.id) === documentId));
});

test('详情不暴露源路径、版本全文或向量，并拒绝文档外版本 ID', async () => {
    const first = createDocument('详情瘦身法规');
    const firstVersion = addVersion(first, 'v1', [{ content: '第一条 当前正文', embedding: '[1,0,0]' }], '完整历史原文'.repeat(500));
    const second = createDocument('其它版本法规');
    const secondVersion = addVersion(second, 'v1', [{ content: '第一条 其它正文' }], '其它完整原文');
    const detail = await getRegulationDocumentDetail(first);
    assert.equal(Object.hasOwn(detail.currentVersion, 'extracted_text'), false);
    assert.equal(Object.hasOwn(detail.currentVersion, 'source_path'), false);
    assert.equal(Object.hasOwn(detail.versions[0], 'extracted_text'), false);
    assert.equal(Object.hasOwn(detail.articles[0], 'embedding'), false);
    assert.deepEqual(detail.download, { fileName: 'hardening.txt' });
    assert.equal(await getRegulationDocumentDetail(first, { versionId: secondVersion.versionId }), null);
    assert.equal((await getRegulationVersionById(firstVersion.versionId)).extracted_text, undefined);
});

test('检索可按发布机构与元数据筛选，并把摘要定位在命中条文附近', async () => {
    const documentId = createDocument('发布机构检索法规', { category: '法律', issuingBody: '审查独有发布机构', jurisdiction: '北京市' });
    addVersion(documentId, 'v1', [{ content: `第一条 ${'前置说明。'.repeat(120)}关键期限审查：应在三十日内完成。` }]);
    const issuerMatches = await searchRegulationArticles({ query: '审查独有发布机构' });
    assert.ok(issuerMatches.some(item => Number(item.document_id) === documentId));
    const filtered = await searchRegulationArticles({ category: '法律', jurisdiction: '北京市', limit: 20 });
    assert.ok(filtered.some(item => Number(item.document_id) === documentId));
    const text = '前言'.repeat(200) + '关键期限审查：应在三十日内完成。' + '尾部'.repeat(100);
    const excerpt = buildRegulationSearchExcerpt(text, '关键期限审查');
    assert.match(excerpt, /关键期限审查/);
    assert.match(excerpt, /三十日/);
    assert.equal(excerpt.startsWith('…'), true);
});

test('法规名称别名会参与词法召回，简称可定位到当前法规条文', async () => {
    const documentId = createDocument('中华人民共和国别名检索条例');
    await saveRegulationAliases(documentId, '中华人民共和国别名检索条例');
    addVersion(documentId, 'v1', [{ content: '第一条 别名检索正文。' }]);
    const matches = await searchRegulationArticles({ query: '别名检索条例' });
    assert.ok(matches.some(item => Number(item.document_id) === documentId));
});

test('法规分类目录按数据库分类聚合，并提供分类范围的一键批量选择清单', async () => {
    const first = createDocument('目录分类法规甲', { category: '目录测试分类' });
    const second = createDocument('目录分类法规乙', { category: '目录测试分类' });
    addVersion(first, 'v1', [{ content: '第一条 目录测试正文甲。' }]);
    addVersion(second, 'v1', [{ content: '第一条 目录测试正文乙。' }]);
    const folder = (await listRegulationCategoryFolders()).find(item => item.category === '目录测试分类');
    assert.equal(folder.documentCount, 2);
    assert.equal(folder.articleCount, 2);
    const selection = await listRegulationFolderDocumentSelection({ category: '目录测试分类' });
    assert.deepEqual(selection.data.map(item => item.id).sort((a, b) => a - b), [first, second].sort((a, b) => a - b));
    assert.equal(selection.truncated, false);
});

test('多个发布机构会去重并规范为顿号分隔，保留任一机构的检索能力', async () => {
    assert.equal(
        normalizeRegulationIssuingBodies('最高人民法院, 最高人民检察院；最高人民法院'),
        '最高人民法院、最高人民检察院'
    );
    const documentId = createDocument('联合司法解释发布机构法规');
    addVersion(documentId, 'v1', [{ content: '第一条 联合发布解释正文。' }]);
    const updated = await updateRegulationDocument({
        documentId,
        userId: 1,
        patch: { issuingBody: '最高人民法院,最高人民检察院；最高人民法院' }
    });
    assert.equal(updated.issuing_body, '最高人民法院、最高人民检察院');
    assert.ok((await searchRegulationArticles({ query: '最高人民检察院' })).some(item => Number(item.document_id) === documentId));
});

test('法规向量索引对配置错误停止重试，对临时故障使用有上限的退避重试', async () => {
    assert.equal(isRegulationEmbeddingErrorRetryable(new Error('未配置 Embedding HTTP 服务地址')), false);
    assert.equal(isRegulationEmbeddingErrorRetryable(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })), true);
    assert.equal(getRegulationIndexRetryDelayMs(1), 60 * 1000);
    assert.equal(getRegulationIndexRetryDelayMs(5), 16 * 60 * 1000);
    assert.equal(getRegulationIndexRetryDelayMs(7), 60 * 60 * 1000);
    const documentId = createDocument('向量人工重建法规');
    const version = addVersion(documentId, 'v1', [{ content: '第一条 向量索引测试正文。' }]);
    db.prepare("UPDATE regulation_versions SET index_status = 'lexical_ready', index_attempts = 5, index_error = '配置错误' WHERE id = ?").run(version.versionId);
    const reindexed = await requestRegulationVersionReindex({ documentId, versionId: version.versionId, userId: 1 });
    assert.equal(reindexed.index_status, 'retry_wait');
    assert.equal(Number(reindexed.index_attempts), 0);
});

test('全库向量重建只排队当前有效版本，清空旧向量且不重新解析原文', async () => {
    const first = createDocument('全库重建法规甲', { category: '全库队列测试' });
    const second = createDocument('全库重建法规乙', { category: '全库队列测试' });
    const archived = createDocument('不应重建的归档法规', { category: '全库队列测试', status: 'archived' });
    const firstVersion = addVersion(first, 'v1', [{ content: '第一条 当前版本向量应清空。', embedding: '[1,0,0]' }]);
    const secondVersion = addVersion(second, 'v1', [{ content: '第一条 第二份当前版本。', embedding: '[0,1,0]' }]);
    const archivedVersion = addVersion(archived, 'v1', [{ content: '第一条 归档版本不应入队。', embedding: '[0,0,1]' }]);

    const result = await queueRegulationLibraryReindex({ category: '全库队列测试' });
    assert.equal(result.queuedVersions, 2);
    assert.equal(result.clearedArticles, 2);
    assert.equal(result.scope, '全库队列测试');
    assert.equal(db.prepare('SELECT embedding FROM regulation_articles WHERE id = ?').get(firstVersion.articleIds[0]).embedding, null);
    assert.equal(db.prepare('SELECT embedding FROM regulation_articles WHERE id = ?').get(secondVersion.articleIds[0]).embedding, null);
    assert.equal(db.prepare('SELECT embedding FROM regulation_articles WHERE id = ?').get(archivedVersion.articleIds[0]).embedding, '[0,0,1]');
    assert.equal(db.prepare('SELECT index_status FROM regulation_versions WHERE id = ?').get(firstVersion.versionId).index_status, 'retry_wait');
    assert.equal(db.prepare('SELECT index_status FROM regulation_versions WHERE id = ?').get(archivedVersion.versionId).index_status, 'lexical_ready');
});

test('混合结果融合保留无向量关键词命中并按排名稳定排序', () => {
    const merged = mergeRegulationCandidates(
        [{ article_id: 1, score: 0.95, document_title: '强词法命中' }, { article_id: 2, score: 0.1, document_title: '弱词法命中' }],
        [{ article_id: 2, vectorScore: 0.9, document_title: '弱词法命中' }, { article_id: 3, vectorScore: 0.8, document_title: '仅语义命中' }],
        10
    );
    assert.equal(merged.length, 3);
    assert.equal(merged[0].article_id, 2);
    assert.equal(merged.find(item => item.article_id === 1).retrieval, 'keyword');
    assert.equal(merged.find(item => item.article_id === 3).retrieval, 'semantic');
});

test('引用重建会将随当前版本更新的跨法条文重定向到目标法规新版', async () => {
    const target = createDocument('目标重建法规');
    await saveRegulationAliases(target, '目标重建法规');
    const previous = addVersion(target, '旧版', [{ content: '第一条 旧版要求' }]);
    const source = createDocument('来源重建法规');
    const sourceVersion = addVersion(source, 'v1', [{ content: '第一条 依据《目标重建法规》第一条办理' }]);
    const links = extractRegulationLinks([{ sortOrder: 1, articleLabel: '第一条', content: '第一条 依据《目标重建法规》第一条办理' }], { documentId: source, versionId: sourceVersion.versionId });
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO regulation_article_links (
            document_id, version_id, source_article_id, target_label, target_article_id, target_document_id, relation_type, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.8, ?)
    `).run(source, sourceVersion.versionId, sourceVersion.articleIds[0], links[0].targetLabel, previous.articleIds[0], target, links[0].relationType, now);
    const current = addVersion(target, '新版', [{ content: '第一条 新版要求' }]);
    await rebuildRegulationCrossLinks();
    const link = db.prepare('SELECT target_article_id FROM regulation_article_links WHERE source_article_id = ?').get(sourceVersion.articleIds[0]);
    assert.equal(Number(link.target_article_id), current.articleIds[0]);
});

test('版本对比保留重复条号的变化，引用图返回实际关系类型', async () => {
    const documentId = createDocument('版本对比法规');
    const oldVersion = addVersion(documentId, '旧版', [
        { content: '第一条 被修改的前段' },
        { content: '后段保持不变' }
    ]);
    const newVersion = addVersion(documentId, '新版', [
        { content: '第一条 修改后的前段' },
        { content: '后段保持不变' }
    ]);
    const diff = await diffRegulationVersions({ documentId, fromVersionId: oldVersion.versionId, toVersionId: newVersion.versionId });
    assert.equal(diff.changed.length, 1);
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO regulation_article_links (
            document_id, version_id, source_article_id, target_label, target_article_id, target_document_id, relation_type, confidence, created_at
        ) VALUES (?, ?, ?, '第一条', ?, ?, 'depend', 0.8, ?)
    `).run(documentId, newVersion.versionId, newVersion.articleIds[1], newVersion.articleIds[0], documentId, now);
    const graph = await getRegulationCitationGraph(documentId);
    assert.equal(graph.edges.find(edge => Number(edge.source) === newVersion.articleIds[1]).type, 'depend');
});

test('AI 依据上下文保留后半段命中规则，并限制在可见当前版本', async () => {
    const documentId = createDocument('问答依据法规');
    addVersion(documentId, '旧版', [{ content: '第一条 旧版期限：十日。' }]);
    addVersion(documentId, '新版', [{ content: `第一条 ${'前置说明。'.repeat(100)}关键期限审查：应在三十日内完成。` }]);
    const built = await buildRegulationAiContext({ query: '关键期限审查', documentId, userId: 1, expandLinks: false });
    assert.ok(built.context.includes('关键期限审查'));
    assert.ok(built.context.includes('三十日'));
    assert.equal(built.sources.every(source => /新版/.test(source.label)), true);
});

test('法规治理信息支持来源、审核和按指定日期选择现行版本', async () => {
    const documentId = createDocument('效力日期审查法规');
    const oldVersion = addVersion(documentId, '旧版', [{ content: '第一条 旧版规则' }]);
    const currentVersion = addVersion(documentId, '新版', [{ content: '第一条 新版规则' }]);
    const oldGovernance = await updateRegulationVersionGovernance({
        documentId,
        versionId: oldVersion.versionId,
        userId: 1,
        patch: { effectStatus: 'effective', effectiveFrom: '2020-01-01', effectiveTo: '2023-12-31', reviewStatus: 'approved', sourceUrl: 'https://intranet.example/old' }
    });
    const currentGovernance = await updateRegulationVersionGovernance({
        documentId,
        versionId: currentVersion.versionId,
        userId: 1,
        patch: { effectStatus: 'effective', effectiveFrom: '2024-01-01', reviewStatus: 'approved', sourceUrl: 'https://intranet.example/new' }
    });
    await updateRegulationDocument({
        documentId,
        userId: 1,
        patch: { legalLevel: '法律', officialSourceUrl: 'https://intranet.example/main', subjectTags: '人事、劳动法', metadataReviewStatus: 'approved' }
    });
    assert.equal(oldGovernance.effect_status, 'effective');
    assert.equal(currentGovernance.review_status, 'approved');
    assert.equal((await findRegulationVersionEffectiveOn(documentId, '2022-06-01')).id, oldVersion.versionId);
    assert.equal((await findRegulationVersionEffectiveOn(documentId, '2025-06-01')).id, currentVersion.versionId);
    assert.equal(await findRegulationVersionEffectiveOn(documentId, '2019-06-01'), null);
    const detail = await getRegulationDocumentDetail(documentId, { effectiveAt: '2022-06-01' });
    assert.equal(detail.currentVersion.id, oldVersion.versionId);
    assert.equal(await getRegulationDocumentDetail(documentId, { effectiveAt: '2019-06-01' }), null);
    assert.equal(detail.document.legal_level, '法律');
    assert.deepEqual(detail.document.subject_tags, ['人事', '劳动法']);
    await assert.rejects(
        updateRegulationVersionGovernance({ documentId, versionId: currentVersion.versionId, userId: 1, patch: { effectiveFrom: '2025-01-02', effectiveTo: '2025-01-01' } }),
        { statusCode: 400 }
    );
});

test('法规解析保留章节路径并能切分 OCR 压缩在同一行的连续条号', () => {
    const structured = parseRegulationArticles([
        '第一章 总则',
        '第一条 总体要求。',
        '第二章 实施',
        '第二条 具体要求。'
    ].join('\n'));
    const first = structured.find(article => article.articleLabel === '第一条');
    const second = structured.find(article => article.articleLabel === '第二条');
    assert.equal(first.headingPath, '第一章 总则');
    assert.equal(second.headingPath, '第二章 实施');
    assert.equal(first.content.includes('第二章 实施'), false);
    const inline = parseRegulationArticles('第一条 要求甲。第二条 要求乙。');
    assert.equal(inline.filter(article => /^第.+条/.test(article.articleLabel)).length, 2);
});

test('法规订阅只对审核通过的现行版本发通知，义务清单与质量摘要可追溯', async () => {
    const documentId = createDocument('订阅与义务法规');
    const version = addVersion(documentId, 'v1', [{ content: '第一条 用人单位应当在三十日内完成备案。' }]);
    const subscription = await subscribeToRegulation({ userId: 1, documentId, approvedOnly: true });
    assert.equal(subscription.status, 'active');
    await updateRegulationVersionGovernance({
        documentId,
        versionId: version.versionId,
        userId: 1,
        patch: { effectStatus: 'effective', effectiveFrom: '2024-01-01', reviewStatus: 'approved' }
    });
    const notification = db.prepare("SELECT * FROM agent_notifications WHERE user_id = ? AND type = 'regulation_update' ORDER BY id DESC LIMIT 1").get(1);
    assert.match(notification.title, /关注法规已更新/);
    assert.match(notification.body, /订阅与义务法规/);
    const subscriptions = await listRegulationSubscriptions({ userId: 1, documentId });
    assert.equal(Number(subscriptions[0].last_notified_version_id), version.versionId);
    const obligation = await createRegulationObligation({
        userId: 1,
        documentId,
        versionId: version.versionId,
        articleId: version.articleIds[0],
        input: { subject: '用人单位', triggerCondition: '发生法定备案事项', requiredAction: '完成备案', dueRule: '三十日内', evidenceRequirement: '备案回执' }
    });
    assert.ok(obligation?.id);
    const obligations = await listRegulationObligations({ documentId });
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0].required_action, '完成备案');
    assert.equal(obligations[0].review_status, 'pending');
    assert.equal(obligations[0].status, 'draft');
    const reviewed = await reviewRegulationObligation({
        obligationId: obligation.id,
        documentId,
        userId: 1,
        input: { reviewStatus: 'approved', status: 'active' }
    });
    assert.equal(reviewed.review_status, 'approved');
    assert.equal(reviewed.status, 'active');
    const summary = await listRegulationQualitySummary();
    assert.equal(Number.isInteger(summary.versions.governanceNeedsReview), true);
    assert.equal(Number.isInteger(summary.obligations.needsReview), true);
    assert.equal(await unsubscribeFromRegulation({ userId: 1, documentId }), true);
    assert.equal((await listRegulationSubscriptions({ userId: 1, documentId })).length, 0);
    assert.equal((await listRegulationSubscriptions({ userId: 1, documentId, includeCancelled: true }))[0].status, 'cancelled');
});

test('法规 AI 问答记录会固化问题、回答、模型、依据来源及上下文快照', async () => {
    const documentId = createDocument('问答审计法规');
    const entry = await recordRegulationAiAnswer({
        userId: 1,
        documentId,
        question: '需要在什么时候完成？',
        answer: '应在三十日内完成。',
        modelName: '审计模型',
        contextSnapshot: '[1] 问答审计法规 / v1 / 第一条\n应在三十日内完成。',
        sources: [{ index: 1, documentId, versionId: 42, articleId: 43, label: '问答审计法规 / v1 / 第一条', excerpt: '应在三十日内完成。' }],
        usage: { totalTokens: 123 }
    });
    assert.ok(entry?.id);
    const logs = await listRegulationAiAnswerLogs({ userId: 1, documentId });
    const logged = logs.data.find(item => Number(item.id) === Number(entry.id));
    assert.equal(logged.answer, '应在三十日内完成。');
    assert.equal(logged.model_name, '审计模型');
    assert.match(logged.context_snapshot, /三十日/);
    assert.equal(logged.sources_json[0].versionId, 42);
    assert.equal(logged.usage_json.totalTokens, 123);
    assert.equal((await listRegulationAiAnswerLogs({ userId: 2, documentId })).data.some(item => Number(item.id) === Number(entry.id)), false);
});

test('法规问答报告可转换为统一渲染器可校验的 Word/PDF 文档 IR', () => {
    const ir = buildRegulationQaReportIr({
        question: '备案期限是多久？',
        answer: '应在三十日内完成。',
        sources: [{ label: '测试法规 / v1 / 第一条', excerpt: '应在三十日内完成。' }]
    });
    const checked = validateDocumentIr(ir);
    assert.equal(checked.valid, true);
    assert.equal(checked.ir.doc_type, 'report');
    assert.equal(checked.ir.blocks.some(block => block.type === 'list'), true);
});

test('法规收藏按用户隔离，并可用个人专题组织常用法规', async () => {
    const documentId = createDocument('收藏专题法规');
    const bookmark = await saveRegulationBookmark({ userId: 1, documentId, topic: '人事' });
    assert.ok(bookmark?.id);
    assert.equal((await listRegulationBookmarks({ userId: 1 }))[0].topic, '人事');
    const updated = await saveRegulationBookmark({ userId: 1, documentId, topic: '劳动用工' });
    assert.equal(updated.id, bookmark.id);
    assert.equal((await listRegulationBookmarks({ userId: 1, documentId }))[0].topic, '劳动用工');
    assert.equal((await listRegulationBookmarks({ userId: 2, documentId })).length, 0);
    assert.equal(await deleteRegulationBookmark({ bookmarkId: bookmark.id, userId: 2 }), false);
    assert.equal(await deleteRegulationBookmark({ bookmarkId: bookmark.id, userId: 1 }), true);
});
