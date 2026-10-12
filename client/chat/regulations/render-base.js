(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderBaseReady) return;

    const { API, state, REGULATIONS_PAGE_SIZE, esc, canManage, canDeleteDocuments } = ns;
    const loadDocuments = (...args) => ns.loadDocuments?.(...args);
        function renderRegulationStatusCell(doc) {
                        const chips = [];
                        if (doc?.status === 'archived') chips.push('<span class="regulations-status-pill archived">已归档</span>');
                        if (!chips.length) chips.push('<span class="regulations-status-pill active">已启用</span>');
                        const effectLabels = { unverified: '效力待核验', pending: '待生效', effective: '现行有效', expired: '已失效', repealed: '已废止' };
                        const effectStatus = String(doc?.current_effect_status || 'unverified');
                        chips.push(`<span class="regulations-status-pill ${esc(effectStatus)}">${esc(effectLabels[effectStatus] || '效力待核验')}</span>`);
                        return `<span class="regulations-status-cell">${chips.join('')}</span>`;
                    }

                    function renderRegulationActions(doc) {
                        const actions = [
                            `<button class="btn-secondary regulations-row-action" type="button" data-regulation-open-doc="${esc(doc.id)}">查看</button>`
                        ];
                        if (canManage() && doc?.current_version_id) {
                            actions.push(`<a class="btn-secondary regulations-row-action" href="${API}/documents/${encodeURIComponent(doc.id)}/download?versionId=${encodeURIComponent(doc.current_version_id)}">下载</a>`);
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
            renderRegulationActions,
            getRegulationsPageSummary,
            renderRegulationsSummary,
            renderDocumentsPagination,
            renderBaseReady: true
        });
})();
