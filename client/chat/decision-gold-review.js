/* 冻结决策金标的双人审核工作台：不显示前序审核人的动作，避免锚定偏差。 */
(function installDecisionGoldReviewQueue() {
    const STATUS_LABELS = {
        pending_human_review: '待第二审核',
        human_review_conflict: '审核冲突',
        verified: '已核验'
    };

    const STATUS_CLASSES = {
        pending_human_review: 'is-pending',
        human_review_conflict: 'is-conflict',
        verified: 'is-verified'
    };

    const state = {
        version: 'v2',
        items: [],
        page: 1,
        pageSize: 20,
        statusFilter: 'all',
        searchKeyword: ''
    };

    function notify(message, type = 'info') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    function clear(node) {
        if (node) node.replaceChildren();
    }

    function contextSummary(item = {}) {
        const request = item.inputContext?.requestState || {};
        return String(request.routingText || '').slice(0, 512) || '未记录路由上下文';
    }

    function fullContextText(item = {}) {
        const request = item.inputContext?.requestState || {};
        return String(request.routingText || '').trim() || '未记录路由上下文';
    }

    function scenarioClass(scenario = '') {
        const key = String(scenario || '').replace(/^chat\./, '').replace(/[^a-zA-Z0-9_-]/g, '_');
        return key ? `scenario-${key}` : 'scenario-default';
    }

    function filterItems() {
        const items = Array.isArray(state.items) ? state.items : [];
        const status = state.statusFilter;
        const kw = state.searchKeyword.toLowerCase().trim();

        return items.filter(item => {
            if (status !== 'all' && item.reviewStatus !== status) {
                return false;
            }
            if (kw) {
                const caseId = String(item.caseId || '').toLowerCase();
                const scenario = String(item.scenario || '').toLowerCase();
                const text = contextSummary(item).toLowerCase();
                const candidateTexts = Array.isArray(item.candidates)
                    ? item.candidates.map(c => String(c.description || c.id || '').toLowerCase()).join(' ')
                    : '';
                if (!caseId.includes(kw) && !scenario.includes(kw) && !text.includes(kw) && !candidateTexts.includes(kw)) {
                    return false;
                }
            }
            return true;
        });
    }

    function updateKpiBar(items, filteredCount) {
        const verified = items.filter(item => item.reviewStatus === 'verified').length;
        const conflicts = items.filter(item => item.reviewStatus === 'human_review_conflict').length;
        const pending = items.length - verified - conflicts;

        const valTotal = document.getElementById('kpi-val-total');
        const valPending = document.getElementById('kpi-val-pending');
        const valConflict = document.getElementById('kpi-val-conflict');
        const valVerified = document.getElementById('kpi-val-verified');
        const versionBadge = document.getElementById('decision-gold-active-version-badge');

        if (valTotal) valTotal.textContent = String(items.length);
        if (valPending) valPending.textContent = String(pending);
        if (valConflict) valConflict.textContent = String(conflicts);
        if (valVerified) valVerified.textContent = String(verified);
        if (versionBadge) versionBadge.textContent = state.version || 'v2';

        const summary = document.getElementById('decision-gold-review-summary');
        if (summary) {
            let text = `共 ${items.length} 项；已核验 ${verified} 项；待第二审核 ${pending} 项；审核冲突 ${conflicts} 项。`;
            if (filteredCount !== items.length) {
                text += `（当前筛选显示 ${filteredCount} 项）`;
            }
            summary.textContent = text;
        }
    }

    function openCaseDetailModal(item) {
        const modal = document.getElementById('decision-gold-detail-modal');
        const badge = document.getElementById('decision-gold-detail-case-badge');
        const content = document.getElementById('decision-gold-detail-content');
        if (!modal || !content) return;

        if (badge) badge.textContent = item.caseId || '—';
        clear(content);

        // 基本信息段落
        const metaSection = document.createElement('div');
        metaSection.className = 'decision-gold-detail-section';
        const metaLabel = document.createElement('div');
        metaLabel.className = 'decision-gold-detail-label';
        metaLabel.textContent = '场景与审核状态';
        metaSection.appendChild(metaLabel);

        const metaRow = document.createElement('div');
        metaRow.style.display = 'flex';
        metaRow.style.alignItems = 'center';
        metaRow.style.gap = '8px';

        const scenarioPill = document.createElement('span');
        scenarioPill.className = `decision-scenario-pill ${scenarioClass(item.scenario)}`;
        scenarioPill.textContent = item.scenario || '未定义场景';
        metaRow.appendChild(scenarioPill);

        const statusBadge = document.createElement('span');
        statusBadge.className = `decision-status-badge ${STATUS_CLASSES[item.reviewStatus] || 'is-pending'}`;
        statusBadge.textContent = STATUS_LABELS[item.reviewStatus] || item.reviewStatus || '待审核';
        metaRow.appendChild(statusBadge);

        if (item.reviewedAt) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'decision-verified-time';
            timeSpan.textContent = `审核时间: ${String(item.reviewedAt).slice(0, 19).replace('T', ' ')}`;
            metaRow.appendChild(timeSpan);
        }
        metaSection.appendChild(metaRow);
        content.appendChild(metaSection);

        // 完整脱敏路由上下文
        const contextSection = document.createElement('div');
        contextSection.className = 'decision-gold-detail-section';
        const contextHeader = document.createElement('div');
        contextHeader.className = 'decision-gold-detail-label';
        const contextTitle = document.createElement('span');
        contextTitle.textContent = '脱敏路由上下文与用户意图';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-secondary';
        copyBtn.style.height = '24px';
        copyBtn.style.padding = '0 8px';
        copyBtn.style.fontSize = '0.72rem';
        copyBtn.textContent = '复制文本';
        copyBtn.addEventListener('click', () => {
            const fullText = fullContextText(item);
            navigator.clipboard?.writeText(fullText).then(() => notify('上下文已复制到剪贴板', 'success'));
        });
        contextHeader.appendChild(contextTitle);
        contextHeader.appendChild(copyBtn);
        contextSection.appendChild(contextHeader);

        const contextCard = document.createElement('div');
        contextCard.className = 'decision-gold-detail-card';
        contextCard.textContent = fullContextText(item);
        contextSection.appendChild(contextCard);
        content.appendChild(contextSection);

        // 候选动作列表
        const candidatesSection = document.createElement('div');
        candidatesSection.className = 'decision-gold-detail-section';
        const candidatesLabel = document.createElement('div');
        candidatesLabel.className = 'decision-gold-detail-label';
        candidatesLabel.textContent = '候选动作集合';
        candidatesSection.appendChild(candidatesLabel);

        const candidatesGrid = document.createElement('div');
        candidatesGrid.className = 'decision-gold-candidates-grid';
        (Array.isArray(item.candidates) ? item.candidates : []).forEach(candidate => {
            const card = document.createElement('div');
            card.className = 'decision-gold-candidate-item';
            if (candidate?.allowed === false) {
                card.style.opacity = '0.5';
                card.style.textDecoration = 'line-through';
                card.title = '此动作为非允许候选';
            }
            const idSpan = document.createElement('span');
            idSpan.className = 'candidate-id';
            idSpan.textContent = candidate.id || '';
            const descSpan = document.createElement('span');
            descSpan.className = 'candidate-desc';
            descSpan.textContent = candidate.description ? ` (${candidate.description})` : '';
            card.appendChild(idSpan);
            card.appendChild(descSpan);
            candidatesGrid.appendChild(card);
        });
        candidatesSection.appendChild(candidatesGrid);
        content.appendChild(candidatesSection);

        modal.classList.remove('hidden');
    }

    function closeCaseDetailModal() {
        const modal = document.getElementById('decision-gold-detail-modal');
        if (modal) modal.classList.add('hidden');
    }

    function renderPaginationControls(total, limit, page) {
        const container = document.getElementById('pagination-decision-gold-review');
        if (!container) return;
        clear(container);

        const totalPages = Math.max(1, Math.ceil(total / limit));
        if (totalPages <= 1) return;

        const renderWorkspacePagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination || window.Pivot?.modules?.['chat.ui']?.renderWorkspacePagination;
        if (typeof renderWorkspacePagination === 'function') {
            renderWorkspacePagination(container, {
                total,
                limit,
                page,
                onPageChange: (targetPage) => {
                    state.page = targetPage;
                    renderTableBody();
                }
            });
            return;
        }

        // 兼容自包含分页条
        const createBtn = (label, targetPage, disabled) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-secondary';
            btn.disabled = disabled;
            btn.textContent = label;
            btn.addEventListener('click', () => {
                if (!btn.disabled) {
                    state.page = targetPage;
                    renderTableBody();
                }
            });
            return btn;
        };

        const summary = document.createElement('span');
        summary.textContent = `第 ${page} / ${totalPages} 页（共 ${total} 条）`;
        container.append(
            createBtn('首页', 1, page <= 1),
            createBtn('上一页', page - 1, page <= 1),
            summary,
            createBtn('下一页', page + 1, page >= totalPages),
            createBtn('末页', totalPages, page >= totalPages)
        );
    }

    function renderTableBody() {
        const body = document.getElementById('decision-gold-review-list');
        if (!body) return;
        clear(body);

        const allItems = Array.isArray(state.items) ? state.items : [];
        const filtered = filterItems();
        updateKpiBar(allItems, filtered.length);

        if (!filtered.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 7;
            cell.className = 'text-center route-feedback-empty';
            cell.textContent = allItems.length
                ? '当前筛选条件下没有匹配的冻结金标案例。'
                : '当前版本没有可审核的冻结金标案例。可先导入冻结集。';
            row.appendChild(cell);
            body.appendChild(row);
            renderPaginationControls(0, state.pageSize, 1);
            return;
        }

        const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;

        const startIdx = (state.page - 1) * state.pageSize;
        const pageItems = filtered.slice(startIdx, startIdx + state.pageSize);

        pageItems.forEach(item => {
            const row = document.createElement('tr');
            row.dataset.decisionGoldCaseId = String(item.caseId || '');

            // 1. 案例 ID
            const caseCell = document.createElement('td');
            caseCell.className = 'text-center';
            const caseTag = document.createElement('span');
            caseTag.className = 'decision-case-tag';
            caseTag.textContent = String(item.caseId || '—');
            caseTag.title = '点击查看案例完整脱敏详情与候选元数据';
            caseTag.addEventListener('click', () => openCaseDetailModal(item));
            caseCell.appendChild(caseTag);
            row.appendChild(caseCell);

            // 2. 场景
            const scenarioCell = document.createElement('td');
            const scenarioPill = document.createElement('span');
            scenarioPill.className = `decision-scenario-pill ${scenarioClass(item.scenario)}`;
            scenarioPill.textContent = item.scenario || '—';
            scenarioCell.appendChild(scenarioPill);
            row.appendChild(scenarioCell);

            // 3. 脱敏路由上下文
            const contextCell = document.createElement('td');
            const contextText = document.createElement('span');
            contextText.className = 'decision-context-text';
            const summaryStr = contextSummary(item);
            contextText.textContent = summaryStr;
            contextText.title = '点击查看完整路由上下文';
            contextText.addEventListener('click', () => openCaseDetailModal(item));
            contextCell.appendChild(contextText);
            row.appendChild(contextCell);

            // 4. 审核状态
            const statusCell = document.createElement('td');
            statusCell.className = 'text-center';
            const statusBadge = document.createElement('span');
            statusBadge.className = `decision-status-badge ${STATUS_CLASSES[item.reviewStatus] || 'is-pending'}`;
            statusBadge.textContent = STATUS_LABELS[item.reviewStatus] || item.reviewStatus || '待审核';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // 5. 候选动作
            const candidateCell = document.createElement('td');
            const select = document.createElement('select');
            select.className = 'form-input decision-action-select';
            select.dataset.decisionGoldAction = String(item.caseId || '');
            select.setAttribute('aria-label', `${item.caseId || '当前'}案例的审核动作`);
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '请选择允许动作';
            select.appendChild(placeholder);

            (Array.isArray(item.candidates) ? item.candidates : []).filter(candidate => candidate?.allowed !== false).forEach(candidate => {
                const option = document.createElement('option');
                option.value = String(candidate.id || '');
                option.textContent = String(candidate.description || candidate.id || '未命名动作');
                select.appendChild(option);
            });
            select.disabled = item.reviewStatus === 'verified';
            candidateCell.appendChild(select);
            row.appendChild(candidateCell);

            // 6. 审核备注
            const noteCell = document.createElement('td');
            const note = document.createElement('input');
            note.type = 'text';
            note.className = 'form-input decision-note-input';
            note.maxLength = 2000;
            note.placeholder = '可选：依据或保留意见';
            note.dataset.decisionGoldNote = String(item.caseId || '');
            note.disabled = item.reviewStatus === 'verified';
            noteCell.appendChild(note);
            row.appendChild(noteCell);

            // 7. 提交操作
            const actionCell = document.createElement('td');
            actionCell.className = 'text-center';
            if (item.reviewStatus === 'verified') {
                const verifiedBox = document.createElement('div');
                verifiedBox.className = 'decision-verified-cell';
                const verifiedText = document.createElement('span');
                verifiedText.textContent = '✓ 两人已确认';
                verifiedBox.appendChild(verifiedText);
                if (item.reviewedAt) {
                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'decision-verified-time';
                    timeSpan.textContent = String(item.reviewedAt).slice(0, 16).replace('T', ' ');
                    verifiedBox.appendChild(timeSpan);
                }
                actionCell.appendChild(verifiedBox);
            } else {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-primary decision-submit-btn';
                button.dataset.decisionGoldReview = String(item.caseId || '');
                button.textContent = '提交审核';
                actionCell.appendChild(button);
            }
            row.appendChild(actionCell);
            body.appendChild(row);
        });

        renderPaginationControls(filtered.length, state.pageSize, state.page);
    }

    function render() {
        renderTableBody();
    }

    function version() {
        return String(document.getElementById('decision-gold-review-version')?.value || state.version || 'v2').trim().slice(0, 128);
    }

    async function loadDecisionGoldReviewQueue() {
        const nextVersion = version();
        if (!nextVersion) return notify('请输入冻结集版本。', 'error');
        const refreshBtn = document.getElementById('decision-gold-review-refresh');
        if (refreshBtn) refreshBtn.disabled = true;
        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/${encodeURIComponent(nextVersion)}/cases?limit=500`);
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '加载冻结金标审核队列失败');
            state.version = nextVersion;
            state.items = Array.isArray(payload.data) ? payload.data : [];
            state.page = 1;
            render();
            return state.items;
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    async function importFrozenSet() {
        const importBtn = document.getElementById('decision-gold-review-import');
        if (importBtn) {
            importBtn.disabled = true;
            importBtn.textContent = '导入中...';
        }
        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '导入冻结评测集失败');
            const imported = payload.imported || {};
            const versionInput = document.getElementById('decision-gold-review-version');
            if (versionInput && imported.version) versionInput.value = imported.version;
            notify(`冻结集 ${imported.version || ''} 已导入；新增 ${Number(imported.inserted || 0)} 项。`, 'success');
            return await loadDecisionGoldReviewQueue();
        } finally {
            if (importBtn) {
                importBtn.disabled = false;
                importBtn.textContent = '导入冻结集';
            }
        }
    }

    async function submitReview(caseId) {
        const item = state.items.find(value => String(value.caseId || '') === String(caseId || ''));
        const actionSelect = document.querySelector(`[data-decision-gold-action="${CSS.escape(String(caseId || ''))}"]`);
        const noteInput = document.querySelector(`[data-decision-gold-note="${CSS.escape(String(caseId || ''))}"]`);
        const submitBtn = document.querySelector(`[data-decision-gold-review="${CSS.escape(String(caseId || ''))}"]`);

        const action = actionSelect?.value || '';
        const note = noteInput?.value || '';
        if (!item || !action) return notify('请选择一个允许动作后再提交审核。', 'error');

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '提交中...';
        }

        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/${encodeURIComponent(state.version)}/cases/${encodeURIComponent(caseId)}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedActionId: action, reviewNote: note })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '提交金标审核失败');
            const review = payload.review || {};
            const isVerified = review.reviewStatus === 'verified';
            const message = isVerified
                ? '两名不同审核员结论一致，案例已成为可用金标。'
                : review.reviewStatus === 'human_review_conflict'
                    ? '审核结论存在分歧，案例继续阻断发布。'
                    : '已记录审核，仍需另一名管理员独立确认。';
            notify(message, isVerified ? 'success' : 'info');

            // 保持当前页码并刷新队列
            const savedPage = state.page;
            await loadDecisionGoldReviewQueue();
            state.page = savedPage;
            render();
        } finally {
            if (submitBtn && submitBtn.isConnected) {
                submitBtn.disabled = false;
                submitBtn.textContent = '提交审核';
            }
        }
    }

    function bindDecisionGoldReviewQueue() {
        const section = document.getElementById('tab-content-decision-gold-review');
        if (!section || section.dataset.decisionGoldBound === '1') return;
        section.dataset.decisionGoldBound = '1';

        // 刷新与导入按钮
        document.getElementById('decision-gold-review-refresh')?.addEventListener('click', () => {
            loadDecisionGoldReviewQueue().catch(error => notify(error.message || '加载冻结金标审核队列失败', 'error'));
        });
        document.getElementById('decision-gold-review-import')?.addEventListener('click', () => {
            importFrozenSet().catch(error => notify(error.message || '导入冻结评测集失败', 'error'));
        });

        // 状态筛选变更
        document.getElementById('decision-gold-review-status-filter')?.addEventListener('change', event => {
            state.statusFilter = String(event.target.value || 'all');
            state.page = 1;
            render();
        });

        // 检索关键词输入
        let searchTimer = null;
        document.getElementById('decision-gold-review-search')?.addEventListener('input', event => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.searchKeyword = String(event.target.value || '');
                state.page = 1;
                render();
            }, 200);
        });

        // 版本输入回车加载
        document.getElementById('decision-gold-review-version')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                loadDecisionGoldReviewQueue().catch(error => notify(error.message || '加载冻结金标审核队列失败', 'error'));
            }
        });

        // 提交按钮委托
        section.addEventListener('click', event => {
            const button = event.target.closest?.('[data-decision-gold-review]');
            if (button && !button.disabled) {
                submitReview(button.dataset.decisionGoldReview).catch(error => notify(error.message || '提交金标审核失败', 'error'));
            }
        });

        // 模态弹窗关闭交互
        document.getElementById('decision-gold-detail-close')?.addEventListener('click', closeCaseDetailModal);
        document.getElementById('decision-gold-detail-close-btn')?.addEventListener('click', closeCaseDetailModal);
        document.getElementById('decision-gold-detail-modal')?.addEventListener('click', event => {
            if (event.target.id === 'decision-gold-detail-modal') {
                closeCaseDetailModal();
            }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeCaseDetailModal();
            }
        });
    }

    window.Pivot?.exposeModule?.('decision.goldReview', {
        bindDecisionGoldReviewQueue,
        loadDecisionGoldReviewQueue: async () => {
            bindDecisionGoldReviewQueue();
            return await loadDecisionGoldReviewQueue();
        },
        getState: () => ({ ...state, items: [...state.items] })
    });
}());
