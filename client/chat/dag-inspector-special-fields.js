/* DAG 检查器专用字段：受控资源选择器、变量标签转换与快捷字段定义。 */

function renderDagInspectorChannelBindingField({ fieldName = 'bindingId', label = '渠道绑定', value = '', bindings = [], escapeAttr, escapeHtml } = {}) {
    const safeAttr = typeof escapeAttr === 'function' ? escapeAttr : text => String(text || '');
    const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : text => String(text || '');
    const platforms = { wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };
    const active = (Array.isArray(bindings) ? bindings : []).filter(binding => {
        const platform = String(binding?.config?.platform || '').trim().toLowerCase();
        return binding?.status === 'active' && Object.hasOwn(platforms, platform);
    });
    const current = String(value || '').trim();
    const currentKnown = active.some(binding => String(binding.id) === current);
    const options = [
        `<option value="">${active.length ? '请选择受控渠道绑定' : '暂无可用渠道绑定'}</option>`,
        current && !currentKnown ? `<option value="${safeAttr(current)}">${safeHtml(`当前绑定（不可用）：${current}`)}</option>` : '',
        ...active.map(binding => {
            const platform = String(binding?.config?.platform || '').trim().toLowerCase();
            const text = `${platforms[platform]} · ${binding.channelKey || binding.id}`;
            return `<option value="${safeAttr(binding.id)}" ${String(binding.id) === current ? 'selected' : ''}>${safeHtml(text)}</option>`;
        })
    ].join('');
    return `<label class="pivot-dag-inline-field pivot-dag-inline-channel-binding"><span>${safeHtml(label)}</span><select class="form-input" data-pivot-dag-input-field="${safeAttr(fieldName)}" ${active.length || current ? '' : 'disabled aria-disabled="true"'}>${options}</select><small>平台由所选绑定自动确定；可在通知设置中新增或启用渠道。</small></label>`;
}

const DAG_INSPECTOR_QUICK_FIELD_GROUPS = {
    'workflow.input': ['name', 'label', 'defaultValue'],
    'agent.llm': ['model', 'prompt'],
    'agent.http': ['method', 'url'],
    'workflow.condition': ['value', 'operator', 'compareTo'],
    'agent.merge': ['fields'],
    'workflow.template': ['template', 'trim', 'missingVariable'],
    'workflow.notify': ['bindingId', 'subject', 'body', 'format']
};

const DAG_INSPECTOR_QUICK_FIELD_LABELS = {
    name: '参数名', label: '展示名称', defaultValue: '默认值', model: '模型', prompt: '提示词',
    method: '请求方法', url: '请求地址', value: '判断值', operator: '判断方式', compareTo: '比较目标',
    fields: '字段映射', template: '模板内容', trim: '清除首尾空白', missingVariable: '缺失变量', bindingId: '渠道绑定', platform: '通知平台', subject: '通知标题', body: '通知正文', format: '消息格式'
};

function dagInspectorExprToTag(str, nodes = []) {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
        const trimmed = expr.trim();
        if (/^(?:inputs|input)\.([A-Za-z0-9_-]+)$/.test(trimmed)) {
            const name = RegExp.$1;
            const inputNode = nodes.find(n => n.tool === 'workflow.input' && (n.input?.name === name || n.id === name));
            const label = inputNode?.input?.label || inputNode?.title || inputNode?.input?.name || name;
            return `⟦${label}⟧`;
        }
        if (/^(?:nodes|node)\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_-]+))?$/.test(trimmed)) {
            const nodeId = RegExp.$1;
            const field = RegExp.$2;
            const sourceNode = nodes.find(n => n.id === nodeId);
            const nodeLabel = sourceNode?.title || nodeId;
            if (!field) return `⟦${nodeLabel} → 输出⟧`;
            let fieldLabel = field;
            if (field === 'text') fieldLabel = '文本结果';
            else if (field === 'rows') fieldLabel = '业务记录';
            else if (field === 'count') fieldLabel = '数量';
            else if (sourceNode?.outputSchema?.properties?.[field]?.title) fieldLabel = sourceNode.outputSchema.properties[field].title;
            return `⟦${nodeLabel} → ${fieldLabel}⟧`;
        }
        if (/^(?:nodes|node)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.test(trimmed)) {
            const nodeId = RegExp.$1;
            const field = RegExp.$2;
            const sourceNode = nodes.find(n => n.id === nodeId);
            const nodeLabel = sourceNode?.title || nodeId;
            return `⟦${nodeLabel} → ${field}⟧`;
        }
        return match;
    });
}

