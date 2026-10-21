/* 画布共用的资料上传、引用删除检查与自然语言草稿生成。 */
(function () {
    const bridge = () => window.Pivot.moduleApi('agent.workflowBridge');
    const definition = () => window.Pivot.moduleApi('agent.dagDefinition');
    const escape = value => window.Pivot.legacy.PivotSafeHtml.escapeHtml(String(value ?? ''));
    async function uploadFile(control, hidden, label) {
        const requestId = globalThis.crypto.randomUUID(); control.dataset.uploadRequest = requestId;
        if (!control.files[0]) { hidden.value = ''; label.textContent = ''; return; }
        control.dataset.uploadPending = '1'; label.textContent = '正在上传并解析资料…';
        try {
            const file = await bridge().upload(control.files[0]);
            if (control.dataset.uploadRequest !== requestId || !control.isConnected) return;
            hidden.value = JSON.stringify(file); label.textContent = file.name; hidden.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (error) { if (control.dataset.uploadRequest === requestId) { label.textContent = error.message; hidden.value = ''; } }
        finally { if (control.dataset.uploadRequest === requestId) delete control.dataset.uploadPending; }
    }
    function bindUploads(root) {
        root.querySelectorAll('[data-workflow-upload]').forEach(control => control.addEventListener('change', async () => {
            const label = [...root.querySelectorAll('[data-workflow-upload-status]')].find(item => item.dataset.workflowUploadStatus === control.dataset.workflowUpload);
            const hidden = [...root.querySelectorAll('[data-dag-input-key]')].find(item => item.dataset.dagInputKey === control.dataset.workflowUpload);
            await uploadFile(control, hidden, label);
        }));
    }
    function confirmDelete(spec, nodeIds, perform) {
        const ids = new Set(nodeIds);
        const affected = spec.nodes.filter(node => !ids.has(node.id)).flatMap(node => definition().references({ input: node.input, when: node.when?.source ? `{{${node.when.source}}}` : '' }).filter(ref => ids.has(ref.nodeId)).map(ref => `${node.title || node.id}：${ref.path}`));
        if (!affected.length) { perform(); return; }
        window.Pivot.legacy.showConfirm('删除步骤会影响下游数据', `${affected.slice(0, 8).join('；')}。删除后这些参数会标为待修正，未完成草稿仍可保存。`, perform);
    }
    function ensurePanel() {
        let overlay = document.getElementById('workflow-authoring-modal-overlay');
        let panel = document.getElementById('workflow-authoring-panel');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'workflow-authoring-modal-overlay';
            overlay.className = 'modal-overlay hidden workflow-authoring-modal-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'workflow-authoring-modal-title');

            panel = document.createElement('section');
            panel.id = 'workflow-authoring-panel';
            panel.className = 'modal workflow-authoring-modal workflow-product-panel';
            overlay.appendChild(panel);

            overlay.addEventListener('click', event => {
                if (event.target === overlay) {
                    overlay.classList.add('hidden');
                    overlay.hidden = true;
                    panel.hidden = true;
                }
            });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !overlay.hidden) {
                    overlay.classList.add('hidden');
                    overlay.hidden = true;
                    panel.hidden = true;
                }
            });
            const observer = new window.MutationObserver(() => {
                if (panel.hidden) {
                    overlay.classList.add('hidden');
                    overlay.hidden = true;
                }
            });
            observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
            document.body.appendChild(overlay);
        } else if (!panel) {
            panel = document.createElement('section');
            panel.id = 'workflow-authoring-panel';
            panel.className = 'modal workflow-authoring-modal workflow-product-panel';
            overlay.appendChild(panel);
        }
        overlay.classList.remove('hidden');
        overlay.hidden = false;
        panel.hidden = false;
        return panel;
    }
    async function describe(target = ensurePanel()) {
        const models = bridge().models();
        const isNew = Boolean(target.closest('#workflow-product-start'));
        const isModal = target.classList.contains('workflow-authoring-modal');
        if (isModal) {
            PivotSafeHtml.setHtml(target, `
                <div class="workflow-authoring-head">
                    <div class="workflow-authoring-title-wrap">
                        <h3 id="workflow-authoring-modal-title">用自然语言生成或修改草稿</h3>
                        <p class="workflow-authoring-subtitle">将调用所选模型并消耗用量。结果先展示变更计划，应用后可以撤销，不会运行或发布。</p>
                    </div>
                </div>
                <div class="workflow-authoring-body">
                    <label class="workflow-product-field">
                        <span>文本模型</span>
                        <select class="form-input workflow-authoring-select" data-author-model>${models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}</option>`).join('')}</select>
                    </label>
                    <label class="workflow-product-field">
                        <span>目标或修改要求</span>
                        <textarea class="form-input" rows="4" data-author-prompt placeholder="例如：根据订单记录生成异常分析报告"></textarea>
                    </label>
                    <div class="workflow-product-row">
                        <button type="button" class="btn-primary" data-author-propose ${models.length ? '' : 'disabled'}>生成变更计划</button>
                    </div>
                    <div data-author-plan role="status"></div>
                </div>
                <div class="workflow-authoring-footer">
                    <button type="button" class="btn-secondary" data-author-close>取消</button>
                </div>
            `);
            target.querySelectorAll('[data-author-close]').forEach(btn => btn.addEventListener('click', () => { target.hidden = true; }));
        } else {
            PivotSafeHtml.setHtml(target, `<h3>用自然语言生成或修改草稿</h3><p>将调用所选模型并消耗用量。结果先展示变更计划，应用后可以撤销，不会运行或发布。</p><label class="workflow-product-field">文本模型<select class="form-input" data-author-model>${models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}</option>`).join('')}</select></label><label class="workflow-product-field">目标或修改要求<textarea class="form-input" rows="4" data-author-prompt placeholder="例如：根据订单记录生成异常分析报告"></textarea></label><button type="button" class="btn-primary" data-author-propose ${models.length ? '' : 'disabled'}>生成变更计划</button><div data-author-plan role="status"></div>`);
        }
        target.querySelector('[data-author-propose]').addEventListener('click', async event => {
            event.target.disabled = true;
            const output = target.querySelector('[data-author-plan]'); output.textContent = '正在生成草稿，当前内容不会被覆盖…';
            try {
                const current = isNew ? { nodes: [] } : bridge().spec();
                const editorIdentity = bridge().editor();
                const response = await bridge().request('/agents/workflow-editor/propose', { method: 'POST', body: JSON.stringify({ prompt: target.querySelector('[data-author-prompt]').value, modelId: target.querySelector('[data-author-model]').value, spec: current }) });
                const proposal = await response.json();
                if (!response.ok) throw new Error(proposal.error || '无法生成，请使用模板或手工编排。');
                PivotSafeHtml.setHtml(output, `<p>${escape(proposal.plan)}</p>${(proposal.issues || []).map(issue => `<p>${escape(issue)}</p>`).join('')}<details><summary>查看变更范围</summary><pre>${escape(JSON.stringify({ before: current, proposed: proposal.spec }, null, 2))}</pre></details><button type="button" class="btn-secondary" data-author-apply>应用为可撤销草稿</button>`);
                output.querySelector('[data-author-apply]').addEventListener('click', () => {
                    if (!isNew && editorIdentity !== bridge().editor()) { output.textContent = '当前编辑流程已切换，请在目标流程重新生成方案。'; return; }
                    if (isNew || !bridge().editor()) bridge().newWorkflow({ name: proposal.name, description: proposal.description });
                    bridge().editor().applySpec(proposal.spec);
                    window.Pivot.moduleApi('agent.workflowDrafts').changed(); target.hidden = true;
                });
            } catch (error) { output.textContent = error.message; }
            finally { event.target.disabled = false; }
        });
    }
    window.Pivot.registerModule('agent.workflowAuthoring', { describe, confirmDelete, bindUploads, uploadFile });
})();
