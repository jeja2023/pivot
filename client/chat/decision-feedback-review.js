/* 管理员路由复核队列。用户建议与可训练标签保持分离。 */
(function installDecisionFeedbackReviewQueue() {
    const SCENARIO_LABELS = {
        'chat.rag': '知识库检索',
        'chat.tools': '工具调用',
        'chat.next_step': '回复方式',
        'chat.execution': '任务执行与续接'
    };
    const ACTION_LABELS = {
        retrieve: '检索知识库',
        skip: '不检索 / 直接回答',
        propose: '规划工具调用',
        candidate_only: '等待工具授权',
        direct_answer: '直接回答',
        clarify: '请求补充信息',
        plan_only: '只提供方案',
        agent_run: '启动任务',
        continue_run: '续接当前任务'
    };
    const REASON_LABELS = {
        intent_mismatch: '误判任务意图',
        missing_evidence: '缺少必要依据',
        tool_not_suitable: '工具或检索不适用',
        preference_mismatch: '不符合使用偏好',
        other: '其他原因',
        execution_scope: '任务执行范围纠正',
        evidence_conflict: '纠正与已有核验证据冲突',
        repeated_correction: '同类路由反复纠正'
    };
    const REVIEW_STATUS_LABELS = {
        pending: '待复核',
        accepted: '已采纳',
        rejected: '未采纳',
        superseded: '已替换',
        not_required: '自动归档'
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

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function parseMetadata(value) {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
    }

    function appendTextCell(row, text, className = '') {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        cell.textContent = text || '-';
        if (text && text !== '-') cell.title = text;
        row.appendChild(cell);
        return cell;
    }

    function formatTime(value) {
        if (typeof formatDateToCN === 'function') return formatDateToCN(value);
        return String(value || '-');
    }

    function renderQueue(rows = [], reviewStatus = 'pending', _total = rows.length, page = 1, _totalPages = 1) {
        const body = document.getElementById('route-feedback-review-list');
        if (!body) return;
        const fragment = document.createDocumentFragment();
        if (!rows.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 10;
            cell.className = 'text-center route-feedback-empty';
            cell.textContent = reviewStatus === 'pending' ? '暂无待复核的路由异常。' : '暂无符合筛选条件的路由记录。';
            row.appendChild(cell);
            fragment.appendChild(row);
        } else {
            rows.forEach((item, index) => {
                const row = document.createElement('tr');
                row.dataset.feedbackId = String(item.feedback_id || '');
                const metadata = parseMetadata(item.metadata);
                const displayIndex = (page - 1) * (feedbackState.pageSize || 10) + index + 1;
                appendTextCell(row, String(displayIndex), 'text-center col-index');
                appendTextCell(row, formatTime(item.occurred_at), 'route-feedback-time');

                const userCell = document.createElement('td');
                userCell.className = 'route-feedback-user';
                const userWrap = document.createElement('div');
                userWrap.className = 'route-feedback-user-main';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'route-feedback-user-name';
                const displayName = item.nickname || item.username || '未知用户';
                nameSpan.textContent = displayName;
                userWrap.appendChild(nameSpan);
                if (item.username && item.nickname && item.username !== item.nickname) {
                    const subSpan = document.createElement('span');
                    subSpan.className = 'route-feedback-user-sub';
                    subSpan.textContent = `(@${item.username})`;
                    userWrap.appendChild(subSpan);
                }
                if (item.unit) {
                    const unitBadge = document.createElement('span');
                    unitBadge.className = 'route-feedback-unit-badge';
                    unitBadge.textContent = item.unit;
                    userWrap.appendChild(unitBadge);
                }
                userCell.appendChild(userWrap);
                userCell.title = [
                    item.nickname ? `昵称: ${item.nickname}` : '',
                    item.username ? `账号: @${item.username}` : '',
                    item.unit ? `单位: ${item.unit}` : ''
                ].filter(Boolean).join('\n') || displayName;
                row.appendChild(userCell);

                const sessionCell = document.createElement('td');
                sessionCell.className = 'route-feedback-session';
                const sessionWrap = document.createElement('div');
                sessionWrap.className = 'route-feedback-session-main';
                const sessionTitleSpan = document.createElement('span');
                sessionTitleSpan.className = 'route-feedback-session-title';
                const titleText = item.session_title || (item.session_id ? '未命名会话' : '未关联会话');
                sessionTitleSpan.textContent = titleText;
                sessionWrap.appendChild(sessionTitleSpan);
                if (item.session_id) {
                    const idSpan = document.createElement('span');
                    idSpan.className = 'route-feedback-session-id';
                    idSpan.textContent = `(ID: ${item.session_id.slice(0, 8)}…)`;
                    idSpan.dataset.sessionId = item.session_id;
                    idSpan.title = `点击复制完整会话ID: ${item.session_id}`;
                    sessionWrap.appendChild(idSpan);
                }
                sessionCell.appendChild(sessionWrap);
                sessionCell.title = item.session_id
                    ? `${titleText}\n会话ID: ${item.session_id}`
                    : titleText;
                row.appendChild(sessionCell);

                const queryCell = document.createElement('td');
                queryCell.className = 'route-feedback-query';
                const queryText = String(item.query_preview || '').trim();
                queryCell.textContent = queryText || '—';
                queryCell.title = queryText ? `当轮提问（已脱敏，点击查看详情）:\n${queryText}` : '未记录当轮提问（点击查看详情）';
                queryCell.dataset.routeFeedbackDetail = String(item.feedback_id || '');
                row.appendChild(queryCell);

                appendTextCell(row, label(SCENARIO_LABELS, item.scenario, '本轮路由'), 'route-feedback-scenario');
                appendTextCell(row, `${label(ACTION_LABELS, item.selected_action_id, '未命名动作')} → ${label(ACTION_LABELS, item.corrected_action_id, '未命名动作')}`, 'route-feedback-action');

                const reasonCell = document.createElement('td');
                reasonCell.className = 'route-feedback-reason';
                const reasonText = (metadata.reviewReasons || []).map(reason => label(REASON_LABELS, reason)).join('、') || label(REASON_LABELS, metadata.feedbackReason, '未填写原因');
                const note = String(metadata.note || '').trim();
                const reasonStrong = document.createElement('strong');
                reasonStrong.textContent = reasonText;
                reasonCell.appendChild(reasonStrong);
                if (note) {
                    const noteSpan = document.createElement('span');
                    noteSpan.className = 'route-feedback-reason-note';
                    noteSpan.textContent = ` · ${note}`;
                    reasonCell.appendChild(noteSpan);
                }
                reasonCell.title = note ? `${reasonText} · ${note}` : reasonText;
                row.appendChild(reasonCell);

                const statusCell = document.createElement('td');
                statusCell.className = 'route-feedback-status-cell';
                const status = document.createElement('span');
                const normalizedStatus = String(item.review_status || '').toLowerCase();
                status.className = `route-feedback-status is-${normalizedStatus || 'pending'}`;
                status.textContent = label(REVIEW_STATUS_LABELS, normalizedStatus, '待复核');
                statusCell.appendChild(status);
                row.appendChild(statusCell);

                const actionCell = document.createElement('td');
                actionCell.className = 'route-feedback-actions-cell';
                const detailBtn = document.createElement('button');
                detailBtn.type = 'button';
                detailBtn.className = 'btn-secondary route-feedback-detail-btn';
                detailBtn.dataset.routeFeedbackDetail = String(item.feedback_id || '');
                detailBtn.textContent = '详情';
                detailBtn.title = '查看脱敏提问与复核详情';
                actionCell.appendChild(detailBtn);

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
                    if (normalizedStatus === 'not_required') {
                        const reviewedSpan = document.createElement('span');
                        reviewedSpan.className = 'route-feedback-reviewed-time';
                        reviewedSpan.textContent = '无需逐条复核';
                        actionCell.appendChild(reviewedSpan);
                    } else if (item.reviewed_at) {
                        detailBtn.title = `已于 ${formatTime(item.reviewed_at)} 完成复核 · 点击查看详情`;
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

    function closeDetailModal() {
        const modal = document.getElementById('route-feedback-detail-modal');
        if (modal) modal.classList.add('hidden');
    }

    function openDetailModal(item) {
        const modal = document.getElementById('route-feedback-detail-modal');
        const content = document.getElementById('route-feedback-detail-content');
        const footer = document.getElementById('route-feedback-detail-footer');
        if (!modal || !content || !footer || !item) return;

        if (modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }

        const metadata = parseMetadata(item.metadata);
        const queryText = String(item.query_preview || '').trim();
        const scenarioText = label(SCENARIO_LABELS, item.scenario, '本轮路由');
        const originActionText = label(ACTION_LABELS, item.selected_action_id, '未命名动作');
        const correctedActionText = label(ACTION_LABELS, item.corrected_action_id, '未命名动作');
        const reasonText = label(REASON_LABELS, metadata.feedbackReason, '未填写原因');
        const noteText = String(metadata.note || '').trim();
        const correction = metadata.naturalCorrection;
        const evidenceText = correction ? JSON.stringify({ sourceMessageId: correction.sourceMessageId, priorMessageId: correction.priorMessageId,
            applied: correction.applied, runId: correction.runId, reviewReasons: metadata.reviewReasons, executionEvidence: metadata.executionEvidence }, null, 2) : '';
        const statusText = label(REVIEW_STATUS_LABELS, item.review_status, '待复核');
        const userDisplay = [
            item.nickname || '',
            item.username ? `(@${item.username})` : '',
            item.unit ? `[${item.unit}]` : ''
        ].filter(Boolean).join(' ') || '未知用户';
        const sessionTitle = item.session_title || (item.session_id ? '未命名会话' : '未关联会话');

        PivotSafeHtml.setHtml(content, `
            <div class="route-feedback-detail-section">
                <div class="route-feedback-detail-label">
                    <span>当轮提问（用户提问）</span>
                    <span class="route-feedback-privacy-badge">已规则脱敏</span>
                </div>
                <div class="route-feedback-query-card ${queryText ? '' : 'text-muted'}">${escapeHtml(queryText || '（未记录提问原文或由早期历史生成）')}</div>
            </div>

            <div class="route-feedback-detail-grid">
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">路由场景</span>
                    <span class="route-feedback-item-value">${escapeHtml(scenarioText)}</span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">当前复核状态</span>
                    <span class="route-feedback-item-value">
                        <span class="route-feedback-status is-${escapeHtml(String(item.review_status || 'pending').toLowerCase())}">
                            ${escapeHtml(statusText)}
                        </span>
                    </span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">原始系统决策</span>
                    <span class="route-feedback-item-value is-origin">${escapeHtml(originActionText)}</span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">对话纠正后的处理方式</span>
                    <span class="route-feedback-item-value is-corrected">${escapeHtml(correctedActionText)}</span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">提交用户</span>
                    <span class="route-feedback-item-value">${escapeHtml(userDisplay)}</span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">关联会话</span>
                    <span class="route-feedback-item-value">
                        ${escapeHtml(sessionTitle)}
                        ${item.session_id ? `<span class="route-feedback-session-id" data-session-id="${escapeHtml(item.session_id)}" title="点击复制完整会话ID">(ID: ${escapeHtml(item.session_id.slice(0, 8))}…)</span>` : ''}
                    </span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">反馈原因分类</span>
                    <span class="route-feedback-item-value">${escapeHtml(reasonText)}</span>
                </div>
                <div class="route-feedback-detail-item">
                    <span class="route-feedback-item-label">提交时间</span>
                    <span class="route-feedback-item-value">${escapeHtml(formatTime(item.occurred_at || item.created_at))}</span>
                </div>
            </div>

            <div class="route-feedback-detail-section">
                <div class="route-feedback-detail-label">用户补充说明</div>
                <div class="route-feedback-note-card ${noteText ? '' : 'text-muted'}">${escapeHtml(noteText || '（用户未填写补充说明）')}</div>
            </div>

            ${item.review_status === 'pending' ? `
                <div class="route-feedback-detail-section">
                    <div class="route-feedback-detail-label">复核备注（可选）</div>
                    <input type="text" id="route-feedback-modal-note" class="form-input route-feedback-review-note-input" placeholder="输入复核意见或采纳说明（可选，最多500字）" maxlength="500">
                </div>
            ` : `
                <div class="route-feedback-detail-section">
                    <div class="route-feedback-detail-label">复核记录</div>
                    <div class="route-feedback-note-card">${item.review_status === 'not_required' ? '常规纠正已自动归档，尚未转为训练标签' : item.reviewed_at ? `已于 ${escapeHtml(formatTime(item.reviewed_at))} 完成复核` : '已复核'}${item.review_note ? ` · 备注：${escapeHtml(item.review_note)}` : ''}</div>
                </div>
            `}
            ${evidenceText ? `<div class="route-feedback-detail-section"><div class="route-feedback-detail-label">纠正来源、即时约束及执行证据</div><pre class="route-feedback-note-card">${escapeHtml(evidenceText)}</pre></div>` : ''}
        `);

        footer.replaceChildren();
        if (item.review_status === 'pending') {
            const acceptBtn = document.createElement('button');
            acceptBtn.type = 'button';
            acceptBtn.className = 'btn-primary';
            acceptBtn.textContent = '采纳此建议';
            acceptBtn.addEventListener('click', () => {
                const noteInput = document.getElementById('route-feedback-modal-note');
                reviewFeedback({ dataset: { routeFeedbackId: item.feedback_id, routeFeedbackReview: 'accepted' } }, noteInput?.value?.trim() || '');
            });

            const rejectBtn = document.createElement('button');
            rejectBtn.type = 'button';
            rejectBtn.className = 'btn-secondary';
            rejectBtn.textContent = '不采纳 / 驳回';
            rejectBtn.addEventListener('click', () => {
                const noteInput = document.getElementById('route-feedback-modal-note');
                reviewFeedback({ dataset: { routeFeedbackId: item.feedback_id, routeFeedbackReview: 'rejected' } }, noteInput?.value?.trim() || '');
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.id = 'route-feedback-detail-close-btn';
            cancelBtn.className = 'btn-danger-outline';
            cancelBtn.textContent = '关闭';
            cancelBtn.addEventListener('click', closeDetailModal);

            footer.appendChild(acceptBtn);
            footer.appendChild(rejectBtn);
            footer.appendChild(cancelBtn);
        } else {
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.id = 'route-feedback-detail-close-btn';
            closeBtn.className = 'btn-danger-outline';
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', closeDetailModal);
            footer.appendChild(closeBtn);
        }

        modal.classList.remove('hidden');
    }

    async function reviewFeedback(button, customNote = '') {
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
            const bodyPayload = { reviewStatus };
            if (customNote) bodyPayload.reviewNote = customNote;
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-feedback/${encodeURIComponent(feedbackId)}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || '复核路由反馈失败');
            const toastMessage = reviewStatus === 'accepted' ? '已采纳，并加入待训练的已核验样本。' : '已标记为未采纳。';
            if (typeof showToast === 'function') showToast(toastMessage, 'success');
            closeDetailModal();
            await loadRouteFeedbackReviewQueue();
        } catch (error) {
            siblingButtons.forEach(control => { control.disabled = false; });
            if (typeof showToast === 'function') showToast(error.message || '复核路由反馈失败', 'error');
        }
    }

    function bindRouteFeedbackReviewQueue() {
        const section = document.getElementById('decision-review-feedback-panel');
        if (!section || section.dataset.routeFeedbackBound === '1') return;
        section.dataset.routeFeedbackBound = '1';
        document.getElementById('route-feedback-refresh-btn')?.addEventListener('click', () => {
            loadRouteFeedbackReviewQueue();
        });
        document.getElementById('route-feedback-status-filter')?.addEventListener('change', () => {
            feedbackState.page = 1;
            loadRouteFeedbackReviewQueue(1);
        });
        const modal = document.getElementById('route-feedback-detail-modal');
        if (modal && modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
        document.getElementById('route-feedback-detail-close')?.addEventListener('click', closeDetailModal);
        modal?.addEventListener('click', event => {
            if (event.target.id === 'route-feedback-detail-modal') {
                closeDetailModal();
                return;
            }
            const copyIdEl = event.target.closest?.('.route-feedback-session-id');
            if (copyIdEl) {
                const text = copyIdEl.dataset?.sessionId || copyIdEl.textContent.replace(/^ID:\s*/, '').trim();
                if (text && navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                        if (typeof showToast === 'function') showToast('已复制会话ID', 'success');
                    }).catch(() => {});
                }
            }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeDetailModal();
        });
        section.addEventListener('click', event => {
            const copyIdEl = event.target.closest?.('.route-feedback-session-id');
            if (copyIdEl) {
                const text = copyIdEl.dataset?.sessionId || copyIdEl.textContent.replace(/^ID:\s*/, '').trim();
                if (text && navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                        if (typeof showToast === 'function') showToast('已复制会话ID', 'success');
                    }).catch(() => {});
                }
                return;
            }
            const detailTrigger = event.target.closest?.('[data-route-feedback-detail]') || event.target.closest?.('.route-feedback-query');
            if (detailTrigger) {
                const feedbackId = detailTrigger.dataset.routeFeedbackDetail || detailTrigger.closest('tr')?.dataset?.feedbackId;
                const item = feedbackState.items.find(it => String(it.feedback_id || '') === String(feedbackId || ''));
                if (item) openDetailModal(item);
                return;
            }
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
