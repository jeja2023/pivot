(function () {
    'use strict';
    if (window.Pivot.moduleApi('apps.mindmaps').show) return;
    const api = '/api/apps/mindmaps';
    const schema = window.Pivot.moduleApi('mindmaps.document');
    const $ = id => document.getElementById(id);
    const html = (node, value) => PivotSafeHtml.setHtml(node, value);
    const escape = value => { const element = document.createElement('span'); element.textContent = String(value ?? ''); return element.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
    const key = () => `mindmap:${window.crypto.randomUUID()}`;
    const state = { active: null, document: null, editor: null, page: 1, total: 0, rows: [], dirty: false, saving: null, pending: null, conflict: false, userId: '', loadSequence: 0, timer: null, maxTimer: null, pollTimer: null, dialogResolve: null, started: false, personalTemplates: [] };
    let editorModule;
    let advanced;
    let collaborationModule;
    const drafts = () => window.Pivot.moduleApi('mindmaps.drafts');
    const status = message => {
        const el = $('mindmap-save-status');
        if (!el) return;
        el.textContent = message;
        const isDirty = message.includes('未保存') || message.includes('等待保存') || message.includes('修改');
        el.classList.toggle('is-dirty', isDirty);
    };
    function syncDocumentMeta() {
        if ($('mindmap-doc-title') && state.document) {
            $('mindmap-doc-title').textContent = state.document.tree?.text || state.active?.title || '思维导图';
        }
        if ($('xmind-topic-stat') && state.document) {
            $('xmind-topic-stat').textContent = `主题: ${schema.count(state.document)}`;
        }
    }
    function syncZoom() {
        if ($('xmind-zoom-percent') && state.editor) {
            $('xmind-zoom-percent').textContent = `${state.editor.getScale?.() || 100}%`;
        }
    }
    const fail = error => { status(error.message); window.Pivot.legacy.showToast?.(error.message, 'error'); };
    async function request(path, options = {}) {
        const response = await window.Pivot.legacy.apiFetch(api + path, { ...options, cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.error?.message || '导图操作失败，请稍后重试。'), { status: response.status, code: data.code, retryAfter: Math.min(60, Math.max(3, Number(response.headers.get('Retry-After')) || 15)) });
        return data;
    }
    const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function options(id, values) { html($(id), Object.entries(values).map(([value, label]) => `<option value="${escape(value)}">${escape(typeof label === 'object' ? label.label : label)}</option>`).join('')); }
    function closeDialog(result = null) {
        state.dialogSequence = (state.dialogSequence || 0) + 1;
        state.aiController?.abort(); state.aiController = null;
        $('mindmap-dialog').classList.add('hidden');
        const closeBtn = $('mindmap-dialog')?.querySelector('.workspace-modal-close');
        if (closeBtn) closeBtn.classList.remove('hidden');
        const resolve = state.dialogResolve; state.dialogResolve = null; resolve?.(result);
    }
    function dialog(title, content, options = {}) {
        closeDialog(); $('mindmap-dialog-title').textContent = title; html($('mindmap-dialog-body'), content);
        const closeBtn = $('mindmap-dialog')?.querySelector('.workspace-modal-close');
        if (closeBtn) closeBtn.classList.toggle('hidden', Boolean(options.hideClose));
        $('mindmap-dialog').classList.remove('hidden');
        $('mindmap-dialog-body').querySelector('input,textarea,button')?.focus();
        return new Promise(resolve => { state.dialogResolve = resolve; });
    }
    async function confirm(title, message) {
        return dialog(title, `<p>${escape(message)}</p><div class="mindmap-toolbar"><button class="btn-secondary" type="button" data-mm-action="dialog-close">取消</button><button class="btn-primary" type="button" data-mm-action="dialog-confirm">确认</button></div>`);
    }
    async function keepDraft() {
        if (state.active && state.dirty && $('mindmap-local-drafts').checked) {
            try { await drafts().write(state.userId, state.active.id, state.document, state.active.versionId); }
            catch (error) { fail(error); }
        }
    }
    function collaborationSnapshot(result) {
        if (!state.collaboration) return;
        if (state.editor?.editing()) { state.deferredRemote = result; return; }
        const merged = state.collaboration.receive(result);
        state.document = merged; state.active = result; state.dirty = JSON.stringify(merged) !== JSON.stringify(result.document);
        state.editor?.receive(merged); renderOutline(); updatePermissions();
        status(state.dirty ? '协作内容已合并，本地修改等待保存' : `协作已同步 · 版本 ${result.version}`);
        if (!state.dirty) void drafts().remove(state.userId, result.id).catch(fail);
        state.deferredRemote = null;
    }
    function updatePermissions() {
        const viewer = state.active?.role === 'viewer' || state.accessRevoked || state.sessionInvalid;
        $('mindmap-access-status').textContent = state.active?.collaboration ? viewer ? '共享查看 · 内容自动同步' : '协作编辑 · 独立修改自动合并' : '个人文档';
        state.editor?.readOnly(viewer);
        for (const button of $('mindmap-editor').querySelectorAll('[data-mm-command],[data-mm-action="save"],[data-mm-action="apply-node"],[data-mm-action="ai-expand"],[data-mm-action="ai-summarize"],[data-mm-action="relations"],[data-mm-action="summaries"],[data-mm-action="theme-pack"],[data-mm-action="theme-library"],[data-mm-action="fold"],[data-mm-action="unfold"]')) button.disabled = viewer;
        $('mindmap-layout').disabled = viewer; $('mindmap-theme').disabled = viewer;
        $('mindmap-editor').querySelector('[data-mm-action="sharing"]').hidden = state.active?.role !== 'owner';
        $('mindmap-editor').querySelector('[data-mm-action="versions"]').disabled = state.active?.role !== 'owner';
        $('mindmap-editor').querySelector('[data-mm-action="export"]').disabled = state.active?.role !== 'owner';
        $('mindmap-source-refresh').hidden = state.active?.role !== 'owner' || !state.document?.source?.mapping;
    }
    function stopSync() { state.syncSequence = (state.syncSequence || 0) + 1; clearTimeout(state.syncTimer); clearTimeout(state.sourceTimer); state.syncTimer = null; state.realtime?.close(); state.realtime = null; state.realtimeLoading = false; state.deferredRemote = null; state.collaboration?.destroy(); state.collaboration = null; }
    async function refreshSource(manual = true) {
        if (!state.active || state.active.role !== 'owner' || !state.document?.source?.mapping || state.sourceRequest) return;
        if (manual) { if (!await confirm('刷新来源数据', '将按已保存的映射重新生成数据分支，并建立可回滚的新版本。是否继续？')) return; await save(); }
        else if (state.dirty || state.saving || state.conflict || state.editor?.editing() || document.visibilityState === 'hidden') return;
        const sequence = state.syncSequence; const signature = JSON.stringify(state.document); const active = state.active;
        state.sourceRequest = request(`/${active.id}/refresh-source`, json({ expectedVersionId: active.versionId, requestKey: key() })).then(result => {
            if (sequence !== state.syncSequence || state.active?.id !== active.id) return;
            if (JSON.stringify(state.document) !== signature) { state.conflict = true; $('mindmap-conflict').classList.remove('hidden'); void keepDraft(); status('数据刷新时出现本地编辑，请重载或另存副本。'); return; }
            if (state.collaboration) collaborationSnapshot(result);
            else { state.active = result; state.document = result.document; state.editor.receive(result.document); renderOutline(); updatePermissions(); }
            status(result.unchanged ? '来源数据没有变化' : `来源数据已刷新 · 版本 ${result.version}`);
        }).finally(() => { state.sourceRequest = null; });
        return state.sourceRequest;
    }
    function startSourceRefresh() {
        clearTimeout(state.sourceTimer);
        if (state.document?.source?.refreshMode !== 'auto' || state.active?.role !== 'owner') return;
        const sequence = state.syncSequence;
        state.sourceTimer = setTimeout(async () => { try { await refreshSource(false); } catch (error) { status(`数据刷新失败：${error.message}`); } finally { if (sequence === state.syncSequence) startSourceRefresh(); } }, 60000);
    }
    function acceptSyncResult(result) {
        if (result.unchanged) { state.active.role = result.role; if (result.role === 'viewer' && state.dirty) { state.conflict = true; $('mindmap-conflict').classList.remove('hidden'); void keepDraft(); } updatePermissions(); }
        else if (!result.collaboration || result.collaborationEpoch !== state.collaboration?.epoch) { state.conflict = true; state.sessionInvalid = true; $('mindmap-conflict').classList.remove('hidden'); updatePermissions(); status('协作配置已变化，请重载或另存本地副本。'); }
        else { state.active.role = result.role; updatePermissions(); collaborationSnapshot(result); }
    }
    function startSync() {
        clearTimeout(state.syncTimer);
        if (!state.active?.collaboration) return;
        const activeId = state.active.id; const userId = state.userId;
        const syncSequence = state.syncSequence;
        if (!state.realtime && !state.realtimeLoading) {
            state.realtimeLoading = true;
            void import('/chat/mindmaps/realtime.mjs').then(module => {
                if (syncSequence !== state.syncSequence || state.active?.id !== activeId || state.userId !== userId) return;
                state.realtime = module.connect({ request, artifactId: activeId, snapshot: result => { if (syncSequence === state.syncSequence && state.active?.id === activeId && state.userId === userId) acceptSyncResult(result); }, revoked: () => { if (syncSequence !== state.syncSequence) return; state.accessRevoked = true; state.conflict = true; updatePermissions(); status('共享访问已撤销，本地修改可以另存为个人副本。'); $('mindmap-conflict').classList.remove('hidden'); } });
            }).catch(() => {}).finally(() => { if (syncSequence === state.syncSequence) state.realtimeLoading = false; });
        }
        state.syncTimer = setTimeout(async () => {
            try {
                if (state.saving || state.editor?.editing() || document.visibilityState === 'hidden') return;
                if (state.deferredRemote) acceptSyncResult(state.deferredRemote);
                if (state.realtime?.connected) return;
                const result = await request(`/${activeId}/sync?versionId=${encodeURIComponent(state.active.versionId)}&epoch=${encodeURIComponent(state.collaboration?.epoch || '')}`);
                if (state.active?.id !== activeId || state.userId !== userId || syncSequence !== state.syncSequence) return;
                state.syncDelay = 0;
                acceptSyncResult(result);
            } catch (error) {
                if (syncSequence !== state.syncSequence || state.active?.id !== activeId || state.userId !== userId) return;
                if (error.status === 404 || error.status === 403) { state.conflict = true; state.accessRevoked = true; updatePermissions(); status('共享访问已撤销，本地修改可以另存为个人副本。'); $('mindmap-conflict').classList.remove('hidden'); }
                else { state.syncDelay = error.status === 429 ? error.retryAfter * 1000 : Math.min(30000, (state.syncDelay || 2000) * 2); status('同步暂不可用，本地草稿将保留；恢复网络后重试。'); }
            } finally { if (state.active?.id === activeId && state.userId === userId && !state.conflict && syncSequence === state.syncSequence) startSync(); }
        }, state.syncDelay || 2000);
    }
    function changed(document) {
        if (JSON.stringify(document) === JSON.stringify(state.document)) return;
        if (state.collaboration && state.active?.role !== 'viewer') document = state.collaboration.edit(document);
        if (JSON.stringify(document) === JSON.stringify(state.document)) return;
        state.document = document; state.dirty = true; $('mindmap-layout').value = document.presentation.layout; $('mindmap-theme').value = document.presentation.themeId; status('有未保存修改'); renderOutline(); void keepDraft(); syncDocumentMeta();
        clearTimeout(state.timer);
        if ($('mindmap-auto-save').checked && !state.conflict) {
            state.timer = setTimeout(() => { void save().catch(fail); }, 3000);
            if (!state.maxTimer) state.maxTimer = setTimeout(() => { state.maxTimer = null; void save().catch(fail); }, 15000);
        }
    }
    async function save() {
        if (!state.active) return;
        if (state.sourceRequest) await state.sourceRequest;
        if (state.editor?.composing()) {
            clearTimeout(state.timer); state.timer = setTimeout(() => { void save().catch(fail); }, 3000);
            throw new Error('请先完成输入法选字，再保存导图。');
        }
        state.editor?.document();
        if (state.deferredRemote && !state.editor?.editing()) collaborationSnapshot(state.deferredRemote);
        if (state.saving) { await state.saving; if (state.dirty && !state.conflict) return save(); return; }
        if (!state.dirty) return state.active;
        if (state.active.role === 'viewer' || state.accessRevoked) throw new Error('当前账号没有编辑权限，请另存副本后编辑。');
        if (state.conflict) throw new Error('版本发生冲突，请重载服务端版本或另存副本。');
        clearTimeout(state.timer); clearTimeout(state.maxTimer); state.maxTimer = null;
        const activeId = state.active.id; const userId = state.userId;
        const serialized = JSON.stringify(state.document);
        if (!state.pending || state.pending.serialized !== serialized || state.pending.versionId !== state.active.versionId) state.pending = { serialized, versionId: state.active.versionId, requestKey: key(), ...(state.collaboration ? state.collaboration.payload() : {}) };
        const pending = state.pending;
        status('正在保存…');
        state.saving = request(`/${encodeURIComponent(activeId)}`, { ...json({ document: JSON.parse(serialized), expectedVersionId: pending.versionId, requestKey: pending.requestKey, ...(pending.collaborationUpdate ? { collaborationUpdate: pending.collaborationUpdate, collaborationEpoch: pending.collaborationEpoch } : {}) }), method: 'PUT' }).then(async result => {
            if (state.active?.id !== activeId || state.userId !== userId) return;
            state.active = result; state.pending = null;
            state.dirty = JSON.stringify(state.document) !== serialized;
            if (state.collaboration) collaborationSnapshot(result);
            if (!state.dirty) await drafts().remove(userId, activeId).catch(fail);
            else await keepDraft();
            if (state.active?.id !== activeId || state.userId !== userId) return;
            status(state.dirty ? '新修改等待保存' : `已保存 · 版本 ${result.version}`);
        }).catch(async error => {
            if (state.active?.id === activeId && state.userId === userId) {
                await keepDraft();
                if (error.status === 409) { state.conflict = true; $('mindmap-conflict').classList.remove('hidden'); }
                status(error.status === 429 ? '保存过于频繁，将稍后重试；也可手动保存' : `保存失败：${error.message}`);
                if (error.status === 429 && $('mindmap-auto-save').checked && !$('mindmaps-view').classList.contains('hidden')) state.timer = setTimeout(() => { void save().catch(fail); }, error.retryAfter * 1000);
            }
            throw error;
        }).finally(() => { state.saving = null; });
        await state.saving;
        if (state.dirty && !state.conflict) return save();
        return state.active;
    }
    function updateOutlineNodeText(nodeId, newText) {
        const trimmed = (newText || '').trim();
        if (!trimmed || !state.document?.tree) return;
        if (trimmed.length > (schema.LIMITS?.text || 120)) {
            fail(new Error(`节点文字长度不能超过 ${schema.LIMITS?.text || 120} 字符`));
            return;
        }
        const next = schema.normalize(state.document);
        let target = null;
        (function walk(n) {
            if (n.id === nodeId) { target = n; return; }
            n.children.forEach(walk);
        })(next.tree);
        if (!target || target.text === trimmed) return;
        target.text = trimmed;
        state.editor.update(next);
        if (state.editor.selection() === nodeId) {
            $('mindmap-selection').textContent = trimmed;
            $('mindmap-node-text').value = trimmed;
        }
        if (nodeId === next.tree.id && $('mindmap-doc-title')) {
            $('mindmap-doc-title').value = trimmed;
        }
    }

    function startOutlineInlineEdit(button, node) {
        if (!button || !button.isConnected) return;
        const parent = button.parentElement;
        if (!parent || parent.querySelector('.xmind-outline-input')) return;

        const originalText = node.text;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'xmind-outline-input';
        input.value = originalText;
        input.maxLength = schema.LIMITS?.text || 120;
        input.setAttribute('aria-label', `编辑节点 ${originalText}`);

        let committed = false;
        const finish = (saveValue) => {
            if (committed) return;
            committed = true;
            input.remove();
            button.style.display = '';
            if (saveValue && input.value.trim() && input.value.trim() !== originalText) {
                updateOutlineNodeText(node.id, input.value.trim());
            } else {
                button.focus();
            }
        };

        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));

        button.style.display = 'none';
        parent.insertBefore(input, button);
        input.focus();
        input.select();
    }

    function renderOutline() {
        const host = $('mindmap-outline'); if (!host) return;
        host.replaceChildren();
        const selectedId = state.editor?.selection?.() || null;
        function visit(node, parent) {
            const item = document.createElement('li'); item.setAttribute('role', 'treeitem');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'xmind-outline-node-btn';
            button.title = `${node.text} (双击直接修改名称)`;
            button.dataset.mmNode = node.id;
            if (node.id === selectedId) button.classList.add('is-active');

            const textSpan = document.createElement('span');
            textSpan.className = 'xmind-outline-node-text';
            textSpan.textContent = node.text;
            button.appendChild(textSpan);

            const editIcon = document.createElement('span');
            editIcon.className = 'xmind-outline-edit-icon';
            editIcon.title = '编辑名称';
            editIcon.setAttribute('aria-label', '编辑名称');
            window.PivotSafeHtml?.setHtml(editIcon, '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', { USE_PROFILES: { html: true, svg: true } });
            editIcon.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                startOutlineInlineEdit(button, node);
            });
            button.appendChild(editIcon);

            button.addEventListener('dblclick', event => {
                event.preventDefault();
                event.stopPropagation();
                startOutlineInlineEdit(button, node);
            });
            button.addEventListener('keydown', event => {
                if ((event.key === 'F2' || (event.key === 'Enter' && button.classList.contains('is-active'))) && !event.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    startOutlineInlineEdit(button, node);
                }
            });

            item.appendChild(button);
            if (node.children && node.children.length) {
                const list = document.createElement('ul');
                list.setAttribute('role', 'group');
                node.children.forEach(child => visit(child, list));
                item.appendChild(list);
            }
            parent.appendChild(item);
        }
        if (state.document?.tree) { const list = document.createElement('ul'); visit(state.document.tree, list); host.appendChild(list); }
    }
    function selected(node) {
        const palette = state.document ? schema.palette(state.document) : schema.THEMES.indigo;
        const defaultFill = node?.id === state.document?.tree.id ? palette.root : palette.background;
        $('mindmap-selection').textContent = node ? node.text : '请在画布或大纲中选择节点';
        $('mindmap-node-text').value = node?.text || '';
        const fontSize = String(node?.style.fontSize || 14);
        if (!$('mindmap-node-size').querySelector(`option[value="${fontSize}"]`) && /^\d{2}$/.test(fontSize)) { const option = document.createElement('option'); option.value = fontSize; option.textContent = fontSize; $('mindmap-node-size').appendChild(option); }
        $('mindmap-node-size').value = fontSize;
        $('mindmap-node-color').value = node?.style.color || schema.foreground(defaultFill);
        $('mindmap-node-fill').value = node?.style.fillColor || defaultFill;
        $('mindmap-node-shape').value = node?.style.shape || 'roundedRectangle';
        $('mindmap-node-bold').checked = node?.style.fontWeight === 'bold';
        $('mindmap-node-italic').checked = node?.style.fontStyle === 'italic';
        const styleFields = { font: ['fontFamily', 'sans-serif'], align: ['textAlign', 'left'], decoration: ['textDecoration', 'none'], border: ['borderColor', palette.line], 'border-width': ['borderWidth', 1], dash: ['borderDasharray', 'none'], line: ['lineColor', palette.line], 'line-width': ['lineWidth', 2], 'padding-x': ['paddingX', 12], 'padding-y': ['paddingY', 8] };
        for (const [id, [key, fallback]] of Object.entries(styleFields)) {
            const input = $(`mindmap-node-${id}`); if (!input) continue;
            const value = node?.style[key] ?? fallback;
            input.value = input.tagName === 'SELECT' && ![...input.options].some(option => option.value === String(value)) ? fallback : value;
        }
        $('mindmap-node-note').value = node?.style.note || '';
        $('mindmap-node-link').value = node?.style.hyperlink || '';

        // XMind 样式控件视觉联动
        if ($('xmind-btn-bold')) $('xmind-btn-bold').classList.toggle('is-active', node?.style.fontWeight === 'bold');
        if ($('xmind-btn-italic')) $('xmind-btn-italic').classList.toggle('is-active', node?.style.fontStyle === 'italic');
        if ($('xmind-btn-strike')) $('xmind-btn-strike').classList.toggle('is-active', Boolean(node?.style.textDecoration && node.style.textDecoration !== 'none'));
        if ($('xmind-inspector')) {
            const currentAlign = node?.style.textAlign || 'left';
            $('xmind-inspector').querySelectorAll('.xmind-align-btn').forEach(btn => {
                btn.classList.toggle('is-active', btn.dataset.align === currentAlign);
            });
            if (node) {
                $('xmind-prop-tab-style')?.click();
            }
        }
        const hasFill = Boolean(node ? (node.style.fillColor && node.style.fillColor !== 'transparent') : true);
        if ($('mindmap-fill-check')) $('mindmap-fill-check').checked = hasFill;
        const hasBorder = Boolean(node ? (Number(node.style.borderWidth) > 0 && node.style.borderColor !== 'transparent') : false);
        if ($('mindmap-border-check')) $('mindmap-border-check').checked = hasBorder;
        if ($('mindmap-outline')) {
            $('mindmap-outline').querySelectorAll('button[data-mm-node]').forEach(btn => {
                const match = btn.dataset.mmNode === node?.id;
                btn.classList.toggle('is-active', match);
                if (match) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
        }
    }
    async function open(artifactId, { recover = true } = {}) {
        advanced?.stop();
        if (state.saving) await state.saving;
        if (state.dirty) await save();
        const sequence = ++state.loadSequence;
        const result = await request(`/${encodeURIComponent(artifactId)}`);
        if (sequence !== state.loadSequence) return;
        state.exportSequence = (state.exportSequence || 0) + 1; clearTimeout(state.pollTimer); $('mindmap-export-status').replaceChildren();
        stopSync();
        state.editor?.destroy(); state.active = result; state.document = result.document; state.dirty = false; state.pending = null; state.conflict = false; state.accessRevoked = false; state.sessionInvalid = false;
        $('mindmap-conflict').classList.add('hidden'); $('mindmap-library').classList.add('hidden'); $('mindmap-editor').classList.remove('hidden');
        $('mindmap-layout').value = result.document.presentation.layout; $('mindmap-theme').value = result.document.presentation.themeId;
        state.editor = editorModule.mount($('mindmap-canvas'), result.document, { change: changed, select: selected, failure: fail });
        if (result.collaborationState) {
            collaborationModule ||= await import('/chat/mindmaps/collaboration.mjs');
            if (sequence !== state.loadSequence || state.active?.id !== result.id) return;
            state.collaboration = collaborationModule.create(result);
            state.editor.historyActions({ undo: () => { const document = state.collaboration.undo(); state.editor.receive(document); changed(document); }, redo: () => { const document = state.collaboration.redo(); state.editor.receive(document); changed(document); } });
        }
        updatePermissions(); startSync(); startSourceRefresh();
        renderOutline(); selected(null); status(`已保存 · 版本 ${result.version}`);
        syncDocumentMeta();
        syncZoom();
        sessionStorage.setItem(`pivot_mindmap_active:${state.userId}`, result.id);
        if (recover && $('mindmap-local-drafts').checked) {
            const draft = await drafts().read(state.userId, result.id).catch(error => { fail(error); return null; });
            if (draft && JSON.stringify(draft.document) !== JSON.stringify(result.document)) {
                if (await confirm('恢复本地草稿', draft.versionId === result.versionId ? '发现尚未同步的本地修改，是否恢复？' : '本地草稿与服务端版本不同。恢复后可另存副本，是否继续？')) {
                    const checked = schema.normalize(draft.document); state.editor.replace(checked); state.document = checked; state.dirty = true; if (state.collaboration && result.role !== 'viewer') state.collaboration.edit(checked); renderOutline();
                    if (draft.versionId !== result.versionId) { state.conflict = true; $('mindmap-conflict').classList.remove('hidden'); }
                    status('已恢复本地草稿，尚未保存');
                } else await drafts().remove(state.userId, result.id);
            }
        }
    }
    function renderPagination() {
        const pager = $('mindmap-pagination');
        if (!pager) return;
        const fn = window.Pivot?.legacy?.renderWorkspacePagination || window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
        if (typeof fn !== 'function') {
            pager.replaceChildren();
            return;
        }
        fn(pager, {
            total: state.total,
            page: state.page,
            limit: 20,
            alwaysShow: true,
            onPageChange: targetPage => {
                const nextPage = Math.max(Number(targetPage) || 1, 1);
                if (nextPage === state.page) return;
                state.page = nextPage;
                loadList().catch(fail);
            }
        });
    }
    async function loadList() {
        const sequence = ++state.loadSequence;
        if ($('mindmap-library-status')) $('mindmap-library-status').textContent = '正在加载…';
        const result = await request(`?page=${state.page}&limit=20&search=${encodeURIComponent($('mindmap-search').value)}&scope=${$('mindmap-library-scope').value}&favorite=${$('mindmap-favorites-only').checked}&tag=${encodeURIComponent($('mindmap-tag-filter').value.trim())}`);
        if (sequence !== state.loadSequence) return;
        state.rows = result.rows; state.total = result.total;
        if (!result.rows.length && state.page > 1) { state.page--; return loadList(); }
        const startIndex = (state.page - 1) * 20;
        const rows = result.rows.map((row, index) => {
            const rowIndex = startIndex + index + 1;
            const titleHtml = `<div class="mm-table-title-cell"><span class="mm-table-title" title="${escape(row.title)}">${escape(row.title)}</span>${row.favorite ? '<span class="mm-favorite-badge" title="已收藏">★</span>' : ''}${row.tags.length ? `<span class="mm-tag-list">${escape(row.tags.join('、'))}</span>` : ''}</div>`;
            const sourceText = row.role !== 'owner' ? (row.role === 'viewer' ? '共享查看' : '共享编辑') : (row.source === 'agent' ? 'Agent 生成' : '人工创作');
            const sourceBadge = `<span class="mm-role-badge ${row.role !== 'owner' ? 'is-shared' : 'is-owner'}">${sourceText}</span>`;
            const versionCell = `<span class="mm-version-badge">v${row.version}</span>`;
            const timeText = escape(new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false }));
            const actions = row.deleted
                ? `<button type="button" class="btn-secondary mm-row-btn" data-mm-recover="${row.id}">恢复导图</button>`
                : `<button type="button" class="btn-secondary mm-row-btn" data-mm-open="${escape(row.id)}">${row.canEdit ? '编辑' : '查看'}</button><button type="button" class="btn-secondary mm-row-btn" data-mm-organize="${row.id}">收藏标签</button>${row.role === 'owner' ? `<button type="button" class="btn-danger mm-row-btn" data-mm-delete="${escape(row.id)}">删除</button>` : ''}`;
            return `<tr><td class="text-center">${rowIndex}</td><td>${titleHtml}</td><td class="text-center">${sourceBadge}</td><td class="text-center">${versionCell}</td><td class="text-center" title="${timeText}">${timeText}</td><td class="text-center"><div class="mm-row-actions">${actions}</div></td></tr>`;
        });
        html($('mindmap-documents'), rows.length ? rows.join('') : '<tr><td colspan="6" class="text-center mm-table-empty">暂无导图，请新建或导入。</td></tr>');
        if ($('mindmap-library-status')) $('mindmap-library-status').textContent = `共 ${result.total} 份导图`;
        if ($('mindmap-page')) $('mindmap-page').textContent = `第 ${state.page} / ${Math.max(1, Math.ceil(result.total / 20))} 页`;
        const prevBtn = $('mindmaps-view').querySelector('[data-mm-action="previous"]');
        if (prevBtn) prevBtn.disabled = state.page <= 1;
        const nextBtn = $('mindmaps-view').querySelector('[data-mm-action="next"]');
        if (nextBtn) nextBtn.disabled = state.page * 20 >= result.total;
        renderPagination();
    }
    async function library() {
        if (state.active && state.dirty) await save();
        stopSync();
        state.exportSequence = (state.exportSequence || 0) + 1; clearTimeout(state.pollTimer);
        state.editor?.destroy(); state.editor = null; state.active = null; state.document = null;
        sessionStorage.removeItem(`pivot_mindmap_active:${state.userId}`);
        $('mindmap-editor').classList.add('hidden'); $('mindmap-library').classList.remove('hidden'); await loadList();
    }
    async function create(document) {
        if (state.dirty) await save();
        const result = await persistNew(document); await open(result.id);
    }
    async function persistNew(document) {
        const signature = JSON.stringify(document);
        if (state.createPending?.signature !== signature) state.createPending = { signature, requestKey: key() };
        const result = await request('', json({ document, requestKey: state.createPending.requestKey })); state.createPending = null; return result;
    }
    async function versionDialog(page = 1) {
        const result = await request(`/${state.active.id}/versions?page=${page}&limit=20`);
        const total = result.total || result.rows.length;
        const totalPages = Math.max(1, Math.ceil(total / 20));
        const modalHtml = `
<div class="mm-modal-form mm-versions-modal">
    <div class="mm-modal-subtitle">浏览与回滚历史编辑快照。恢复所选版本将自动保存为最新版本，当前内容完整保留。</div>
    <div class="mm-version-current-bar">
        <div class="mm-version-current-left">
            <span class="mm-version-badge-curr">当前版本</span>
            <span class="mm-version-number">v${state.active.version}</span>
        </div>
        <span class="mm-version-total-count">共 ${total} 个历史快照</span>
    </div>
    <div class="mm-modal-table-wrap mm-version-table-wrap">
        <table class="mm-modal-table">
            <thead>
                <tr>
                    <th style="width: 16%;">版本</th>
                    <th style="width: 38%;">说明</th>
                    <th style="width: 28%;">保存时间</th>
                    <th style="width: 18%; text-align: center;">操作</th>
                </tr>
            </thead>
            <tbody>
                ${result.rows.map(row => {
                    const isCurrent = Number(row.version) === Number(state.active.version);
                    return `<tr>
                        <td>
                            <span class="mm-version-pill${isCurrent ? ' is-current' : ''}">v${row.version}</span>
                        </td>
                        <td>
                            <span class="mm-desc-text" title="${escape(row.note || '导图编辑保存')}">${escape(row.note || '导图编辑保存')}</span>
                        </td>
                        <td>
                            <span class="mm-version-time">${escape(new Date(row.createdAt).toLocaleString())}</span>
                        </td>
                        <td style="text-align: center;">
                            ${isCurrent
                                ? '<span class="mm-version-curr-tag">当前版本</span>'
                                : `<button type="button" class="mm-restore-btn" data-mm-restore="${row.id}">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                                    <span>恢复</span>
                                   </button>`
                            }
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    </div>
    <div class="mm-version-pagination">
        <span class="mm-version-page-info">第 ${page} 页 / 共 ${totalPages} 页</span>
        <div class="mm-version-page-btns">
            ${page > 1 ? `<button class="btn-secondary btn-xs mm-version-page-btn" type="button" data-mm-version-page="${page - 1}">上一页</button>` : ''}
            ${page < totalPages ? `<button class="btn-secondary btn-xs mm-version-page-btn" type="button" data-mm-version-page="${page + 1}">下一页</button>` : ''}
        </div>
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">每次手动保存或自动协作均会生成稳定快照</span>
    </div>
</div>`;
        void dialog('历史版本', modalHtml);
    }
    async function download(job) {
        const userId = state.userId; const title = state.document?.tree.text || '思维导图';
        const fetch = window.Pivot.legacy.apiFetch;
        const issued = await fetch(`/api/agents/renditions/${encodeURIComponent(job.renditionId)}/download-token`, json({}));
        const token = await issued.json(); if (!issued.ok) throw new Error(token.error || '下载授权失败。');
        if (state.userId !== userId) return;
        const result = await fetch(`/api/agents/renditions/${encodeURIComponent(job.renditionId)}/download?token=${encodeURIComponent(token.token)}`);
        if (!result.ok) throw new Error('下载失败，请重新导出。');
        const blob = await result.blob(); if (state.userId !== userId) return;
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${title}.${job.format}`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    async function poll(jobId, sequence = state.exportSequence, userId = state.userId) {
        clearTimeout(state.pollTimer);
        const result = await request(`/exports/${encodeURIComponent(jobId)}`); const job = result.job;
        if (state.exportSequence !== sequence || state.userId !== userId) return;
        const host = $('mindmap-export-status'); host.replaceChildren();
        if (job.status === 'ready') {
            host.textContent = '导出完成，文件绑定所选历史版本。';
            const button = document.createElement('button'); button.className = 'btn-secondary'; button.type = 'button'; button.textContent = '下载文件'; button.onclick = () => download(job).catch(fail); host.appendChild(button);
        } else if (job.status === 'failed') { host.textContent = `导出失败：${job.error}。可点击导出重试。`; }
        else { host.textContent = job.status === 'pending' ? '导出已排队…' : '正在生成导出文件…'; state.pollTimer = setTimeout(() => { void poll(jobId, sequence, userId).catch(fail); }, 2000); }
    }
    async function action(name) {
        if (await advanced?.action(name, state.actionButton)) return;
        if (name === 'dialog-close') return closeDialog();
        if (name === 'dialog-confirm') return closeDialog(true);
        if (name === 'save') return save();
        if (name === 'refresh-source') return refreshSource();
        if (name === 'library') return library();
        if (name === 'refresh') return loadList();
        if (name === 'previous') { state.page--; return loadList(); }
        if (name === 'next') { state.page++; return loadList(); }
        if (name === 'fold') return state.editor?.fold?.(false);
        if (name === 'unfold') return state.editor?.fold?.(true);
        if (name === 'new') {
            const personalTpls = state.personalTemplates || [];
            const personalOptionsHtml = personalTpls.length > 0
                ? `<optgroup label="个人模板" id="mm-personal-template-group">${personalTpls.map(t => `<option value="personal:${escape(t.id)}" data-personal-template="true">${escape(t.name)}</option>`).join('')}</optgroup>`
                : '<optgroup label="个人模板" id="mm-personal-template-group" hidden></optgroup>';

            const modalHtml = `
<div class="mm-modal-form mm-create-modal">
    <div class="mm-modal-subtitle">选择适合的结构模板并设定导图名称，即刻开始梳理思路</div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label" for="mindmap-new-title">
                <span class="mm-label-text">导图名称</span>
            </label>
            <span class="mm-label-hint">按 Enter 键可直接创建</span>
        </div>
        <input id="mindmap-new-title" class="form-input mm-modal-input" maxlength="120" value="中心主题" placeholder="请输入导图名称或中心主题…">
    </div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <span class="mm-field-label">
                <span class="mm-label-text">选择结构模板</span>
            </span>
            <span class="mm-label-hint">双击卡片快速创建</span>
        </div>
        <div class="mm-tpl-cards" role="radiogroup" aria-label="导图模板">
            <div class="mm-tpl-card is-selected" data-template="blank" tabindex="0" role="radio" aria-checked="true">
                <div class="mm-tpl-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="mm-tpl-icon mm-icon-blank">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>
                </div>
                <div class="mm-tpl-content">
                    <div class="mm-tpl-name">空白导图</div>
                    <div class="mm-tpl-brief">仅包含中心主题，自由发散扩展</div>
                </div>
            </div>
            <div class="mm-tpl-card" data-template="plan" tabindex="0" role="radio" aria-checked="false">
                <div class="mm-tpl-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="mm-tpl-icon mm-icon-plan">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                </div>
                <div class="mm-tpl-content">
                    <div class="mm-tpl-name">工作计划</div>
                    <div class="mm-tpl-brief">目标、里程碑、具体行动与资源</div>
                </div>
            </div>
            <div class="mm-tpl-card" data-template="analysis" tabindex="0" role="radio" aria-checked="false">
                <div class="mm-tpl-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="mm-tpl-icon mm-icon-analysis">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>
                </div>
                <div class="mm-tpl-content">
                    <div class="mm-tpl-name">分析研判</div>
                    <div class="mm-tpl-brief">态势研判、因果溯源与结论推演</div>
                </div>
            </div>
            <div class="mm-tpl-card" data-template="meeting" tabindex="0" role="radio" aria-checked="false">
                <div class="mm-tpl-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="mm-tpl-icon mm-icon-meeting">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="mm-tpl-content">
                    <div class="mm-tpl-name">会议纪要</div>
                    <div class="mm-tpl-brief">会议议题、决议事项与待办跟进</div>
                </div>
            </div>
        </div>
        <select id="mindmap-template" class="form-input hidden" tabindex="-1" aria-hidden="true">
            <option value="blank" selected>空白导图</option>
            <option value="plan">工作计划</option>
            <option value="analysis">分析研判</option>
            <option value="meeting">会议纪要</option>
            ${personalOptionsHtml}
        </select>
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">支持回车快速创建</span>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button type="button" class="btn-primary mm-modal-submit" data-mm-action="create-confirm">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>创建</span>
            </button>
        </div>
    </div>
</div>`;
            void dialog('新建思维导图', modalHtml, { hideClose: true });
            const dialogBody = $('mindmap-dialog-body');
            const selectEl = $('mindmap-template');
            const cards = dialogBody.querySelectorAll('.mm-tpl-card');
            const titleInput = $('mindmap-new-title');

            const syncActiveCard = val => {
                cards.forEach(card => {
                    const match = card.dataset.template === val;
                    card.classList.toggle('is-selected', match);
                    card.setAttribute('aria-checked', String(match));
                });
            };

            cards.forEach(card => {
                card.addEventListener('click', () => {
                    const tpl = card.dataset.template;
                    if (selectEl) selectEl.value = tpl;
                    syncActiveCard(tpl);
                });
                card.addEventListener('dblclick', () => {
                    const tpl = card.dataset.template;
                    if (selectEl) selectEl.value = tpl;
                    syncActiveCard(tpl);
                    void action('create-confirm');
                });
                card.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        const tpl = card.dataset.template;
                        if (selectEl) selectEl.value = tpl;
                        syncActiveCard(tpl);
                    }
                });
            });

            if (selectEl) {
                selectEl.addEventListener('change', () => {
                    syncActiveCard(selectEl.value);
                });
            }

            if (titleInput) {
                titleInput.focus();
                titleInput.select();
                titleInput.addEventListener('keydown', e => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        void action('create-confirm');
                    }
                });
            }
            return;
        }
        if (name === 'create-confirm') {
            const templateValue = $('mindmap-template')?.value || 'blank';
            const titleValue = $('mindmap-new-title')?.value.trim() || '中心主题';
            if (templateValue.startsWith('personal:')) { const result = await request(`/personal-templates/${encodeURIComponent(templateValue.slice(9))}`); result.document.tree.text = titleValue; await create(result.document); closeDialog(); return; }
            const template = await request('/templates', json({ template: templateValue, title: titleValue }));
            await create(template.document); closeDialog(); return;
        }
        if (name === 'import') return $('mindmap-import-file').click();
        if (name === 'copy') {
            const local = schema.normalize(state.document); local.tree.text = local.tree.text.slice(0, 116) + ' 副本';
            // 冲突时复制本地内容，不先覆盖服务端原稿。
            const result = await persistNew(local);
            await drafts().remove(state.userId, state.active.id).catch(fail);
            state.dirty = false; state.conflict = false; return open(result.id);
        }
        if (name === 'reload') {
            if (await confirm('重载服务端版本', '本地草稿将被清除，是否重载？')) { const id = state.active.id; await drafts().remove(state.userId, id); state.dirty = false; state.conflict = false; await open(id, { recover: false }); } return;
        }
        if (name === 'fit') {
            state.editor.fit();
            setTimeout(syncZoom, 60);
            return;
        }
        if (name === 'apply-node') {
            const isFillChecked = $('mindmap-fill-check') ? $('mindmap-fill-check').checked : true;
            const isBorderChecked = $('mindmap-border-check') ? $('mindmap-border-check').checked : true;
            return state.editor.apply({
                fontStyle: $('mindmap-node-italic').checked ? 'italic' : 'normal',
                fontFamily: $('mindmap-node-font').value,
                textAlign: $('mindmap-node-align').value,
                textDecoration: $('mindmap-node-decoration').value,
                borderColor: isBorderChecked ? $('mindmap-node-border').value : 'transparent',
                borderWidth: isBorderChecked ? Number($('mindmap-node-border-width').value) : 0,
                borderDasharray: $('mindmap-node-dash').value,
                lineColor: $('mindmap-node-line').value,
                lineWidth: Number($('mindmap-node-line-width').value),
                paddingX: Number($('mindmap-node-padding-x').value),
                paddingY: Number($('mindmap-node-padding-y').value),
                text: $('mindmap-node-text').value,
                fontSize: Number($('mindmap-node-size').value),
                color: $('mindmap-node-color').value,
                fillColor: isFillChecked ? $('mindmap-node-fill').value : 'transparent',
                shape: $('mindmap-node-shape').value,
                fontWeight: $('mindmap-node-bold').checked ? 'bold' : 'normal',
                note: $('mindmap-node-note').value,
                hyperlink: $('mindmap-node-link').value
            });
        }
        if (name === 'versions') { await save(); return versionDialog(); }
        if (name === 'export') {
            $('xmind-export-menu')?.classList.add('hidden');
            $('xmind-export-dropdown')?.classList.remove('is-open');
            const sequence = state.exportSequence = (state.exportSequence || 0) + 1; const userId = state.userId;
            clearTimeout(state.pollTimer); $('mindmap-export-status').replaceChildren(); $('mindmap-export-status').textContent = '正在提交导出任务…';
            await save(); const result = await request(`/${state.active.id}/exports`, json({ format: $('mindmap-export-format').value, versionId: state.active.versionId })); return poll(result.job.id, sequence, userId);
        }
        if (name === 'ai') {
            const aiHtml = `
<div class="mm-modal-form mm-ai-modal">
    <div class="mm-modal-subtitle">输入核心主题或粘贴长文大纲，AI 模型将智能解析并构建思维导图层级结构</div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label" for="mindmap-ai-prompt">
                <span class="mm-label-text">主题或材料内容</span>
            </label>
            <span class="mm-label-hint">支持大纲草案、会议材料或方案文本</span>
        </div>
        <div class="mm-textarea-wrap">
            <textarea id="mindmap-ai-prompt" class="form-input mm-ai-textarea" rows="5" maxlength="12000" placeholder="请输入导图主题，或粘贴方案材料、研判分析要点等内容…"></textarea>
        </div>
    </div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label" for="mindmap-ai-model">
                <span class="mm-label-text">分析推理模型</span>
            </label>
            <span class="mm-label-hint">选择用于生成导图的模型</span>
        </div>
        <select id="mindmap-ai-model" class="form-input mm-ai-model-select" data-pivot-app-model="mindmaps">
            <option value="">使用默认模型</option>
        </select>
    </div>
    <div class="mm-ai-notice">
        <svg class="mm-notice-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <span class="mm-notice-text">生成结果将先以大纲树形预览展示，经确认后才保存为正式导图。</span>
    </div>
    <div id="mindmap-ai-status" class="mm-status-bar" role="status"></div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">支持按 Ctrl + Enter 快捷生成</span>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button type="button" class="btn-primary mm-modal-submit" data-mm-action="ai-generate">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                <span>生成预览</span>
            </button>
        </div>
    </div>
</div>`;
            void dialog('AI 生成导图', aiHtml, { hideClose: true });
            window.Pivot.moduleApi('apps.modelSelector').refresh?.('mindmaps', 'mindmap-ai-model');
            const promptInput = $('mindmap-ai-prompt');
            if (promptInput) {
                promptInput.focus();
                promptInput.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void action('ai-generate');
                    }
                });
            }
            return;
        }
        if (name === 'ai-generate') {
            const button = $('mindmap-dialog-body').querySelector('[data-mm-action="ai-generate"]'); button.disabled = true;
            if ($('mindmap-ai-status')) $('mindmap-ai-status').textContent = '正在分析材料并生成结构化导图…';
            const sequence = state.dialogSequence; state.aiController = new AbortController();
            try {
                const result = await request('/ai', { ...json({ prompt: $('mindmap-ai-prompt').value, model: $('mindmap-ai-model').value }), signal: state.aiController.signal });
                if (sequence !== state.dialogSequence) return;
                const generated = result.document; if (!generated) throw new Error('未收到有效导图，请重试。');
                state.aiGenerated = generated;
                const preview = schema.markdown(generated);
                const previewHtml = `
<div class="mm-modal-form mm-ai-preview-modal">
    <div class="mm-modal-subtitle">已成功解析生成导图大纲结构，请检查各分支层级与节点内容：</div>
    <pre class="mm-ai-preview-pre">${escape(preview)}</pre>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">确认无误后即可保存到导图库并开启可视化编辑</span>
        <div class="mm-footer-btns">
            <button class="btn-secondary mm-modal-cancel" type="button" data-mm-action="dialog-close">返回重试</button>
            <button class="btn-primary mm-modal-submit" type="button" data-mm-action="ai-save">保存为新导图</button>
        </div>
    </div>
</div>`;
                void dialog('检查生成结果', previewHtml);
            } catch (error) {
                if (error.name === 'AbortError') return;
                if ($('mindmap-ai-status')) $('mindmap-ai-status').textContent = error.message;
                throw error;
            } finally { if (button.isConnected) button.disabled = false; }
        }
        if (name === 'ai-save' && state.aiGenerated) { await create(state.aiGenerated); state.aiGenerated = null; closeDialog(); }
    }
    function bind() {
        if (state.started) return; state.started = true;
        options('mindmap-layout', schema.LAYOUTS); options('mindmap-theme', schema.THEMES);
        const moreBtn = $('mindmap-more-btn');
        const moreMenu = $('mindmap-more-menu');
        if (moreBtn && moreMenu) {
            moreBtn.addEventListener('click', event => {
                event.stopPropagation();
                const willOpen = moreMenu.classList.contains('hidden');
                moreMenu.classList.toggle('hidden', !willOpen);
                moreBtn.setAttribute('aria-expanded', String(willOpen));
            });
            document.addEventListener('click', event => {
                if (!moreMenu.contains(event.target) && event.target !== moreBtn) {
                    moreMenu.classList.add('hidden');
                    moreBtn.setAttribute('aria-expanded', 'false');
                }
            });
            moreMenu.addEventListener('click', () => {
                moreMenu.classList.add('hidden');
                moreBtn.setAttribute('aria-expanded', 'false');
            });
        }
        $('mindmaps-view').addEventListener('click', event => {
            const button = event.target.closest('button'); if (!button) return;
            const run = async () => {
                if (button.dataset.mmAction) { state.actionButton = button; return action(button.dataset.mmAction); }
                if (button.dataset.mmCommand) return state.editor.command(button.dataset.mmCommand);
                if (button.dataset.mmOpen) return open(button.dataset.mmOpen);
                if (button.dataset.mmRecover) { if (await confirm('恢复导图', '恢复会生成新版本并清除之前的共享授权；版本配额已满时恢复为个人副本。是否继续？')) { const result = await request(`/${button.dataset.mmRecover}/recover`, json({})); await loadList(); if (result.recoveredAsCopy) window.Pivot.legacy.showToast?.('已恢复为个人副本，原记录仍保留在回收站。', 'success'); } return; }
                if (button.dataset.mmOrganize) return advanced.action('organize', button);
                if (button.dataset.mmNode) return state.editor.focus(button.dataset.mmNode);
                if (button.dataset.mmVersionPage) return versionDialog(Number(button.dataset.mmVersionPage));
                if (button.dataset.mmRestore) {
                    const versionId = button.dataset.mmRestore;
                    if (await confirm('恢复历史版本', '当前内容会保留为历史版本，是否恢复所选快照？')) {
                        await request(`/${state.active.id}/versions/${versionId}/restore`, json({ expectedVersionId: state.active.versionId, requestKey: key() }));
                        await open(state.active.id, { recover: false }); closeDialog();
                    } return;
                }
                if (button.dataset.mmDelete) {
                    const row = state.rows.find(row => row.id === button.dataset.mmDelete);
                    if (await confirm('删除思维导图', `确认删除“${row.title}”？删除后无法继续访问或下载其内容。`)) { await request(`/${row.id}`, { ...json({ expectedVersionId: row.versionId }), method: 'DELETE' }); await drafts().remove(state.userId, row.id); await loadList(); }
                }
            };
            button.disabled = true;
            void run().catch(fail).finally(() => { if (button.isConnected) button.disabled = false; if (state.active) updatePermissions(); });
        });
        $('mindmap-layout').addEventListener('change', event => state.editor.layout(event.target.value));
        $('mindmap-theme').addEventListener('change', event => state.editor.theme(event.target.value));
        $('mindmap-library-scope').addEventListener('change', () => { state.page = 1; void loadList().catch(fail); });
        $('mindmap-favorites-only').addEventListener('change', () => { state.page = 1; void loadList().catch(fail); });
        $('mindmap-tag-filter').addEventListener('change', () => { state.page = 1; void loadList().catch(fail); });
        $('mindmap-local-drafts').addEventListener('change', async event => {
            try {
                localStorage.setItem(`pivot_mindmap_drafts:${state.userId}`, event.target.checked ? 'on' : 'off');
                if (!event.target.checked) await drafts().clear(state.userId); else await keepDraft();
            } catch (error) { fail(error); }
        });
        $('mindmap-search').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { state.page = 1; void loadList().catch(fail); }, 350); });
        $('mindmap-import-file').addEventListener('change', async event => {
            const file = event.target.files[0]; event.target.value = ''; if (!file) return;
            try {
                const extension = file.name.split('.').pop().toLowerCase(); const format = { json: 'json', md: 'markdown', markdown: 'markdown', mm: 'mm', opml: 'opml', xmind: 'xmind' }[extension];
                if (!format || file.size > (format === 'xmind' ? 2 * 1024 * 1024 : schema.LIMITS.bytes)) throw new Error('请选择不超过 4MiB 的文本导图，或不超过 2MiB 的 XMind 文件。');
                let body;
                if (format === 'xmind') {
                    const buffer = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of buffer) binary += String.fromCharCode(byte);
                    body = { format, contentBase64: window.btoa(binary) };
                } else body = { format, content: await file.text() };
                const result = await request('/import', json(body));
                if (await confirm('导入思维导图', `将导入“${result.document.tree.text}”，共 ${schema.count(result.document)} 个节点。跨格式只保留支持的字段；原生 JSON 可完整备份。`)) await create(result.document);
            } catch (error) { fail(error); }
        });

        // XMind 交互组件绑定
        const docTitleInput = $('mindmap-doc-title');
        if (docTitleInput) {
            const handleTitleCommit = () => {
                const newTitle = docTitleInput.value.trim();
                if (!newTitle || !state.document?.tree || state.document.tree.text === newTitle) return;
                state.document.tree.text = newTitle;
                state.editor?.receive?.(state.document);
                changed(state.document);
                renderOutline();
                if (state.editor?.selection?.() === state.document.tree.id) {
                    selected(state.document.tree);
                }
            };
            docTitleInput.addEventListener('blur', handleTitleCommit);
            docTitleInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    docTitleInput.blur();
                }
            });
        }

        const exportBtn = $('xmind-export-toggle-btn');
        const exportMenu = $('xmind-export-menu');
        if (exportBtn && exportMenu) {
            exportBtn.addEventListener('click', event => {
                event.stopPropagation();
                exportMenu.classList.toggle('hidden');
            });
            document.addEventListener('click', event => {
                if (!exportMenu.contains(event.target) && event.target !== exportBtn) {
                    exportMenu.classList.add('hidden');
                }
            });
        }

        const outlineToggle = $('xmind-toggle-outline');
        const outlinePanel = $('xmind-outline-panel');
        if (outlineToggle && outlinePanel) {
            outlineToggle.addEventListener('click', () => {
                const isCollapsed = outlinePanel.classList.toggle('is-collapsed');
                outlineToggle.classList.toggle('is-active', !isCollapsed);
            });
        }

        const inspectorToggle = $('xmind-toggle-inspector');
        const inspector = $('xmind-inspector');
        if (inspectorToggle && inspector) {
            inspectorToggle.addEventListener('click', () => {
                const isCollapsed = inspector.classList.toggle('is-collapsed');
                inspectorToggle.classList.toggle('is-active', !isCollapsed);
            });
        }
        const propTabStyle = $('xmind-prop-tab-style');
        const propTabCanvas = $('xmind-prop-tab-canvas');
        const paneStyle = $('xmind-pane-style');
        const paneCanvas = $('xmind-pane-canvas');
        if (propTabStyle && propTabCanvas && paneStyle && paneCanvas) {
            propTabStyle.addEventListener('click', () => {
                propTabStyle.classList.add('is-active');
                propTabCanvas.classList.remove('is-active');
                paneStyle.classList.remove('hidden');
                paneCanvas.classList.add('hidden');
            });
            propTabCanvas.addEventListener('click', () => {
                propTabCanvas.classList.add('is-active');
                propTabStyle.classList.remove('is-active');
                paneCanvas.classList.remove('hidden');
                paneStyle.classList.add('hidden');
            });
        }

        const zoomInBtn = $('xmind-zoom-in');
        if (zoomInBtn) {
            zoomInBtn.addEventListener('click', () => {
                state.editor?.zoomIn?.();
                syncZoom();
            });
        }
        const zoomOutBtn = $('xmind-zoom-out');
        if (zoomOutBtn) {
            zoomOutBtn.addEventListener('click', () => {
                state.editor?.zoomOut?.();
                syncZoom();
            });
        }
        const zoomPercentBtn = $('xmind-zoom-percent');
        if (zoomPercentBtn) {
            zoomPercentBtn.addEventListener('click', () => {
                state.editor?.zoomReset?.();
                syncZoom();
            });
        }

        const boldBtn = $('xmind-btn-bold');
        if (boldBtn) {
            boldBtn.addEventListener('click', () => {
                const input = $('mindmap-node-bold');
                if (input) {
                    input.checked = !input.checked;
                    boldBtn.classList.toggle('is-active', input.checked);
                    if (state.editor?.selection?.()) void action('apply-node');
                }
            });
        }
        const italicBtn = $('xmind-btn-italic');
        if (italicBtn) {
            italicBtn.addEventListener('click', () => {
                const input = $('mindmap-node-italic');
                if (input) {
                    input.checked = !input.checked;
                    italicBtn.classList.toggle('is-active', input.checked);
                    if (state.editor?.selection?.()) void action('apply-node');
                }
            });
        }
        const strikeBtn = $('xmind-btn-strike');
        if (strikeBtn) {
            strikeBtn.addEventListener('click', () => {
                const input = $('mindmap-node-decoration');
                if (input) {
                    const next = input.value === 'line-through' ? 'none' : 'line-through';
                    input.value = next;
                    strikeBtn.classList.toggle('is-active', next === 'line-through');
                    if (state.editor?.selection?.()) void action('apply-node');
                }
            });
        }
        if (inspector) {
            inspector.querySelectorAll('.xmind-align-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const align = btn.dataset.align;
                    const input = $('mindmap-node-align');
                    if (input && align) {
                        input.value = align;
                        inspector.querySelectorAll('.xmind-align-btn').forEach(b => b.classList.toggle('is-active', b === btn));
                        if (state.editor?.selection?.()) void action('apply-node');
                    }
                });
            });
        }

        const autoApplyIds = [
            'mindmap-node-shape',
            'mindmap-node-fill',
            'mindmap-node-border',
            'mindmap-node-border-width',
            'mindmap-node-dash',
            'mindmap-node-font',
            'mindmap-node-size',
            'mindmap-node-color',
            'mindmap-node-line',
            'mindmap-node-line-width',
            'mindmap-node-padding-x',
            'mindmap-node-padding-y',
            'mindmap-node-note',
            'mindmap-node-link'
        ];
        autoApplyIds.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('change', () => {
                if (id === 'mindmap-node-fill' && $('mindmap-fill-check')) $('mindmap-fill-check').checked = true;
                if ((id === 'mindmap-node-border' || id === 'mindmap-node-dash') && $('mindmap-border-check')) $('mindmap-border-check').checked = true;
                if (id === 'mindmap-node-border-width' && $('mindmap-border-check')) $('mindmap-border-check').checked = Number(el.value) > 0;
                if (state.editor?.selection?.()) void action('apply-node');
            });
        });
        const fillCheck = $('mindmap-fill-check');
        if (fillCheck) {
            fillCheck.addEventListener('change', () => {
                if (state.editor?.selection?.()) void action('apply-node');
            });
        }
        const borderCheck = $('mindmap-border-check');
        if (borderCheck) {
            borderCheck.addEventListener('change', () => {
                if (borderCheck.checked && Number($('mindmap-node-border-width').value) <= 0) {
                    $('mindmap-node-border-width').value = 1;
                }
                if (state.editor?.selection?.()) void action('apply-node');
            });
        }
        const nodeTextInput = $('mindmap-node-text');
        if (nodeTextInput) {
            nodeTextInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (state.editor?.selection?.()) void action('apply-node');
                }
            });
        }

        window.addEventListener('beforeunload', event => { if (state.dirty) { void keepDraft(); event.preventDefault(); event.returnValue = ''; } });
        window.addEventListener('online', () => { if (state.dirty && !state.conflict && $('mindmap-auto-save').checked) void save().catch(fail); });
        window.addEventListener('pagehide', () => { void keepDraft(); });
        window.addEventListener('keydown', event => {
            if (!$('mindmap-dialog').classList.contains('hidden')) {
                if (event.key === 'Escape') { closeDialog(); return; }
                if (event.key === 'Tab') {
                    const controls = [...$('mindmap-dialog').querySelectorAll('button,input,select,textarea')].filter(control => !control.disabled);
                    const first = controls[0]; const last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
                return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.active && !$('mindmaps-view').classList.contains('hidden') && !event.isComposing) { event.preventDefault(); void save().catch(fail); }
        });
    }
    async function show(options = {}) {
        let activation = state.activationSequence = (state.activationSequence || 0) + 1;
        await window.Pivot.loadScriptOnce('/chat/mindmaps/drafts.js');
        await window.Pivot.loadScriptOnce('/chat/mindmaps/advanced.js');
        advanced ||= window.Pivot.moduleApi('mindmaps.advanced').create({ state, dialog, closeDialog, escape, changed, save, request, json, create, open, loadList });
        editorModule ||= await import('/chat/mindmaps/editor.mjs');
        const userId = String(window.Pivot.legacy.currentUser?.id || ''); if (!userId) throw new Error('请登录后打开思维导图。');
        if (state.userId && state.userId !== userId) { await logout(); activation = state.activationSequence = (state.activationSequence || 0) + 1; }
        state.userId = userId;
        bind();
        const personalTemplates = await request('/personal-templates');
        if (activation !== state.activationSequence || state.userId !== userId || String(window.Pivot.legacy.currentUser?.id || '') !== userId) return;
        state.personalTemplates = personalTemplates.rows || [];
        if ($('mindmap-template')) {
            $('mindmap-template').querySelectorAll('[data-personal-template]').forEach(option => option.remove());
            for (const template of personalTemplates.rows) { const option = document.createElement('option'); option.value = `personal:${template.id}`; option.textContent = template.name; option.dataset.personalTemplate = 'true'; $('mindmap-template').appendChild(option); }
        }
        try { $('mindmap-local-drafts').checked = localStorage.getItem(`pivot_mindmap_drafts:${state.userId}`) !== 'off'; } catch (_) { $('mindmap-local-drafts').checked = false; }
        const workspace = window.Pivot.moduleApi('workspaces.apps'); workspace.setStoredAppsActiveApp('mindmaps');
        const body = $('apps-home-view').parentElement;
        for (const view of body.children) if (view.id.endsWith('-view')) view.classList.toggle('hidden', view.id !== 'mindmaps-view');
        $('apps-back-btn').classList.remove('hidden'); $('apps-workspace-title').textContent = '思维导图'; $('apps-workspace-desc').textContent = '编辑、保存与管理你的思维导图';
        const artifactId = options.artifactId || sessionStorage.getItem(`pivot_mindmap_active:${state.userId}`);
        if (artifactId) {
            try { await open(artifactId); }
            catch (error) {
                if (error.status !== 404) throw error;
                sessionStorage.removeItem(`pivot_mindmap_active:${state.userId}`);
                state.editor?.destroy(); state.editor = null; state.active = null; state.document = null; state.dirty = false;
                await library(); fail(error);
            }
        } else await library();
    }
    function suspend() { state.loadSequence++; state.activationSequence = (state.activationSequence || 0) + 1; state.exportSequence = (state.exportSequence || 0) + 1; advanced?.stop(); void keepDraft(); stopSync(); clearTimeout(state.timer); clearTimeout(state.maxTimer); clearTimeout(state.pollTimer); state.maxTimer = null; state.editor?.destroy(); state.editor = null; closeDialog(); }
    async function logout() {
        suspend(); if (state.saving) await state.saving.catch(() => {}); await drafts().clear(state.userId).catch(() => {});
        state.editor?.destroy(); state.editor = null; state.active = null; state.document = null; state.rows = []; state.dirty = false; state.pending = null; state.aiGenerated = null; state.createPending = null; state.userId = '';
        for (const id of ['mindmap-outline', 'mindmap-dialog-body', 'mindmap-documents', 'mindmap-export-status', 'mindmap-minimap']) $(id)?.replaceChildren();
        selected(null); status(''); $('mindmap-access-status').textContent = '';
        state.personalTemplates = [];
        $('mindmap-template')?.querySelectorAll('[data-personal-template]').forEach(option => option.remove());
    }
    window.Pivot.exposeModule('apps.mindmaps', { show, suspend, logout, save, open });
})();
