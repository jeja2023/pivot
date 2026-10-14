(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsGovernanceReady) return;

    const { API, state, esc, toast, fetchJson, regulationConfirm, fmtDate, canManage } = ns;
    const setBusy = (...args) => ns.setBusy?.(...args);
    const collectForm = (...args) => ns.collectForm?.(...args);
    const loadDocuments = (...args) => ns.loadDocuments?.(...args);
    const loadDetail = (...args) => ns.loadDetail?.(...args);
    let citationSelectedIds = new Set();

    async function showAnnotations(articleId) {
        const panel = document.getElementById('regulations-annotation-panel');
        const body = document.getElementById('regulations-annotation-body');
        if (!panel || !body) return;
        panel.dataset.articleId = articleId;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载批注…</div>');
        try {
            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`);
            renderAnnotations(body, Array.isArray(resp.annotations) ? resp.annotations : [], articleId);
        } catch (e) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(e.message || '加载批注失败')}</div>`);
        }
    }

    async function showAccessLogs(documentId) {
        const panel = document.getElementById('regulations-access-log-panel');
        const body = document.getElementById('regulations-access-log-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载访问记录…</div>');
        try {
            const data = await fetchJson(`${API}/access-logs?documentId=${encodeURIComponent(documentId)}&limit=100`);
            const rows = Array.isArray(data.data) ? data.data : [];
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead>
                        <tbody>${rows.map(row => `<tr><td>${esc(fmtDate(row.created_at))}</td><td>${esc(row.user_name || '-')}</td><td>${esc(row.action || '-')}</td><td>${esc(row.detail || '-')}</td></tr>`).join('')}</tbody>
                    </table>
                </div>` : '<div class="regulations-empty compact">暂无访问记录</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载访问记录失败')}</div>`);
        }
    }

    async function showRegulationAiLogs(documentId) {
        const panel = document.getElementById('regulations-ai-log-panel');
        const body = document.getElementById('regulations-ai-log-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取问答审计记录…</div>');
        try {
            const data = await fetchJson(`${API}/ai-logs?documentId=${encodeURIComponent(documentId)}&limit=30`);
            const rows = Array.isArray(data.data) ? data.data : [];
            const sourceLabels = item => {
                const sources = Array.isArray(item.sources_json) ? item.sources_json : [];
                return sources.map(source => source.label || '').filter(Boolean).join('；') || '未命中可用依据';
            };
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="regulations-ai-audit-list">
                    ${rows.map(row => `<article class="regulations-ai-audit-item">
                        <div class="regulations-annotation-meta"><strong>${esc(row.question || '未命名问题')}</strong><span>${esc(fmtDate(row.created_at))}</span></div>
                        <div class="regulations-ai-audit-model">模型：${esc(row.model_name || '-')} · 依据：${esc(sourceLabels(row))}</div>
                        <details><summary>查看回答与依据快照</summary><div class="regulations-ai-audit-answer">${esc(row.answer || '模型未返回正文')}</div><div class="regulations-ai-audit-context">${esc(row.context_snapshot || '未保存上下文快照')}</div></details>
                    </article>`).join('')}
                </div>` : '<div class="regulations-empty compact">该法规暂无你的问答记录。</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载问答记录失败')}</div>`);
        }
    }

    async function showArticleLocations(articleId) {
        const panel = document.getElementById('regulations-location-panel');
        const body = document.getElementById('regulations-location-body');
        if (!panel || !body || !articleId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取条文来源定位…</div>');
        try {
            const data = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/locations`);
            const locations = Array.isArray(data.locations) ? data.locations : [];
            const source = data.source || {};
            const article = data.article || {};
            const firstPage = Number(locations[0]?.page_number || 1);
            const sourceAction = source.downloadUrl ? `
                <div class="regulations-admin-actions regulations-source-actions">
                    ${source.previewUrl ? `<a class="btn-secondary" href="${esc(source.previewUrl)}#page=${firstPage}" target="_blank" rel="noopener">打开来源 PDF（第 ${firstPage} 页）</a>` : ''}
                    <a class="btn-secondary" href="${esc(source.downloadUrl)}" target="_blank" rel="noopener">下载同版本原文件${source.fileName ? `：${esc(source.fileName)}` : ''}</a>
                </div>` : '';
            const rebuildAction = !locations.length && canManage?.() && article.documentId && article.versionId
                ? `<div class="regulations-admin-actions"><button type="button" class="btn-primary" data-regulation-rebuild-locations-document="${esc(article.documentId)}" data-regulation-rebuild-locations-version="${esc(article.versionId)}">重新生成来源定位</button></div>`
                : '';
            PivotSafeHtml.setHtml(body, locations.length ? `
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>页码</th><th>字符范围</th><th>定位置信度</th></tr></thead>
                        <tbody>${locations.map(location => `<tr><td>第 ${Number(location.page_number || 1)} 页</td><td>${Number(location.char_start || 0)} - ${Number(location.char_end || 0)}</td><td>${Math.round(Number(location.confidence || 0) * 100)}%</td></tr>`).join('')}</tbody>
                    </table>
                </div>${sourceAction}` : `<div class="regulations-empty compact">该条文尚未生成可用来源定位。可根据当前版本已抽取正文重新生成；正文缺失时请补充原始文件并重新解析。</div>${rebuildAction}${sourceAction}`);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载条文来源定位失败')}</div>`);
        }
    }

    const GOVERNANCE_SCOPE_CONFIG = {
        metadata: {
            title: '元数据待审核法规',
            description: '补齐法规层级、权威来源等字段，并确认元数据审核状态。',
            notice: '处理元数据',
            focus: '[name="legalLevel"]'
        },
        maintainer: {
            title: '缺少维护人法规',
            description: '为法规指派明确维护人，后续版本、来源和效力变更由维护人持续治理。',
            notice: '指派维护人',
            focus: '[name="maintainerUserId"]'
        },
        version: {
            title: '待治理法规',
            description: '仅显示当前版本效力待核验、审核未通过或缺少当前版本的法规；请逐条确认后保存。',
            notice: '确认效力与审核状态',
            focus: '[name="effectStatus"]'
        },
        index: {
            title: '索引未完成法规',
            description: '检查当前版本向量索引状态；可重新加入索引队列，不会重新 OCR 或解析原文件。',
            notice: '重建向量索引',
            focus: ''
        },
        location: {
            title: '条文缺少定位法规',
            description: '根据当前版本已抽取正文重新生成页码与字符位置；正文缺失时需补充原文件并重新解析。',
            notice: '重建来源定位',
            focus: ''
        }
    };

    function normalizeGovernanceScope(scope) {
        return Object.hasOwn(GOVERNANCE_SCOPE_CONFIG, scope) ? scope : 'version';
    }

    function governanceScopeConfig(scope = state.governanceScope) {
        return GOVERNANCE_SCOPE_CONFIG[normalizeGovernanceScope(scope)];
    }

    function renderQualityMetric(label, value, hint = '', action = '') {
        return `<div class="regulations-quality-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}${action}</div>`;
    }

    async function loadGovernanceAssignees() {
        if (!canManage?.()) return [];
        const data = await fetchJson(`${API}/assignees`);
        state.governanceAssignees = Array.isArray(data.assignees) ? data.assignees : [];
        return state.governanceAssignees;
    }

    async function openGovernanceWorklist(scope = 'version') {
        if (!canManage?.()) return;
        const config = governanceScopeConfig(scope);
        state.governanceScope = normalizeGovernanceScope(scope);
        state.governancePending = state.governanceScope === 'version';
        state.libraryView = 'documents';
        state.activeFolder = null;
        state.page = 1;
        state.batchMode = false;
        state.selectedDocumentIds.clear();
        state.selectedDocumentTitles.clear();
        document.getElementById('regulations-quality-panel')?.classList.add('hidden');
        try {
            await loadDocuments({ keepActive: false, page: 1 });
            toast(`已打开${config.title}队列，请${config.notice}`, 'info');
        } catch (error) {
            toast(error.message || `加载${config.title}失败`, 'error');
        }
    }

    async function openDocumentGovernance(documentId, versionId = '', scope = state.governanceScope) {
        if (!documentId || !canManage?.()) return;
        const config = governanceScopeConfig(scope);
        try {
            // 编辑表单始终会回传维护人字段；所有治理入口先加载候选项，避免
            // 从“版本待治理”进入时因下拉框为空而把既有维护人误保存为空。
            await loadGovernanceAssignees();
            await loadDetail(documentId, versionId);
            const editForm = document.getElementById('regulations-edit-form');
            const versionForm = document.getElementById('regulations-version-form');
            if (!editForm) return;
            editForm.classList.remove('hidden');
            versionForm?.classList.add('hidden');
            window.setTimeout(() => editForm.querySelector(config.focus || '[name="title"]')?.focus(), 0);
        } catch (error) {
            toast(error.message || `打开${config.title}表单失败`, 'error');
        }
    }

    async function openVersionGovernance(documentId, versionId = '') {
        return await openDocumentGovernance(documentId, versionId, 'version');
    }

    async function requestRegulationLocationRebuild(documentId, versionId) {
        if (!documentId || !versionId || !canManage?.()) return;
        if (!(await regulationConfirm('重建条文来源定位', '将依据当前版本已抽取正文重新生成条文页码与字符定位；不会重新上传或修改法规正文。确认继续？'))) return;
        setBusy(true, '正在重建条文来源定位…');
        try {
            const data = await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/rebuild-locations`, { method: 'POST' });
            toast(`已生成 ${Number(data.result?.rebuilt || 0)} 条来源定位`, 'success');
            await loadDocuments({ keepActive: true, page: state.page });
            if (String(state.activeId) === String(documentId)) await loadDetail(documentId, versionId);
        } catch (error) {
            toast(error.message || '重建条文来源定位失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function citationReviewLabel(status) {
        return ({ approved: '已确认', rejected: '已标记外部/不采用', pending: '待审核', auto: '待审核' })[String(status || '').toLowerCase()] || '待审核';
    }

    function citationRelationBadge(type) {
        const key = String(type || '').toLowerCase();
        if (key === 'depend') {
            return '<span class="regulations-relation-badge relation-depend" title="从属/法律依据关系">依据</span>';
        }
        if (key === 'cite') {
            return '<span class="regulations-relation-badge relation-cite" title="引用/参见条文">引用</span>';
        }
        if (key === 'supersede') {
            return '<span class="regulations-relation-badge relation-supersede" title="废止/替代关系">废止</span>';
        }
        if (key === 'amend') {
            return '<span class="regulations-relation-badge relation-amend" title="修正/修订关系">修正</span>';
        }
        const fallbackRelation = esc(type || '引用');
        const customTitle = `引用关系类型：${fallbackRelation}`;
        return `<span class="regulations-relation-badge relation-other" title="${customTitle}">${fallbackRelation}</span>`;
    }

    function citationConfidenceBadge(confidence) {
        const pct = Math.round(Number(confidence || 0) * 100);
        if (pct >= 80) {
            return `<span class="regulations-conf-badge conf-high" title="高置信度（≥80%），可安全批量确认">${pct}%</span>`;
        }
        if (pct >= 60) {
            return `<span class="regulations-conf-badge conf-mid" title="中置信度（60%~79%），建议人工核验">${pct}%</span>`;
        }
        return `<span class="regulations-conf-badge conf-low" title="低置信度（<60%），需人工仔细核查">${pct}%</span>`;
    }

    function citationStatusBadge(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'approved') {
            return '<span class="regulations-review-status-badge status-approved"><span class="regulations-status-dot"></span>已确认</span>';
        }
        if (s === 'rejected') {
            return '<span class="regulations-review-status-badge status-rejected"><span class="regulations-status-dot"></span>已标记外部</span>';
        }
        return '<span class="regulations-review-status-badge status-pending"><span class="regulations-status-dot"></span>待审核</span>';
    }

    function renderCitationGovernanceRows(rows, type) {
        if (!rows.length) return '<tr><td colspan="8" class="text-center regulations-citation-empty-td">当前没有需要处理的引用</td></tr>';
        return rows.map((item, index) => {
            const selected = citationSelectedIds.has(String(item.id));
            const action = type === 'unresolved'
                ? `<button type="button" class="btn-secondary regulations-row-action regulations-citation-btn-external" data-regulation-citation-review="rejected" data-regulation-citation-id="${esc(item.id)}" title="确属外部资料，标记为外部引用">标记外部引用</button>`
                : `<button type="button" class="btn-secondary regulations-row-action regulations-citation-btn-approve" data-regulation-citation-review="approved" data-regulation-citation-id="${esc(item.id)}" title="确认此引用关系">确认</button><button type="button" class="btn-secondary regulations-row-action regulations-citation-btn-reject" data-regulation-citation-review="rejected" data-regulation-citation-id="${esc(item.id)}" title="驳回此引用关系">驳回</button>`;

            const docTitle = item.document_title || '未命名法规';
            const articleParts = [item.source_article_label, item.source_article_title].filter(Boolean);
            const articleText = articleParts.join(' ') || '未定位条文';
            const fullSourceTooltip = `${docTitle} · ${articleText}`;

            const targetLabel = item.target_label || '-';
            const evidenceTooltip = item.evidence_excerpt ? `${targetLabel} (依据: ${item.evidence_excerpt})` : targetLabel;

            let articleLabelHtml = '';
            if (item.source_article_label) {
                articleLabelHtml = `<span class="regulations-citation-article-label">${esc(item.source_article_label)}</span>`;
            }
            let articleNameHtml = '';
            if (item.source_article_title) {
                articleNameHtml = `<span class="regulations-citation-article-name">${esc(item.source_article_title)}</span>`;
            } else if (!item.source_article_label) {
                articleNameHtml = '<span class="regulations-citation-article-name">未定位条文</span>';
            }

            return `<tr class="${selected ? 'selected' : ''}">
                <td class="col-checkbox"><input type="checkbox" aria-label="选择引用 ${esc(item.target_label || item.id)}" data-regulation-citation-select="${esc(item.id)}" ${selected ? 'checked' : ''}></td>
                <td class="col-index text-center"><span class="regulations-table-index">${index + 1}</span></td>
                <td class="col-source">
                    <div class="regulations-citation-source-cell" title="${esc(fullSourceTooltip)}">
                        <div class="regulations-citation-doc-title">${esc(docTitle)}</div>
                        <div class="regulations-citation-article-info">
                            ${articleLabelHtml}
                            ${articleNameHtml}
                        </div>
                    </div>
                </td>
                <td class="col-target">
                    <div class="regulations-citation-target-cell" title="${esc(evidenceTooltip)}">
                        <span class="regulations-citation-target-text">${esc(targetLabel)}</span>
                    </div>
                </td>
                <td class="col-relation text-center">${citationRelationBadge(item.relation_type)}</td>
                <td class="col-confidence text-center">${citationConfidenceBadge(item.confidence)}</td>
                <td class="col-status text-center">${citationStatusBadge(item.review_status)}</td>
                <td class="col-actions text-center"><div class="regulations-row-actions">${action}</div></td>
            </tr>`;
        }).join('');
    }

    function syncCitationSelection() {
        const panel = document.getElementById('regulations-citation-governance-panel');
        if (!panel) return;
        const checkboxes = Array.from(panel.querySelectorAll('[data-regulation-citation-select]'));
        const visibleIds = checkboxes.map(input => String(input.dataset.regulationCitationSelect));
        citationSelectedIds = new Set([...citationSelectedIds].filter(id => visibleIds.includes(String(id))));
        checkboxes.forEach(input => { input.checked = citationSelectedIds.has(String(input.dataset.regulationCitationSelect)); });
        const selectAll = panel.querySelector('[data-regulation-citation-select-all]');
        if (selectAll) {
            selectAll.checked = Boolean(visibleIds.length) && visibleIds.every(id => citationSelectedIds.has(id));
            selectAll.indeterminate = visibleIds.some(id => citationSelectedIds.has(id)) && !selectAll.checked;
            selectAll.disabled = !visibleIds.length;
        }
        panel.querySelectorAll('[data-regulation-citation-review-selected]').forEach(button => {
            button.disabled = !citationSelectedIds.size;
            button.textContent = `${button.dataset.regulationCitationReviewSelected === 'approved' ? '确认' : (panel.dataset.citationGovernanceType === 'unresolved' ? '标记外部' : '驳回')}选中（${citationSelectedIds.size}）`;
        });
    }

    function toggleCitationSelection(id, checked) {
        const key = String(id || '');
        if (!key) return;
        if (checked) citationSelectedIds.add(key);
        else citationSelectedIds.delete(key);
        const panel = document.getElementById('regulations-citation-governance-panel');
        if (panel) {
            const row = panel.querySelector(`[data-regulation-citation-select="${key}"]`)?.closest('tr');
            if (row) row.classList.toggle('selected', Boolean(checked));
        }
        syncCitationSelection();
    }

    function selectAllCitationGovernance(checked) {
        const panel = document.getElementById('regulations-citation-governance-panel');
        if (!panel) return;
        panel.querySelectorAll('[data-regulation-citation-select]').forEach(input => {
            const key = String(input.dataset.regulationCitationSelect || '');
            if (checked) citationSelectedIds.add(key);
            else citationSelectedIds.delete(key);
            input.closest('tr')?.classList.toggle('selected', Boolean(checked));
        });
        syncCitationSelection();
    }

    async function showCitationGovernance(type = 'unresolved') {
        if (!canManage?.()) return;
        const safeType = type === 'review' ? 'review' : 'unresolved';
        const panel = document.getElementById('regulations-citation-governance-panel');
        const title = document.getElementById('regulations-citation-governance-title');
        const subtitle = document.getElementById('regulations-citation-governance-subtitle');
        const typeBadge = document.getElementById('regulations-citation-type-badge');
        const body = document.getElementById('regulations-citation-governance-body');
        if (!panel || !body) return;
        citationSelectedIds = new Set();
        panel.dataset.citationGovernanceType = safeType;
        if (title) title.textContent = safeType === 'review' ? '引用审核队列' : '未解析引用队列';
        if (typeBadge) {
            typeBadge.textContent = safeType === 'review' ? '库内待审核' : '跨法规待回连';
            typeBadge.className = `regulations-citation-type-tag ${safeType === 'review' ? 'tag-review' : 'tag-unresolved'}`;
        }
        if (subtitle) subtitle.textContent = safeType === 'review'
            ? '仅列出已成功回连到库内条文、但尚未人工确认的当前版本引用；可安全批量确认高置信项。'
            : '仅列出尚未回连的当前版本跨法规引用；先重建回连，确属外部资料时可标记为外部引用。';
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载引用治理队列…</div>');
        try {
            const data = await fetchJson(`${API}/citation-governance?type=${encodeURIComponent(safeType)}&limit=200`);
            const rows = Array.isArray(data.data) ? data.data : [];
            const actions = safeType === 'review'
                ? '<button type="button" class="btn-primary regulations-citation-approve-high-btn" data-regulation-citation-approve-high>一键确认高置信引用（≥80%）</button><button type="button" class="btn-secondary" data-regulation-citation-review-selected="approved" disabled>确认选中（0）</button><button type="button" class="btn-secondary" data-regulation-citation-review-selected="rejected" disabled>驳回选中（0）</button>'
                : '<button type="button" class="btn-secondary regulations-citation-rebuild-btn" data-regulation-citation-rebuild>一键重建全库引用回连</button><button type="button" class="btn-secondary" data-regulation-citation-review-selected="rejected" disabled>标记外部选中（0）</button>';
            PivotSafeHtml.setHtml(body, `
                <div class="regulations-citation-governance-head">
                    <div class="regulations-citation-stat-wrap">
                        <span class="regulations-citation-stat-label">当前显示</span>
                        <span class="regulations-citation-stat-number">${rows.length}</span>
                        <span class="regulations-citation-stat-divider">/</span>
                        <span class="regulations-citation-stat-total">${Number(data.total || 0)} 条</span>
                    </div>
                    <div class="regulations-admin-actions">${actions}</div>
                </div>
                <div class="table-container workspace-table-wrap regulations-citation-table-wrap">
                    <table class="data-table compact-table regulations-citation-table">
                        <thead>
                            <tr>
                                <th class="col-checkbox"><input type="checkbox" aria-label="全选当前引用治理队列" data-regulation-citation-select-all></th>
                                <th class="col-index text-center">序号</th>
                                <th class="col-source">来源法规 / 条文</th>
                                <th class="col-target">引用目标</th>
                                <th class="col-relation text-center">关系</th>
                                <th class="col-confidence text-center">置信度</th>
                                <th class="col-status text-center">状态</th>
                                <th class="col-actions text-center">处理</th>
                            </tr>
                        </thead>
                        <tbody>${renderCitationGovernanceRows(rows, safeType)}</tbody>
                    </table>
                </div>
            `);
            syncCitationSelection();
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载引用治理队列失败')}</div>`);
        }
    }

    async function rebuildCitationLinks() {
        if (!(await regulationConfirm('重建全库引用回连', '系统将按当前法规版本重新匹配库内别名和条文，不会改动原法规正文。确认继续？'))) return;
        setBusy(true, '正在重建跨法规引用回连…');
        try {
            const result = await fetchJson(`${API}/cross-links/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            toast(`引用回连完成：已匹配 ${Number(result.resolved || 0)} 条`, 'success');
            await showCitationGovernance('unresolved');
        } catch (error) {
            toast(error.message || '重建引用回连失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function reviewCitationLinks(ids, reviewStatus) {
        const list = Array.isArray(ids) ? ids : [ids];
        if (!list.filter(Boolean).length) return;
        try {
            const data = await fetchJson(`${API}/citation-governance/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: list, reviewStatus })
            });
            toast(`已处理 ${Number(data.result?.updated || 0)} 条引用`, 'success');
            await showCitationGovernance(document.getElementById('regulations-citation-governance-panel')?.dataset.citationGovernanceType || 'review');
        } catch (error) {
            toast(error.message || '处理引用失败', 'error');
        }
    }

    async function reviewSelectedCitationLinks(reviewStatus) {
        const ids = [...citationSelectedIds];
        if (!ids.length) {
            toast('请先勾选需要处理的引用', 'warning');
            return;
        }
        const panel = document.getElementById('regulations-citation-governance-panel');
        const unresolved = panel?.dataset.citationGovernanceType === 'unresolved';
        const action = reviewStatus === 'approved' ? '确认' : (unresolved ? '标记为外部/不采用' : '驳回');
        if (!(await regulationConfirm(`批量${action}引用`, `将${action}选中的 ${ids.length} 条引用关系。该操作只作用于当前法规版本，确认继续？`))) return;
        await reviewCitationLinks(ids, reviewStatus);
    }

    async function approveHighConfidenceCitationLinks() {
        if (!(await regulationConfirm('批量确认高置信引用', '仅确认已回连到库内条文且置信度不低于 80% 的引用；未解析和低置信引用仍保留人工复核。确认继续？'))) return;
        setBusy(true, '正在批量确认高置信引用…');
        try {
            const data = await fetchJson(`${API}/citation-governance/approve-high-confidence`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minConfidence: 0.8, limit: 2000 })
            });
            toast(`已确认 ${Number(data.result?.updated || 0)} 条高置信引用`, 'success');
            await showCitationGovernance('review');
        } catch (error) {
            toast(error.message || '批量确认引用失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function showQualitySummary() {
        const panel = document.getElementById('regulations-quality-panel');
        const body = document.getElementById('regulations-quality-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在汇总法规质量信息…</div>');
        try {
            const data = await fetchJson(`${API}/quality-summary`);
            const summary = data.summary || {};
            const documents = summary.documents || {};
            const versions = summary.versions || {};
            const links = summary.links || {};
            const locations = summary.locations || {};
            const obligations = summary.obligations || {};
            PivotSafeHtml.setHtml(body, `
                <div class="regulations-quality-grid">
                    ${renderQualityMetric('法规文档', documents.total)}
                    ${renderQualityMetric('元数据待审核', documents.metadataNeedsReview, '含缺少层级、来源或审核信息', Number(documents.metadataNeedsReview || 0) ? '<button type="button" class="btn-secondary" data-regulation-governance-worklist="metadata">处理元数据</button>' : '')}
                    ${renderQualityMetric('缺少维护人', documents.missingMaintainer, '指派责任人后可持续维护', Number(documents.missingMaintainer || 0) ? '<button type="button" class="btn-secondary" data-regulation-governance-worklist="maintainer">指派维护人</button>' : '')}
                    ${renderQualityMetric('版本待治理', versions.governanceNeedsReview, '效力或审核状态未确认', Number(versions.governanceNeedsReview || 0) ? '<button type="button" class="btn-secondary" data-regulation-governance-worklist="version">处理版本</button>' : '')}
                    ${renderQualityMetric('索引未完成', versions.indexingIncomplete, '可重新加入向量索引队列', Number(versions.indexingIncomplete || 0) ? '<button type="button" class="btn-secondary" data-regulation-governance-worklist="index">重建索引</button>' : '')}
                    ${renderQualityMetric('未解析引用', links.unresolved, '可重建回连或标记为外部引用', Number(links.unresolved || 0) ? '<button type="button" class="btn-secondary" data-regulation-citation-governance="unresolved">处理引用</button>' : '')}
                    ${renderQualityMetric('引用待审核', links.needsReview, '高置信引用可批量确认', Number(links.needsReview || 0) ? '<button type="button" class="btn-secondary" data-regulation-citation-governance="review">审核引用</button>' : '')}
                    ${renderQualityMetric('条文缺少定位', locations.articlesWithoutLocation, '按当前正文重建页码与字符位置', Number(locations.articlesWithoutLocation || 0) ? '<button type="button" class="btn-secondary" data-regulation-governance-worklist="location">重建定位</button>' : '')}
                    ${renderQualityMetric('义务待审核', obligations.needsReview)}
                </div>
                <div class="regulations-quality-note">“现行有效”仅表示已由管理员填写并审核的版本状态；请继续以权威来源和组织正式意见为准。</div>
            `);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载质量概览失败')}</div>`);
        }
    }

    async function showRegulationRecycleBin() {
        if (!ns.canDeleteDocuments?.()) return;
        const panel = document.getElementById('regulations-recycle-bin-panel');
        const body = document.getElementById('regulations-recycle-bin-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取法规回收站…</div>');
        try {
            const data = await fetchJson(`${API}/recycle-bin?limit=100`);
            const rows = Array.isArray(data.data) ? data.data : [];
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="table-container workspace-table-wrap regulations-recycle-bin-table-wrap">
                    <table class="data-table compact-table regulations-recycle-bin-table">
                        <thead>
                            <tr>
                                <th class="col-index text-center">序号</th>
                                <th class="col-title">法规名称</th>
                                <th class="col-category text-center">分类</th>
                                <th class="col-date text-center">删除时间</th>
                                <th class="col-actions text-center">操作</th>
                            </tr>
                        </thead>
                        <tbody>${rows.map((item, index) => {
                            const title = item.title || '未命名法规';
                            const category = item.category || '-';
                            const dateStr = fmtDate(item.deleted_at);
                            return `<tr>
                                <td class="col-index text-center"><span class="regulations-table-index">${index + 1}</span></td>
                                <td class="col-title"><span class="regulations-recycle-title" title="${esc(title)}">${esc(title)}</span></td>
                                <td class="col-category text-center"><span class="regulations-recycle-category-pill">${esc(category)}</span></td>
                                <td class="col-date text-center"><span class="regulations-recycle-date">${esc(dateStr)}</span></td>
                                <td class="col-actions text-center">
                                    <div class="regulations-row-actions">
                                        <button type="button" class="btn-secondary regulations-row-action regulations-restore-btn" data-regulation-restore="${esc(item.id)}" title="恢复此法规至目录与检索">恢复</button>
                                    </div>
                                </td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                </div>` : '<div class="regulations-empty compact">回收站为空。</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载法规回收站失败')}</div>`);
        }
    }

    async function requestRegulationReindex(documentId, versionId) {
        if (!documentId || !versionId || !ns.canManage?.()) return;
        setBusy(true, '正在重新排队向量索引…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/reindex`, { method: 'POST' });
            toast('向量索引已重新排队；失败时会按退避策略有限重试', 'success');
            await ns.loadDetail?.(documentId, versionId);
        } catch (error) {
            toast(error.message || '重新建立向量索引失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function restoreRegulationFromRecycleBin(documentId) {
        if (!documentId || !ns.canDeleteDocuments?.()) return;
        if (!(await regulationConfirm('恢复法规', '恢复后该法规会重新出现在法规目录和检索结果中。确认恢复？'))) return;
        setBusy(true, '正在恢复法规…');
        try {
            await fetchJson(`${API}/recycle-bin/${encodeURIComponent(documentId)}/restore`, { method: 'POST' });
            toast('法规已恢复', 'success');
            await showRegulationRecycleBin();
            await ns.loadDocuments?.({ keepActive: true, page: state.page });
            await ns.loadFacets?.();
        } catch (error) {
            toast(error.message || '恢复法规失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderObligationForm(documentId, versionId, articleId, assignees = []) {
        const assigneeOptions = (Array.isArray(assignees) ? assignees : []).map(item => {
            const label = [item.nickname || item.username || `用户 ${item.id}`, item.unit].filter(Boolean).join(' · ');
            return `<option value="${esc(item.id)}">${esc(label)}</option>`;
        }).join('');
        return `
            <form class="regulations-obligation-form" data-obligation-document="${esc(documentId)}" data-obligation-version="${esc(versionId)}" data-obligation-article="${esc(articleId)}">
                <div class="regulations-admin-group">
                    <div class="regulations-admin-grid">
                        <label>适用主体<input name="subject" class="form-input" maxlength="240" placeholder="如 用人单位"></label>
                        <label>触发条件<input name="triggerCondition" class="form-input" maxlength="1000" placeholder="如 发生法定备案事项"></label>
                        <label>要求动作<input name="requiredAction" class="form-input" maxlength="1000" placeholder="必填，如 完成备案" required></label>
                        <label>期限规则<input name="dueRule" class="form-input" maxlength="500" placeholder="如 三十日内"></label>
                        <label>责任人<select name="ownerUserId" class="form-input"><option value="">审核后待分派</option>${assigneeOptions}</select></label>
                    </div>
                    <label>留存凭证<input name="evidenceRequirement" class="form-input" maxlength="1000" placeholder="如 备案回执"></label>
                </div>
                <div class="regulations-admin-actions"><button class="btn-primary" type="submit">保存为待审核义务</button></div>
            </form>`;
    }

    async function showRegulationObligations(documentId, articleId = '') {
        const panel = document.getElementById('regulations-obligation-panel');
        const body = document.getElementById('regulations-obligation-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载合规义务…</div>');
        try {
            const query = articleId ? `?articleId=${encodeURIComponent(articleId)}` : '';
            const data = await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations${query}`);
            const obligations = Array.isArray(data.obligations) ? data.obligations : [];
            const assignees = Array.isArray(data.assignees) ? data.assignees : [];
            const versionId = state.detail?.currentVersion?.id || '';
            const canCreate = Boolean(articleId && versionId && ns.canManage?.());
            const reviewLabel = item => item.review_status === 'approved' ? '已审核' : (item.review_status === 'rejected' ? '已驳回' : '待审核');
            const reviewAction = item => ns.canManage?.() && item.review_status !== 'approved'
                ? `<button type="button" class="btn-secondary regulations-obligation-review" data-regulation-obligation-review="${esc(item.id)}" data-regulation-obligation-document="${esc(documentId)}">审核并转为待办</button>`
                : '';
            const obligationRows = obligations.length
                ? obligations.map(item => {
                    const ownerLabel = item.owner_nickname || item.owner_username || '-';
                    return `<tr><td>${esc(item.article_label || '-')}</td><td>${esc(item.subject || '-')}</td><td>${esc(item.required_action || '-')}</td><td>${esc(item.due_rule || '-')}</td><td>${esc(ownerLabel)}</td><td><span>${esc(reviewLabel(item))}</span>${reviewAction(item)}</td></tr>`;
                }).join('')
                : '<tr><td colspan="6" class="text-center">暂无义务事项</td></tr>';
            PivotSafeHtml.setHtml(body, `
                ${canCreate ? renderObligationForm(documentId, versionId, articleId, assignees) : ''}
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>条文</th><th>主体</th><th>要求动作</th><th>期限</th><th>责任人</th><th>审核/待办</th></tr></thead>
                        <tbody>${obligationRows || '暂无义务事项'}</tbody>
                    </table>
                </div>
            `);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载合规义务失败')}</div>`);
        }
    }

    async function submitRegulationObligation(form) {
        const documentId = form.dataset.obligationDocument;
        const versionId = form.dataset.obligationVersion;
        const articleId = form.dataset.obligationArticle;
        const payload = collectForm(form);
        setBusy(true, '正在保存合规义务…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/articles/${encodeURIComponent(articleId)}/obligations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            toast('义务事项已保存，等待人工审核', 'success');
            await showRegulationObligations(documentId, articleId);
        } catch (error) {
            toast(error.message || '保存合规义务失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function reviewRegulationObligation(documentId, obligationId) {
        if (!documentId || !obligationId) return;
        setBusy(true, '正在确认合规义务…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations/${encodeURIComponent(obligationId)}/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reviewStatus: 'approved', status: 'active' })
            });
            toast('义务已审核通过，可作为后续任务分派依据', 'success');
            await showRegulationObligations(documentId);
        } catch (error) {
            toast(error.message || '审核合规义务失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderAnnotations(body, annotations, articleId) {
        const currentUserId = (typeof currentUser !== 'undefined' ? currentUser : window.Pivot.legacy.currentUser)?.id;
        PivotSafeHtml.setHtml(body, `
            <form class="regulations-annotation-form" data-annotation-article="${esc(articleId)}">
                <textarea class="form-input" name="content" rows="3" placeholder="输入内部理解、适用案例或注意事项…" required></textarea>
                <div class="regulations-admin-actions">
                    <button type="submit" class="btn-primary">提交批注</button>
                </div>
            </form>
            <div class="regulations-annotation-list">
                ${annotations.length ? annotations.map(a => `
                    <div class="regulations-annotation-item">
                        <div class="regulations-annotation-meta">
                            <strong>${esc(a.user_name || '匿名')}</strong>
                            <span>${esc(a.updated_at || a.created_at || '')}</span>
                            ${Number(a.user_id) === Number(currentUserId) ? `<button class="btn-secondary regulations-annotation-delete" type="button" data-annotation-delete="${esc(a.id)}" data-annotation-article="${esc(articleId)}">删除</button>` : ''}
                        </div>
                        <div class="regulations-annotation-content">${esc(a.content)}</div>
                    </div>
                `).join('') : '<div class="regulations-empty compact">暂无批注，添加第一条吧</div>'}
            </div>
        `);
    }

    async function submitAnnotation(form) {
        const articleId = form.dataset.annotationArticle;
        const content = form.querySelector('[name="content"]')?.value?.trim();
        if (!content) {
            toast('请输入批注内容', 'warning');
            return;
        }
        try {
            await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            toast('批注已提交', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '提交失败', 'error');
        }
    }

    async function deleteAnnotation(annotationId, articleId) {
        if (!(await regulationConfirm('删除批注', '确定删除该批注吗？'))) return;
        try {
            await fetchJson(`${API}/annotations/${encodeURIComponent(annotationId)}`, { method: 'DELETE' });
            toast('批注已删除', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        }
    }

    Object.assign(ns, {
        showAnnotations,
        showAccessLogs,
        showRegulationAiLogs,
        showArticleLocations,
        renderQualityMetric,
        showQualitySummary,
        loadGovernanceAssignees,
        openGovernanceWorklist,
        openDocumentGovernance,
        openVersionGovernance,
        requestRegulationLocationRebuild,
        showCitationGovernance,
        rebuildCitationLinks,
        reviewCitationLinks,
            reviewSelectedCitationLinks,
            selectAllCitationGovernance,
            toggleCitationSelection,
        approveHighConfidenceCitationLinks,
        showRegulationRecycleBin,
        requestRegulationReindex,
        restoreRegulationFromRecycleBin,
        renderObligationForm,
        showRegulationObligations,
        submitRegulationObligation,
        reviewRegulationObligation,
        renderAnnotations,
        submitAnnotation,
        deleteAnnotation,
        actionsGovernanceReady: true
    });
})();
