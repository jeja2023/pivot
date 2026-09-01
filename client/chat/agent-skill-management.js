// Skill 配方治理：SKILL.md 编辑/预览/版本差异与 release ACL 管理。
// 业务规则全部在服务端，前端只组装已授权 API 调用和展示差异。
/* global API_BASE, PivotSafeHtml, agentEscape, apiFetch, apiJson, showToast */
(() => {
    function ensureModal() {
        let modal = document.getElementById('agent-skill-management-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'agent-skill-management-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
        PivotSafeHtml.setHtml(modal, `
            <div class="modal rag-detail-modal agent-artifact-modal">
                <div class="rag-detail-header"><div><h3 id="agent-skill-management-title">Skill 配方治理</h3><p class="model-modal-desc" id="agent-skill-management-desc"></p></div><button type="button" class="btn-danger-outline" data-skill-management-close>关闭</button></div>
                <div class="agent-artifact-editor"><label><span>SKILL.md</span><textarea id="agent-skill-management-source" class="form-input agent-artifact-content" spellcheck="false"></textarea></label><div class="agent-harness-form-actions"><button type="button" class="btn-secondary" data-skill-management-preview>预览校验</button><button type="button" class="btn-primary" data-skill-management-save>创建新草稿版本</button></div><pre id="agent-skill-management-preview" class="agent-artifact-diff"></pre></div>
                <div class="agent-artifact-editor"><strong>共享发布（管理员）</strong><p class="model-modal-desc">个人发布无需签名；管理员发布到团队或组织时，系统会自动批准、组织签名并完成发布。</p><div class="agent-harness-form-actions"><select id="agent-skill-shared-scope" class="form-input"><option value="organization">发布到组织</option><option value="team">发布到团队</option></select><input id="agent-skill-shared-team" class="form-input" placeholder="团队 ID（仅团队发布）"><button type="button" class="btn-primary" data-skill-management-publish-shared>发布共享版本</button></div></div>
                <div><strong>版本差异</strong><div id="agent-skill-management-history" class="agent-artifact-version-list"></div><pre id="agent-skill-management-diff" class="agent-artifact-diff"></pre></div>
                <div id="agent-skill-management-acl-wrap"><strong>Release 授权（ACL）</strong><div id="agent-skill-management-acl" class="agent-artifact-version-list"></div><div class="agent-harness-form-grid"><label><span>主体类型</span><select id="agent-skill-acl-type" class="form-input"><option value="user">用户</option><option value="team">团队</option><option value="organization">组织</option><option value="role">角色</option></select></label><label><span>主体 ID</span><input id="agent-skill-acl-id" class="form-input"></label><label><span>动作</span><select id="agent-skill-acl-action" class="form-input"><option value="use">use</option><option value="publish">publish</option><option value="manage">manage</option></select></label><label><span>效果</span><select id="agent-skill-acl-effect" class="form-input"><option value="allow">allow</option><option value="deny">deny</option></select></label></div><button type="button" class="btn-secondary" data-skill-acl-save>保存授权</button></div>
            </div>`);
        document.body.appendChild(modal);
        modal.addEventListener('click', event => {
            if (event.target.closest('[data-skill-management-close]')) modal.classList.add('hidden');
        });
        return modal;
    }

    async function readJson(url, options) {
        const res = await apiFetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Skill 管理请求失败。');
        return data;
    }

    function renderDiff(target, diff) {
        const expanded = diff?.privilegeExpanded ? '权限扩大：是' : '权限扩大：否';
        const caps = diff?.capabilities || {};
        const tools = diff?.tools || {};
        target.textContent = [
            expanded,
            `能力新增：${(caps.added || []).join('、') || '无'}`,
            `能力移除：${(caps.removed || []).join('、') || '无'}`,
            `工具新增：${(tools.added || []).join('、') || '无'}`,
            `工具移除：${(tools.removed || []).join('、') || '无'}`,
            `工作指引变更：${diff?.instructionsChanged ? '是' : '否'}`
        ].join('\n');
    }

    async function open(skill = {}) {
        const versionId = String(skill.versionId || skill.release?.skill_version_id || skill.id || '').trim();
        if (!versionId) return showToast('当前 Skill 没有可管理的版本。', 'warning');
        const modal = ensureModal();
        const source = await readJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(versionId)}/source`);
        const history = await readJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(versionId)}/history`);
        const releaseId = String(skill.releaseId || skill.release?.id || '').trim();
        modal.querySelector('#agent-skill-management-title').textContent = `Skill：${source.version?.name || skill.name || ''}`;
        modal.querySelector('#agent-skill-management-desc').textContent = `版本 ${source.version?.version || ''} · ${source.version?.status || ''}`;
        modal.querySelector('#agent-skill-management-source').value = source.markdown || '';
        modal.querySelector('#agent-skill-management-preview').textContent = '';
        const historyList = modal.querySelector('#agent-skill-management-history');
        const rows = history.history || [];
        PivotSafeHtml.setHtml(historyList, rows.map(item => `
            <div class="agent-artifact-version"><div><strong>${agentEscape(item.version || '')}</strong><span>${agentEscape(item.status || '')}</span></div>${String(item.id) !== versionId ? `<button class="btn-secondary" type="button" data-skill-diff="${agentEscape(item.id)}">与当前对比</button>` : ''}</div>
        `).join('') || '<div class="empty-state compact">暂无可比较版本</div>');
        historyList.querySelectorAll('[data-skill-diff]').forEach(button => button.addEventListener('click', async () => {
            try {
                const diff = await readJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(versionId)}/diff/${encodeURIComponent(button.dataset.skillDiff)}`);
                renderDiff(modal.querySelector('#agent-skill-management-diff'), diff.diff);
            } catch (error) { showToast(error.message, 'error'); }
        }));
        modal.querySelector('[data-skill-management-preview]').onclick = async () => {
            try {
                const data = await readJson(`${API_BASE}/agents/skills/source/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: modal.querySelector('#agent-skill-management-source').value }) });
                modal.querySelector('#agent-skill-management-preview').textContent = data.preview?.valid ? '校验通过。' : (data.preview?.errors || []).join('\n');
            } catch (error) { modal.querySelector('#agent-skill-management-preview').textContent = error.message; }
        };
        modal.querySelector('[data-skill-management-save]').onclick = async () => {
            try {
                await readJson(`${API_BASE}/agents/skills/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: modal.querySelector('#agent-skill-management-source').value }) });
                showToast('已创建新的 Skill 草稿版本。', 'success');
                window.Pivot?.moduleApi?.('agent.harness')?.loadAgentHarnessSkills?.();
            } catch (error) { showToast(error.message, 'error'); }
        };
        modal.querySelector('[data-skill-management-publish-shared]').onclick = async () => {
            try {
                const scope = modal.querySelector('#agent-skill-shared-scope').value;
                const teamId = modal.querySelector('#agent-skill-shared-team').value.trim();
                const body = { scope };
                if (scope === 'team') body.teamId = teamId;
                const data = await readJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const target = data.release?.rollout_scope === 'team' ? '团队' : '组织';
                const prefix = data.release?.autoApproved ? '已自动批准、组织签名并' : '已';
                showToast(`${prefix}发布到${target}。`, 'success');
                window.Pivot?.moduleApi?.('agent.harness')?.loadAgentHarnessSkills?.();
            } catch (error) { showToast(error.message, 'error'); }
        };
        await loadAcl(modal, releaseId);
        modal.classList.remove('hidden');
    }

    async function loadAcl(modal, releaseId) {
        const wrap = modal.querySelector('#agent-skill-management-acl-wrap');
        if (!releaseId) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');
        const data = await readJson(`${API_BASE}/agents/skills/releases/${encodeURIComponent(releaseId)}/permissions`);
        const list = modal.querySelector('#agent-skill-management-acl');
        PivotSafeHtml.setHtml(list, (data.data || []).map(item => `<div class="agent-artifact-version"><span>${agentEscape(`${item.subject_type}:${item.subject_id} · ${item.action} · ${item.effect}`)}</span><button type="button" class="btn-secondary" data-skill-acl-delete="${agentEscape(item.id)}">删除</button></div>`).join('') || '<div class="empty-state compact">没有额外 ACL，按发布范围授予访问。</div>');
        list.querySelectorAll('[data-skill-acl-delete]').forEach(button => button.addEventListener('click', async () => {
            try { await readJson(`${API_BASE}/agents/skills/releases/${encodeURIComponent(releaseId)}/permissions/${encodeURIComponent(button.dataset.skillAclDelete)}`, { method: 'DELETE' }); await loadAcl(modal, releaseId); } catch (error) { showToast(error.message, 'error'); }
        }));
        modal.querySelector('[data-skill-acl-save]').onclick = async () => {
            try {
                await readJson(`${API_BASE}/agents/skills/releases/${encodeURIComponent(releaseId)}/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: modal.querySelector('#agent-skill-acl-type').value, subjectId: modal.querySelector('#agent-skill-acl-id').value, action: modal.querySelector('#agent-skill-acl-action').value, effect: modal.querySelector('#agent-skill-acl-effect').value }) });
                await loadAcl(modal, releaseId);
            } catch (error) { showToast(error.message, 'error'); }
        };
    }

    window.Pivot?.exposeModule?.('agent.skillManagement', { open });
})();
