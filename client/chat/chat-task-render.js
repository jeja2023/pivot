// 对话任务使用现有主题、按钮和安全 HTML，过程与最终回答分别更新。
(function initializeChatTaskRender() {
    const escape = value => escapeCodeHtml(String(value ?? ''));
    const attr = value => escapeAttrValue(String(value ?? ''));
    const model = () => window.Pivot.moduleApi('chat.taskState');
    const operationLabels = Object.freeze({ preparing: '准备中', running: '执行中', completed: '完成',
        failed: '失败', denied: '已阻止', waiting: '等待确认', rejected: '已拒绝', reused: '已复用', staged: '待提交', cancelled: '已停止', uncertain: '结果待确认' });

    function dateText(value) {
        const milliseconds = model().timestamp(value);
        return milliseconds ? new Date(milliseconds).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    }

    function button(action, label, title, className = 'btn-secondary', extra = '', disabled = false) {
        return `<button type="button" class="${['btn-primary', 'btn-secondary', 'btn-danger-outline'].includes(className) ? className : 'btn-secondary'}" data-task-action="${action}" title="${attr(title)}" aria-label="${attr(title)}" ${extra}${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
    }

    function recordMarkup(record, state) {
        const label = operationLabels[record.status] || '已记录';
        const symbol = ['failed', 'rejected', 'denied'].includes(record.status) ? '!' : record.status === 'uncertain' ? '?' : ['running', 'preparing', 'waiting', 'staged'].includes(record.status) ? '·' : '✓';
        const elapsed = model().duration(record.durationMs);
        const key = String(record.operationId || record.id);
        const open = state.disclosures?.has(key) ? ' open' : '';
        return `<li class="chat-task-record is-${attr(record.status)}" data-task-operation="${attr(key)}">
            <span class="chat-task-record-symbol" aria-hidden="true">${symbol}</span>
            <div class="chat-task-record-main"><div class="chat-task-record-line"><span class="chat-task-record-title"><span class="chat-task-record-title-text">${escape(record.title)}${record.attempt > 1 ? `（第 ${record.attempt} 次尝试）` : ''}</span>
                    ${record.location ? `<span class="chat-task-record-location">· ${escape(record.location)}</span>` : ''}</span>
                <span class="chat-task-record-meta">${escape(label)}${elapsed ? ` · ${escape(elapsed)}` : ''}</span></div>
                ${record.detail ? `<details class="chat-task-record-detail" data-task-disclosure="${attr(key)}"${open}><summary>查看说明</summary><p>${escape(record.detail)}</p></details>` : ''}
            </div></li>`;
    }

    function approvalMarkup(state) {
        const approval = state.approval;
        if (!approval) return '';
        const expired = approval.expiresAt && model().timestamp(approval.expiresAt) <= Date.now();
        const rememberHtml = !expired ? `<label class="chat-task-approval-remember" style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:0.8rem;color:var(--text-secondary);cursor:pointer;"><input type="checkbox" data-task-approval-remember="1"> <span>在此次任务中信任该工具后续操作（免密继续）</span></label>` : '';
        return `<section class="chat-task-approval" aria-label="操作授权">
            <strong>${escape(approval.title)}需要你的确认</strong>
            <p>执行位置：${escape(approval.location)}。本次决定仅作用于当前操作和参数。</p>
            ${approval.fields?.length ? `<dl>${approval.fields.map(field => `<div><dt>${escape(field.label)}</dt><dd>${escape(field.value)}</dd></div>`).join('')}</dl>` : ''}
            ${approval.expiresAt ? `<p>${expired ? '本次请求已过期，请刷新任务状态后处理。' : `本次请求有效至 ${escape(dateText(approval.expiresAt))}。`}</p>` : ''}
            ${rememberHtml}
            <div class="chat-task-approval-actions">${expired ? button('renew-approval', '重新申请授权', '重新生成当前操作的授权请求', 'btn-primary') : button('approve', '本次允许', '允许当前操作并继续任务', 'btn-primary')}
                ${button('reject', '拒绝并停止', '拒绝当前操作并停止后续处理', 'btn-danger-outline')}
                ${button('details', '查看完整范围', '查看任务详情中的完整操作范围')}</div>
        </section>`;
    }

    function artifactMarkup(artifact) {
        const rendition = artifact.rendition;
        const format = String(rendition?.format || '').toUpperCase();
        const bytes = rendition?.byteSize || 0;
        const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '';
        const saved = artifact.delivery?.state === 'delivered';
        const delivery = artifact.delivery ? ({ delivered: '已保存到授权本机目录', confirmed: '已保存到授权本机目录',
            pending: '已加入本机保存队列', claimed: '正在保存到本机', failed: '本机保存失败，可查看详情', expired: '本机保存请求已过期', cancelled: '本机保存已取消' })[artifact.delivery.state] : '';
        const selector = `data-task-artifact="${attr(artifact.id)}" data-task-rendition="${attr(rendition?.id || '')}"`;
        return `<li class="chat-task-artifact"><div><strong>${escape(artifact.title)}</strong>
            <span>${escape([format, size, `版本 ${artifact.version}`].filter(Boolean).join(' · '))}</span>
            <span>${escape(delivery || (rendition?.ready ? '文件已生成，可下载' : rendition?.status === 'expired' ? '文件已过期' : '结果已记录，尚无可下载文件'))}</span></div>
            <div class="chat-task-artifact-actions">${button('preview', '查看', '查看结果内容与版本', 'btn-secondary', selector)}
                ${rendition?.ready ? button('download', '下载', '下载已生成的结果文件', 'btn-secondary', selector) : ''}
                ${rendition?.ready && window.pivotDesktop?.getDeliveryStatus && !saved ? button('save-local', '保存到本机', '选择授权目录保存结果文件', 'btn-secondary', selector) : ''}</div></li>`;
    }

    function controlsMarkup(entry) {
        const { state } = entry;
        const status = state.run.status;
        const terminal = model().isTerminal(status);
        const waiting = model().isWaiting(status);
        const resumable = ['partial', 'needs_input', 'error', 'failed', 'cancelled'].includes(status);
        const control = (action, label, title, className = 'btn-secondary') => button(action,
            entry.busyAction === action ? ({ cancel: '正在停止…', pause: '正在暂停…', resume: '正在继续…' })[action] || '处理中…' : label,
            title, className, '', entry.actionInFlight);
        return `<div class="chat-task-actions"><div class="chat-task-actions-primary">${button('details', '任务详情', '查看完整执行记录与诊断')}
            ${terminal && (status === 'completed' || state.run.final_answer) ? button('create-schedule', '转为计划', '将本次调试成功的任务创建为周期计划') : ''}
            ${terminal && (status === 'completed' || state.run.final_answer) ? button('save-template', '另存模板', '保存为常用智能体模板') : ''}
            ${state.connection === 'unavailable' ? button('refresh', terminal ? '刷新记录' : '重新连接', '重新获取任务最新状态') : ''}
            ${!terminal && status !== 'awaiting_commit' ? button('steer', '补充要求', '为当前任务补充要求') : ''}
            ${!terminal && !waiting ? control('pause', '暂停', '暂停当前任务，可随后继续') : ''}
            ${resumable ? control('resume', '继续', '从上次执行位置继续任务', 'btn-primary') : ''}
            ${status === 'awaiting_commit' ? button('details', '查看提交决定', '查看待提交操作并决定提交或回滚', 'btn-primary') : ''}
            </div>${!terminal && status !== 'awaiting_commit' ? control('cancel', '停止任务', '停止当前任务的后续处理', 'btn-danger-outline') : ''}</div>`;
    }

    function render(entry) {
        const { state, element } = entry;
        if (!element) return;
        let panel = element.querySelector('.chat-task-panel');
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'chat-task-panel';
            element.insertBefore(panel, element.querySelector('.text-body') || element.firstChild);
        }
        const rows = model().records(state);
        const terminal = model().isTerminal(state.run.status);
        const hasError = ['error', 'failed', 'completed_with_errors'].includes(state.run.status)
            || Boolean(state.run.error_message && ['partial', 'error', 'failed', 'cancelled'].includes(state.run.status));
        const waitingAction = ['needs_input', 'approval_required', 'waiting_approval', 'awaiting_approval', 'awaiting_commit'].includes(state.run.status)
            || Boolean(state.approval);
        const completedCleanly = terminal && !hasError && !waitingAction;
        const expanded = state.expanded ?? !terminal;

        const tools = rows.filter(row => row.kind === 'tool').length;
        const summary = model().summary(state);
        const connectionProblem = state.connection === 'unavailable' && !terminal;
        const tone = connectionProblem ? 'warning' : ['error', 'failed'].includes(state.run.status) ? 'error' : terminal ? 'complete' : 'active';
        panel.dataset.tone = tone;
        panel.dataset.taskCompleted = completedCleanly ? 'true' : 'false';
        panel.dataset.processExpanded = expanded ? 'true' : 'false';
        const verification = state.run.status === 'verifying'
            ? { status: 'verifying', label: '正在核验本次结果', missing: [] } : state.verification;
        const showVerification = !hasError && verification && ((terminal && state.run.status !== 'cancelled') || state.run.status === 'verifying' || state.run.status === 'awaiting_commit');
        const statusLabel = connectionProblem ? '读取异常' : state.run.statusText || model().labels[state.run.status] || '正在确认';
        const emptyText = connectionProblem ? '执行记录暂时无法读取。可以重新连接，或直接停止此任务。'
            : terminal ? '当前任务暂无执行记录。' : state.run.status === 'queued' ? '任务正在排队，开始后将显示操作记录。' : '正在等待第一条执行记录…';
        const countText = !rows.length ? '暂无记录'
            : tools > 0 && tools !== rows.length ? `${rows.length} 步记录（含 ${tools} 项操作）`
            : tools > 0 ? `${tools} 项操作`
            : `${rows.length} 步记录`;
        const html = `<header class="chat-task-status" role="status" aria-live="polite" aria-atomic="true">
                <div class="chat-task-heading"><span class="chat-task-sparkle" aria-hidden="true">✦</span><strong>${escape(state.run.title || '对话任务')}</strong><span class="chat-task-status-summary chat-task-status-badge">${escape(statusLabel)}</span></div>
                ${summary !== statusLabel ? `<span class="chat-task-current-action">${escape(summary)}</span>` : ''}
                ${connectionProblem && state.highWater >= 0 ? `<small>最后确认：${escape(state.run.statusText || model().labels[state.run.status] || '')}</small>` : ''}
            </header>
            ${state.actionFeedback ? `<p class="chat-task-feedback" role="status">${escape(state.actionFeedback)}</p>` : ''}
            <details class="chat-task-process"${expanded ? ' open' : ''}><summary tabindex="0"><span>执行过程</span><span>${escape(countText)}</span></summary>
                ${rows.length ? `<ol class="chat-task-records">${rows.map(row => recordMarkup(row, state)).join('')}</ol>` : `<p class="chat-task-empty">${escape(emptyText)}</p>`}
                ${state.older?.hasMore ? button('older', '加载更早记录', '加载更早的执行记录') : ''}
                ${completedCleanly ? controlsMarkup(entry) : ''}
            </details>
            ${approvalMarkup(state)}
            ${['waiting_approval', 'awaiting_approval'].includes(state.run.status) && !state.approval ? '<p class="chat-task-empty">审批已发起，可在任务详情查看审批对象与处理进度。</p>' : ''}
            ${showVerification ? `<div class="chat-task-verification" data-verification-status="${attr(verification.status)}">${escape(verification.label || '暂无独立核验记录')}${verification.missing?.length ? `<p>待补齐：${verification.missing.map(escape).join('；')}</p>` : ''}</div>` : ''}
            ${state.run.error_message && (hasError || ['partial', 'cancelled'].includes(state.run.status)) ? `<p class="chat-task-result-note chat-task-error-note">${escape(state.run.error_message)}</p>` : ''}
            ${state.artifacts.length ? `<section class="chat-task-artifacts" aria-label="结果文件"><strong>结果文件</strong><ul>${state.artifacts.map(artifactMarkup).join('')}</ul></section>` : ''}
            ${state.warnings?.length ? `<p class="chat-task-result-note">${state.warnings.map(item => escape(item.message)).join('；')}</p>` : ''}
            ${!completedCleanly ? controlsMarkup(entry) : ''}`;
        if (entry.renderedHtml === html) return;
        const focused = document.activeElement?.closest?.('[data-task-action]');
        const focusAction = panel.contains(focused) ? focused?.dataset.taskAction : '';
        PivotSafeHtml.setHtml(panel, html);
        entry.renderedHtml = html;
        panel.querySelector('.chat-task-process')?.addEventListener('click', event => {
            if (event.target.closest('summary')?.parentElement?.classList.contains('chat-task-process')) state.expanded = !panel.querySelector('.chat-task-process').open;
        });
        panel.querySelectorAll('[data-task-disclosure]').forEach(details => {
            details.addEventListener('click', event => {
                if (event.target.closest('summary')?.parentElement !== details) return;
                state.disclosures ||= new Set();
                if (details.open) state.disclosures.delete(details.dataset.taskDisclosure);
                else state.disclosures.add(details.dataset.taskDisclosure);
            });
        });
        panel.onclick = event => {
            const target = event.target.closest('[data-task-action]');
            if (!target || !panel.contains(target)) return;
            event.preventDefault();
            void window.Pivot.moduleApi('chat.taskActions').perform?.(entry, target.dataset.taskAction, target);
        };
        if (focusAction) panel.querySelector(`[data-task-action="${focusAction}"]`)?.focus({ preventScroll: true });
    }

    window.Pivot.exposeModule('chat.taskRender', { render, dateText });
})();
