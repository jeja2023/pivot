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
            void dialog('管理关联线', `<p>连接两个不同节点；关联线和说明随历史版本保存。</p><label>起点<select id="mindmap-relation-from" class="form-input">${fieldOptions()}</select></label><label>终点<select id="mindmap-relation-to" class="form-input">${fieldOptions()}</select></label><label>说明<input id="mindmap-relation-text" class="form-input" maxlength="120"></label><button class="btn-primary" type="button" data-mm-action="relation-add">添加关联线</button><div class="table-container"><table class="data-table"><thead><tr><th>起点</th><th>终点</th><th>说明</th><th>操作</th></tr></thead><tbody>${state.document.relations.map((line, index) => `<tr><td>${escape(nodes().find(node => node.id === line.from)?.text)}</td><td>${escape(nodes().find(node => node.id === line.to)?.text)}</td><td>${escape(line.text)}</td><td><button class="btn-danger" type="button" data-mm-action="relation-remove" data-mm-index="${index}">删除</button></td></tr>`).join('')}</tbody></table></div>`);
            if (state.editor.selection()) $('mindmap-relation-from').value = state.editor.selection();
        }
        function summaries() {
            void dialog('管理概要', `<p>选定父节点下连续分支，概要文字可在画布中双击修改。</p><label>父节点<select id="mindmap-summary-parent" class="form-input">${nodes().filter(node => node.children.length).map(node => `<option value="${node.id}">${escape(node.text)}</option>`).join('')}</select></label><label>起始分支序号<input id="mindmap-summary-start" class="form-input" type="number" min="1" value="1"></label><label>结束分支序号<input id="mindmap-summary-end" class="form-input" type="number" min="1" value="1"></label><label>概要文字<input id="mindmap-summary-text" class="form-input" maxlength="120"></label><button class="btn-primary" type="button" data-mm-action="summary-add">添加概要</button><ul>${state.document.summaries.map((summary, index) => `<li>${escape(summary.text)}（分支 ${summary.start + 1}–${summary.end + 1}）<button class="btn-danger" type="button" data-mm-action="summary-remove" data-mm-index="${index}">删除</button></li>`).join('')}</ul>`);
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
                if (name === 'template-delete') { await context.request(`/personal-templates/${button.dataset.mmTemplate}`, { method: 'DELETE' }); $('mindmap-template').querySelector(`option[value="personal:${button.dataset.mmTemplate}"]`)?.remove(); return this.action('personal-templates'); }
                if (name === 'template-save') {
                    await context.save(); void dialog('保存为个人模板', '<label>模板名称<input id="mindmap-template-name" class="form-input" maxlength="80" placeholder="例如：项目复盘结构"></label><button class="btn-primary" type="button" data-mm-action="template-save-confirm">保存模板</button>'); return true;
                }
                if (name === 'template-save-confirm') {
                    const result = await context.request('/personal-templates', context.json({ artifactId: state.active.id, name: $('mindmap-template-name').value }));
                    if (!$('mindmap-template').querySelector(`option[value="personal:${result.template.id}"]`)) { const option = document.createElement('option'); option.value = `personal:${result.template.id}`; option.textContent = result.template.name; option.dataset.personalTemplate = 'true'; $('mindmap-template').appendChild(option); }
                    closeDialog(); return true;
                }
                if (name === 'sharing') {
                    await context.save(); const [config, targets] = await Promise.all([context.request(`/${state.active.id}/sharing`), context.request('/share-targets')]); sharingConfig = config;
                    void dialog('共享与协作权限', `<p>仅所有者可以设置权限、恢复历史和删除；查看者可阅读并另存个人副本，编辑者可协作修改。共享文件导出需先另存为个人副本。</p><label><input id="mindmap-sharing-enabled" type="checkbox"${config.enabled ? ' checked' : ''}> 开启共享与协作</label><div class="table-container"><table class="data-table"><thead><tr><th>账号</th><th>单位</th><th>权限</th></tr></thead><tbody>${targets.users.map(user => `<tr><td>${escape(user.nickname || user.username)}</td><td>${escape(user.unit)}</td><td><select class="form-input" data-mm-member="${user.id}"><option value="">不共享</option><option value="viewer"${config.members.find(member => member.userId === String(user.id))?.role === 'viewer' ? ' selected' : ''}>查看</option><option value="editor"${config.members.find(member => member.userId === String(user.id))?.role === 'editor' ? ' selected' : ''}>编辑</option></select></td></tr>`).join('')}</tbody></table></div><button class="btn-primary" type="button" data-mm-action="sharing-save">保存权限</button>`); return true;
                }
                if (name === 'sharing-save') {
                    const members = [...$('mindmap-dialog-body').querySelectorAll('[data-mm-member]')].filter(select => select.value).map(select => ({ userId: select.dataset.mmMember, role: select.value }));
                    await context.request(`/${state.active.id}/sharing`, { ...context.json({ enabled: $('mindmap-sharing-enabled').checked, members, expectedRevision: sharingConfig.revision, expectedVersionId: state.active.versionId }), method: 'PUT' });
                    closeDialog(); await context.open(state.active.id); return true;
                }
                if (name === 'theme-pack') {
                    const current = schema.palette(state.document); const pack = { version: 1, label: current.label, root: current.root, line: current.line, background: current.background, ...(current.styles ? { styles: current.styles } : {}) };
                    void dialog('自定义主题包', `<p>可修改并粘贴主题配置。主题包允许颜色与 root/second/node 三组 styles 节点样式；应用后随导图版本保存，原生 JSON 导出包含完整配置。</p><label>主题配置<textarea id="mindmap-theme-pack" class="form-input" rows="10" maxlength="16000">${escape(JSON.stringify(pack, null, 2))}</textarea></label><button class="btn-primary" type="button" data-mm-action="theme-pack-apply">应用主题包</button>`); return true;
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
                    await context.save(); aiContext = { artifactId: state.active.id, nodeId, versionId: state.active.versionId, signature: JSON.stringify(state.document), mode: name === 'ai-expand' ? 'expand' : 'summarize' };
                    void dialog(name === 'ai-expand' ? 'AI 展开分支' : 'AI 总结分支', '<label>补充要求<textarea id="mindmap-branch-prompt" class="form-input" rows="4" maxlength="12000" placeholder="可留空，按当前分支生成"></textarea></label><p>生成结果会先预览，核对后再应用。</p><button class="btn-primary" type="button" data-mm-action="ai-branch-generate">生成预览</button>'); return true;
                }
                if (name === 'ai-branch-generate') {
                    const sequence = state.dialogSequence; state.aiController = new AbortController();
                    let result;
                    try { result = await context.request('/ai', { ...context.json({ mode: aiContext.mode, artifactId: aiContext.artifactId, nodeId: aiContext.nodeId, expectedVersionId: aiContext.versionId, prompt: $('mindmap-branch-prompt').value }), signal: state.aiController.signal }); }
                    catch (error) { if (error.name === 'AbortError') return true; throw error; }
                    if (sequence !== state.dialogSequence || $('mindmap-dialog').classList.contains('hidden')) return true;
                    aiResult = result;
                    void dialog('检查分支结果', `<pre>${escape(result.summary || schema.markdown(result.document))}</pre><button class="btn-primary" type="button" data-mm-action="ai-branch-apply">应用到原分支</button>`); return true;
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
