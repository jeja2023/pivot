/* 运行诊断面板：负责单次运行的缓存、请求与交互，不承担授权决策。 */
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