function dagInspectorTagToExpr(str, nodes = []) {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/⟦\s*([^⟧]+?)\s*⟧/g, (match, token) => {
        const trimmed = token.trim();
        if (trimmed.includes('→')) {
            const [nodePart, fieldPart] = trimmed.split(/\s*→\s*/);
            const sourceNode = nodes.find(n => n.title === nodePart || n.id === nodePart);
            const nodeId = sourceNode?.id || nodePart;
            if (fieldPart === '输出') return `{{nodes.${nodeId}.output}}`;
            let field = fieldPart;
            if (fieldPart === '文本结果') field = 'text';
            else if (fieldPart === '业务记录') field = 'rows';
            else if (fieldPart === '数量') field = 'count';
            else if (sourceNode?.outputSchema?.properties) {
                const found = Object.entries(sourceNode.outputSchema.properties).find(([, v]) => v?.title === fieldPart);
                if (found) field = found[0];
            }
            return `{{nodes.${nodeId}.output.${field}}}`;
        }
        const inputNode = nodes.find(n => n.tool === 'workflow.input' && (n.input?.label === trimmed || n.title === trimmed || n.input?.name === trimmed || n.id === trimmed));
        if (inputNode) return `{{inputs.${inputNode.input?.name || inputNode.id}}}`;
        const otherNode = nodes.find(n => n.title === trimmed || n.id === trimmed);
        if (otherNode) return `{{nodes.${otherNode.id}.output.text}}`;
        return `{{inputs.${trimmed}}}`;
    });
}

function bindDagInspectorVariablePickerTriggers({ inspector, node, ctx, currentTools, showVariablePicker, cssEscape }) {
    if (!inspector || typeof showVariablePicker !== 'function') return;
    const safeEscape = typeof cssEscape === 'function' ? cssEscape : val => String(val || '');
    const triggerPicker = (button, field, isTagField = false) => {
        const targetInput = inspector.querySelector(`[data-pivot-dag-input-field="${safeEscape(field)}"]`);
        if (!targetInput) return;
        if (isTagField) {
            showVariablePicker({
                anchorEl: button,
                targetInput,
                nodeId: node.id,
                nodes: ctx.spec?.nodes || [],
                tools: typeof currentTools === 'function' ? currentTools() : [],
                expectedType: 'text',
                onSelect: expr => {
                    const tag = dagInspectorExprToTag(expr, ctx.spec?.nodes || []);
                    const pickerModule = window.Pivot?.moduleApi?.('agent.dagVariablePicker');
                    if (pickerModule?.insertTextIntoInput) {
                        pickerModule.insertTextIntoInput(targetInput, tag);
                    } else {
                        targetInput.value = (targetInput.value || '') + tag;
                        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            });
        } else {
            showVariablePicker({
                anchorEl: button,
                targetInput,
                nodeId: node.id,
                nodes: ctx.spec?.nodes || [],
                tools: typeof currentTools === 'function' ? currentTools() : []
            });
        }
    };
    inspector.querySelectorAll('[data-pivot-dag-source-pick]').forEach(button => {
        button.addEventListener('click', event => {
            triggerPicker(event.currentTarget, event.currentTarget.dataset.pivotDagSourcePick, true);
        });
    });
    inspector.querySelectorAll('[data-pivot-dag-inline-pick-var]').forEach(button => {
        button.addEventListener('click', event => {
            const field = event.currentTarget.dataset.pivotDagInlinePickVar;
            triggerPicker(event.currentTarget, field, field === 'prompt' || field === 'template');
        });
    });
}
