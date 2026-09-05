/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderBaseReady) return;
    with (ns) {
        function renderRegulationStatusCell(doc) {
                        const chips = [];
                        if (doc?.status === 'archived') chips.push('<span class="regulations-status-pill archived">已归档</span>');
                        if (!chips.length) chips.push('<span class="regulations-status-pill active">有效</span>');
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
    }
})();
