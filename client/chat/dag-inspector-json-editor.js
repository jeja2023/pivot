/* global PivotSafeHtml */
/* DAG 检查器高级 JSON 参数弹窗编辑器 */
(function () {
    function openNodeJsonEditor(nodeId, { ctx, currentTools, resolveToolForNode, friendlyToolTitle, renderToolSchemaHint, showDagToast, dagEscapeHtml, dagEscapeAttr } = {}) {
        const node = ctx?.spec?.nodes?.find?.(n => n.id === nodeId);
        if (!node) return;
        const tools = typeof currentTools === 'function' ? currentTools() : (currentTools || []);
        const resolveTool = typeof resolveToolForNode === 'function' ? resolveToolForNode : (t, val) => t.find(item => item.name === val);
        const tool = resolveTool(tools, node.tool);
        let modal = document.getElementById('pivot-dag-json-input-editor');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pivot-dag-json-input-editor';
            modal.className = 'modal-overlay hidden pivot-dag-json-input-overlay';
            document.body.appendChild(modal);
        }
        const getVarOptions = ctx?.getAvailableVariableOptions;
        const variableGroups = typeof getVarOptions === 'function'
            ? getVarOptions(ctx.spec?.nodes || [], node.id, tools)
            : [];
        const safeHtml = (typeof PivotSafeHtml !== 'undefined' && PivotSafeHtml) || window.Pivot?.safeHtml;
        const escHtml = dagEscapeHtml || (s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        const escAttr = dagEscapeAttr || (s => escHtml(s).replace(/"/g, '&quot;'));
        const getTitle = friendlyToolTitle || (t => t?.title || t?.name || '');
        const getSchemaHint = renderToolSchemaHint || (() => '');

        safeHtml.setHtml(modal, `
            <div class="modal rag-detail-modal pivot-dag-json-input-editor">
                <div class="rag-detail-header pivot-dag-input-head">
                    <div>
                        <h3>编辑高级参数</h3>
                        <p class="model-modal-desc">${escHtml([getTitle(tool), node.title || node.id].filter(Boolean).join(' · '))}</p>
                    </div>
                    <button type="button" class="btn-danger-outline" data-pivot-dag-json-close="1">关闭</button>
                </div>
                <div class="pivot-dag-json-input-body">
                    <div class="pivot-dag-json-main">
                        <textarea class="form-input" data-pivot-dag-json-input spellcheck="false">${escHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
                        <div class="pivot-dag-json-error" data-pivot-dag-json-error></div>
                    </div>
                    <aside class="pivot-dag-json-side">
                        <div class="pivot-dag-json-side-section">
                            <strong>参数字段</strong>
                            ${getSchemaHint(tool)}
                        </div>
                        <div class="pivot-dag-json-side-section">
                            <strong>插入上游变量与全局输入</strong>
                            <div class="pivot-dag-token-groups">
                                ${variableGroups.map(grp => `
                                    <div class="pivot-dag-token-group">
                                        <span class="pivot-dag-token-group-title">${escHtml(grp.group)}</span>
                                        <div class="pivot-dag-token-list">
                                            ${grp.items.map(item => `
                                                <button type="button" class="btn-secondary pivot-dag-token-btn" data-pivot-dag-json-token="${escAttr(item.expression)}" title="${escAttr(item.description || item.expression)}">
                                                    ${escHtml(item.label)}
                                                </button>
                                            `).join('')}
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </aside>
                </div>
                <div class="agent-workflow-create-actions pivot-dag-json-actions">
                    <button type="button" class="btn-secondary" data-pivot-dag-json-format="1">格式化</button>
                    <button type="button" class="btn-primary" data-pivot-dag-json-apply="1">应用</button>
                </div>
            </div>
        `);
        const textareaEl = modal.querySelector('[data-pivot-dag-json-input]');
        const errorEl = modal.querySelector('[data-pivot-dag-json-error]');
        const setError = message => {
            if (!errorEl) return;
            errorEl.textContent = message || '';
        };
        const closeJson = () => modal.classList.add('hidden');
        const parseInput = () => {
            try {
                const parsed = JSON.parse(textareaEl.value || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('高级参数必须是对象。');
                setError('');
                textareaEl.classList.remove('is-invalid');
                return parsed;
            } catch (e) {
                textareaEl.classList.add('is-invalid');
                setError(e.message || '高级参数格式不正确。');
                return null;
            }
        };
        const applyJson = () => {
            const parsed = parseInput();
            if (!parsed) return;
            ctx?.recordHistory?.();
            node.input = parsed;
            ctx?.render?.();
            ctx?.flushOut?.();
            closeJson();
            showDagToast?.('高级参数已更新', 'success');
        };
        const insertToken = token => {
            if (!token || !textareaEl) return;
            const start = textareaEl.selectionStart ?? textareaEl.value.length;
            const end = textareaEl.selectionEnd ?? textareaEl.value.length;
            const before = textareaEl.value.slice(0, start);
            const quoteCount = (before.match(/(?<!\\)"/g) || []).length;
            const insertText = quoteCount % 2 === 1 ? token : JSON.stringify(token);
            textareaEl.value = `${before}${insertText}${textareaEl.value.slice(end)}`;
            textareaEl.selectionStart = start + insertText.length;
            textareaEl.selectionEnd = start + insertText.length;
            textareaEl.focus();
        };
        modal.querySelector('[data-pivot-dag-json-close]')?.addEventListener('click', closeJson);
        modal.querySelector('[data-pivot-dag-json-apply]')?.addEventListener('click', applyJson);
        modal.querySelector('[data-pivot-dag-json-format]')?.addEventListener('click', () => {
            const parsed = parseInput();
            if (parsed) textareaEl.value = JSON.stringify(parsed, null, 2);
        });
        modal.querySelectorAll('[data-pivot-dag-json-token]').forEach(btn => {
            btn.addEventListener('click', () => insertToken(btn.dataset.pivotDagJsonToken || ''));
        });
        modal.classList.remove('hidden');
        requestAnimationFrame(() => textareaEl?.focus?.({ preventScroll: true }));
    }

    if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
        window.Pivot.registerModule('agent.dagInspectorJsonEditor', {
            openNodeJsonEditor
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { openNodeJsonEditor };
    }
})();
