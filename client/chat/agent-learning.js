(function () {
    const state = { settings: {}, jobs: [], experiences: [], proposals: [], memories: [], memorySummary: {}, page: 1, limit: 8 };

    const escape = value => window.PivotSafeHtml?.escapeHtml
        ? window.PivotSafeHtml.escapeHtml(value)
        : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const escapeAttr = value => window.PivotSafeHtml?.escapeAttr
        ? window.PivotSafeHtml.escapeAttr(value)
        : escape(value).replace(/"/g, '&quot;');
    const shortText = (value, max = 120) => {
        const text = String(value ?? '').trim();
        return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    const formatDate = value => {
        const text = String(value || '').trim();
        if (!text) return '未使用';
        const date = new Date(text.includes('T') || /Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`);
        return Number.isNaN(date.getTime()) ? text : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    };
    const notice = (message, tone = 'success') => {
        if (typeof globalThis.showToast === 'function') return globalThis.showToast(message, tone);
        const target = document.getElementById('agent-harness-notice');
        if (target) { target.textContent = message; target.className = `agent-harness-notice is-${tone}`; }
    };
    const setMarkup = (element, markup) => {
        if (!element) return;
        if (window.PivotSafeHtml?.setHtml) window.PivotSafeHtml.setHtml(element, markup);
        else element.textContent = String(markup || '');
    };
    async function request(path, options = {}) {
        const response = await apiFetch(`${API_BASE}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
        return data;
    }

    function memorySourceLabel(memory = {}) {
        if (memory.sourceSessionId) return '来源：对话会话';
        if (Array.isArray(memory.sourceMessageIds) && memory.sourceMessageIds.length) return '来源：对话提炼';
        return '来源：自动沉淀';
    }

    function openMemoryCenter() {
        window.showMainWorkspace?.('settings');
        window.switchTab?.('memories');
    }

    function renderMemories() {
        const summary = document.getElementById('agent-memory-console-summary');
        const list = document.getElementById('agent-memory-console-list');
        if (!summary || !list) return;
        const metrics = state.memorySummary || {};
        setMarkup(summary, `<span class="agent-memory-console-metric">${metrics.enabled === false ? '记忆已关闭' : `活跃 ${Number(metrics.active || 0)}`}</span><span class="agent-memory-console-metric">已暂停 ${Number(metrics.disabled || 0)}</span><span class="agent-memory-console-hint">记忆只会在相关且受策略允许时注入任务上下文。</span>`);
        if (!state.memories.length) {
            setMarkup(list, '<div class="agent-harness-empty-card agent-memory-console-empty"><strong>还没有可展示的记忆</strong><span>完成对话或任务后，符合治理策略的稳定信息会在这里出现。</span></div>');
            return;
        }
        const statusLabel = status => status === 'active' ? '活跃' : status === 'disabled' ? '已暂停' : '已归档';
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:56px" class="tc">序号</th><th style="width:120px" class="tc">类型</th><th>记忆内容</th><th style="width:90px" class="tc">状态</th><th style="width:140px" class="tc">最近使用</th><th style="width:110px" class="tc">来源</th><th style="width:180px" class="tc">操作</th></tr></thead><tbody>${state.memories.map((memory, i) => `<tr><td class="tc font-mono">${i + 1}</td><td class="tc"><span class="agent-inbox-type-badge badge-event">${escape(memory.typeLabel || '记忆')}</span></td><td title="${escapeAttr(memory.content || '')}">${escape(shortText(memory.content || '', 100))}</td><td class="tc"><span class="agent-inbox-type-badge ${memory.status === 'active' ? 'badge-run' : 'badge-event'}">${escape(statusLabel(memory.status))}</span></td><td class="tc">${escape(formatDate(memory.lastUsedAt || memory.updatedAt))}</td><td class="tc">${escape(memorySourceLabel(memory))}</td><td class="tc"><div class="aht-actions"><button type="button" class="btn-secondary btn-xs" data-agent-memory-action="edit" data-agent-memory-id="${escapeAttr(memory.id)}">编辑</button><button type="button" class="btn-secondary btn-xs" data-agent-memory-action="${memory.status === 'active' ? 'pause' : 'restore'}" data-agent-memory-id="${escapeAttr(memory.id)}">${memory.status === 'active' ? '暂停' : '恢复'}</button><button type="button" class="btn-danger-outline btn-xs" data-agent-memory-action="delete" data-agent-memory-id="${escapeAttr(memory.id)}">删除</button></div></td></tr>`).join('')}</tbody></table></div>`);
    }

    async function loadMemories() {
        const [active, paused] = await Promise.all([
            request('/memories?status=active&limit=5', { cache: 'no-store' }),
            request('/memories?status=disabled&limit=3', { cache: 'no-store' })
        ]);
        const deduped = new Map();
        [...(active.memories || []), ...(paused.memories || [])].forEach(memory => deduped.set(String(memory.id), memory));
        state.memories = [...deduped.values()];
        state.memorySummary = active.summary || paused.summary || {};
        renderMemories();
        return { memories: state.memories, summary: state.memorySummary };
    }

    async function actOnMemory(id, action) {
        const memory = state.memories.find(item => String(item.id) === String(id));
        if (!memory) return;
        if (action === 'edit') {
            if (typeof globalThis.openMemoryEditModal === 'function') return globalThis.openMemoryEditModal(memory);
            return openMemoryCenter();
        }
        if (action === 'delete' && typeof globalThis.confirm === 'function' && !globalThis.confirm('删除后该记忆不会再被使用，确定继续吗？')) return;
        try {
            if (action === 'delete') await request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
            else await request(`/memories/${encodeURIComponent(id)}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: action === 'pause' ? 'disabled' : 'active' }) });
            notice(action === 'delete' ? '记忆已删除。' : action === 'pause' ? '记忆已暂停。' : '记忆已恢复。');
            await loadMemories();
        } catch (error) { notice(error.message || '记忆操作失败。', 'error'); }
    }

    function render() {
        const list = document.getElementById('agent-learning-list');
        const pagination = document.getElementById('agent-learning-pagination');
        if (!list) return;
        const proposals = Array.isArray(state.proposals) ? state.proposals : [];
        const experiences = (Array.isArray(state.experiences) ? state.experiences : []).map(item => ({
            ...item,
            proposal: proposals.find(proposal => String(proposal.releaseId || '') === String(item.id || ''))
                || proposals.find(proposal => String(proposal.artifactVersionId || '') === String(item.skill_version_id || ''))
                || null
        }));
        if (!experiences.length && !proposals.length) {
            pagination?.replaceChildren();
            setMarkup(list, '<div class="agent-harness-empty-card"><strong>还没有个人经验</strong><span>完成包含多个步骤的任务后，智能助手会在后台提炼可复用方法。</span></div>');
            return;
        }
        const experienceProposalIds = new Set(experiences.map(item => String(item.proposal?.id || '')).filter(Boolean));
        const rows = [...experiences, ...proposals.filter(proposal => !experienceProposalIds.has(String(proposal.id)) && !['published', 'personal_active'].includes(String(proposal.status || '')))].slice(0, 100);
        const total = rows.length;
        const currentPage = Math.min(Math.max(1, Number(state.page || 1)), Math.max(1, Math.ceil(total / state.limit)));
        state.page = currentPage;
        const start = (currentPage - 1) * state.limit;
        const kindLabel = kind => ({ skill: '技能', workflow: '工作流', preference: '偏好' }[kind] || '方法');
        const statusLabel = status => ({ published: '已启用', personal_active: '已启用', paused: '已暂停', archived: '已归档', rolled_back: '已撤销', rejected: '已拒绝', candidate_created: '待确认', waiting_user_review: '待确认', versioned_draft: '待发布', validation_failed: '验证失败' }[status] || '学习中');
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:48px" class="tc">序号</th><th style="width:160px">经验名称</th><th style="width:75px" class="tc">类别</th><th style="width:80px" class="tc">状态</th><th style="width:80px" class="tc">使用次数</th><th style="width:75px" class="tc">成功率</th><th>提炼说明与方法</th><th style="width:230px" class="tc">操作</th></tr></thead><tbody>${rows.slice(start, start + state.limit).map((item, index) => {
            const proposal = item.proposal || (item.kind ? item : null);
            const status = String(item.status === 'paused' ? 'paused' : proposal?.status || item.status || 'published');
            const title = item.title || item.name || proposal?.title || '个人经验';
            const kind = item.kind || proposal?.kind || 'skill';
            const usesText = item.metrics?.uses != null ? `${item.metrics.uses} 次` : '-';
            const successText = item.metrics?.successRate != null ? `${Math.round(item.metrics.successRate * 100)}%` : '-';
            const description = [item.description || proposal?.description || '已验证的个人处理方法', proposal?.reviewReason || ''].filter(Boolean).join(' · ');
            const id = proposal?.id || '';
            return `<tr><td class="tc">${start + index + 1}</td><td title="${escapeAttr(title)}">${escape(shortText(title, 28))}</td><td class="tc"><span class="agent-inbox-type-badge badge-event">${escape(kindLabel(kind))}</span></td><td class="tc"><span class="agent-inbox-type-badge ${['published', 'personal_active'].includes(status) ? 'badge-run' : ['paused', 'archived', 'rolled_back', 'rejected'].includes(status) ? 'badge-event' : 'badge-approval'}">${escape(statusLabel(status))}</span></td><td class="tc mono">${escape(usesText)}</td><td class="tc mono">${escape(successText)}</td><td title="${escapeAttr(description)}">${escape(shortText(description, 100))}</td><td class="tc"><div class="aht-actions">${id && ['published', 'personal_active'].includes(status) ? `<button type="button" class="btn-secondary btn-xs" data-agent-learning-action="edit" data-agent-learning-id="${escapeAttr(id)}">编辑</button><button type="button" class="btn-secondary btn-xs" data-agent-learning-action="pause" data-agent-learning-id="${escapeAttr(id)}">暂停</button><button type="button" class="btn-secondary btn-xs" data-agent-learning-action="share" data-agent-learning-id="${escapeAttr(id)}">申请共享</button><button type="button" class="btn-danger-outline btn-xs" data-agent-learning-action="revoke" data-agent-learning-id="${escapeAttr(id)}">撤销</button>` : ''}${id && ['paused', 'archived'].includes(status) ? `${proposal?.kind === 'skill' ? `<button type="button" class="btn-secondary btn-xs" data-agent-learning-action="edit" data-agent-learning-id="${escapeAttr(id)}">编辑</button>` : ''}<button type="button" class="btn-primary btn-xs" data-agent-learning-action="restore" data-agent-learning-id="${escapeAttr(id)}">恢复</button>` : ''}${id && ['candidate_created', 'waiting_user_review'].includes(status) && proposal?.kind === 'skill' ? `<button type="button" class="btn-primary btn-xs" data-agent-learning-action="activate" data-agent-learning-id="${escapeAttr(id)}">确认启用</button><button type="button" class="btn-secondary btn-xs" data-agent-learning-action="reject" data-agent-learning-id="${escapeAttr(id)}">拒绝</button>` : ''}${proposal?.kind === 'workflow' && ['candidate_created', 'waiting_user_review'].includes(status) ? `<button type="button" class="btn-secondary btn-xs" data-agent-learning-action="preview" data-agent-learning-id="${escapeAttr(id)}">打开草稿</button><button type="button" class="btn-secondary btn-xs" data-agent-learning-action="share" data-agent-learning-id="${escapeAttr(id)}">发布后申请共享</button><button type="button" class="btn-secondary btn-xs" data-agent-learning-action="reject" data-agent-learning-id="${escapeAttr(id)}">拒绝</button>` : ''}</div></td></tr>`;
        }).join('')}</tbody></table></div>`);
        if (pagination && window.renderWorkspacePagination) window.renderWorkspacePagination(pagination, { total, limit: state.limit, page: currentPage, onPageChange: page => { state.page = page; render(); } });
    }

    async function load() {
        const [data] = await Promise.all([request('/agents/learning/overview', { cache: 'no-store' }), loadMemories()]);
        state.settings = data.settings || {};
        state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
        state.experiences = Array.isArray(data.experiences) ? data.experiences : [];
        state.proposals = Array.isArray(data.proposals) ? data.proposals : [];
        const auto = document.getElementById('agent-learning-auto');
        const activate = document.getElementById('agent-learning-auto-activate');
        const notify = document.getElementById('agent-learning-notify');
        if (auto) auto.checked = state.settings.autoLearning !== false;
        if (activate) activate.checked = state.settings.autoActivate !== false;
        if (notify) notify.checked = state.settings.notifyLearning !== false;
        render();
        return data;
    }

    async function saveSettings() {
        const data = await request('/agents/learning/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoLearning: document.getElementById('agent-learning-auto')?.checked !== false, autoActivate: document.getElementById('agent-learning-auto-activate')?.checked !== false, notifyLearning: document.getElementById('agent-learning-notify')?.checked !== false }) });
        state.settings = data.settings || {};
        notice('自动学习设置已保存。');
    }

    async function act(id, action) {
        const proposal = state.proposals.find(item => String(item.id) === String(id));
        if (action === 'edit') {
            return window.Pivot?.moduleApi?.('agent.skillManagement')?.open?.({ versionId: proposal?.artifactVersionId, releaseId: proposal?.releaseId });
        }
        if (action === 'preview') {
            return window.openAgentDagWorkbench?.({ workflowId: proposal?.artifactId, editor: true });
        }
        const path = action === 'share'
            ? `/agents/evolution/proposals/${encodeURIComponent(id)}/share-request`
            : action === 'reject' ? `/agents/evolution/proposals/${encodeURIComponent(id)}/decision`
                : `/agents/evolution/proposals/${encodeURIComponent(id)}/${action}`;
        try {
            const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: action === 'reject' ? JSON.stringify({ decision: 'reject' }) : undefined });
            notice(result.requiresPreview ? '工作流草稿已生成，请到自动化中心预览。' : action === 'share' ? '组织共享申请已提交。' : action === 'pause' ? '个人经验已暂停。' : action === 'restore' ? '个人经验已恢复。' : action === 'revoke' ? '个人经验已撤销并保留审计历史。' : action === 'reject' ? '待确认改进已拒绝。' : '个人经验已验证并启用。');
            await load();
        } catch (error) { notice(error.message || '个人经验操作失败。', 'error'); }
    }

    function bind() {
        document.getElementById('agent-learning-refresh')?.addEventListener('click', () => load().catch(error => notice(error.message, 'error')));
        document.getElementById('agent-learning-settings-save')?.addEventListener('click', () => saveSettings().catch(error => notice(error.message, 'error')));
        document.getElementById('agent-learning-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-learning-action]');
            if (button) act(button.dataset.agentLearningId, button.dataset.agentLearningAction);
        });
        document.getElementById('agent-memory-console-refresh')?.addEventListener('click', () => loadMemories().catch(error => notice(error.message, 'error')));
        document.getElementById('agent-memory-console-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-memory-action]');
            if (button) actOnMemory(button.dataset.agentMemoryId, button.dataset.agentMemoryAction);
        });
        document.querySelectorAll('[data-memory-open]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); openMemoryCenter(); }));
        document.addEventListener('pivot:memory-changed', () => loadMemories().catch(() => {}));
    }

    window.Pivot?.exposeModule?.('agent.learning', { load, loadMemories, saveSettings, state }, ['load', 'loadMemories', 'saveSettings']);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
})();
