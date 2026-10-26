(function () {
    'use strict';
    const schema = window.Pivot.moduleApi('mindmaps.document');
    const $ = id => document.getElementById(id);

    function create(context) {
        const { state, dialog, closeDialog, escape, request, json, create: createDoc, save } = context;

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

        function showNewDialog(onAction) {
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
                    void onAction('create-confirm');
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
                        void onAction('create-confirm');
                    }
                });
            }
        }

        async function createConfirm() {
            const templateValue = $('mindmap-template')?.value || 'blank';
            const titleValue = $('mindmap-new-title')?.value.trim() || '中心主题';
            if (templateValue.startsWith('personal:')) {
                const result = await request(`/personal-templates/${encodeURIComponent(templateValue.slice(9))}`);
                result.document.tree.text = titleValue;
                await createDoc(result.document);
                closeDialog();
                return;
            }
            const template = await request('/templates', json({ template: templateValue, title: titleValue }));
            await createDoc(template.document);
            closeDialog();
        }

        function showAiDialog(onAction) {
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
                        void onAction('ai-generate');
                    }
                });
            }
        }

        async function generateAi() {
            const button = $('mindmap-dialog-body').querySelector('[data-mm-action="ai-generate"]');
            if (button) button.disabled = true;
            if ($('mindmap-ai-status')) $('mindmap-ai-status').textContent = '正在分析材料并生成结构化导图…';
            const sequence = state.dialogSequence;
            state.aiController = new AbortController();
            try {
                const result = await request('/ai', { ...json({ prompt: $('mindmap-ai-prompt').value, model: $('mindmap-ai-model').value }), signal: state.aiController.signal });
                if (sequence !== state.dialogSequence) return;
                const generated = result.document;
                if (!generated) throw new Error('未收到有效导图，请重试。');
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
            } finally {
                if (button && button.isConnected) button.disabled = false;
            }
        }

        async function saveAi() {
            if (state.aiGenerated) {
                await createDoc(state.aiGenerated);
                state.aiGenerated = null;
                closeDialog();
            }
        }

        async function action(name) {
            if (name === 'versions') { await save(); await versionDialog(); return true; }
            if (name === 'new') { showNewDialog(action); return true; }
            if (name === 'create-confirm') { await createConfirm(); return true; }
            if (name === 'ai') { showAiDialog(action); return true; }
            if (name === 'ai-generate') { await generateAi(); return true; }
            if (name === 'ai-save') { await saveAi(); return true; }
            return false;
        }

        return { action, versionDialog, showNewDialog, createConfirm, showAiDialog, generateAi, saveAi };
    }

    window.Pivot.exposeModule('mindmaps.dialogs', { create });
})();
