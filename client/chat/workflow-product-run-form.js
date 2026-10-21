/* 发布运行始终从服务端解析该账号的有效版本，不读取未发布草稿。 */
(function () {
    let requestSequence = 0;
    let lastInputs = null;
    const bridge = () => window.Pivot.moduleApi('agent.workflowBridge');
    const escape = value => window.Pivot.legacy.PivotSafeHtml.escapeAttr(String(value ?? ''));
    function definitions(spec) {
        const values = new Map();
        (spec.nodes || []).filter(node => node.tool === 'workflow.input').forEach(node => values.set(node.input.name, node.input));
        for (const ref of window.Pivot.moduleApi('agent.dagDefinition').references(spec.nodes)) {
            const match = /^(?:run\.)?inputs?\.([\w-]+)/.exec(ref.expression);
            if (match && !values.has(match[1])) values.set(match[1], { name: match[1], label: match[1], type: 'text' });
        }
        return [...values.values()];
    }
    function fields(spec) {
        return definitions(spec).map(field => {
            const attributes = `data-product-input="${escape(field.name)}" data-value-type="${escape(field.type || 'text')}"`;
            const value = typeof field.defaultValue === 'object' ? JSON.stringify(field.defaultValue, null, 2) : String(field.defaultValue ?? '');
            let control;
            if (field.type === 'file') control = `<input class="form-input" type="file" data-product-file="${escape(field.name)}"><input type="hidden" ${attributes}><span data-file-status="${escape(field.name)}"></span>`;
            else if (field.type === 'boolean') control = `<input type="checkbox" ${attributes} ${field.defaultValue === true ? 'checked' : ''}>`;
            else if (['array', 'object', 'text'].includes(field.type || 'text')) control = `<textarea class="form-input" rows="3" ${attributes} ${field.required ? 'required' : ''}>${escape(value)}</textarea>`;
            else control = `<input class="form-input" type="${field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}" ${attributes} value="${escape(value)}" ${field.required ? 'required' : ''}>`;
            return `<label class="workflow-product-field"><span>${escape(field.label || field.name)}${field.required ? ' · 必填' : ''}</span>${control}</label>`;
        }).join('');
    }
    function collect(root, spec) {
        if (root.querySelector('[data-upload-pending="1"]')) throw new Error('资料仍在上传，请完成后再运行。');
        const values = {};
        const defs = definitions(spec);
        root.querySelectorAll('[data-product-input]').forEach(control => {
            const name = control.dataset.productInput;
            const type = control.dataset.valueType;
            let value = type === 'boolean' ? control.checked : control.value;
            if (value === '' && defs.find(field => field.name === name)?.required) throw new Error(`请填写“${defs.find(field => field.name === name)?.label || name}”。`);
            if (value !== '' && ['object', 'array', 'file'].includes(type)) {
                try { value = JSON.parse(value); } catch (_) { throw new Error(`“${name}”需要有效的${type === 'array' ? '记录列表' : '对象'}。`); }
                if (type === 'array' ? !Array.isArray(value) : (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`“${name}”的数据类型不匹配。`);
            }
            if (type === 'number' && value !== '') { value = Number(value); if (!Number.isFinite(value)) throw new Error(`“${name}”必须为有效数字。`); }
            if (value !== '') values[name] = value;
        });
        return values;
    }
    async function open(workflow) {
        if (!workflow) return;
        const experience = window.Pivot.moduleApi('agent.workflowExperience');
        experience.mount();
        if (document.getElementById('automation-editor-view')?.classList.contains('hidden') || String(bridge().current()?.id) !== String(workflow.id)) bridge().openEditor(workflow.id, { readOnly: !workflow.can_edit });
        const sequence = ++requestSequence;
        const panel = document.getElementById('workflow-product-run-form');
        panel.hidden = true;
        experience.status('正在读取发布版本和运行依赖…');
        let data;
        try {
            const response = await bridge().request(`/agents/workflows/${workflow.id}/run-context`);
            data = await response.json();
            if (sequence !== requestSequence) return;
            if (!response.ok) throw new Error(data.error || '无法读取发布版本。');
        } catch (error) { if (sequence === requestSequence) experience.status(error.message, 'error'); return; }
        const canReuse = () => lastInputs && lastInputs.userId === bridge().userId() && lastInputs.versionId === data.versionId && Date.now() - lastInputs.createdAt < 900000;
        panel.hidden = false;
        document.getElementById('automation-editor-view').classList.add('workflow-product-run-mode');
        PivotSafeHtml.setHtml(panel, `<h3>${escape(workflow.name)} · 已发布 V${data.version}</h3><p>${escape(workflow.description || '填写参数并获取本次业务结果。')}</p><p>以下参数属于本次发布版本，草稿修改不会参与运行。</p>${workflow.can_edit ? '<button type="button" class="btn-secondary" data-edit-workflow>编辑编排</button>' : ''}
            ${data.binding?.blockers?.length ? `<p role="alert">${escape(data.binding.blockers.join('；'))}</p><button class="btn-secondary" type="button" data-config-deps>配置运行依赖</button>` : ''}
            <form data-product-form>${fields(data.dagSpec)}<p>按当前账号权限读取资料并执行已发布步骤；模型调用可能消耗用量，写入或发送仍遵守原审批规则。</p><p data-input-error role="alert"></p><div class="workflow-product-row"><button class="btn-primary" type="submit">运行发布版</button><button class="btn-secondary" type="button" data-previous ${canReuse() ? '' : 'disabled'}>使用上次参数</button><button class="btn-secondary" type="button" data-close-form>关闭</button></div></form>`);
        panel.querySelector('[data-config-deps]')?.addEventListener('click', () => bridge().openDependencies(workflow.id));
        window.Pivot.moduleApi('agent.workflowDataFields')?.enhance(panel, '[data-product-input]');
        panel.querySelector('[data-edit-workflow]')?.addEventListener('click', () => { panel.hidden = true; document.getElementById('automation-editor-view').classList.remove('workflow-product-run-mode'); });
        panel.querySelector('[data-close-form]').addEventListener('click', () => { panel.hidden = true; document.getElementById('automation-editor-view').classList.remove('workflow-product-run-mode'); });
        panel.querySelectorAll('[data-product-file]').forEach(control => control.addEventListener('change', async () => {
            const field = control.dataset.productFile; const hidden = [...panel.querySelectorAll('[data-product-input]')].find(input => input.dataset.productInput === field);
            const label = [...panel.querySelectorAll('[data-file-status]')].find(item => item.dataset.fileStatus === field);
            await window.Pivot.moduleApi('agent.workflowAuthoring').uploadFile(control, hidden, label);
        }));
        panel.querySelector('[data-previous]').addEventListener('click', event => {
            if (!canReuse()) { event.target.disabled = true; return; }
            panel.querySelectorAll('[data-product-input]').forEach(control => {
                const value = lastInputs.values[control.dataset.productInput];
                if (value === undefined) return;
                if (control.type === 'checkbox') control.checked = value;
                else control.value = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
                control.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
        panel.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            const button = event.target.querySelector('[type="submit"]');
            button.disabled = true;
            try {
                const values = collect(panel, data.dagSpec);
                if (!definitions(data.dagSpec).some(field => field.type === 'file' || field.sensitive) && !/password|token|secret|authorization|api.?key/i.test(JSON.stringify(Object.keys(values)))) lastInputs = { values, userId: bridge().userId(), versionId: data.versionId, createdAt: Date.now() };
                else lastInputs = null;
                panel.querySelector('[data-input-error]').textContent = '';
                await bridge().run('published', { workflow, runContext: data, dagInputs: values, inline: true });
            } catch (error) { panel.querySelector('[data-input-error]').textContent = error.message; }
            finally { button.disabled = false; }
        });
        panel.querySelector('input,textarea,button')?.focus();
        experience.status(`已载入发布版本 V${data.version} 的参数。`);
    }
    function close() { requestSequence += 1; }
    window.Pivot.registerModule('agent.workflowRunForm', { open, close, fields, collect, definitions });
})();
