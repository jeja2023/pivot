(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderBaseReady) return;

    const { API, state, REGULATIONS_PAGE_SIZE, esc, canManage, canDeleteDocuments } = ns;
    const loadDocuments = (...args) => ns.loadDocuments?.(...args);
        function isRegulationGovernancePending(doc = {}) {
                        return !doc?.current_version_id
                            || String(doc.current_effect_status || 'unverified') === 'unverified'
                            || String(doc.current_review_status || 'pending') !== 'approved';
                    }
        function renderRegulationStatusCell(doc) {
            const isArchived = doc?.status === 'archived';
            const effectLabels = { unverified: '效力待核验', pending: '待生效', effective: '现行有效', expired: '已失效', repealed: '已废止' };
            const effectStatus = String(doc?.current_effect_status || 'unverified');
            const effectText = effectLabels[effectStatus] || '效力待核验';

            const metadataReviewLabels = { unreviewed: '待审核', approved: '已审核', rejected: '已驳回' };
            const metadataReviewStatus = String(doc?.metadata_review_status || 'unreviewed');
            const metadataReviewText = metadataReviewLabels[metadataReviewStatus] || '待审核';
            // 元数据审核和当前版本审核是两条独立治理线。列表“管理/效力”列
            // 应展示文档元数据状态，不能误用 current_review_status。
            const metadataReviewClass = metadataReviewStatus === 'unreviewed' ? 'pending' : metadataReviewStatus;

            // 效力状态徽章（核心法学属性，配轻量圆点指示器）
            const effectChip = `<span class="regulations-status-pill ${esc(effectStatus)}" title="效力状态：${esc(effectText)}"><span class="regulations-status-dot" aria-hidden="true"></span>${esc(effectText)}</span>`;

            // 治理与管理状态徽章：归档显式标记；启用状态展示元数据审核结论
            const secondaryChip = isArchived
                ? '<span class="regulations-status-pill archived" title="管理状态：已归档">已归档</span>'
                : `<span class="regulations-status-pill review-${esc(metadataReviewClass)}" title="元数据审核：${esc(metadataReviewText)}">${esc(metadataReviewText)}</span>`;

            const indexStatus = String(doc?.current_index_status || 'lexical_ready');
            const indexLabels = { vector_ready: '向量已就绪', indexing: '索引中', retry_wait: '索引待重试', lexical_ready: '关键词检索' };
            const indexText = indexLabels[indexStatus] || '索引待处理';
            const indexChip = indexStatus === 'vector_ready'
                ? ''
                : `<span class="regulations-status-pill review-pending" title="${esc(doc?.current_index_error || indexText)}">${esc(indexText)}</span>`;

            const fullTitle = `管理状态：${isArchived ? '已归档' : '已启用'} | 效力状态：${effectText} | 元数据审核：${metadataReviewText}`;
            return `<span class="regulations-status-cell" title="${esc(`${fullTitle} | 索引状态：${indexText}`)}">${effectChip}${secondaryChip}${indexChip}</span>`;
        }

                    function renderRegulationActions(doc) {
                        const actions = [
                            `<button class="btn-secondary regulations-row-action" type="button" data-regulation-open-doc="${esc(doc.id)}">查看</button>`
                        ];
                        const scope = String(state.governanceScope || '');
                        if (canManage() && doc?.current_version_id) {
                            actions.push(`<a class="btn-secondary regulations-row-action" href="${API}/documents/${encodeURIComponent(doc.id)}/download?versionId=${encodeURIComponent(doc.current_version_id)}">下载</a>`);
                        }
                        if (canManage() && scope === 'version' && isRegulationGovernancePending(doc)) {
                            actions.push(doc?.current_version_id
                                ? `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-governance-document="${esc(doc.id)}" data-regulation-governance-version="${esc(doc.current_version_id)}">处理治理</button>`
                                : `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-add-version="${esc(doc.id)}">补充版本</button>`);
                        }
                        if (canManage() && ['metadata', 'maintainer'].includes(scope)) {
                            const label = scope === 'metadata' ? '审核元数据' : '指派维护人';
                            actions.push(`<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-document-governance="${esc(doc.id)}" data-regulation-governance-version="${esc(doc.current_version_id || '')}" data-regulation-governance-scope="${esc(scope)}">${label}</button>`);
                        }
                        if (canManage() && scope === 'index') {
                            actions.push(doc?.current_version_id
                                ? `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-reindex-document="${esc(doc.id)}" data-regulation-reindex-version="${esc(doc.current_version_id)}">重建索引</button>`
                                : `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-add-version="${esc(doc.id)}">补充版本</button>`);
                        }
                        if (canManage() && scope === 'location') {
                            actions.push(doc?.current_version_id
                                ? `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-rebuild-locations-document="${esc(doc.id)}" data-regulation-rebuild-locations-version="${esc(doc.current_version_id)}">重建定位</button>`
                                : `<button class="btn-secondary regulations-row-action regulations-governance-action" type="button" data-regulation-add-version="${esc(doc.id)}">补充版本</button>`);
                        }
                        if (canDeleteDocuments()) {
                            actions.push(`<button class="btn-danger-outline regulations-row-action" type="button" data-regulation-delete="${esc(doc.id)}">删除</button>`);
                        }
                        return `<div class="regulations-row-actions">${actions.join('')}</div>`;
                    }

                    function getRegulationsPageSummary() {
                        const total = Number(state.total || 0);
                        const pageSize = Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
                        const totalPages = Math.max(Math.ceil(total / pageSize), 1);
                        const page = Math.min(Math.max(Number(state.page || 1), 1), totalPages);
                        return `第 ${page} / ${totalPages} 页`;
                    }

                    function renderRegulationsSummary() {
                        const target = document.getElementById('regulations-summary');
                        if (!target) return;
                        if (state.libraryView === 'folders') {
                            const folders = Array.isArray(state.categoryFolders) ? state.categoryFolders : [];
                            const documentCount = folders.reduce((sum, folder) => sum + Number(folder.documentCount || 0), 0);
                            const articleCount = folders.reduce((sum, folder) => sum + Number(folder.articleCount || 0), 0);
                            const effectiveCount = folders.reduce((sum, folder) => sum + Number(folder.effectiveCount || 0), 0);
                            const needsReviewCount = folders.reduce((sum, folder) => sum + Number(folder.needsReviewCount || 0), 0);
                            const chips = [`${documentCount} 文档`, `${folders.length} 分类目录`, `${articleCount} 条文`, `${effectiveCount} 已核验现行`, `${needsReviewCount} 待治理`];
                            PivotSafeHtml.setHtml(target, chips.map(text => `<span class="regulations-summary-pill">${esc(text)}</span>`).join(''));
                            return;
                        }
                        const docs = Array.isArray(state.documents) ? state.documents : [];
                        const articleCount = docs.reduce((sum, doc) => sum + Number(doc.article_count || 0), 0);
                        const archivedCount = docs.filter(doc => doc.status === 'archived').length;
                        const activeCount = Math.max(docs.length - archivedCount, 0);
                        const categories = new Set(docs.map(doc => doc.category).filter(Boolean));
                        const jurisdictions = new Set(docs.map(doc => doc.jurisdiction).filter(Boolean));
                        const chips = [
                            `${Number(state.total || 0)} 文档`,
                            `${docs.length} 本页`,
                            `${activeCount} 有效`,
                            `${archivedCount} 已归档`,
                            `${articleCount} 条文`,
                            `${categories.size} 分类`,
                            `${jurisdictions.size} 适用范围`,
                            getRegulationsPageSummary()
                        ];
                        PivotSafeHtml.setHtml(target, chips.map(text => `<span class="regulations-summary-pill">${esc(text)}</span>`).join(''));
                    }

                    function renderDocumentsPagination() {
                        if (typeof window.Pivot.legacy.renderWorkspacePagination !== 'function') return;
                        window.Pivot.legacy.renderWorkspacePagination('regulations-pagination', {
                            total: state.total,
                            page: state.page,
                            limit: state.pageSize,
                            onPageChange: targetPage => loadDocuments({ page: targetPage, keepActive: true })
                        });
                    }

        Object.assign(ns, {
            renderRegulationStatusCell,
            isRegulationGovernancePending,
            renderRegulationActions,
            getRegulationsPageSummary,
            renderRegulationsSummary,
            renderDocumentsPagination,
            renderBaseReady: true
        });
})();
