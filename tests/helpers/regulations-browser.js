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
            current_version_label: '2024 年修订', summary: `摘要 ${id}`
        }));
        window.testCategoryFolders = [
            { title: '法律', category: '法律', documentCount: 2, articleCount: 20, effectiveCount: 1, needsReviewCount: 1, latestUpdatedAt: '2026-10-12 12:00:00', isUncategorized: false },
            { title: '部门规章', category: '部门规章', documentCount: 1, articleCount: 10, effectiveCount: 0, needsReviewCount: 1, latestUpdatedAt: '2026-10-11 12:00:00', isUncategorized: false }
        ];
        window.testRequests = [];
        window.testUpdates = [];
        window.testBatchUndo = [];
        window.testFailures = [];
        window.testConfirmed = true;
        window.testImportJobs = [];
        window.testSubscriptionActive = false;
        window.testBookmarks = [];
        window.testRecycleBin = [{ id: 91, title: '已删除测试法规', category: '法律', deleted_at: '2026-10-12 12:00:00' }];
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
                return { folders: window.testCategoryFolders };
            }
            if (url.includes('/documents/folder-selection')) {
                const query = new URLSearchParams(url.split('?')[1]);
                const category = query.get('category');
                const data = window.testDocuments
                    .filter(item => !category || item.category === category)
                    .map(item => ({ id: item.id, title: item.title }));
                return { data, total: data.length, truncated: false, limit: 2000 };
            }
            if (url.includes('/search/hybrid') || url.includes('/documents/search')) {
                window.testSearchRequest = url;
                return { matches: [{ document_id: 1, version_id: 1, article_id: 11, document_title: '测试法规 1', article_label: '第一条', excerpt: '测试内容', retrieval: 'keyword' }] };
            }
            if (url.includes('/quality-summary')) {
                return { summary: {
                    documents: { total: 3, metadataNeedsReview: 1, missingMaintainer: 1 },
                    versions: { total: 3, governanceNeedsReview: 2, indexingIncomplete: 0, parsingIncomplete: 0 },
                    links: { unresolved: 1, needsReview: 2 },
                    locations: { total: 3, articlesWithoutLocation: 1 },
                    obligations: { total: window.testObligations.length, needsReview: window.testObligations.filter(item => item.review_status !== 'approved').length }
                } };
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
                        document[key === 'issuingBody' ? 'issuing_body' : key] = value;
                    }
                    updated.push(document);
                }
                return { total: payload.ids.length, updated, failed, batchId: updated.length ? '测试批量记录-1' : null };
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
            const params = new URLSearchParams(url.split('?')[1]);
            const offset = Number(params.get('offset'));
            const limit = Number(params.get('limit'));
            const category = params.get('category');
            const uncategorized = params.get('uncategorized') === 'true';
            const documents = window.testDocuments.filter(document => (
                uncategorized ? !document.category : (!category || document.category === category)
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
