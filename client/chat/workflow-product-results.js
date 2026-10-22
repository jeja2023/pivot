/* 就地结果区域区分测试来源与真实运行，刷新不会伪造完成状态。 */
(function () {
    let activeRun = null;
    let timer = null;
    let sequence = 0;
    const sessions = new Map();
    const bridge = () => window.Pivot?.moduleApi?.('agent.workflowBridge') || {};
    const escape = text => window.Pivot?.legacy?.PivotSafeHtml?.escapeHtml?.(String(text ?? '')) ?? String(text ?? '');
    const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch (_) { return {}; } };
    const statusNames = { queued: '已排队', running: '运行中', needs_input: '需要补充', awaiting_commit: '等待提交', paused: '已暂停', waiting_approval: '等待审批', partial: '部分完成', completed: '已完成', error: '失败', cancelled: '已取消', completed_with_errors: '部分完成', waiting_delay: '等待延时', verifying: '正在验收' };

    function getStatusSvg(status, size = 14) {
        const s = size;
        switch (status) {
            case 'completed':
                return `<svg class="status-svg status-svg-completed" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="16 10 11 15 8 12"></polyline></svg>`;
            case 'running':
            case 'verifying':
                return `<svg class="status-svg status-svg-running icon-spin" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`;
            case 'error':
            case 'failed':
                return `<svg class="status-svg status-svg-error" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
            case 'queued':
            case 'waiting_delay':
            case 'waiting_approval':
                return `<svg class="status-svg status-svg-queued" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
            case 'cancelled':
            case 'paused':
                return `<svg class="status-svg status-svg-cancelled" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>`;
            case 'partial':
            case 'completed_with_errors':
                return `<svg class="status-svg status-svg-partial" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
            default:
                return `<svg class="status-svg status-svg-default" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
        }
    }

    function getItemStatus(item, id = '') {
        if (!item) return 'default';
        if (item.run?.status) return item.run.status;
        if (item.error) return 'error';
        if (String(id).startsWith('node:') || item.source?.includes('测试')) return 'debug';
        return 'completed';
    }

    function getStatusSymbol(status) {
        switch (status) {
            case 'completed':
                return '✓';
            case 'running':
            case 'verifying':
                return '⟳';
            case 'error':
            case 'failed':
                return '✕';
            case 'debug':
                return '▶';
            case 'queued':
            case 'waiting_approval':
            case 'waiting_delay':
                return '⏱';
            case 'cancelled':
            case 'paused':
                return '⊘';
            default:
                return '✓';
        }
    }

    function formatRunTime(val) {
        if (!val) return '';
        const d = new Date(val);
        if (Number.isNaN(d.getTime())) return String(val).slice(0, 19);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:${min}`;
    }

    function formatOptionLabel(id, item) {
        const st = getItemStatus(item, id);
        const symbol = getStatusSymbol(st);
        const time = formatRunTime(item.run?.created_at || item.run?.updated_at);
        const statusTag = (st === 'completed') ? '' : (item.run?.status ? `[${statusNames[item.run.status] || item.run.status}]` : (id.startsWith('node:') ? '[单步测试]' : ''));
        let src = item.source || '';
        if (src === '历史发布运行' || src === '发布版运行') src = '发布版';
        else if (src === '试运行草稿') src = '草稿试跑';
        else if (src === '实际节点测试 · 当前草稿') src = '单步测试';
        const srcTag = src ? `[${src}]` : '';
        let title = item.run?.title || item.title || '运行结果';
        title = title.replace(/^(执行工作流|预览运行|发布版运行|工作流运行)[：:]\s*/u, '').trim();
        const parts = [];
        if (symbol) parts.push(symbol);
        if (time) parts.push(time);
        if (statusTag) parts.push(statusTag);
        if (srcTag && srcTag !== statusTag) parts.push(srcTag);
        if (title) parts.push(title);
        return parts.join(' ');
    }

    function buildHistoryOptions(selectedKey) {
        const debugItems = [];
        const historyRuns = [];
        sessions.forEach((item, id) => {
            if (id.startsWith('node:') || item.source?.includes('测试') || (!item.run && !item.isHistoryStub)) {
                debugItems.push([id, item]);
            } else {
                historyRuns.push([id, item]);
            }
        });
        historyRuns.sort((a, b) => new Date(b[1].run?.created_at || 0) - new Date(a[1].run?.created_at || 0));

        let html = '';
        if (debugItems.length && historyRuns.length) {
            html += `<optgroup label="单步/调试测试">` +
                debugItems.map(([id, item]) => `<option value="${escape(id)}" ${id === selectedKey ? 'selected' : ''}>${escape(formatOptionLabel(id, item))}</option>`).join('') +
                `</optgroup><optgroup label="历史运行记录">` +
                historyRuns.map(([id, item]) => `<option value="${escape(id)}" ${id === selectedKey ? 'selected' : ''}>${escape(formatOptionLabel(id, item))}</option>`).join('') +
                `</optgroup>`;
        } else {
            const allItems = [...debugItems, ...historyRuns];
            if (!allItems.length && selectedKey) {
                html = `<option value="${escape(selectedKey)}" selected>✓ 当前运行结果</option>`;
            } else {
                html = allItems.map(([id, item]) => `<option value="${escape(id)}" ${id === selectedKey ? 'selected' : ''}>${escape(formatOptionLabel(id, item))}</option>`).join('');
            }
        }
        return html;
    }

    let loadingHistory = false;
    async function loadHistory(workflowId, workflowName, currentKey) {
        if (loadingHistory || !bridge()?.request) return;
        loadingHistory = true;
        try {
            const response = await bridge().request('/agents/runs?includePreview=true&runType=workflow&limit=30');
            if (!response?.ok) return;
            const result = await response.json();
            const runs = result?.data || [];
            let added = 0;
            runs.forEach(candidate => {
                const meta = parse(candidate.metadata);
                const candWfId = meta.workflowId || meta.workflowEditorId;
                const candWfName = meta.workflowName;
                const matches = (workflowId && candWfId && String(candWfId) === String(workflowId)) ||
                    (workflowName && (candWfName === workflowName || candidate.title?.includes(workflowName)));
                if (!matches) return;
                if (!sessions.has(candidate.id)) {
                    let src = '工作流运行';
                    if (meta.workflowRunSource === 'preview' || candidate.title?.startsWith('预览运行')) {
                        src = '草稿预览';
                    } else if (meta.workflowVersion) {
                        src = `发布版 V${meta.workflowVersion}`;
                    } else if (candidate.title?.startsWith('执行工作流')) {
                        src = '发布版运行';
                    }
                    sessions.set(candidate.id, {
                        title: candidate.title,
                        source: src,
                        run: candidate,
                        isHistoryStub: true
                    });
                    added += 1;
                }
            });
            if (added > 0 || sessions.size > 0) {
                const canvasViewBtn = document.getElementById('agent-dag-canvas-view-results');
                if (canvasViewBtn) canvasViewBtn.hidden = false;
                const panel = document.getElementById('workflow-product-results');
                const select = panel?.querySelector('[data-result-history]');
                if (select) {
                    const activeVal = select.value || currentKey;
                    const newHtml = buildHistoryOptions(activeVal);
                    PivotSafeHtml.setHtml(select, newHtml);
                    select.value = activeVal;
                }
            }
        } catch (_) {
            /* 历史记录获取异常不阻断当前运行结果呈现 */
        } finally {
            loadingHistory = false;
        }
    }

    function reuseIssue(run, spec, inputs) {
        const metadata = parse(run.metadata);
        const definition = window.Pivot.moduleApi('agent.dagDefinition');
        const normalize = value => window.Pivot.moduleApi('agent.dagCore').serialize(window.Pivot.moduleApi('agent.dagCore').ensureDefaults(value));
        if (definition.stable(definition.executionSpec(normalize(metadata.dagSpec || {}))) !== definition.stable(definition.executionSpec(normalize(spec)))) return '历史定义与当前草稿不同，不能复用；请重新测试。';
        if (definition.stable(metadata.dagInputs || {}) !== definition.stable(inputs || {})) return '历史运行输入与当前输入不同，不能复用；请重新测试。';
        return '';
    }
    function valueHtml(value) {
        if (value?.workflowDeliveries) return value.workflowDeliveries.map(item => `<section><h4>${escape(item.title)}</h4>${valueHtml(item.output)}</section>`).join('');
        if (value?.presentation === 'table' && value.table) return valueHtml(value.table.rows);
        if (value?.presentation === 'file' && value.file) {
            const file = value.file; let href = '';
            try { const url = new URL(file.downloadUrl || file.url, globalThis.location.href); if (['http:', 'https:'].includes(url.protocol)) href = url.href; } catch (_) { /* 没有 URL 的受控产物从完整记录打开。 */ }
            return `<p>${escape(file.name || '文件产物')}${href ? ` · <a href="${escape(href)}" target="_blank" rel="noopener noreferrer">预览 / 下载</a>` : ' · 在完整记录中查看'}</p>`;
        }
        if (value && Object.hasOwn(value, 'value') && value.name && value.format) return valueHtml(value.value);
        if (Array.isArray(value) && value.some(row => row && typeof row === 'object')) {
            const columns = [...new Set(value.flatMap(row => Object.keys(row || {})))].slice(0, 20);
            return `<div class="table-container"><table class="data-table"><thead><tr>${columns.map(key => `<th>${escape(key)}</th>`).join('')}</tr></thead><tbody>${value.slice(0, 100).map(row => `<tr>${columns.map(key => `<td>${escape(typeof row?.[key] === 'object' ? JSON.stringify(row[key]) : row?.[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${value.length > 100 ? '<p>表格预览前 100 行，完整数据可在原运行中查看。</p>' : ''}`;
        }
        if (typeof value === 'string') return window.Pivot?.legacy?.renderMarkdown ? window.Pivot.legacy.renderMarkdown(value) : value;
        if (value?.rows) return valueHtml(value.rows);
        if (value?.text || value?.content || value?.markdown) return valueHtml(value.text || value.content || value.markdown) + (value.artifact?.id ? `<button type="button" class="btn-secondary" data-result-artifact="${escape(value.artifact.id)}">打开完整报告</button>` : '');
        return `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
    }
    function render({ title, source, output, input, nodes = [], run = null, error = '', openModal = true }) {
        const panel = document.getElementById('workflow-product-results');
        if (!panel) return;
        if (openModal) panel.hidden = false;
        const canvasViewBtn = document.getElementById('agent-dag-canvas-view-results');
        if (canvasViewBtn) canvasViewBtn.hidden = false;
        const key = run?.id || `node:${title}`;
        sessions.set(key, { title, source, output, input, nodes, run, error });
        if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
        const disclosure = [...panel.querySelectorAll('details')].map(item => item.open);
        const statusClass = run ? (run.status || 'default') : (error ? 'error' : (key.startsWith('node:') ? 'debug' : 'completed'));
        const statusText = run ? (statusNames[run.status] || run.status) : (error ? '失败' : (key.startsWith('node:') ? '单步测试' : '已完成'));
        let pillSource = source;
        if (pillSource === '历史发布运行' || pillSource === '发布版运行') pillSource = '发布版';
        else if (pillSource === '试运行草稿') pillSource = '草稿试跑';
        const formattedTime = run?.created_at ? formatRunTime(run.created_at) : '';
        const historyOptionsHtml = buildHistoryOptions(key);

        const hasInputs = Boolean(input && typeof input === 'object' && Object.keys(input).length > 0);
        const inputsHtml = hasInputs
            ? `<div class="workflow-product-trace-inputs"><span class="workflow-product-trace-label">运行输入参数：</span><div class="workflow-product-trace-params">${Object.entries(input).map(([k, v]) => `<span class="workflow-product-param-tag"><code>${escape(k)}</code>: ${escape(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`).join('')}</div></div>`
            : '';
        const traceTitle = hasInputs ? `输入与执行过程 (${nodes.length} 个步骤)` : `执行过程 (${nodes.length} 个步骤)`;

        const contentHtml = `<div class="workflow-product-results-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-results-title"><header class="workflow-product-results-header"><div class="workflow-product-results-title-group"><span class="workflow-product-results-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg></span><h3 id="workflow-results-title">${escape(title)}</h3><span class="workflow-product-results-source-pill status-${escape(statusClass)}"><span class="workflow-product-pill-icon" aria-hidden="true">${getStatusSvg(statusClass, 12)}</span>${escape(pillSource)} · ${escape(statusText)}</span>${formattedTime ? `<span class="workflow-product-results-time">${escape(formattedTime)}</span>` : ''}</div><div class="workflow-product-results-header-actions"><div class="workflow-product-history-wrap"><label class="workflow-product-history-label" for="workflow-results-history-select"><span class="workflow-product-history-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span><span class="workflow-product-history-text">历史运行</span></label><div class="workflow-product-history-select-box"><select id="workflow-results-history-select" class="form-input workflow-product-history-select" data-result-history title="切换历史运行记录">${historyOptionsHtml}</select></div></div><button type="button" class="btn-secondary workspace-modal-close workflow-product-results-close" aria-label="关闭结果面板" title="关闭 (Esc)">关闭</button></div></header><div class="workflow-product-results-body">${error ? `<p role="alert" class="workflow-product-results-error">${escape(error)}</p>` : ''}<div class="text-body message-content workflow-product-output">${output !== undefined ? valueHtml(output) : '<p>正在等待结果，已完成的步骤会保留。</p>'}</div><details class="workflow-product-results-trace"><summary>${traceTitle}</summary>${inputsHtml}<ol class="workflow-product-steps-list">${nodes.map(node => `<li class="workflow-product-step-item"><button type="button" class="btn-secondary btn-xs workflow-product-step-node-btn" data-result-node="${escape(node.node_key || node.id)}" title="点击在画布中定位此节点">${escape(node.title || node.node_key || node.id)}</button> <span class="workflow-product-node-status status-${escape(node.status || '')}"><span class="workflow-product-node-status-icon" aria-hidden="true">${getStatusSvg(node.status || 'default', 11)}</span>${escape(statusNames[node.status] || node.status || '')}</span>${node.error_message ? `<span class="workflow-product-step-error">：${escape(node.error_message)}</span>` : ''}</li>`).join('')}</ol></details></div><footer class="workflow-product-results-footer workflow-product-row"><div class="workflow-product-results-footer-actions">${run ? '<button type="button" class="btn-secondary" data-result-details>完整记录 / 审批 / 产物</button><button type="button" class="btn-secondary" data-result-refresh>刷新运行状态</button>' + (!bridge().readOnly?.() ? '<button type="button" class="btn-secondary" data-result-reuse>将已完成节点结果用于调试</button>' : '') + (['error', 'partial', 'completed_with_errors'].includes(run.status) ? '<button type="button" class="btn-secondary" data-result-retry>从失败处继续</button>' : '') : ''}</div></footer></div>`;

        PivotSafeHtml.setHtml(panel, contentHtml);

        [...panel.querySelectorAll('details')].forEach((item, index) => { item.open = disclosure[index] || false; });
        panel.querySelector('[data-result-history]')?.addEventListener('change', async event => {
            const val = event.target.value;
            const saved = sessions.get(val);
            if (!saved) return;
            if (saved.run) void watch(saved.run, saved.source);
            else { stop(); render(saved); }
        });
        panel.querySelectorAll('[data-result-artifact]').forEach(button => button.addEventListener('click', () => window.Pivot?.moduleApi?.('agent.artifacts')?.openVersions?.(button.dataset.resultArtifact)));
        panel.querySelector('[data-result-refresh]')?.addEventListener('click', () => void watch(run, source));
        panel.querySelectorAll('[data-result-node]').forEach(button => button.addEventListener('click', () => { panel.hidden = true; bridge().focus?.(button.dataset.resultNode); }));
        panel.querySelector('[data-result-details]')?.addEventListener('click', () => window.Pivot?.legacy?.openAgentRun?.(run?.id));
        panel.querySelector('[data-result-reuse]')?.addEventListener('click', () => {
            const core = window.Pivot?.moduleApi?.('agent.dagCore');
            if (!core) return;
            const currentSpec = bridge().spec?.() || {};
            const currentInputs = bridge().inputs?.() || {};
            core.setDagNodeTestContext(currentSpec, currentInputs);
            const issue = reuseIssue(run, currentSpec, currentInputs);
            const toastFn = window.Pivot?.legacy?.showToast || (typeof showToast === 'function' ? showToast : null);

            const completedNodes = (nodes || []).filter(node => node.status === 'completed' && node.output !== undefined);
            if (!completedNodes.length) {
                const msg = '当前运行结果中没有已完成的步骤输出可供复用。';
                window.Pivot?.moduleApi?.('agent.workflowExperience')?.status?.(msg, 'warning');
                if (toastFn) toastFn(msg, 'warning');
                return;
            }

            completedNodes.forEach(node => {
                const key = node.node_key || node.id;
                core.setDagNodeTestOutput(key, { output: node.output, source: 'history', expiresAt: Date.now() + 900000, runId: run?.id });
            });
            bridge().editor?.()?.refresh?.();
            window.Pivot?.moduleApi?.('agent.workflowDrafts')?.changed?.();

            const reuseBtn = panel.querySelector('[data-result-reuse]');
            if (reuseBtn) {
                const origText = reuseBtn.textContent;
                reuseBtn.textContent = `已复用 (${completedNodes.length}个节点)`;
                reuseBtn.classList.add('btn-success-feedback');
                setTimeout(() => {
                    if (reuseBtn) {
                        reuseBtn.textContent = origText;
                        reuseBtn.classList.remove('btn-success-feedback');
                    }
                }, 2500);
            }

            if (issue) {
                const warnMsg = `已将 ${completedNodes.length} 个节点结果注入草稿用于调试（提示：${issue}）`;
                window.Pivot?.moduleApi?.('agent.workflowExperience')?.status?.(warnMsg, 'warning');
                if (toastFn) toastFn(warnMsg, 'info');
            } else {
                const successMsg = `已成功将 ${completedNodes.length} 个节点的历史运行结果注入当前草稿用于调试！`;
                window.Pivot?.moduleApi?.('agent.workflowExperience')?.status?.(successMsg);
                if (toastFn) toastFn(successMsg, 'success');
            }
        });
        panel.querySelector('[data-result-retry]')?.addEventListener('click', async event => {
            if (!run) return;
            event.target.disabled = true;
            try {
                const response = await bridge().request(`/agents/runs/${encodeURIComponent(run.id)}/dag/rerun`, { method: 'POST', body: JSON.stringify({ nodeId: nodes.find(node => ['error', 'continued_error'].includes(node.status))?.node_key || '' }) });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '重试失败。');
                await watch(data.run, '局部重跑');
            } catch (failure) { window.Pivot?.moduleApi?.('agent.workflowExperience')?.status?.(failure.message, 'error'); }
            finally { event.target.disabled = false; }
        });
        panel.querySelector('.workflow-product-results-close')?.addEventListener('click', () => { panel.hidden = true; });
        if (!panel.dataset.dismissBound) {
            panel.dataset.dismissBound = 'true';
            panel.addEventListener('click', event => { if (event.target === panel) panel.hidden = true; });
            document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) panel.hidden = true; });
        }

        const meta = parse(run?.metadata);
        const curWf = bridge()?.current?.();
        const curDraft = window.Pivot?.moduleApi?.('agent.workflowDrafts')?.current?.();
        const wfId = curWf?.id || curDraft?.workflow_id || meta?.workflowId || meta?.workflowEditorId;
        const wfName = curWf?.name || curDraft?.name || meta?.workflowName;
        if (wfId || wfName) {
            void loadHistory(wfId, wfName, key);
        }
    }
    async function watch(run, source = '试运行草稿', { openModal = true } = {}) {
        stop(); activeRun = run.id;
        const key = window.Pivot?.moduleApi?.('agent.workflowDrafts')?.current?.()?.key;
        try { if (key && bridge()?.userId) sessionStorage.setItem(`pivot.workflow.run.${bridge().userId()}.${key}`, JSON.stringify({ id: run.id, source })); } catch (_) { /* 无存储时仍可从运行历史恢复。 */ }
        const currentSequence = sequence;
        const poll = async () => {
            if (currentSequence !== sequence || document.getElementById('agent-dag-workbench-modal')?.classList.contains('hidden')) return;
            try {
                const response = await bridge().request(`/agents/runs/${encodeURIComponent(activeRun)}`);
                const detail = await response.json();
                if (currentSequence !== sequence) return;
                if (!response.ok) throw new Error(detail.error || '读取运行结果失败，可重试。');
                const current = detail.run;
                const deliveries = (detail.dagNodes || []).filter(node => node.tool_name === 'workflow.output' && node.status === 'completed' && node.output !== undefined);
                const output = deliveries.length ? { workflowDeliveries: deliveries.map(node => ({ title: node.title || node.node_key, output: node.output })) } : current.final_answer || undefined;
                const inFlight = ['queued', 'running', 'verifying', 'planning', 'waiting_delay'].includes(current.status);
                const shouldOpen = openModal || inFlight;
                render({ title: '运行结果', source, output, input: parse(current.metadata).dagInputs, nodes: detail.dagNodes || [], run: current, error: current.error_message, openModal: shouldOpen });
                if (inFlight) timer = setTimeout(poll, 1400);
            } catch (error) { if (currentSequence === sequence) render({ title: '运行结果', source, error: error.message, run, openModal }); }
        };
        await poll();
    }
    function stop() { sequence += 1; clearTimeout(timer); }
    function nodeResult(node, data) { stop(); render({ title: `${node.title || node.id} · 测试结果`, source: '实际节点测试 · 当前草稿', output: data.output, input: data.resolvedInput }); }
    function reset() {
        stop(); sessions.clear();
        const panel = document.getElementById('workflow-product-results');
        if (panel) panel.hidden = true;
        const canvasViewBtn = document.getElementById('agent-dag-canvas-view-results');
        if (canvasViewBtn) canvasViewBtn.hidden = true;
    }
    function open() {
        const panel = document.getElementById('workflow-product-results');
        if (!panel) return;
        if (!panel.innerHTML.trim() && sessions.size > 0) {
            const first = sessions.values().next().value;
            if (first?.run) {
                void watch(first.run, first.source);
                return;
            } else if (first) {
                render(first);
                return;
            }
        }
        if (sessions.size > 0 || panel.innerHTML.trim()) {
            panel.hidden = false;
            const curWf = bridge()?.current?.();
            const curDraft = window.Pivot?.moduleApi?.('agent.workflowDrafts')?.current?.();
            const wfId = curWf?.id || curDraft?.workflow_id;
            const wfName = curWf?.name || curDraft?.name;
            if (wfId || wfName) void loadHistory(wfId, wfName, activeRun);
        }
    }
    function close() {
        const panel = document.getElementById('workflow-product-results');
        if (panel) panel.hidden = true;
    }
    async function restore(key) {
        try {
            const uid = bridge()?.userId?.();
            const saved = uid ? JSON.parse(sessionStorage.getItem(`pivot.workflow.run.${uid}.${key}`) || 'null') : null;
            if (saved?.id) await watch({ id: saved.id }, saved.source, { openModal: false });
            else {
                const wfId = key.replace(/^(workflow-|new-)/, '');
                if (wfId && !Number.isNaN(Number(wfId))) void loadHistory(wfId, '', '');
            }
        } catch (_) { /* 无效记录不会阻断草稿。 */ }
    }
    window.Pivot.registerModule('agent.workflowResults', { watch, stop, reset, restore, render, valueHtml, nodeResult, reuseIssue, open, close });
})();
