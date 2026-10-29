/* 技能单文件导入：先核对内容和工具，再沿用现有个人发布门禁。 */
/* global API_BASE, apiFetch */
(() => {
    let bound = false;
    let proposal = null;
    let sourceText = '';
    let draftId = '';
    let stage = '';
    let preparedSnapshot = '';
    let publishAttempted = false;
    let creationAttempted = false;
    let busy = false;
    let toolsGeneration = 0;
    let fileGeneration = 0;
    let toolsFingerprint = '';
    let toolsLoading = null;
    let cachedTools = [];
    let modalSelected = new Set();
    function updateToolsPreview() {
        const preview = document.getElementById('agent-skill-tools-tags-preview');
        const badge = document.getElementById('agent-skill-tools-count-badge');
        const sel = document.getElementById('agent-skill-import-tools');
        if (!preview) return;
        const selected = sel ? [...sel.selectedOptions].map(o => o.value) : [];
        if (badge) { badge.textContent = selected.length ? `已选 ${selected.length}` : ''; badge.className = 'agent-skill-tools-badge' + (selected.length ? ' has-selection' : ''); }
        if (!selected.length) { PivotSafeHtml.setHtml(preview, '<span class="agent-skill-tools-empty-hint">暂未选择工具（点击左侧按钮配置）</span>'); return; }
        PivotSafeHtml.setHtml(preview, selected.map(function(name) {
            const tool = cachedTools.find(function(t) { return t.name === name; });
            const label = tool ? (tool.title || tool.name) : name;
            return `<span class="agent-skill-tool-tag" title="${name}"><span>${label}</span><button type="button" class="btn-secondary agent-skill-tool-tag-remove" data-tool-name="${name}" aria-label="移除 ${label}">×</button></span>`;
        }).join(''));
        preview.querySelectorAll('.agent-skill-tool-tag-remove').forEach(btn => { btn.addEventListener('click', e => { e.stopPropagation(); const sel2 = document.getElementById('agent-skill-import-tools'); if (sel2) { const opt = sel2.querySelector(`option[value="${btn.dataset.toolName}"]`); if (opt) opt.selected = false; } modalSelected.delete(btn.dataset.toolName); updateToolsPreview(); invalidate(); }); });
    }
    function updateModalSummary() {
        const el = document.getElementById('agent-skill-tools-selected-summary');
        if (el) el.textContent = modalSelected.size ? `已选 ${modalSelected.size} 个工具` : '未选择工具';
        const count = document.getElementById('agent-skill-tools-modal-count');
        if (count) count.textContent = `已选 ${modalSelected.size} / ${cachedTools.length}`;
    }
    function renderToolsGrid(filter) {
        const grid = document.getElementById('agent-skill-tools-grid');
        if (!grid) return;
        const q = (filter || '').trim().toLowerCase();
        const visible = cachedTools.filter(t => !q || (t.name || '').toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
        if (!visible.length) { PivotSafeHtml.setHtml(grid, '<p class="agent-skill-tools-modal-empty">没有匹配的工具</p>'); return; }
        PivotSafeHtml.setHtml(grid, visible.map(t => { const isSel = modalSelected.has(t.name); return `<label class="agent-skill-tool-card${isSel ? ' is-selected' : ''}"><input type="checkbox" class="agent-skill-tool-checkbox" value="${t.name}"${isSel ? ' checked' : ''}><div class="agent-skill-tool-card-content"><div class="agent-skill-tool-card-head"><strong>${t.title || t.name}</strong>${t.approvalRequired ? '<span class="agent-skill-tool-badge-approval">需审批</span>' : ''}</div><div class="agent-skill-tool-card-name">${t.name}</div>${t.description ? `<div class="agent-skill-tool-card-desc">${t.description}</div>` : ''}</div></label>`; }).join(''));
        grid.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.addEventListener('change', () => { if (cb.checked) modalSelected.add(cb.value); else modalSelected.delete(cb.value); const card = cb.closest('.agent-skill-tool-card'); if (card) card.classList.toggle('is-selected', cb.checked); updateModalSummary(); }); });
    }
    function setToolsModalVisibility(visible) {
        const modal = document.getElementById('agent-skill-tools-modal');
        if (!modal) return;
        if (visible) {
            const sel = document.getElementById('agent-skill-import-tools');
            modalSelected = new Set(sel ? [...sel.selectedOptions].map(o => o.value) : []);
            modal.classList.remove('hidden');
            renderToolsGrid(document.getElementById('agent-skill-tools-filter')?.value || '');
            updateModalSummary();
        } else { modal.classList.add('hidden'); }
    }
    function confirmToolsSelection() {
        const sel = document.getElementById('agent-skill-import-tools');
        if (sel) { [...sel.options].forEach(o => { o.selected = modalSelected.has(o.value); }); }
        setToolsModalVisibility(false);
        updateToolsPreview();
        invalidate();
    }
    const element = id => document.getElementById(id);
    const status = text => { const target = element('agent-skill-import-status'); if (target) target.textContent = text; };
    const riskText = value => ({ low: '低', medium: '中', high: '高', critical: '高' }[value] || '未标注');
    function invalidate() {
        proposal = null;
        preparedSnapshot = '';
        if (!draftId && !creationAttempted) {
            element('agent-skill-import-submit').disabled = true;
            element('agent-skill-import-review').textContent = '';
        }
        if (!busy) status('内容或工具已更改，请重新预览。');
    }
    function lockInputs(locked) {
        ['agent-skill-import-source', 'agent-skill-import-title', 'agent-skill-import-description', 'agent-skill-import-tools', 'agent-skill-import-preview', 'agent-skill-tools-picker-open-btn'].forEach(id => { const target = element(id); if (target) target.disabled = locked; });
    }
    async function request(url, options = {}) {
        const response = await apiFetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const details = [...(data.manifest?.errors || []), ...(data.declarative?.errors || []), ...(data.supplyChain?.errors || []), data.sandbox?.result?.stderr].filter(Boolean);
            const error = new Error(data.error || data.message || details.join('；') || `请求失败（${response.status}）`);
            error.status = response.status;
            throw error;
        }
        return data;
    }
    const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function findDraft() {
        const versions = await request(`${API_BASE}/agents/skills/versions?limit=200`, { cache: 'no-store' });
        return (versions.data || []).find(item => String(item.name) === proposal.name && String(item.version) === '1.0.0');
    }
    async function loadTools() {
        const select = element('agent-skill-import-tools');
        if (!select || draftId || busy || creationAttempted) return;
        if (toolsLoading) return toolsLoading;
        const sequence = ++toolsGeneration;
        const previous = new Set([...select.selectedOptions].map(option => option.value));
        toolsLoading = (async () => { try {
            const data = await request(`${API_BASE}/agents/skills/import/tools`, { cache: 'no-store' });
            if (sequence !== toolsGeneration || draftId || busy || creationAttempted) return;
            const nextFingerprint = JSON.stringify([...(data.tools || [])].sort((a, b) => String(a.name).localeCompare(String(b.name))));
            if (toolsFingerprint && toolsFingerprint !== nextFingerprint) invalidate();
            toolsFingerprint = nextFingerprint;
            cachedTools = Array.isArray(data.tools) ? [...data.tools] : [];
            select.replaceChildren();
            for (const tool of Array.isArray(data.tools) ? data.tools : []) {
                const option = document.createElement('option');
                option.value = tool.name;
                option.textContent = `${tool.title || tool.name}（${tool.name}）${tool.approvalRequired ? ' · 需要审批' : ''}`;
                option.selected = previous.has(tool.name);
                select.append(option);
            }
            updateToolsPreview();
            if (!select.options.length) status('当前没有可用工具，请先在工具库配置或授权。');
        } catch (_) {
            if (sequence === toolsGeneration) status('工具列表暂不可用，刷新技能列表后可重试。');
        } finally { toolsLoading = null; } })();
        return toolsLoading;
    }
    function updateFileDropzoneUI(file) {
        const dropzone = element('agent-skill-file-dropzone');
        const titleEl = element('agent-skill-file-title');
        const descEl = element('agent-skill-file-desc');
        if (!dropzone) return;
        if (file) {
            dropzone.classList.add('has-file');
            if (titleEl) titleEl.textContent = file.name;
            if (descEl) descEl.textContent = `${(file.size / 1024).toFixed(1)} KB · 文件已就绪`;
        } else {
            dropzone.classList.remove('has-file');
            if (titleEl) PivotSafeHtml.setHtml(titleEl, '点击或拖拽上传 <strong>SKILL.md</strong>');
            if (descEl) descEl.textContent = '标准 Markdown 指引，大小不超过 272 KB';
        }
    }
    async function readFile() {
        invalidate();
        const sequence = ++fileGeneration;
        const file = element('agent-skill-import-source').files?.[0];
        sourceText = '';
        updateFileDropzoneUI(file);
        if (!file) return;
        if (file.size > 272 * 1024) { status('技能文件过大，请选择不超过 272 KB 的文件。'); return; }
        try {
            const text = await file.text();
            if (sequence !== fileGeneration) return;
            sourceText = text; status('文件已读取，请填写名称并选择工具。');
        } catch (_) { if (sequence === fileGeneration) status('无法读取技能文件，请重新选择。'); }
    }
    function snapshot() {
        return JSON.stringify({ sourceText, title: element('agent-skill-import-title').value.trim(), description: element('agent-skill-import-description').value.trim(), tools: [...element('agent-skill-import-tools').selectedOptions].map(option => option.value) });
    }
    async function preview() {
        if (busy || draftId) return;
        invalidate();
        const title = element('agent-skill-import-title').value.trim();
        const tools = [...element('agent-skill-import-tools').selectedOptions].map(option => option.value);
        if (!sourceText || !title || !tools.length) return status('请先选择文件、填写技能名称并选择至少一个工具。');
        const expectedSnapshot = snapshot();
        busy = true; lockInputs(true); status('正在检查技能文件和工具…');
        try {
            const result = await post(`${API_BASE}/agents/skills/import/preview`, { markdown: sourceText, title, description: element('agent-skill-import-description').value.trim(), tools });
            if (snapshot() !== expectedSnapshot) throw new Error('文件或工具已变化，请重新预览');
            proposal = result.proposal;
            preparedSnapshot = expectedSnapshot;
            creationAttempted = false;
            publishAttempted = false;
            const lines = [
                `技能名称：${title}`,
                ...proposal.tools.map(item => `工具：${item.title}（${item.name}） · 能力：${item.capabilities.join('、')} · 风险：${riskText(item.risk)}${item.approvalRequired ? ' · 需要审批' : ''}`),
                ...proposal.warnings.map(item => `提示：${item}`),
                ...(proposal.preview.errors || []).map(item => `校验问题：${item}`),
                '', '以下为将要保存的完整技能内容，请核对：', proposal.markdown
            ];
            element('agent-skill-import-review').textContent = lines.join('\n');
            element('agent-skill-import-submit').disabled = !proposal.preview.valid;
            status(proposal.preview.valid ? '请核对工具、权限和完整工作指引，然后确认添加。' : '配置尚未通过检查，请调整后重新预览。');
        } catch (error) { invalidate(); status(error.message || '预览失败，请检查文件。'); }
        finally { busy = false; lockInputs(false); }
    }
    async function submit(refresh) {
        if (busy || (!proposal && !draftId)) return;
        if (!draftId && !creationAttempted && snapshot() !== preparedSnapshot) { invalidate(); return; }
        busy = true; lockInputs(true); element('agent-skill-import-submit').disabled = true;
        try {
            stage = '核对工具';
            const current = await request(`${API_BASE}/agents/skills/import/tools`, { cache: 'no-store' });
            const currentByName = new Map((current.tools || []).map(tool => [tool.name, tool]));
            const comparable = tool => tool && ({ name: tool.name, title: tool.title, description: tool.description, risk: tool.risk, approvalRequired: tool.approvalRequired, capabilities: [...(tool.capabilities || [])].sort() });
            const changed = (proposal?.tools || []).some(tool => JSON.stringify(comparable(currentByName.get(tool.name))) !== JSON.stringify(comparable(tool)));
            if (changed) {
                if (!draftId && !creationAttempted) {
                    proposal = null;
                    element('agent-skill-import-review').textContent = '';
                    toolsFingerprint = '';
                    throw new Error('可用工具或授权已变化，请重新预览');
                }
                throw new Error('所选工具或授权已变化，请在技能列表核对草稿');
            }
            if (!draftId) {
                stage = '创建草稿'; status('正在创建个人草稿…');
                let result;
                if (creationAttempted) {
                    const found = await findDraft();
                    if (!found) throw new Error('上次创建结果尚未确认，请在技能列表核对后再操作');
                    result = { version: found };
                }
                creationAttempted = true;
                try { if (!result) result = await post(`${API_BASE}/agents/skills/source`, { markdown: proposal.markdown }); }
                catch (error) {
                    const statusVal = Number(error.status) || 0;
                    if (Math.floor(statusVal / 100) === 4 && statusVal !== 408) {
                        creationAttempted = false;
                        throw error;
                    }
                    // 请求可能已落库但响应丢失；按预览中的唯一标识先核对，避免重复创建。
                    const found = await findDraft();
                    if (!found) throw error;
                    result = { version: found };
                }
                draftId = String(result.version?.id || '');
                if (!draftId) throw new Error('未获得草稿标识，请刷新列表检查。');
            }
            let alreadyPublished = false;
            if (publishAttempted) {
                const releases = await request(`${API_BASE}/agents/skills/releases?limit=200`, { cache: 'no-store' });
                alreadyPublished = (releases.data || []).some(item => String(item.skill_version_id) === draftId && item.status === 'published' && item.rollout_scope === 'personal');
                if (!alreadyPublished) {
                    const versions = await request(`${API_BASE}/agents/skills/versions?limit=200`, { cache: 'no-store' });
                    const version = (versions.data || []).find(item => String(item.id) === draftId);
                    if (!version || version.status === 'published' || releases.data?.length >= 200 || versions.data?.length >= 200) {
                        throw new Error('上次发布结果尚未确认，请在技能列表核对后再操作');
                    }
                    publishAttempted = false;
                }
            }
            if (!alreadyPublished) {
                stage = '验证'; status('正在验证技能…');
                await post(`${API_BASE}/agents/skills/versions/${encodeURIComponent(draftId)}/validate`, {});
                stage = '发布'; status('正在发布个人技能…');
                publishAttempted = true;
                try { await post(`${API_BASE}/agents/skills/versions/${encodeURIComponent(draftId)}/publish`, { scope: 'personal' }); }
                catch (error) {
                    const statusVal = Number(error.status) || 0;
                    if (Math.floor(statusVal / 100) === 4 && statusVal !== 408) publishAttempted = false;
                    throw error;
                }
            }
            draftId = ''; proposal = null; sourceText = ''; preparedSnapshot = '';
            publishAttempted = false;
            creationAttempted = false;
            element('agent-skill-import-source').value = '';
            updateFileDropzoneUI(null);
            element('agent-skill-import-title').value = '';
            element('agent-skill-import-description').value = '';
            element('agent-skill-import-review').textContent = '';
            element('agent-skill-import-submit').textContent = '确认并添加个人技能';
            status('个人技能已添加并发布，可在任务中选择。');
            try { await refresh?.(); } catch (_) { status('个人技能已发布；列表刷新失败，请点击刷新。'); }
        } catch (error) {
            status(`${stage}未完成：${error.message}。${draftId ? '草稿已保留，可重试或在列表中管理。' : '请检查列表后重试，避免重复创建。'}`);
            try { await refresh?.(); } catch (_) {}
            element('agent-skill-import-submit').disabled = !proposal && !draftId;
            element('agent-skill-import-submit').textContent = publishAttempted ? '重新核对发布结果' : draftId ? '重试验证并发布' : creationAttempted ? '重新核对创建结果' : '确认并添加个人技能';
        } finally {
            busy = false;
            if (!draftId && !creationAttempted) {
                lockInputs(false);
                if (!toolsFingerprint) void loadTools();
            }
            else { element('agent-skill-import-submit').disabled = false; }
        }
    }
    function bind({ refresh } = {}) {
        if (bound || !element('agent-skill-import-source')) return;
        bound = true;
        element('agent-skill-import-source').addEventListener('change', readFile);
        ['agent-skill-import-title', 'agent-skill-import-description', 'agent-skill-import-tools'].forEach(id => element(id).addEventListener('input', invalidate));
        element('agent-skill-import-tools').addEventListener('change', invalidate);
        element('agent-skill-import-preview').addEventListener('click', preview);
        element('agent-skill-import-submit').addEventListener('click', () => submit(refresh));
        element('agent-skill-tools-picker-open-btn')?.addEventListener('click', () => setToolsModalVisibility(true));
        element('agent-skill-tools-modal-confirm')?.addEventListener('click', confirmToolsSelection);
        element('agent-skill-tools-modal-cancel')?.addEventListener('click', () => setToolsModalVisibility(false));
        element('agent-skill-tools-modal-close-btn')?.addEventListener('click', () => setToolsModalVisibility(false));
        element('agent-skill-tools-modal')?.addEventListener('click', event => { if (event.target === element('agent-skill-tools-modal')) setToolsModalVisibility(false); });
        element('agent-skill-tools-filter')?.addEventListener('input', event => renderToolsGrid(event.target.value));
        element('agent-skill-tools-select-all')?.addEventListener('click', () => { cachedTools.forEach(t => modalSelected.add(t.name)); renderToolsGrid(element('agent-skill-tools-filter')?.value || ''); updateModalSummary(); });
        element('agent-skill-tools-clear-all')?.addEventListener('click', () => { modalSelected.clear(); renderToolsGrid(element('agent-skill-tools-filter')?.value || ''); updateModalSummary(); });
        updateToolsPreview();
    }
    document.addEventListener('click', event => {
        if (!event.target.closest?.('[data-agent-harness-nav="skills"], #agent-harness-skills-refresh')) return;
        bind({ refresh: () => window.Pivot.moduleApi('agent.harness')?.loadAgentHarnessSkills?.() });
        void loadTools();
    });
    document.addEventListener('focusin', event => {
        if (!event.target.closest?.('[data-agent-harness-section="skills"]')) return;
        if (!bound) {
            bind({ refresh: () => window.Pivot.moduleApi('agent.harness')?.loadAgentHarnessSkills?.() });
            void loadTools();
        }
    });
    window.Pivot.exposeModule('agent.skillImport', { bind, loadTools });
})();
