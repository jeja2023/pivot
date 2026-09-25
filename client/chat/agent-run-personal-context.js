/* 个人经验与项目资料包在运行详情中的可解释摘要。 */
/* global API_BASE */
(function () {
    function metadata(run = {}) {
        if (run.metadata && typeof run.metadata === 'object') return run.metadata;
        try { return JSON.parse(String(run.metadata || '{}')) || {}; } catch (_) { return {}; }
    }

    function skillMatchText(run = {}) {
        const value = metadata(run);
        if (!value.learnedSkillAuto || !value.skillTitle) return '';
        const reason = value.skillMatchReason && typeof value.skillMatchReason === 'object' ? value.skillMatchReason : {};
        const terms = Array.isArray(reason.matchedTerms) ? reason.matchedTerms.filter(Boolean).slice(0, 6) : [];
        return `已使用个人经验“${String(value.skillTitle).slice(0, 120)}”：${String(reason.summary || '与当前任务匹配。').slice(0, 180)}${terms.length ? ` 匹配词：${terms.join('、')}。` : ''}`;
    }

    function skillContextMarkup(run = {}, escape = value => String(value || '')) {
        const value = metadata(run);
        if (!value.learnedSkillAuto || !value.skillReleaseId || !value.skillTitle) return '';
        const reason = value.skillMatchReason && typeof value.skillMatchReason === 'object' ? value.skillMatchReason : {};
        const terms = Array.isArray(reason.matchedTerms) ? reason.matchedTerms.filter(Boolean).slice(0, 6) : [];
        return `<div class="agent-context-card"><h5>已使用的个人经验</h5><div class="agent-context-row"><span>${escape(String(value.skillTitle).slice(0, 120))}</span><strong>${escape(String(reason.summary || '与当前任务匹配。').slice(0, 180))}</strong></div>${terms.length ? `<div class="agent-context-row"><span>匹配词</span><strong>${escape(terms.join('、'))}</strong></div>` : ''}<div class="agent-context-actions"><button type="button" class="btn-secondary btn-xs" data-agent-skill-match-pause="${escape(String(run.id || ''))}">这条经验不相关，暂停使用</button></div></div>`;
    }

    function personalContextMarkup(run = {}, escape = value => String(value || '')) {
        return `${memoryContextMarkup(run, escape)}${skillContextMarkup(run, escape)}`;
    }

    function feedbackStatusText(response = {}) {
        return response?.feedback?.learning?.scheduled
            ? '已记录，将基于这次修正生成一条待确认的个人经验。'
            : '已记录，谢谢反馈。';
    }

    function bindSkillMatchPause(container, run = {}) {
        container?.querySelector('[data-agent-skill-match-pause]')?.addEventListener('click', async event => {
            const button = event.currentTarget;
            if (!window.confirm('暂停后，后续任务将不再自动使用这条个人经验；历史记录会保留，且可在“经验沉淀”中恢复。是否继续？')) return;
            button.disabled = true;
            try {
                const response = await fetch(`${API_BASE}/agents/runs/${encodeURIComponent(run.id)}/skill-match/pause`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '暂停个人经验失败');
                window.Pivot?.legacy?.showToast?.(data.message || '已暂停个人经验。', 'success');
                await window.Pivot?.legacy?.openAgentRun?.(run.id, { silent: true });
            } catch (error) { window.Pivot?.legacy?.showToast?.(error.message || '暂停个人经验失败', 'error'); }
            finally { button.disabled = false; }
        });
    }

    function projectContextMarkup(run = {}, escape = value => String(value || '')) {
        const collections = Array.isArray(metadata(run).projectContextPack?.collections) ? metadata(run).projectContextPack.collections : [];
        const names = collections.map(item => String(item?.name || item?.id || '').trim()).filter(Boolean).slice(0, 8);
        return names.length ? `<div class="agent-context-card"><h5>项目资料包</h5><div class="agent-context-row"><span>检索范围</span><strong>${escape(names.join('、'))}</strong></div><div class="agent-context-row"><span>权限校验</span><strong>每次检索按当前授权重新校验</strong></div></div>` : '';
    }

    function memoryContextMarkup(run = {}, escape = value => String(value || '')) {
        const value = metadata(run);
        const reasons = Array.isArray(value.memoryUsage?.reasons)
            ? value.memoryUsage.reasons
            : Array.isArray(value.chatBridge?.memoryUsageReasons) ? value.chatBridge.memoryUsageReasons : [];
        if (!reasons.length) return '';
        const items = reasons.slice(0, 6).map(item => {
            const id = String(item?.memoryId || item?.id || '').trim();
            const reason = String(item?.reason || item?.usageReason || '与当前任务相关。').slice(0, 180);
            const actions = id ? `<span class="agent-context-actions"><button type="button" class="btn-secondary btn-xs" data-agent-memory-disable="${escape(id)}">不相关，暂停</button><button type="button" class="btn-danger-outline btn-xs" data-agent-memory-forget="${escape(id)}">忘记</button></span>` : '';
            return `<div class="agent-context-row agent-memory-context-row"><span>${escape(id ? `记忆 #${id}` : '个人记忆')}</span><strong>${escape(reason)}</strong>${actions}</div>`;
        }).join('');
        return `<div class="agent-context-card"><h5>已使用的个人记忆</h5>${items}</div>`;
    }

    function bindMemoryActions(container, run = {}) {
        const update = async (memoryId, mode) => {
            const forget = mode === 'forget';
            const confirmed = window.confirm(forget
                ? '忘记后，这条记忆不会再自动重建。是否继续？'
                : '暂停后，后续任务不会使用这条记忆。是否继续？');
            if (!confirmed) return;
            const response = await fetch(`${API_BASE}/memories/${encodeURIComponent(memoryId)}${forget ? '' : '/status'}`, {
                method: forget ? 'DELETE' : 'PUT',
                credentials: 'same-origin',
                headers: forget ? undefined : { 'Content-Type': 'application/json' },
                body: forget ? undefined : JSON.stringify({ status: 'disabled' })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || (forget ? '忘记记忆失败' : '暂停记忆失败'));
            window.Pivot?.legacy?.showToast?.(forget ? '已忘记这条记忆。' : '已暂停这条记忆。', 'success');
            await window.Pivot?.legacy?.openAgentRun?.(run.id, { silent: true });
        };
        container?.querySelectorAll('[data-agent-memory-disable]').forEach(button => {
            button.addEventListener('click', () => update(button.dataset.agentMemoryDisable, 'disable').catch(error => window.Pivot?.legacy?.showToast?.(error.message, 'error')));
        });
        container?.querySelectorAll('[data-agent-memory-forget]').forEach(button => {
            button.addEventListener('click', () => update(button.dataset.agentMemoryForget, 'forget').catch(error => window.Pivot?.legacy?.showToast?.(error.message, 'error')));
        });
    }

    function appendCollaboratorGroup(container, run) {
        if (!container || !run?.id) return;
        fetch(`${API_BASE}/agents/runs/${encodeURIComponent(run.id)}/collaborators`, { credentials: 'same-origin' })
            .then(response => response.ok ? response.json() : null)
            .then(data => {
                const rows = Array.isArray(data?.data) ? data.data : [];
                if (!rows.length || !container.isConnected || container.querySelector('[data-agent-collaborator-group]')) return;
                const group = document.createElement('section'); group.className = 'agent-collaborator-group'; group.dataset.agentCollaboratorGroup = run.id;
                const heading = document.createElement('div'); heading.className = 'agent-tool-section-head compact';
                const title = document.createElement('strong'); title.textContent = '并行协作任务组';
                const completed = rows.filter(item => ['completed', 'completed_with_errors'].includes(String(item.status))).length;
                const failed = rows.filter(item => ['error', 'failed', 'cancelled'].includes(String(item.status))).length;
                const summary = document.createElement('span'); summary.textContent = `${completed}/${rows.length} 已完成${failed ? ` · ${failed} 异常` : ''}`;
                heading.append(title, summary); group.appendChild(heading);
                const list = document.createElement('div'); list.className = 'agent-collaborator-list';
                rows.forEach(item => {
                    const row = document.createElement('button'); row.type = 'button'; row.className = `agent-collaborator-row is-${String(item.status || 'unknown')}`;
                    const label = document.createElement('strong'); label.textContent = item.title || '子任务';
                    const status = document.createElement('span'); status.textContent = window.Pivot?.moduleApi?.('agent.runUtils')?.statusLabel?.(item.status) || item.status || '等待中';
                    row.append(label, status); row.addEventListener('click', () => window.Pivot?.legacy?.openAgentRun?.(item.id)); list.appendChild(row);
                });
                group.appendChild(list); container.appendChild(group);
            }).catch(() => {});
    }

    async function createSkillDraftFromRun(runId) {
        const response = await fetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/skill-draft`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '生成 Skill 草稿失败');
        const draft = data.draft || {}; const tools = (draft.provenance?.tools || []).join('、') || '无'; const caps = (draft.provenance?.capabilities || []).join('、') || '无';
        if (!window.confirm(`将创建个人 Skill 草稿（尚未发布）。\n工具：${tools}\n能力：${caps}\n\n确认后仍需在 Skill 管理中校验、编辑并发布。`)) return null;
        const created = await fetch(`${API_BASE}/agents/skills/source`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: draft.markdown, sourceRunId: runId }) });
        const createdData = await created.json().catch(() => ({}));
        if (!created.ok) throw new Error(createdData.error || '创建 Skill 草稿失败');
        window.Pivot?.legacy?.showToast?.('个人 Skill 草稿已创建；请先校验并发布。', 'success');
        window.Pivot?.moduleApi?.('agent.harness')?.loadAgentHarnessSkills?.();
        return createdData.version || null;
    }

    window.Pivot?.exposeModule?.('agent.runPersonalContext', { appendCollaboratorGroup, bindMemoryActions, bindSkillMatchPause, createSkillDraftFromRun, feedbackStatusText, memoryContextMarkup, personalContextMarkup, projectContextPack: projectContextMarkup, projectContextMarkup, skillContextMarkup, skillMatchText });
})();
