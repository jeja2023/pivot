/* 管理员路由反馈核验队列。用户建议与可训练标签保持分离。 */
(function installDecisionFeedbackReviewQueue() {
    const SCENARIO_LABELS = {
        'chat.rag': '知识库检索',
        'chat.tools': '工具调用',
        'chat.next_step': '回复方式'
    };
    const ACTION_LABELS = {
        retrieve: '检索知识库',
        skip: '不检索 / 直接回答',
        propose: '规划工具调用',
        candidate_only: '等待工具授权',
        direct_answer: '直接回答',
        clarify: '请求补充信息'
    };
    const REASON_LABELS = {
        intent_mismatch: '误判任务意图',
        missing_evidence: '缺少必要依据',
        tool_not_suitable: '工具或检索不适用',
        preference_mismatch: '不符合使用偏好',
        other: '其他原因'
    };
    const REVIEW_STATUS_LABELS = {
        pending: '待核验',
        accepted: '已采纳',
        rejected: '未采纳',
        superseded: '已替换'
    };

    const feedbackState = {
        items: [],
        page: 1,
        pageSize: 10,
        reviewStatus: 'pending'
    };

    function label(map, value, fallback) {
        const key = String(value || '').trim().toLowerCase();
        return map[key] || fallback || key || '-';
    }

    function parseMetadata(value) {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
    }

    function appendTextCell(row, text, className = '') {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        cell.textContent = text || '-';
        row.appendChild(cell);
        return cell;
    }

    function formatTime(value) {
        if (typeof formatDateToCN === 'function') return formatDateToCN(value);
        return String(value || '-');
    }

    function renderQueue(rows = [], reviewStatus = 'pending', total = rows.length, page = 1, totalPages = 1) {
        const body = document.getElementById('route-feedback-review-list');
        if (!body) return;
        const fragment = document.createDocumentFragment();
        if (!rows.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 7;
            cell.className = 'text-center route-feedback-empty';
            cell.textContent = reviewStatus === 'pending' ? '暂无待核验的路由建议。' : '暂无符合筛选条件的路由建议。';
            row.appendChild(cell);
            fragment.appendChild(row);
        } else {
            rows.forEach((item, index) => {
                const row = document.createElement('tr');
                const metadata = parseMetadata(item.metadata);
                const displayIndex = (page - 1) * (feedbackState.pageSize || 10) + index + 1;
                appendTextCell(row, String(displayIndex), 'text-center col-index');
                appendTextCell(row, formatTime(item.occurred_at), 'route-feedback-time');
                appendTextCell(row, label(SCENARIO_LABELS, item.scenario, '本轮路由'), 'route-feedback-scenario');
                appendTextCell(row, `${label(ACTION_LABELS, item.selected_action_id, '未命名动作')} → ${label(ACTION_LABELS, item.corrected_action_id, '未命名动作')}`, 'route-feedback-action');

                const reasonCell = document.createElement('td');
                reasonCell.className = 'route-feedback-reason';
                const reason = document.createElement('strong');
                reason.textContent = label(REASON_LABELS, metadata.feedbackReason, '未填写原因');
                reasonCell.appendChild(reason);
                const note = String(metadata.note || '').trim();
                if (note) {
                    const noteText = document.createElement('span');
                    noteText.textContent = note;
                    reasonCell.appendChild(noteText);
                }
                row.appendChild(reasonCell);

                const statusCell = document.createElement('td');
                statusCell.className = 'text-center';
                const status = document.createElement('span');
                const normalizedStatus = String(item.review_status || '').toLowerCase();
                status.className = `route-feedback-status is-${normalizedStatus || 'pending'}`;
                status.textContent = label(REVIEW_STATUS_LABELS, normalizedStatus, '待核验');
                statusCell.appendChild(status);
                row.appendChild(statusCell);

                const actionCell = document.createElement('td');
                actionCell.className = 'text-center route-feedback-actions-cell';
                if (normalizedStatus === 'pending') {
                    ['accepted', 'rejected'].forEach(reviewStatusValue => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = reviewStatusValue === 'accepted' ? 'btn-primary' : 'btn-secondary';
                        button.dataset.routeFeedbackReview = reviewStatusValue;
                        button.dataset.routeFeedbackId = String(item.feedback_id || '');
                        button.textContent = reviewStatusValue === 'accepted' ? '采纳' : '不采纳';
                        button.setAttribute('aria-label', `${button.textContent}此条路由建议`);
                        actionCell.appendChild(button);
                    });
                } else {
                    if (item.reviewed_at) {
                        const reviewedSpan = document.createElement('span');
                        reviewedSpan.className = 'route-feedback-reviewed-time';
                        reviewedSpan.textContent = `已于 ${formatTime(item.reviewed_at)} 核验`;
                        actionCell.appendChild(reviewedSpan);
                    } else {
                        actionCell.textContent = '-';
                    }
                }
                row.appendChild(actionCell);
                fragment.appendChild(row);
            });
        }
        body.replaceChildren(fragment);
    }

    function renderFeedbackPage() {
        const total = feedbackState.items.length;
        const totalPages = Math.max(1, Math.ceil(total / feedbackState.pageSize));
        feedbackState.page = Math.min(Math.max(1, feedbackState.page), totalPages);
        const start = (feedbackState.page - 1) * feedbackState.pageSize;
        const pagedRows = feedbackState.items.slice(start, start + feedbackState.pageSize);

        renderQueue(pagedRows, feedbackState.reviewStatus, total, feedbackState.page, totalPages);

        const renderWorkspacePagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination
            || window.Pivot?.legacy?.renderWorkspacePagination;
        renderWorkspacePagination?.('pagination-route-feedback', {
            total,
            limit: feedbackState.pageSize,
            page: feedbackState.page,
            onPageChange: (targetPage) => {
                feedbackState.page = targetPage;
                renderFeedbackPage();
            }
        });
    }

    async function loadRouteFeedbackReviewQueue(targetPage) {
        const filter = document.getElementById('route-feedback-status-filter');
        const reviewStatus = String(filter?.value || 'pending').trim().toLowerCase();
        const body = document.getElementById('route-feedback-review-list');
        if (!body) return false;

        if (reviewStatus !== feedbackState.reviewStatus) {
            feedbackState.reviewStatus = reviewStatus;
            feedbackState.page = 1;
        }
        if (Number.isFinite(Number(targetPage))) {
            feedbackState.page = Math.max(1, Number(targetPage));
        }

        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-feedback?reviewStatus=${encodeURIComponent(reviewStatus)}&limit=200`);
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '加载路由反馈失败');
            feedbackState.items = Array.isArray(payload.data) ? payload.data : [];
            renderFeedbackPage();
            return true;
        } catch (error) {
            feedbackState.items = [];
            renderFeedbackPage();
            if (typeof showToast === 'function') showToast(error.message || '加载路由反馈失败', 'error');
            return false;
        }
    }

    async function reviewFeedback(button) {
        const feedbackId = String(button?.dataset?.routeFeedbackId || '').trim();
        const reviewStatus = String(button?.dataset?.routeFeedbackReview || '').trim().toLowerCase();
        if (!feedbackId || !['accepted', 'rejected'].includes(reviewStatus)) return;
        const actionLabel = reviewStatus === 'accepted' ? '采纳' : '不采纳';
        const confirmed = await (window.Pivot?.legacy?.showConfirm?.(
            `${actionLabel}路由建议？`,
            reviewStatus === 'accepted'
                ? '采纳后会生成一条已核验训练样本。'
                : '该建议将被标记为未采纳，且不会进入训练样本。'
        ) ?? Promise.resolve(window.confirm(`确认${actionLabel}这条路由建议？`)));
        if (!confirmed) return;
        const siblingButtons = button.parentElement?.querySelectorAll('button') || [];
        siblingButtons.forEach(control => { control.disabled = true; });
        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-feedback/${encodeURIComponent(feedbackId)}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reviewStatus })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '核验路由反馈失败');
            const toastMessage = reviewStatus === 'accepted' ? '已采纳，并加入待训练的已核验样本。' : '已标记为未采纳。';
            if (typeof showToast === 'function') showToast(toastMessage, 'success');
            await loadRouteFeedbackReviewQueue();
        } catch (error) {
            siblingButtons.forEach(control => { control.disabled = false; });
            if (typeof showToast === 'function') showToast(error.message || '核验路由反馈失败', 'error');
        }
    }

    function bindRouteFeedbackReviewQueue() {
        const section = document.getElementById('tab-content-route-feedback');
        if (!section || section.dataset.routeFeedbackBound === '1') return;
        section.dataset.routeFeedbackBound = '1';
        document.getElementById('route-feedback-refresh-btn')?.addEventListener('click', () => {
            loadRouteFeedbackReviewQueue();
        });
        document.getElementById('route-feedback-status-filter')?.addEventListener('change', () => {
            feedbackState.page = 1;
            loadRouteFeedbackReviewQueue(1);
        });
        section.addEventListener('click', event => {
            const button = event.target.closest?.('[data-route-feedback-review]');
            if (button) reviewFeedback(button);
        });
    }

    window.Pivot?.exposeModule?.('decision.feedbackReview', {
        bindRouteFeedbackReviewQueue,
        loadRouteFeedbackReviewQueue: async (targetPage) => {
            bindRouteFeedbackReviewQueue();
            return await loadRouteFeedbackReviewQueue(targetPage);
        },
        renderFeedbackPage,
        renderQueue,
        getState: () => ({ ...feedbackState })
    });
}());
