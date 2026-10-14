/* global document, window, URLSearchParams -- 浏览器测试执行上下文 */
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

async function createPage(browser, { width = 1280, batchMode = false, includeAdvanced = false, user = { username: 'admin', role: 'admin', permissionTier: 'admin' } } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent('<div class="apps-workspace-body"></div>');
    await page.addStyleTag({ content: 'body { height: 100vh; } .apps-workspace-body { height: 100%; display: flex; overflow: hidden; } .hidden { display: none !important; }' });
    for (const file of ['client/common/styles/theme.css', 'client/chat/styles/workspaces/shared.css', 'client/chat/styles/admin/admin-tables-models.css', 'client/chat/styles/workspaces/apps/regulations.css']) {
        await page.addStyleTag({ path: path.join(root, file) });
    }
    await page.evaluate(activeUser => {
        window.Pivot = { legacy: { currentUser: activeUser } };
        window.testToasts = [];
        window.showToast = (message, type) => window.testToasts.push({ message, type });
    }, user);
    for (const file of ['common/vendor/purify.min.js', 'chat/safe-html.js', 'chat/regulations/core.js']) {
        await page.addScriptTag({ path: path.join(root, 'client', file) });
    }
    await page.evaluate(() => {
        window.testDocuments = [1, 2, 3].map(id => ({
            id, title: `测试法规 ${id}`, status: 'active',
            category: id === 2 ? '部门规章' : '法律', issuing_body: `发布机构 ${id}`, jurisdiction: id === 2 ? '北京市' : '全国',
            current_version_id: 100 + id,
            current_version_label: '2024 年修订',
            current_effect_status: id === 1 ? 'unverified' : 'effective',
            current_review_status: id === 1 ? 'pending' : (id === 3 ? 'rejected' : 'approved'),
            current_index_status: id === 1 ? 'indexing' : 'vector_ready',
            legal_level: id === 1 ? '' : '法律',
            official_source_url: id === 1 ? '' : 'https://authority.example/regulation',
            metadata_review_status: id === 1 ? 'unreviewed' : 'approved',
            maintainer_user_id: id === 2 ? 1 : null,
            location_missing: id === 3,
            summary: `摘要 ${id}`
        }));
        window.testCategoryFolders = [
            { title: '法律', category: '法律', documentCount: 2, articleCount: 20, effectiveCount: 1, needsReviewCount: 1, latestUpdatedAt: '2026-10-12 12:00:00', isUncategorized: false },
            { title: '部门规章', category: '部门规章', documentCount: 1, articleCount: 10, effectiveCount: 0, needsReviewCount: 1, latestUpdatedAt: '2026-10-11 12:00:00', isUncategorized: false }
        ];
        window.testRequests = [];
        window.testDocumentListUrls = [];
        window.testReindexRequests = [];
        window.testUpdates = [];
        window.testBatchUndo = [];
        window.testFailures = [];
        window.testConfirmed = true;
        window.confirm = () => window.testConfirmed;
        window.testImportJobs = [];
        window.testSubscriptionActive = false;
        window.testBookmarks = [];
        window.testRecycleBin = [{ id: 91, title: '已删除测试法规', category: '法律', deleted_at: '2026-10-12 12:00:00' }];
        window.testCitationLinks = [
            { id: 801, document_id: 1, version_id: 101, document_title: '测试法规 1', source_article_label: '第一条', target_label: '《外部法规》第三条', relation_type: 'cite', confidence: 0.62, review_status: 'auto', target_article_id: null },
            { id: 802, document_id: 2, version_id: 102, document_title: '测试法规 2', source_article_label: '第二条', target_label: '《测试法规 1》第一条', relation_type: 'depend', confidence: 0.92, review_status: 'auto', target_article_id: 11 }
        ];
        window.testObligations = [{
            id: 71, article_label: '第一条', subject: '用人单位', required_action: '完成备案',
            due_rule: '三十日内', review_status: 'pending', status: 'draft'
        }];
        window.testPreview = {
            title: '预览法规', articleCount: 2,
            articles: [
                { articleLabel: '第一条', articleTitle: '总则', headingPath: '第一章 总则', content: '第一条 原始内容。' },
                { articleLabel: '第二条', articleTitle: '', headingPath: '第一章 总则', content: '第二条 原始内容。' }
            ]
        };
        const ns = window.Pivot.legacy.PivotRegulationsInternal;
        ns.regulationConfirm = async () => window.testConfirmationPromise || window.testConfirmed;
        ns.loadFacets = async () => { window.testFacetsRefreshed = true; };
        ns.fetchJson = async (url, options = {}) => {
            if (url.endsWith('/ai')) {
                window.testAiRequest = JSON.parse(options.body);
                return { content: '测试回答', sources: [] };
            }
            if (url.endsWith('/report')) {
                const payload = JSON.parse(options.body || '{}');
                if (payload.format === 'docx' || payload.format === 'pdf') {
                    return { format: payload.format, fileName: `法规查询报告.${payload.format}`, mimeType: 'application/octet-stream', contentBase64: 'AA==' };
                }
                return { format: 'md', markdown: '# 测试法规报告' };
            }
            if (url.includes('/category-folders')) {
                if (options.method === 'POST') {
                    const payload = JSON.parse(options.body || '{}');
                    const name = String(payload.name || '').trim();
                    const newFolder = {
                        category: name,
                        title: name,
                        documentCount: 0,
                        articleCount: 0,
                        effectiveCount: 0,
                        needsReviewCount: 0,
                        isCustom: true,
                        description: payload.description || ''
                    };
                    window.testCategoryFolders.push(newFolder);
                    return { success: true, message: '分类目录创建成功', category: newFolder };
                }
                if (options.method === 'DELETE') {
                    const category = decodeURIComponent(url.split('/category-folders/')[1]?.split('?')[0] || '');
                    window.testCategoryFolders = window.testCategoryFolders.filter(f => f.category !== category);
                    return { success: true, message: '分类目录已删除' };
                }
                return { folders: window.testCategoryFolders };
            }
            if (url.includes('/documents/folder-selection')) {
                const query = new URLSearchParams(url.split('?')[1]);
                const category = query.get('category');
                const governanceScope = query.get('governanceScope') || '';
                const data = window.testDocuments
                    .filter(item => (!category || item.category === category)
                        && (!governanceScope
                            || (governanceScope === 'version' && (!item.current_version_id || item.current_effect_status === 'unverified' || item.current_review_status !== 'approved'))
                            || (governanceScope === 'metadata' && (!item.legal_level || !item.official_source_url || item.metadata_review_status !== 'approved'))
                            || (governanceScope === 'maintainer' && !item.maintainer_user_id)
                            || (governanceScope === 'index' && item.current_index_status !== 'vector_ready')
                            || (governanceScope === 'location' && item.location_missing)))
                    .map(item => ({ id: item.id, title: item.title }));
                return { data, total: data.length, truncated: false, limit: 2000 };
            }
            if (url.includes('/search/hybrid') || url.includes('/documents/search')) {
                window.testSearchRequest = url;
                return { matches: [{ document_id: 1, version_id: 1, article_id: 11, document_title: '测试法规 1', article_label: '第一条', excerpt: '测试内容', retrieval: 'keyword' }] };
            }
            if (url.includes('/quality-summary')) {
                return { summary: {
                    documents: { total: 3, metadataNeedsReview: 1, missingMaintainer: 2 },
                    versions: { total: 3, governanceNeedsReview: 2, indexingIncomplete: 1, parsingIncomplete: 0 },
                    links: { unresolved: 1, needsReview: 1 },
                    locations: { total: 3, articlesWithoutLocation: 1 },
                    obligations: { total: window.testObligations.length, needsReview: window.testObligations.filter(item => item.review_status !== 'approved').length }
                } };
            }
            if (url.endsWith('/assignees')) {
                return { assignees: [{ id: 1, username: 'admin', nickname: '管理员', unit: '法务部' }, { id: 2, username: 'owner', nickname: '法规维护员', unit: '法务部' }] };
            }
            if (url.includes('/citation-governance')) {
                const query = new URLSearchParams(url.split('?')[1]);
                if (url.endsWith('/approve-high-confidence') && options.method === 'POST') {
                    window.testCitationLinks.filter(item => item.target_article_id && item.confidence >= 0.8 && item.review_status === 'auto').forEach(item => { item.review_status = 'approved'; });
                    return { result: { updated: 1, candidates: 1, minConfidence: 0.8 } };
                }
                if (url.endsWith('/review') && options.method === 'PUT') {
                    const payload = JSON.parse(options.body || '{}');
                    const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(id => String(id));
                    window.testCitationLinks.filter(item => ids.includes(String(item.id))).forEach(item => { item.review_status = payload.reviewStatus; });
                    return { result: { updated: payload.ids.length } };
                }
                const type = query.get('type') === 'review' ? 'review' : 'unresolved';
                const data = window.testCitationLinks.filter(item => type === 'review'
                    ? Boolean(item.target_article_id) && !['approved', 'rejected'].includes(item.review_status)
                    : !item.target_article_id && item.review_status !== 'rejected');
                return { type, data, total: data.length, limit: 200, offset: 0 };
            }
            if (url.endsWith('/cross-links/rebuild') && options.method === 'POST') {
                return { resolved: 0, versions: 3 };
            }
            const governanceUpdate = url.match(/\/documents\/(\d+)\/versions\/(\d+)\/governance$/);
            if (governanceUpdate && options.method === 'PUT') {
                const payload = JSON.parse(options.body || '{}');
                const document = window.testDocuments.find(item => item.id === Number(governanceUpdate[1]));
                if (document) {
                    if (payload.effectStatus !== undefined) document.current_effect_status = payload.effectStatus;
                    if (payload.reviewStatus !== undefined) document.current_review_status = payload.reviewStatus;
                }
                return { version: { id: Number(governanceUpdate[2]), effect_status: document?.current_effect_status, review_status: document?.current_review_status } };
            }
            const rebuildLocations = url.match(/\/documents\/(\d+)\/versions\/(\d+)\/rebuild-locations$/);
            if (rebuildLocations && options.method === 'POST') {
                const document = window.testDocuments.find(item => item.id === Number(rebuildLocations[1]));
                if (document) document.location_missing = false;
                return { result: { documentId: Number(rebuildLocations[1]), versionId: Number(rebuildLocations[2]), rebuilt: 10 } };
            }
            const reindex = url.match(/\/documents\/(\d+)\/versions\/(\d+)\/reindex$/);
            if (reindex && options.method === 'POST') {
                const document = window.testDocuments.find(item => item.id === Number(reindex[1]));
                if (document) document.current_index_status = 'vector_ready';
                return { version: { id: Number(reindex[2]), index_status: 'vector_ready' } };
            }
            const documentUpdate = url.match(/\/documents\/(\d+)$/);
            if (documentUpdate && options.method === 'PUT') {
                const payload = JSON.parse(options.body || '{}');
                const document = window.testDocuments.find(item => item.id === Number(documentUpdate[1]));
                if (document) {
                    Object.entries(payload).forEach(([key, value]) => {
                        const field = ({ legalLevel: 'legal_level', officialSourceUrl: 'official_source_url', metadataReviewStatus: 'metadata_review_status', maintainerUserId: 'maintainer_user_id', issuingBody: 'issuing_body' })[key] || key;
                        document[field] = value;
                    });
                }
                return { document };
            }
            const detailRequest = url.match(/\/documents\/(\d+)(?:\?|$)/);
            if (detailRequest && options.method !== 'PUT') {
                const document = window.testDocuments.find(item => item.id === Number(detailRequest[1]));
                const currentVersion = document ? {
                    id: document.current_version_id,
                    version_label: document.current_version_label,
                    effect_status: document.current_effect_status,
                    review_status: document.current_review_status,
                    source_url: '', published_at: '', effective_from: '', effective_to: ''
                } : null;
                return { detail: document ? { document, currentVersion, versions: [currentVersion], articles: [] } : null };
            }
            if (url.includes('/ai-logs')) {
                return { data: [{
                    id: 61, question: '测试问答问题', answer: '测试问答回答。', model_name: '测试模型',
                    context_snapshot: '[1] 测试法规 / v1 / 第一条\n测试依据。',
                    sources_json: [{ label: '测试法规 / v1 / 第一条' }], created_at: '2026-10-12 12:00:00'
                }], total: 1, limit: 30 };
            }
            if (url.includes('/documents/') && url.includes('/bookmarks') && options.method === 'POST') {
                const documentId = Number(url.match(/documents\/(\d+)\/bookmarks/)?.[1]);
                const payload = JSON.parse(options.body || '{}');
                let bookmark = window.testBookmarks.find(item => item.document_id === documentId);
                if (bookmark) Object.assign(bookmark, { topic: payload.topic || '', note: payload.note || '' });
                else {
                    bookmark = { id: window.testBookmarks.length + 81, document_id: documentId, document_title: `测试法规 ${documentId}`, category: '法律', issuing_body: `发布机构 ${documentId}`, current_version_label: 'v1', topic: payload.topic || '', note: payload.note || '' };
                    window.testBookmarks.push(bookmark);
                }
                return { bookmark };
            }
            if (url.includes('/bookmarks')) {
                const bookmarkId = Number(url.match(/bookmarks\/(\d+)$/)?.[1]);
                if (bookmarkId && options.method === 'DELETE') {
                    window.testBookmarks = window.testBookmarks.filter(item => item.id !== bookmarkId);
                    return { success: true };
                }
                const documentId = Number(new URLSearchParams(url.split('?')[1]).get('documentId') || 0);
                return { bookmarks: documentId ? window.testBookmarks.filter(item => item.document_id === documentId) : window.testBookmarks };
            }
            if (url.includes('/recycle-bin')) {
                const restoreId = Number(url.match(/recycle-bin\/(\d+)\/restore/)?.[1]);
                if (restoreId && options.method === 'POST') {
                    const restored = window.testRecycleBin.find(item => item.id === restoreId);
                    window.testRecycleBin = window.testRecycleBin.filter(item => item.id !== restoreId);
                    if (restored) window.testDocuments.push({ ...restored, status: 'active', jurisdiction: '全国', issuing_body: '测试机构', current_version_label: 'v1', summary: '' });
                    return { document: restored };
                }
                return { data: window.testRecycleBin, total: window.testRecycleBin.length, limit: 100 };
            }
            if (url.includes('/subscriptions')) {
                if (options.method === 'POST') {
                    window.testSubscriptionActive = true;
                    return { subscription: { status: 'active' } };
                }
                if (options.method === 'DELETE') {
                    window.testSubscriptionActive = false;
                    return { success: true };
                }
                return { subscriptions: window.testSubscriptionActive ? [{ id: 1, status: 'active' }] : [] };
            }
            if (url.includes('/obligations')) {
                if (url.includes('/review') && options.method === 'PUT') {
                    const id = Number(url.match(/obligations\/(\d+)\/review/)?.[1]);
                    const item = window.testObligations.find(row => row.id === id);
                    if (item) Object.assign(item, { review_status: 'approved', status: 'active' });
                    return { obligation: item };
                }
                if (options.method === 'POST') {
                    const payload = JSON.parse(options.body || '{}');
                    const item = { id: 72, article_label: '第一条', review_status: 'pending', status: 'draft', required_action: payload.requiredAction || '' };
                    window.testObligations.push(item);
                    return { obligation: item };
                }
                return { obligations: window.testObligations, assignees: [{ id: 1, username: 'admin', nickname: '管理员', unit: '法务部' }] };
            }
            if (url.endsWith('/documents/preview')) {
                window.testPreviewRequest = [...options.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : value.name]);
                return window.testPreview;
            }
            if (url.includes('/documents/import-jobs')) {
                if (options.method === 'POST') {
                    window.testImportJobRequest = [...options.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : value.name]);
                    window.testImportJobs = [{ id: 1, source_name: '预览法规.txt', status: 'queued', stage: 'queued', progress: 0, result: {} }];
                    return { total: 1, jobs: window.testImportJobs, failed: [] };
                }
                return { data: window.testImportJobs, total: window.testImportJobs.length, limit: 30 };
            }
            if (url.includes('/import-jobs')) {
                const retryId = Number(url.match(/import-jobs\/(\d+)\/retry/)?.[1]);
                const cancelId = Number(url.match(/import-jobs\/(\d+)$/)?.[1]);
                if (retryId && options.method === 'POST') {
                    const job = window.testImportJobs.find(item => item.id === retryId);
                    if (job) Object.assign(job, { status: 'queued', stage: 'queued', progress: 0, attempts: 0, errorMessage: '' });
                    return { job };
                }
                if (cancelId && options.method === 'DELETE') {
                    const job = window.testImportJobs.find(item => item.id === cancelId);
                    if (job) Object.assign(job, { status: 'cancelled', stage: 'cancelled', errorMessage: '导入任务已由用户取消。' });
                    return { job };
                }
                return { data: window.testImportJobs, total: window.testImportJobs.length, limit: 30 };
            }
            if (url.endsWith('/batch-update')) {
                const payload = JSON.parse(options.body);
                window.testUpdates.push(payload);
                if (window.testRequestError) throw new Error('请求失败，请稍后重试');
                const updated = [];
                const failed = [];
                for (const id of payload.ids) {
                    if (window.testFailures.includes(id)) {
                        failed.push({ documentId: id, message: '修改失败，请稍后重试' });
                        continue;
                    }
                    const document = window.testDocuments.find(doc => doc.id === id);
                    for (const [key, value] of Object.entries(payload.patch)) {
                        const field = ({
                            issuingBody: 'issuing_body',
                            legalLevel: 'legal_level',
                            officialSourceUrl: 'official_source_url',
                            metadataReviewStatus: 'metadata_review_status',
                            maintainerUserId: 'maintainer_user_id',
                            effectStatus: 'current_effect_status',
                            reviewStatus: 'current_review_status'
                        })[key] || key;
                        document[field] = value;
                    }
                    updated.push(document);
                }
                return { total: payload.ids.length, updated, failed, batchId: updated.length ? '测试批量记录-1' : null };
            }
            if (url.endsWith('/documents/batch-reindex') && options.method === 'POST') {
                const payload = JSON.parse(options.body || '{}');
                const queuedDocumentIds = (payload.ids || []).map(Number).filter(id => {
                    const document = window.testDocuments.find(item => item.id === id && item.current_version_id);
                    if (!document) return false;
                    document.current_index_status = 'retry_wait';
                    return true;
                });
                return { result: { total: (payload.ids || []).length, queuedVersions: queuedDocumentIds.length, queuedDocumentIds, clearedArticles: queuedDocumentIds.length * 10, failed: [] } };
            }
            if (url.endsWith('/documents/batch-rebuild-locations') && options.method === 'POST') {
                const payload = JSON.parse(options.body || '{}');
                const rebuilt = (payload.ids || []).map(Number).flatMap(id => {
                    const document = window.testDocuments.find(item => item.id === id && item.current_version_id);
                    if (!document) return [];
                    document.location_missing = false;
                    return [{ documentId: id, rebuilt: 10 }];
                });
                return { result: { total: (payload.ids || []).length, rebuilt, rebuiltArticles: rebuilt.reduce((sum, item) => sum + item.rebuilt, 0), failed: [] } };
            }
            if (url.endsWith('/documents/reindex')) {
                const payload = JSON.parse(options.body || '{}');
                window.testReindexRequests.push(payload);
                return { result: { queuedVersions: 2, clearedArticles: 20, scope: payload.category || (payload.uncategorized ? 'uncategorized' : 'all') } };
            }
            if (url.endsWith('/batch-revert')) {
                const payload = JSON.parse(options.body || '{}');
                window.testBatchUndo.push(payload);
                for (const document of window.testDocuments) {
                    if (document.id === 1) Object.assign(document, { category: '法律', issuing_body: '发布机构 1' });
                    if (document.id === 2) Object.assign(document, { category: '部门规章', issuing_body: '发布机构 2' });
                }
                return { reverted: window.testDocuments.slice(0, 2), failed: [] };
            }
            if (url.endsWith('/batch-delete')) {
                const ids = JSON.parse(options.body).ids;
                window.testRequests.push(ids);
                if (window.testRequestError) throw new Error('请求失败，请稍后重试');
                const deleted = ids.filter(id => !window.testFailures.includes(id));
                const failed = ids.filter(id => window.testFailures.includes(id)).map(documentId => ({ documentId, message: '删除失败，请稍后重试' }));
                window.testDocuments = window.testDocuments.filter(doc => !deleted.includes(doc.id));
                return { total: ids.length, deleted, failed };
            }
            if (window.testRefreshError) throw new Error('列表刷新失败');
            window.testDocumentListUrls.push(url);
            const params = new URLSearchParams(url.split('?')[1]);
            const offset = Number(params.get('offset'));
            const limit = Number(params.get('limit'));
            const category = params.get('category');
            const uncategorized = params.get('uncategorized') === 'true';
            const governancePending = params.get('governancePending') === 'true';
            const governanceScope = params.get('governanceScope') || (governancePending ? 'version' : '');
            const documents = window.testDocuments.filter(document => (
                (uncategorized ? !document.category : (!category || document.category === category))
                && (!governanceScope
                    || (governanceScope === 'version' && (!document.current_version_id || document.current_effect_status === 'unverified' || document.current_review_status !== 'approved'))
                    || (governanceScope === 'metadata' && (!document.legal_level || !document.official_source_url || document.metadata_review_status !== 'approved'))
                    || (governanceScope === 'maintainer' && !document.maintainer_user_id)
                    || (governanceScope === 'index' && document.current_index_status !== 'vector_ready')
                    || (governanceScope === 'location' && document.location_missing))
            ));
            return { data: documents.slice(offset, offset + limit), total: documents.length, limit };
        };
    });
    const modules = ['render-base', 'render-batch', 'render-shell', 'render-documents', 'render-results', 'actions-core', 'actions-batch', 'actions-batch-edit'];
    if (includeAdvanced) modules.push('actions-import', 'actions-governance', 'actions-advanced');
    modules.push('events');
    for (const file of modules) {
        await page.addScriptTag({ path: path.join(root, 'client/chat/regulations', `${file}.js`) });
    }
    await page.evaluate(async () => {
        const ns = window.Pivot.legacy.PivotRegulationsInternal;
        ns.renderShell();
        document.getElementById('regulations-view').classList.remove('hidden');
        ns.state.libraryView = 'documents';
        await ns.loadDocuments();
    });
    if (batchMode) await page.locator('#regulations-batch-mode-btn').click();
    return page;
}

module.exports = { createPage };
