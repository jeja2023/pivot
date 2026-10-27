(function () {
    'use strict';
    const schema = window.Pivot.moduleApi('mindmaps.document');
    const $ = id => document.getElementById(id);
    function create(context) {
        const { state, dialog, closeDialog, escape, changed } = context;
        let sequence = []; let position = 0; let presentation = false;
        let aiContext; let aiResult; let dataResult;
        let sharingConfig; let organizeRow; let dataSource; let themes;
        function nodes() { const result = []; (function walk(node, depth = 0) { result.push({ ...node, depth }); node.children.forEach(child => walk(child, depth + 1)); })(state.document.tree); return result; }
        function apply(document) { const next = schema.normalize(document); state.editor.update(next); changed(next); }
        function fieldOptions() { return nodes().map(node => `<option value="${escape(node.id)}">${escape('　'.repeat(node.depth) + node.text)}</option>`).join(''); }
        function relations() {
            const relList = state.document.relations || [];
            const relationsListHtml = relList.length === 0
                ? `<div class="mm-empty-box">
                    <svg class="mm-empty-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5l7 7"/></svg>
                    <span class="mm-empty-text">当前暂未建立关联线</span>
                    <span class="mm-empty-hint">在上方选择起点与终点节点，点击“添加关联”即可创建</span>
                   </div>`
                : `<div class="mm-modal-table-wrap">
                    <table class="mm-modal-table">
                        <thead>
                            <tr>
                                <th style="width: 46%;">关联节点</th>
                                <th style="width: 38%;">说明</th>
                                <th style="width: 16%; text-align: center;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${relList.map((line, index) => {
                                const fromNode = nodes().find(node => node.id === line.from);
                                const toNode = nodes().find(node => node.id === line.to);
                                const fromText = fromNode?.text || '未知节点';
                                const toText = toNode?.text || '未知节点';
                                return `<tr>
                                    <td>
                                        <div class="mm-relation-flow">
                                            <span class="mm-node-badge" title="${escape(fromText)}">${escape(fromText)}</span>
                                            <svg class="mm-flow-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                                            <span class="mm-node-badge" title="${escape(toText)}">${escape(toText)}</span>
                                        </div>
                                    </td>
                                    <td>
                                        ${line.text ? `<span class="mm-desc-text" title="${escape(line.text)}">${escape(line.text)}</span>` : '<span class="mm-empty-dash">—</span>'}
                                    </td>
                                    <td style="text-align: center;">
                                        <button class="mm-btn-danger" type="button" data-mm-action="relation-remove" data-mm-index="${index}">删除</button>
                                    </td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                   </div>`;

            const relationsHtml = `
<div class="mm-modal-form mm-relations-modal">
    <div class="mm-modal-subtitle">在导图的任意两个主题节点之间建立逻辑连接线，支持标注关系说明。</div>
    <div class="mm-section-card">
        <div class="mm-section-title">添加新关联线</div>
        <div class="mm-form-grid-2">
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-relation-from">
                    <span class="mm-label-text">起点节点</span>
                </label>
                <select id="mindmap-relation-from" class="form-input mm-modal-select">
                    ${fieldOptions()}
                </select>
            </div>
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-relation-to">
                    <span class="mm-label-text">终点节点</span>
                </label>
                <select id="mindmap-relation-to" class="form-input mm-modal-select">
                    ${fieldOptions()}
                </select>
            </div>
        </div>
        <div class="mm-form-field">
            <label class="mm-field-label" for="mindmap-relation-text">
                <span class="mm-label-text">关联说明（可选）</span>
            </label>
            <div class="mm-input-action-row">
                <input id="mindmap-relation-text" class="form-input mm-modal-input" maxlength="120" placeholder="例如：前置条件、衍生推进、论证支持…">
                <button class="btn-primary mm-modal-submit mm-btn-inline-submit" type="button" data-mm-action="relation-add" aria-label="添加关联线">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span>添加关联</span>
                </button>
            </div>
        </div>
    </div>
    <div class="mm-section-block">
        <div class="mm-section-header">
            <span class="mm-section-title">已建立关联 (${relList.length})</span>
        </div>
        ${relationsListHtml}
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">关联线可在画布中双击直接编辑文字或拖拽端点</span>
    </div>
</div>`;
            void dialog('管理关联线', relationsHtml);
            if (state.editor.selection()) {
                const sel = state.editor.selection();
                const fromEl = $('mindmap-relation-from');
                if (fromEl) fromEl.value = sel;
            }
        }
        function summaries() {
            const sumList = state.document.summaries || [];
            const parentNodes = nodes().filter(node => node.children.length);
            const summariesListHtml = sumList.length === 0
                ? `<div class="mm-empty-box">
                    <svg class="mm-empty-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    <span class="mm-empty-text">当前暂未建立概要</span>
                    <span class="mm-empty-hint">在上方选择父节点与分支序号范围，点击“添加概要”即可创建</span>
                   </div>`
                : `<div class="mm-modal-table-wrap">
                    <table class="mm-modal-table">
                        <thead>
                            <tr>
                                <th style="width: 32%;">所属父节点</th>
                                <th style="width: 24%;">分支跨度</th>
                                <th style="width: 28%;">概要文字</th>
                                <th style="width: 16%; text-align: center;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sumList.map((summary, index) => {
                                const parentNode = nodes().find(node => node.id === summary.parentId);
                                const parentText = parentNode?.text || '未知父节点';
                                return `<tr>
                                    <td>
                                        <span class="mm-node-badge" title="${escape(parentText)}">${escape(parentText)}</span>
                                    </td>
                                    <td>
                                        <span class="mm-range-badge">分支 ${summary.start + 1} – ${summary.end + 1}</span>
                                    </td>
                                    <td>
                                        <span class="mm-desc-text" title="${escape(summary.text)}">${escape(summary.text)}</span>
                                    </td>
                                    <td style="text-align: center;">
                                        <button class="mm-btn-danger" type="button" data-mm-action="summary-remove" data-mm-index="${index}">删除</button>
                                    </td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                   </div>`;

            const summariesHtml = `
<div class="mm-modal-form mm-summaries-modal">
    <div class="mm-modal-subtitle">选定某一父主题下的连续子分支范围生成大括号概要，归纳提炼阶段性总结。</div>
    <div class="mm-section-card">
        <div class="mm-section-title">添加新概要</div>
        <div class="mm-form-field">
            <label class="mm-field-label" for="mindmap-summary-parent">
                <span class="mm-label-text">父主题节点</span>
            </label>
            <select id="mindmap-summary-parent" class="form-input mm-modal-select">
                ${parentNodes.length ? parentNodes.map(node => `<option value="${node.id}">${escape(node.text)} (${node.children.length} 个子分支)</option>`).join('') : '<option value="">暂无包含子分支的节点</option>'}
            </select>
        </div>
        <div class="mm-form-grid-2">
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-summary-start">
                    <span class="mm-label-text">起始分支序号</span>
                </label>
                <input id="mindmap-summary-start" class="form-input mm-modal-input" type="number" min="1" value="1">
            </div>
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-summary-end">
                    <span class="mm-label-text">结束分支序号</span>
                </label>
                <input id="mindmap-summary-end" class="form-input mm-modal-input" type="number" min="1" value="1">
            </div>
        </div>
        <div class="mm-form-field">
            <label class="mm-field-label" for="mindmap-summary-text">
                <span class="mm-label-text">概要文字</span>
            </label>
            <div class="mm-input-action-row">
                <input id="mindmap-summary-text" class="form-input mm-modal-input" maxlength="120" placeholder="例如：关键产出、第一阶段总结、核心论点…">
                <button class="btn-primary mm-modal-submit mm-btn-inline-submit" type="button" data-mm-action="summary-add"${parentNodes.length ? '' : ' disabled'}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span>添加概要</span>
                </button>
            </div>
        </div>
    </div>
    <div class="mm-section-block">
        <div class="mm-section-header">
            <span class="mm-section-title">已建立概要 (${sumList.length})</span>
        </div>
        ${summariesListHtml}
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">概要可在画布中双击就地修改文字</span>
    </div>
</div>`;
            void dialog('管理概要', summariesHtml);
            if (state.editor.selection()) {
                const sel = state.editor.selection();
                const parentEl = $('mindmap-summary-parent');
                if (parentEl && parentNodes.some(n => n.id === sel)) parentEl.value = sel;
            }
        }
        function presentFocus() {
            const node = sequence[position]; if (!node) return;
            $('mindmap-present-position').textContent = `${position + 1} / ${sequence.length} · ${node.text}`;
            state.editor.focus(node.id);
        }
        function stop() {
            dataSource?.stop();
            aiContext = null; aiResult = null; dataResult = null;
            if (!presentation) return; presentation = false;
            $('mindmap-editor').classList.remove('is-presenting'); $('mindmap-present-controls').classList.add('hidden');
            state.editor?.present(false);
        }
        const onKey = event => {
            if (!presentation) return;
            if (['Escape', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
            if (event.key === 'Escape') stop();
            if (event.key === 'ArrowLeft') { position = Math.max(0, position - 1); presentFocus(); }
            if (event.key === 'ArrowRight' || event.key === ' ') { position = Math.min(sequence.length - 1, position + 1); presentFocus(); }
        };
        window.addEventListener('keydown', onKey);
        return {
            stop,
            async action(name, button) {
                if (['theme-library', 'theme-save', 'theme-use', 'theme-delete', 'theme-export', 'theme-import'].includes(name)) { await window.Pivot.loadScriptOnce('/chat/mindmaps/themes.js'); themes ||= window.Pivot.moduleApi('mindmaps.themes').create(context); return themes.action(name, button); }
                if (name.startsWith('dataset-')) { await window.Pivot.loadScriptOnce('/chat/mindmaps/data-source.js'); dataSource ||= window.Pivot.moduleApi('mindmaps.dataSource').create(context); return dataSource.action(name); }
                if (name === 'organize') {
                    organizeRow = state.rows.find(row => row.id === button.dataset.mmOrganize);
                    void dialog('收藏与标签', `<label><input id="mindmap-organize-favorite" type="checkbox"${organizeRow.favorite ? ' checked' : ''}> 收藏此导图</label><label>标签（用中文或英文逗号分隔）<input id="mindmap-organize-tags" class="form-input" maxlength="660" value="${escape(organizeRow.tags.join('，'))}"></label><button class="btn-primary" type="button" data-mm-action="organize-save">保存设置</button>`); return true;
                }
                if (name === 'organize-save') {
                    const tags = $('mindmap-organize-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
                    await context.request(`/${organizeRow.id}/settings`, { ...context.json({ tags, favorite: $('mindmap-organize-favorite').checked }), method: 'PUT' }); closeDialog(); await context.loadList(); return true;
                }
                if (name === 'personal-templates') {
                    const result = await context.request('/personal-templates');
                    void dialog('个人模板', `<p>模板保存完整导图结构与样式，只对当前账号可见；每账号最多 100 份。</p><ul>${result.rows.map(template => `<li>${escape(template.name)} <button class="btn-secondary" type="button" data-mm-action="template-use" data-mm-template="${template.id}">使用</button> <button class="btn-danger" type="button" data-mm-action="template-delete" data-mm-template="${template.id}">删除模板</button></li>`).join('')}</ul>`); return true;
                }
                if (name === 'template-use') { const result = await context.request(`/personal-templates/${button.dataset.mmTemplate}`); await context.create(result.document); closeDialog(); return true; }
                if (name === 'template-delete') {
                    await context.request(`/personal-templates/${button.dataset.mmTemplate}`, { method: 'DELETE' });
                    state.personalTemplates = (state.personalTemplates || []).filter(t => String(t.id) !== String(button.dataset.mmTemplate));
                    $('mindmap-template')?.querySelector(`option[value="personal:${button.dataset.mmTemplate}"]`)?.remove();
                    return this.action('personal-templates');
                }
                if (name === 'template-save') {
                    await context.save(); void dialog('保存为个人模板', '<label>模板名称<input id="mindmap-template-name" class="form-input" maxlength="80" placeholder="例如：项目复盘结构"></label><button class="btn-primary" type="button" data-mm-action="template-save-confirm">保存模板</button>'); return true;
                }
                if (name === 'template-save-confirm') {
                    const result = await context.request('/personal-templates', context.json({ artifactId: state.active.id, name: $('mindmap-template-name').value }));
                    state.personalTemplates = [...(state.personalTemplates || []).filter(t => String(t.id) !== String(result.template.id)), result.template];
                    if ($('mindmap-template') && !$('mindmap-template').querySelector(`option[value="personal:${result.template.id}"]`)) {
                        const option = document.createElement('option'); option.value = `personal:${result.template.id}`; option.textContent = result.template.name; option.dataset.personalTemplate = 'true'; $('mindmap-template').appendChild(option);
                    }
                    closeDialog(); return true;
                }
                if (name === 'sharing') {
                    await context.save();
                    const [config, targets] = await Promise.all([context.request(`/${state.active.id}/sharing`), context.request('/share-targets')]);
                    sharingConfig = config;
                    const curUser = (typeof currentUser !== 'undefined' && currentUser) || window.Pivot?.legacy?.currentUser || null;
                    const owner = curUser ? {
                        id: Number(curUser.id),
                        username: curUser.username,
                        nickname: curUser.nickname || curUser.username,
                        unit: curUser.unit || '未分配单位'
                    } : null;
                    const modalEngine = window.Pivot?.modules?.['share.collaborators'] || window.Pivot?.legacy?.PivotShareCollabModal;
                    if (modalEngine) {
                        modalEngine.open({
                            modalId: 'mindmap-share-modal',
                            title: '思维导图协作者与共享',
                            subtitle: '管理共同审阅、协作编辑与查看该思维导图的成员与单位协作权限。',
                            summaryTitle: state.active?.title || '思维导图',
                            summaryDesc: '仅所有者可恢复历史快照与彻底删除；编辑者可实时协作修改，查看者仅可浏览及另存副本。',
                            owner,
                            users: Array.isArray(targets.users) ? targets.users : [],
                            units: Array.isArray(targets.units) ? targets.units : [],
                            initialCollaborators: (config.members || []).map(m => ({
                                id: Number(m.userId),
                                role: m.role || 'editor'
                            })),
                            roles: [
                                { value: 'editor', label: '编辑者（可协作编辑）', shortLabel: '编辑者' },
                                { value: 'viewer', label: '查看者（仅浏览及另存副本）', shortLabel: '查看者' }
                            ],
                            defaultRole: 'editor',
                            onSave: async ({ collaborators }) => {
                                const members = collaborators.map(c => ({
                                    userId: String(c.id),
                                    role: c.role || 'editor'
                                }));
                                const enabled = members.length > 0;
                                await context.request(`/${state.active.id}/sharing`, {
                                    ...context.json({
                                        enabled,
                                        members,
                                        expectedRevision: sharingConfig.revision,
                                        expectedVersionId: state.active.versionId
                                    }),
                                    method: 'PUT'
                                });
                                await context.open(state.active.id);
                            }
                        });
                    }
                    return true;
                }
                if (name === 'theme-pack') {
                    const current = schema.palette(state.document);
                    const pack = { version: 1, label: current.label, root: current.root, line: current.line, background: current.background, ...(current.styles ? { styles: current.styles } : {}) };
                    const modalHtml = `
<div class="mm-modal-form mm-theme-pack-modal">
    <div class="mm-modal-subtitle">以结构化 JSON 定义主题色板与节点层级样式规范，配置随当前导图版本持久化保存。</div>
    <div class="mm-section-card mm-theme-pack-meta-card">
        <div class="mm-theme-pack-left">
            <span class="mm-badge-theme">JSON 规范</span>
            <span class="mm-theme-pack-label">${escape(pack.label || '自定义主题')}</span>
            <div class="mm-theme-color-chips">
                <span class="mm-color-dot" data-color="${pack.root || 'var(--primary, #4338ca)'}" title="根节点 root: ${pack.root}"></span>
                <span class="mm-color-dot" data-color="${pack.line || 'var(--primary-light, #6366f1)'}" title="分支连线 line: ${pack.line}"></span>
                <span class="mm-color-dot mm-dot-bordered" data-color="${pack.background || 'var(--surface, #ffffff)'}" title="背景 background: ${pack.background || 'var(--surface, #ffffff)'}"></span>
            </div>
        </div>
        <div class="mm-theme-pack-helpers">
            <button type="button" class="btn-secondary mm-btn-xs" id="mm-pack-format-btn" title="格式化 JSON 缩进">格式化</button>
            <button type="button" class="btn-secondary mm-btn-xs" id="mm-pack-copy-btn" title="复制完整配置">复制配置</button>
        </div>
    </div>
    <div class="mm-code-editor-card">
        <div class="mm-code-editor-header">
            <div class="mm-code-title">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                <span>theme.json</span>
            </div>
            <span class="mm-code-hint">最大 16KB · 支持 root / line / background / styles</span>
        </div>
        <textarea id="mindmap-theme-pack" class="form-input mm-code-textarea" rows="11" spellcheck="false" maxlength="16000">${escape(JSON.stringify(pack, null, 2))}</textarea>
    </div>
    <div class="mm-theme-pack-guide">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <span>说明：支持配置 <code>根节点(root)</code>、<code>分支线(line)</code>、<code>背景色(background)</code> 及 <code>层级样式(styles)</code>（分级设定各层级节点文字、形状与线条属性）。</span>
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">原生 JSON 导出将包含完整自定义主题参数</span>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button type="button" class="btn-primary mm-modal-submit" data-mm-action="theme-pack-apply">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>
                <span>应用主题包</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog('自定义主题包', modalHtml);
                    setTimeout(() => {
                        const body = $('mindmap-dialog-body');
                        if (body) {
                            body.querySelectorAll('.mm-color-dot[data-color]').forEach(dot => {
                                dot.style.backgroundColor = dot.getAttribute('data-color');
                            });
                        }
                        const formatBtn = $('mm-pack-format-btn');
                        const copyBtn = $('mm-pack-copy-btn');
                        const textarea = $('mindmap-theme-pack');
                        if (formatBtn && textarea) {
                            formatBtn.addEventListener('click', () => {
                                try { textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2); } catch (_) {}
                            });
                        }
                        if (copyBtn && textarea) {
                            copyBtn.addEventListener('click', async () => {
                                try {
                                    await navigator.clipboard.writeText(textarea.value);
                                    const old = copyBtn.textContent;
                                    copyBtn.textContent = '已复制';
                                    setTimeout(() => { copyBtn.textContent = old; }, 1500);
                                } catch (_) {}
                            });
                        }
                    }, 0);
                    return true;
                }
                if (name === 'theme-pack-apply') {
                    let parsed; try { parsed = JSON.parse($('mindmap-theme-pack').value); } catch (_) { throw new Error('主题配置不是有效 JSON，请检查后重试。'); }
                    const next = schema.normalize(state.document); next.presentation.themeId = 'custom'; next.presentation.customTheme = schema.themePack(parsed); apply(next); $('mindmap-theme').value = 'custom'; closeDialog(); return true;
                }
                if (name === 'data-import') {
                    const response = await context.request('/data-views');
                    void dialog('从数据分析视图创建导图', `<p>选择本人数据集的已保存分类汇总图表。生成的是当前查询范围的静态快照，后续数据变化不会自动覆盖导图。</p><label>分析视图<select id="mindmap-data-view" class="form-input">${response.rows.map(view => `<option value="${escape(view.id)}">${escape(view.name)}</option>`).join('')}</select></label><div class="mindmap-toolbar"><button class="btn-primary" type="button" data-mm-action="data-preview"${response.rows.length ? '' : ' disabled'}>生成预览</button></div>${response.rows.length ? '' : '<p>没有可转换的视图，请先在数据分析应用保存分类汇总图表。</p>'}`); return true;
                }
                if (name === 'data-preview') {
                    const response = await context.request('/from-data', context.json({ viewId: $('mindmap-data-view').value })); dataResult = response.document;
                    void dialog('检查数据导图', `<p>${escape(dataResult.source.description)}</p><pre>${escape(schema.markdown(dataResult))}</pre><button type="button" class="btn-primary" data-mm-action="data-save">保存为新导图</button>`); return true;
                }
                if (name === 'data-save') { if (!dataResult) throw new Error('请先生成数据预览。'); await context.create(dataResult); dataResult = null; closeDialog(); return true; }
                if (name === 'ai-expand' || name === 'ai-summarize') {
                    const nodeId = state.editor.selection(); if (!nodeId) throw new Error('请先选择一个节点。');
                    await context.save();
                    const targetNode = nodes().find(node => node.id === nodeId);
                    const nodeTitle = targetNode?.text || '选中节点';
                    const nodeDepth = (targetNode?.depth ?? 0) + 1;
                    aiContext = {
                        artifactId: state.active.id,
                        nodeId,
                        nodeTitle,
                        nodeDepth,
                        versionId: state.active.versionId,
                        signature: JSON.stringify(state.document),
                        mode: name === 'ai-expand' ? 'expand' : 'summarize'
                    };
                    const isExpand = name === 'ai-expand';
                    const dialogTitle = isExpand ? 'AI 展开分支' : 'AI 总结分支';
                    const subtitle = isExpand
                        ? '输入扩充方向与要求，AI 将结合当前分支上下文智能生成下级多维度子分支'
                        : '输入提炼重点与摘要要求，AI 将汇总该分支及其下属子节点并生成精炼结论';
                    const placeholder = isExpand
                        ? '可留空直接生成；或输入具体要求，如：“从实施步骤、资源投入与潜在风险细化展开”、“增加 3 个创新解决方案”…'
                        : '可留空直接生成；或输入具体要求，如：“精炼成 3 句核心论点与后续行动项”、“概括主要观点，语言精炼简短”…';
                    const noticeText = isExpand
                        ? '生成结果会先展示结构化大纲预览，经核对确认后才会应用合并至当前分支。'
                        : '生成结果会先展示摘要预览，经核对确认后将自动写入该节点的“备注”中。';
                    const branchHtml = `
<div class="mm-modal-form mm-ai-modal">
    <div class="mm-modal-subtitle">${subtitle}</div>
    <div class="mm-target-branch-card">
        <div class="mm-target-branch-header">
            <span class="mm-target-branch-tag">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 3v6m0 6v6m9-9h-6m-6 0H3"/></svg>
                <span>目标分支</span>
            </span>
            <span class="mm-target-branch-depth">层级: L${nodeDepth}</span>
        </div>
        <div class="mm-target-branch-name" title="${escape(nodeTitle)}">${escape(nodeTitle)}</div>
    </div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label" for="mindmap-branch-prompt">
                <span class="mm-label-text">补充要求与重点（可选）</span>
            </label>
            <span class="mm-label-hint">按 Ctrl + Enter 快速提交</span>
        </div>
        <div class="mm-textarea-wrap">
            <textarea id="mindmap-branch-prompt" class="form-input mm-ai-textarea" rows="4" maxlength="12000" placeholder="${placeholder}"></textarea>
        </div>
    </div>
    <div class="mm-ai-notice">
        <svg class="mm-notice-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <span class="mm-notice-text">${noticeText}</span>
    </div>
    <div id="mindmap-branch-status" class="mm-status-bar" role="status"></div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">支持空要求智能推导</span>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button type="button" class="btn-primary mm-modal-submit" data-mm-action="ai-branch-generate">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                <span>生成预览</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog(dialogTitle, branchHtml, { hideClose: true });
                    const promptInput = $('mindmap-branch-prompt');
                    if (promptInput) {
                        promptInput.focus();
                        promptInput.addEventListener('keydown', e => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                const btn = $('mindmap-dialog-body')?.querySelector('[data-mm-action="ai-branch-generate"]');
                                if (btn && !btn.disabled) btn.click();
                            }
                        });
                    }
                    return true;
                }
                if (name === 'ai-branch-generate') {
                    const btn = $('mindmap-dialog-body')?.querySelector('[data-mm-action="ai-branch-generate"]');
                    if (btn) btn.disabled = true;
                    const statusBar = $('mindmap-branch-status');
                    if (statusBar) statusBar.textContent = aiContext?.mode === 'summarize' ? '正在分析分支内容并提炼核心摘要…' : '正在分析分支上下文并生成子分支…';
                    const sequence = state.dialogSequence;
                    state.aiController = new AbortController();
                    let result;
                    try {
                        result = await context.request('/ai', {
                            ...context.json({
                                mode: aiContext.mode,
                                artifactId: aiContext.artifactId,
                                nodeId: aiContext.nodeId,
                                expectedVersionId: aiContext.versionId,
                                prompt: $('mindmap-branch-prompt')?.value || ''
                            }),
                            signal: state.aiController.signal
                        });
                    } catch (error) {
                        if (error.name === 'AbortError') return true;
                        if (statusBar) statusBar.textContent = error.message;
                        throw error;
                    } finally {
                        if (btn && btn.isConnected) btn.disabled = false;
                    }
                    if (sequence !== state.dialogSequence || $('mindmap-dialog').classList.contains('hidden')) return true;
                    aiResult = result;
                    const isSummarize = aiContext.mode === 'summarize';
                    const previewText = isSummarize ? result.summary : schema.markdown(result.document);
                    const previewTitle = isSummarize ? '检查分支总结结果' : '检查分支扩展结果';
                    const previewSubtitle = isSummarize
                        ? '已成功提炼所选分支的要点摘要，确认后将自动写入该节点的备注中：'
                        : '已成功生成下级子分支大纲，确认后将合并追加到当前分支结构中：';
                    const previewHtml = `
<div class="mm-modal-form mm-ai-preview-modal">
    <div class="mm-modal-subtitle">${previewSubtitle}</div>
    <div class="mm-target-branch-card">
        <div class="mm-target-branch-header">
            <span class="mm-target-branch-tag">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 3v6m0 6v6m9-9h-6m-6 0H3"/></svg>
                <span>目标分支</span>
            </span>
            <span class="mm-target-branch-depth">操作: ${isSummarize ? '写入节点备注' : '新增子分支'}</span>
        </div>
        <div class="mm-target-branch-name" title="${escape(aiContext.nodeTitle || '')}">${escape(aiContext.nodeTitle || '')}</div>
    </div>
    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label">
                <span class="mm-label-text">${isSummarize ? '提炼摘要预览' : '生成子分支大纲预览'}</span>
            </label>
            <span class="mm-label-hint">结构化 Markdown 预览</span>
        </div>
        <pre class="mm-ai-preview-pre">${escape(previewText)}</pre>
    </div>
    <div class="mm-modal-footer">
        <span class="mm-footer-hint">${isSummarize ? '可在属性面板中随时修改该节点的备注' : '应用后可在画布中继续编辑与调整位置'}</span>
        <div class="mm-footer-btns">
            <button class="btn-secondary mm-modal-cancel" type="button" data-mm-action="dialog-close">返回重试</button>
            <button class="btn-primary mm-modal-submit" type="button" data-mm-action="ai-branch-apply" aria-label="应用到原分支">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                <span>应用到原分支</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog(previewTitle, previewHtml, { hideClose: true });
                    return true;
                }
                if (name === 'ai-branch-apply') {
                    if (!aiContext || !aiResult || state.active.id !== aiContext.artifactId || JSON.stringify(state.document) !== aiContext.signature) throw new Error('生成期间导图已变化，请重新生成，或复制预览内容后手动编辑。');
                    const next = schema.normalize(state.document); let target; (function find(node) { if (node.id === aiContext.nodeId) target = node; node.children.forEach(find); })(next.tree);
                    if (aiContext.mode === 'summarize') next.presentation.nodes[target.id] = { ...next.presentation.nodes[target.id], note: aiResult.summary };
                    else {
                        const remap = node => ({ id: `node-${window.crypto.randomUUID()}`, text: node.text, children: node.children.map(remap) });
                        const additions = aiResult.document.tree.children; if (!additions.length) throw new Error('模型没有返回可添加的子分支，请重新生成。');
                        target.children.push(...additions.map(remap));
                    }
                    apply(next); aiResult = null; aiContext = null; closeDialog(); return true;
                }
                if (name === 'outline-edit') {
                    void dialog('编辑节点大纲', `<p>按稳定节点标识修改文字，保留样式、备注和关联关系。</p>${nodes().map(node => `<label>${escape('　'.repeat(node.depth) + '节点')}<input class="form-input" maxlength="120" data-mm-outline-text="${node.id}" value="${escape(node.text)}"></label>`).join('')}<div class="mindmap-toolbar"><button class="btn-primary" type="button" data-mm-action="outline-apply">应用大纲</button></div>`); return true;
                }
                if (name === 'outline-apply') {
                    const next = schema.normalize(state.document); const values = new Map([...$('mindmap-dialog-body').querySelectorAll('[data-mm-outline-text]')].map(input => [input.dataset.mmOutlineText, input.value]));
                    (function walk(node) { node.text = values.get(node.id); node.children.forEach(walk); })(next.tree); apply(next); closeDialog(); return true;
                }
                if (name === 'relations') { relations(); return true; }
                if (name === 'relation-add' || name === 'relation-remove') {
                    const next = schema.normalize(state.document);
                    if (name === 'relation-add') next.relations.push({ from: $('mindmap-relation-from').value, to: $('mindmap-relation-to').value, text: $('mindmap-relation-text').value });
                    else next.relations.splice(Number(button.dataset.mmIndex), 1);
                    apply(next); relations(); return true;
                }
                if (name === 'summaries') { summaries(); return true; }
                if (name === 'summary-add' || name === 'summary-remove') {
                    const next = schema.normalize(state.document);
                    if (name === 'summary-add') next.summaries.push({ id: `summary-${window.crypto.randomUUID()}`, parentId: $('mindmap-summary-parent').value, start: Number($('mindmap-summary-start').value) - 1, end: Number($('mindmap-summary-end').value) - 1, text: $('mindmap-summary-text').value });
                    else next.summaries.splice(Number(button.dataset.mmIndex), 1);
                    apply(next); summaries(); return true;
                }
                if (name === 'present') {
                    state.editor.document(); await context.save(); sequence = nodes(); position = 0; presentation = true;
                    $('mindmap-editor').classList.add('is-presenting'); $('mindmap-present-controls').classList.remove('hidden'); state.editor.present(true); presentFocus(); return true;
                }
                if (name === 'present-close') { stop(); return true; }
                if (name === 'present-next' || name === 'present-prev') { position = Math.max(0, Math.min(sequence.length - 1, position + (name === 'present-next' ? 1 : -1))); presentFocus(); return true; }
                if (name === 'minimap') {
                    const host = $('mindmap-minimap'); host.classList.toggle('hidden');
                    if (!host.classList.contains('hidden')) {
                        PivotSafeHtml.setHtml(host, state.editor.minimap(), { USE_PROFILES: { html: true, svg: true } });
                        const caption = document.createElement('p'); caption.textContent = '点击适配全图；拖动导航图平移画布'; host.appendChild(caption);
                        let start;
                        host.onpointerdown = event => { start = { x: event.clientX, y: event.clientY }; host.setPointerCapture(event.pointerId); };
                        host.onpointerup = event => { if (!start) return; const dx = event.clientX - start.x; const dy = event.clientY - start.y; start = null; if (Math.abs(dx) + Math.abs(dy) < 5) state.editor.fit(); else state.editor.pan(-dx * 4, -dy * 4); };
                    }
                    return true;
                }
                return false;
            }
        };
    }
    window.Pivot.exposeModule('mindmaps.advanced', { create });
})();
