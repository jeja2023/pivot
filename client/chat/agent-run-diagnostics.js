/* 运行诊断面板：负责单次运行的缓存、请求与交互，不承担授权决策。 */
/* eslint-disable no-undef */
/* global API_BASE */
(function () {
    function create({ diagnostics, escape, escapeAttr, formatDate, shortText, jsonText, setMarkup, prependMarkup, setNotice, apiJson }) {
        const controlMessageStatusLabel = status => ({
            pending: '待投递', claimed: '投递中', delivered: '已送达', applied: '已应用', acknowledged: '已确认', expired: '已过期'
        })[String(status || '').toLowerCase()] || '状态未知';

        function renderDiagnosticValue(value, maxChars = 12000) {
            const text = jsonText(value);
            return `<pre class="agent-harness-json">${escape(text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text)}</pre>`;
        }

        const diagnosticCache = new Map();

        function getDiagnosticCache(runId) {
            const key = String(runId || '');
            let item = diagnosticCache.get(key);
            if (!item) {
                item = {
                    activeTab: diagnostics.get(key) || 'context',
                    panels: { context: '', world: '', resources: '', control: '' },
                    loaded: { context: false, world: false, resources: false, control: false },
                    fetching: { context: false, world: false, resources: false, control: false },
                    sequence: 0
                };
                diagnosticCache.set(key, item);
                if (diagnosticCache.size > 80) {
                    const oldest = diagnosticCache.keys().next().value;
                    if (oldest !== undefined) {
                        diagnosticCache.delete(oldest);
                        diagnostics.delete(oldest);
                    }
                }
            }
            return item;
        }

        function formatDiagnosticHtml(type, data) {
            if (type === 'context') {
                const list = Array.isArray(data) ? data : [];
                return list.length
                    ? list.map(item => `<article class="agent-harness-diagnostic-card"><strong>窗口 ${escape(item.window_version)}</strong><span>${escape(item.status)} · ${escape(item.opened_reason)}</span><small>${escape(formatDate(item.created_at))} → ${escape(formatDate(item.closed_at))}</small><code>${escape(item.initial_state_hash || '-')}</code></article>`).join('')
                    : '<div class="empty-state">暂无上下文窗口记录。</div>';
            }
            if (type === 'world') {
                const list = Array.isArray(data) ? data : [];
                return list.length
                    ? list.slice().reverse().map(item => `<details class="agent-harness-diagnostic-card"><summary><strong>快照 ${escape(item.snapshot_version)}</strong><span>${escape(item.injection_mode === 'diff' ? '增量更新' : '完整更新')} · ${escape(item.full_refresh_reason || '常规更新')}</span><small>${escape(formatDate(item.created_at))}</small></summary><div class="agent-harness-diagnostic-meta">上下文摘要 ${escape(shortText(item.context_hash, 18))} · 状态摘要 ${escape(shortText(item.state_hash, 18))}</div>${renderDiagnosticValue({ state: item.state, patch: item.patch }, 9000)}</details>`).join('')
                    : '<div class="empty-state">暂无状态快照。</div>';
            }
            if (type === 'resources') {
                const obj = data && typeof data === 'object' ? data : {};
                const budget = Number(obj.token_budget || 0);
                const consumed = Number(obj.tokens_consumed || 0);
                return `<div class="agent-harness-resource-grid"><div><span>Token 预算</span><strong>${escape(budget > 0 ? budget.toLocaleString() : '不限')}</strong></div><div><span>已消耗</span><strong>${escape(consumed.toLocaleString())}</strong></div><div><span>已预留</span><strong>${escape(Number(obj.tokens_reserved || 0).toLocaleString())}</strong></div><div><span>子运行</span><strong>${escape(`${Number(obj.active_children || 0)} / ${Number(obj.max_children || 0) || '不限'}`)}</strong></div></div>${renderDiagnosticValue(obj, 6000)}`;
            }
            if (type === 'control') {
                const list = Array.isArray(data) ? data : [];
                const typeOptions = '<option value="steer">指令</option><option value="request">请求</option><option value="reply">回复</option><option value="system">系统消息</option>';
                const items = list.map(item => `<article class="agent-harness-diagnostic-card"><div><strong>${escape(item.message_type)}</strong><span>${escape(controlMessageStatusLabel(item.status))}</span><small>${escape(formatDate(item.created_at))}</small></div>${renderDiagnosticValue(item.payload, 2600)}${['pending', 'delivered'].includes(String(item.status)) ? `<button type="button" class="btn-secondary btn-xs" data-agent-control-ack="${escapeAttr(item.message_id)}">确认</button>` : ''}</article>`).join('');
                return `<form class="agent-harness-control-form"><select class="form-input" data-agent-control-type>${typeOptions}</select><textarea class="form-input" rows="2" data-agent-control-payload placeholder="输入 JSON 载荷，例如 {&quot;message&quot;:&quot;请优先处理第二步&quot;}"></textarea><button class="btn-primary" type="submit">发送控制消息</button></form>${items || '<div class="empty-state">暂无控制消息。</div>'}`;
            }
            return '<div class="empty-state">暂无诊断数据。</div>';
        }

        function diagnosticTabMarkup(runId) {
            const cache = getDiagnosticCache(runId), activeTab = cache.activeTab || diagnostics.get(String(runId)) || 'context';
            cache.activeTab = activeTab;
            const tab = (key, label) => `<button class="btn-secondary agent-harness-diagnostic-tab${activeTab === key ? ' active' : ''}" type="button" data-agent-harness-diagnostic-tab="${key}" role="tab" aria-selected="${activeTab === key ? 'true' : 'false'}" tabindex="${activeTab === key ? '0' : '-1'}">${label}</button>`;
            const panelMarkup = (key, placeholder) => `<div class="agent-harness-diagnostic-panel${activeTab !== key ? ' hidden' : ''}" data-agent-harness-panel="${key}" role="tabpanel" aria-label="${key}">${cache.panels[key] || `<div class="empty-state">${placeholder}</div>`}</div>`;
            return `<details class="agent-run-harness-diagnostics" data-agent-harness-diagnostics="${escapeAttr(runId)}" data-agent-harness-active-tab="${escapeAttr(activeTab)}"><summary><span>运行诊断</span><em>上下文、状态快照、资源与控制消息</em></summary><div class="agent-harness-diagnostics-body"><div class="agent-harness-diagnostic-tabs" role="tablist" aria-label="运行诊断">${tab('context', '上下文窗口')}${tab('world', '状态快照')}${tab('resources', '资源用量')}${tab('control', '控制消息')}</div><div class="agent-harness-diagnostic-panels">${panelMarkup('context', '正在加载上下文窗口记录...')}${panelMarkup('world', '正在加载状态快照...')}${panelMarkup('resources', '正在加载资源用量...')}${panelMarkup('control', '正在加载控制消息...')}</div></div></details>`;
        }

        async function loadDiagnostic(runId, type, detail, options = {}) {
            const cache = getDiagnosticCache(runId), panel = detail?.querySelector?.(`[data-agent-harness-panel="${type}"]`);
            if (!panel) return;
            if (!cache.loaded[type] && !cache.panels[type] && !options.silent) setMarkup(panel, '<div class="empty-state">正在加载诊断数据...</div>');
            const seq = ++cache.sequence;
            cache.fetching[type] = true;
            try {
                let data;
                if (type === 'context') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/context-windows?limit=100`, { cache: 'no-store' })).data || [];
                if (type === 'world') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/world-states?limit=120`, { cache: 'no-store' })).data || [];
                if (type === 'resources') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resources`, { cache: 'no-store' })).data || {};
                if (type === 'control') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages?limit=100`, { cache: 'no-store' })).data || [];
                if (seq !== cache.sequence) return;
                const html = formatDiagnosticHtml(type, data);
                cache.panels[type] = html;
                cache.loaded[type] = true;
                setMarkup(panel, html);
            } catch (error) {
                if (seq !== cache.sequence) return;
                if (!cache.loaded[type] || !cache.panels[type]) setMarkup(panel, `<div class="empty-state agent-harness-error">${escape(error.message || '诊断数据加载失败。')}</div>`);
            } finally { cache.fetching[type] = false; }
        }

        function bindRunDiagnostics(root, runId) {
            const detail = root?.querySelector?.('.agent-run-harness-diagnostics');
            if (!detail || detail.dataset.bound === '1') return;
            detail.dataset.bound = '1';
            const cache = getDiagnosticCache(runId);
            let active = cache.activeTab || diagnostics.get(String(runId)) || 'context';
            cache.activeTab = active;
            diagnostics.set(String(runId), active);
            detail.dataset.agentHarnessActiveTab = active;

            const switchTab = (targetTab, shouldFetch = true) => {
                active = targetTab;
                cache.activeTab = active;
                diagnostics.set(String(runId), active);
                detail.dataset.agentHarnessActiveTab = active;

                // 1. 切换按钮常驻高亮状态，不发生 DOM 重建
                detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(item => {
                    const selected = item.dataset.agentHarnessDiagnosticTab === active;
                    item.classList.toggle('active', selected);
                    item.setAttribute('aria-selected', selected ? 'true' : 'false');
                    item.tabIndex = selected ? 0 : -1;
                });

                // 2. 切换子面板常驻显示，零延迟且无内容闪烁
                detail.querySelectorAll('[data-agent-harness-panel]').forEach(panelEl => {
                    const isMatch = panelEl.dataset.agentHarnessPanel === active;
                    panelEl.classList.toggle('hidden', !isMatch);
                });

                // 3. 静默或平滑更新数据
                if (shouldFetch && detail.open) {
                    loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
                }
            };

            detail.addEventListener('toggle', () => {
                if (detail.open) {
                    loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
                }
            });

            detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(button => {
                button.addEventListener('click', () => {
                    const targetTab = button.dataset.agentHarnessDiagnosticTab || 'context';
                    switchTab(targetTab, true);
                });
            });

            // 初始应用标签与常驻面板状态
            switchTab(active, false);
            if (detail.open) {
                loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
            }

            // 控制表单提交与确认按钮绑定（事件委托）
            detail.addEventListener('submit', async event => {
                const form = event.target.closest('.agent-harness-control-form');
                if (!form) return;
                event.preventDefault();
                let payload = {};
                try { payload = JSON.parse(form.querySelector('[data-agent-control-payload]')?.value || '{}'); } catch (_) { return setNotice('控制消息内容必须是合法 JSON。', 'error'); }
                try {
                    await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: form.querySelector('[data-agent-control-type]')?.value, payload }) });
                    form.reset();
                    await loadDiagnostic(runId, 'control', detail, { silent: true });
                } catch (error) {
                    const controlPanel = detail.querySelector('[data-agent-harness-panel="control"]');
                    if (controlPanel) prependMarkup(controlPanel, `<div class="empty-state agent-harness-error">${escape(error.message || '控制消息发送失败。')}</div>`);
                }
            });

            detail.addEventListener('click', async event => {
                const ack = event.target.closest('[data-agent-control-ack]');
                if (!ack) return;
                try {
                    await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages/${encodeURIComponent(ack.dataset.agentControlAck)}/ack`, { method: 'POST' });
                    await loadDiagnostic(runId, 'control', detail, { silent: true });
                } catch (error) { setNotice(error.message || '控制消息确认失败。', 'error'); }
            });
        }

        return { diagnosticTabMarkup, bindRunDiagnostics };
    }

    window.Pivot?.exposeModule?.('agent.runDiagnostics', { create });
})();

// --- 技术运行诊断与性能报告 (拆自 agent-run-detail.js) ---
function buildAgentDiagnosticReport(run = {}, payload = {}) {
    const progress = payload.progress || {};
    const trace = payload.trace || {};
    const spans = Array.isArray(trace?.spans) ? trace.spans : [];
    const checkpoints = payload.checkpoints || {};
    const tokenUsage = formatAgentTokenUsage(run);
    const durationLabel = agentRunDurationLabel(progress.totalDurationMs || 0);

    const lines = [
        '=== Pivot AI 任务运行诊断报告 ===',
        `任务 ID: ${run.id || '-'}`,
        `任务标题: ${run.title || run.goal || '-'}`,
        `执行状态: ${agentStatusLabel(run.status)} (${agentStatusLabel(run.status)})`,
        `运行模式: ${agentRunModeLabel(run.run_mode)} (${agentRunModeLabel(run.run_mode)})`,
        `调用模型: ${run.model_name || '系统默认'}`,
        `工具权限: ${agentToolPolicyLabel(run.tool_policy)}`,
        `总耗时: ${durationLabel}`,
        `执行轮次: ${Number(progress.roundCount || 0)}${progress.maxSteps ? ` / ${Number(progress.maxSteps)}` : ''}`,
        `步骤记录数: ${Number(progress.stepCount || 0)} 条`,
        `工具调用数: ${Number(progress.toolCount || 0)} 次`,
        `异常记录数: ${Number(progress.errorCount || 0)} 次`,
        `检查点数量: ${Number(checkpoints.total || 0)} 个`,
        tokenUsage ? `模型用量: ${tokenUsage}` : null,
        run.error_message ? `异常信息: ${run.error_message}` : null,
        '',
        `--- 链路环节追踪 (${spans.length} 个环节) ---`,
        ...(spans.length ? spans.map((span, idx) => `  [${idx + 1}] ${agentTraceTypeLabel(span.span_type)} | ${agentTraceDisplayName(span)} | 状态: ${agentStatusLabel(span.status) || '已完成'} | 耗时: ${agentTraceDuration(span.duration_ms)}`) : ['  (无追踪环节)']),
        '',
        `报告生成时间: ${new Date().toLocaleString()}`
    ].filter(item => item !== null);
    return lines.join('\n');
}

function renderAgentRunTechnicalDiagnostics(run, options = {}) {
    const {
        progress = {},
        checkpoints = {},
        tokenUsage = '',
        modelLabel = '',
        durationLabel = '',
        trace = {},
        transactionMarkup = '',
        workingMemoryMarkup = '',
        promptProvenanceMarkup = '',
        browserEvidenceMarkup = '',
        isDiagnosticsOpen = false
    } = options;

    const friendlyTokenUsage = tokenUsage ? tokenUsage.replace(/^模型用量\s*/u, '总计 ') : '';
    const checkpointCount = Number(checkpoints.total || 0);
    const stepCount = Number(progress.stepCount || 0);
    const toolCount = Number(progress.toolCount || 0);
    const errorCount = Number(progress.errorCount || 0);
    const openAttr = isDiagnosticsOpen ? ' open' : '';

    return `
        <details class="agent-run-technical-diagnostics" data-disclosure-key="technical-diagnostics"${openAttr}>
            <summary class="agent-run-technical-head">
                <span class="agent-run-tech-title">
                    <svg class="agent-run-tech-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                    <strong>技术运行诊断与性能分析</strong>
                </span>
                <span>
                    <em>耗时 ${agentEscape(durationLabel)}</em>
                    ${errorCount ? `<em class="has-error">${errorCount} 个异常</em>` : '<em>链路正常</em>'}
                </span>
            </summary>
            <div class="agent-run-technical-body">
                <div class="agent-run-technical-toolbar">
                    <span class="agent-run-technical-tip">以下技术指标与链路详情供问题排查和性能分析使用，普通用户无需关注。</span>
                    <button type="button" class="btn-secondary btn-xs" data-agent-copy-diagnostics="${agentEscapeAttr(run.id)}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span>复制诊断报告</span>
                    </button>
                </div>
                <div class="agent-run-metadata-grid">
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">任务 ID</span>
                        <strong class="agent-run-metadata-value" title="${agentEscapeAttr(run.id)}">${agentEscape(String(run.id || '').slice(0, 12))}</strong>
                    </div>
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">运行模式</span>
                        <strong class="agent-run-metadata-value">${agentEscape(agentRunModeLabel(run.run_mode))}</strong>
                    </div>
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">调用模型</span>
                        <strong class="agent-run-metadata-value">${agentEscape(modelLabel || '系统默认')}</strong>
                    </div>
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">工具权限</span>
                        <strong class="agent-run-metadata-value">${agentEscape(agentToolPolicyLabel(run.tool_policy))}</strong>
                    </div>
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">执行记录</span>
                        <strong class="agent-run-metadata-value">${stepCount} 条</strong>
                    </div>
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">工具调用</span>
                        <strong class="agent-run-metadata-value">${toolCount} 次</strong>
                    </div>
                    ${friendlyTokenUsage ? `
                    <div class="agent-run-metadata-item agent-run-metadata-item--full">
                        <span class="agent-run-metadata-label">模型用量</span>
                        <strong class="agent-run-metadata-value">${agentEscape(friendlyTokenUsage)}</strong>
                    </div>` : ''}
                    ${checkpointCount ? `
                    <div class="agent-run-metadata-item">
                        <span class="agent-run-metadata-label">检查点</span>
                        <strong class="agent-run-metadata-value">${checkpointCount} 个</strong>
                    </div>` : ''}
                </div>
                ${transactionMarkup ? `<div class="agent-run-tech-section">${transactionMarkup}</div>` : ''}
                ${workingMemoryMarkup ? `<div class="agent-run-tech-section">${workingMemoryMarkup}</div>` : ''}
                ${promptProvenanceMarkup ? `<div class="agent-run-tech-section">${promptProvenanceMarkup}</div>` : ''}
                ${browserEvidenceMarkup ? `<div class="agent-run-tech-section">${browserEvidenceMarkup}</div>` : ''}
            </div>
        </details>
    `;
}


if (typeof document !== 'undefined') {
    document.addEventListener('click', async (event) => {
        const copyDiagBtn = event.target.closest('[data-agent-copy-diagnostics]');
        if (copyDiagBtn) {
            const runId = copyDiagBtn.dataset.agentCopyDiagnostics || (typeof activeAgentRunId !== 'undefined' ? activeAgentRunId : '');
            const currentRecord = typeof currentRunDetailRecord !== 'undefined' ? currentRunDetailRecord : null;
            const currentData = typeof currentRunDetailData !== 'undefined' ? currentRunDetailData : {};
            const report = buildAgentDiagnosticReport(currentRecord || { id: runId }, currentData || {});
            try {
                if (typeof copyAgentText === 'function') {
                    await copyAgentText(report);
                } else if (typeof window.Pivot?.legacy?.chatDialogHelpers?.writeTextToClipboard === 'function') {
                    await window.Pivot.legacy.chatDialogHelpers.writeTextToClipboard(report);
                } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    await navigator.clipboard.writeText(report);
                }
                const originalHtml = copyDiagBtn.innerHTML;
                PivotSafeHtml.setHtml(copyDiagBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>已复制</span>');
                setTimeout(() => { PivotSafeHtml.setHtml(copyDiagBtn, originalHtml); }, 1600);
                if (typeof showToast === 'function') showToast('已成功复制技术诊断报告到剪贴板', 'success');
            } catch (e) {
                if (typeof showToast === 'function') showToast('复制失败，请手动选择复制', 'error');
            }
        }
    });
}

