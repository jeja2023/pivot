/* 冻结决策金标的双人审核队列：不显示其他审核人的动作，避免锚定偏差。 */
(function installDecisionGoldReviewQueue() {
    const STATUS_LABELS = {
        pending_human_review: '待第二审核',
        human_review_conflict: '审核冲突',
        verified: '已核验'
    };
    const state = { version: 'v2', items: [] };

    function notify(message, type = 'info') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    function clear(node) {
        if (node) node.replaceChildren();
    }

    function textCell(row, value, className = '') {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        const text = String(value || '—');
        cell.textContent = text;
        if (text !== '—') cell.title = text;
        row.appendChild(cell);
        return cell;
    }

    function contextSummary(item = {}) {
        const request = item.inputContext?.requestState || {};
        return String(request.routingText || '').slice(0, 512) || '未记录路由上下文';
    }

    function render() {
        const body = document.getElementById('decision-gold-review-list');
        const summary = document.getElementById('decision-gold-review-summary');
        if (!body || !summary) return;
        clear(body);
        const items = Array.isArray(state.items) ? state.items : [];
        const verified = items.filter(item => item.reviewStatus === 'verified').length;
        const conflicts = items.filter(item => item.reviewStatus === 'human_review_conflict').length;
        summary.textContent = `共 ${items.length} 项；已核验 ${verified} 项；待第二审核 ${items.length - verified - conflicts} 项；审核冲突 ${conflicts} 项。`;
        if (!items.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 7;
            cell.className = 'text-center route-feedback-empty';
            cell.textContent = '当前版本没有可审核的冻结金标案例。可先导入冻结集。';
            row.appendChild(cell);
            body.appendChild(row);
            return;
        }
        items.forEach(item => {
            const row = document.createElement('tr');
            row.dataset.decisionGoldCaseId = String(item.caseId || '');
            textCell(row, item.caseId, 'text-center mono');
            textCell(row, item.scenario || '—');
            textCell(row, contextSummary(item));
            textCell(row, STATUS_LABELS[item.reviewStatus] || item.reviewStatus || '待审核', 'text-center');
            const candidateCell = document.createElement('td');
            const select = document.createElement('select');
            select.className = 'form-input';
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
            const noteCell = document.createElement('td');
            const note = document.createElement('input');
            note.type = 'text';
            note.className = 'form-input';
            note.maxLength = 2000;
            note.placeholder = '可选：依据或保留意见';
            note.dataset.decisionGoldNote = String(item.caseId || '');
            note.disabled = item.reviewStatus === 'verified';
            noteCell.appendChild(note);
            row.appendChild(noteCell);
            const actionCell = document.createElement('td');
            actionCell.className = 'text-center';
            if (item.reviewStatus === 'verified') {
                actionCell.textContent = `已由两人确认${item.reviewedAt ? ` · ${String(item.reviewedAt).slice(0, 16)}` : ''}`;
            } else {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-primary';
                button.dataset.decisionGoldReview = String(item.caseId || '');
                button.textContent = '提交审核';
                actionCell.appendChild(button);
            }
            row.appendChild(actionCell);
            body.appendChild(row);
        });
    }

    function version() {
        return String(document.getElementById('decision-gold-review-version')?.value || state.version || 'v2').trim().slice(0, 128);
    }

    async function loadDecisionGoldReviewQueue() {
        const nextVersion = version();
        if (!nextVersion) return notify('请输入冻结集版本。', 'error');
        const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/${encodeURIComponent(nextVersion)}/cases?limit=500`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.error) throw new Error(payload.error || '加载冻结金标审核队列失败');
        state.version = nextVersion;
        state.items = Array.isArray(payload.data) ? payload.data : [];
        render();
        return state.items;
    }

    async function importFrozenSet() {
        const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.error) throw new Error(payload.error || '导入冻结评测集失败');
        const imported = payload.imported || {};
        document.getElementById('decision-gold-review-version').value = imported.version || state.version;
        notify(`冻结集 ${imported.version || ''} 已导入；新增 ${Number(imported.inserted || 0)} 项。`, 'success');
        return await loadDecisionGoldReviewQueue();
    }

    async function submitReview(caseId) {
        const item = state.items.find(value => String(value.caseId || '') === String(caseId || ''));
        const action = document.querySelector(`[data-decision-gold-action="${CSS.escape(String(caseId || ''))}"]`)?.value || '';
        const note = document.querySelector(`[data-decision-gold-note="${CSS.escape(String(caseId || ''))}"]`)?.value || '';
        if (!item || !action) return notify('请选择一个允许动作后再提交审核。', 'error');
        const response = await apiFetch(`${API_BASE}/stats/observability/decision-evaluation-sets/${encodeURIComponent(state.version)}/cases/${encodeURIComponent(caseId)}/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedActionId: action, reviewNote: note })
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
        await loadDecisionGoldReviewQueue();
    }

    function bindDecisionGoldReviewQueue() {
        const section = document.getElementById('tab-content-decision-gold-review');
        if (!section || section.dataset.decisionGoldBound === '1') return;
        section.dataset.decisionGoldBound = '1';
        document.getElementById('decision-gold-review-refresh')?.addEventListener('click', () => loadDecisionGoldReviewQueue().catch(error => notify(error.message || '加载冻结金标审核队列失败', 'error')));
        document.getElementById('decision-gold-review-import')?.addEventListener('click', () => importFrozenSet().catch(error => notify(error.message || '导入冻结评测集失败', 'error')));
        section.addEventListener('click', event => {
            const button = event.target.closest?.('[data-decision-gold-review]');
            if (button) submitReview(button.dataset.decisionGoldReview).catch(error => notify(error.message || '提交金标审核失败', 'error'));
        });
    }

    window.Pivot?.exposeModule?.('decision.goldReview', {
        bindDecisionGoldReviewQueue,
        loadDecisionGoldReviewQueue: async () => { bindDecisionGoldReviewQueue(); return await loadDecisionGoldReviewQueue(); },
        getState: () => ({ ...state, items: [...state.items] })
    });
}());
