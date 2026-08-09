/* DAG 检查器与 JSON 输入编辑器（拆自 agents-dag-editor.js） */



function createDagInspectorController(ctx) {
    const inspector = ctx.inspector;
    const onNodeSelectionChange = ctx.onNodeSelectionChange;
    const currentTools = () => typeof ctx.currentTools === 'function' ? (ctx.currentTools() || []) : [];
    const getDependencyCandidateNodes = (...args) => ctx.getDependencyCandidateNodes?.(...args) || [];
    const wouldCreateCycle = (...args) => Boolean(ctx.wouldCreateCycle?.(...args));
    const openNodeInputWizard = (...args) => ctx.openNodeInputWizard?.(...args);
    const renderInputSummary = (...args) => ctx.renderInputSummary?.(...args) || '';
    const testNode = async (node) => {
        const button = inspector.querySelector('[data-pivot-dag-test-node]');
        const result = inspector.querySelector('[data-pivot-dag-test-result]');
        if (!node?.tool || !button || !result) return;
        button.disabled = true;
        button.textContent = '测试中…';
        result.hidden = false;
        result.className = 'pivot-dag-test-result is-running';
        result.textContent = '正在执行当前节点…';
        try {
            const response = await apiFetch(`${API_BASE}/agents/tools/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tool: node.tool,
                    input: node.input || {},
                    dagInputs: window.collectAgentDagInputs?.() || {}
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '节点测试失败');
            result.className = 'pivot-dag-test-result is-success';
            result.textContent = `节点执行完成 · 耗时 ${data.durationMs || 0} 毫秒\n${JSON.stringify(data.output, null, 2)}`;
        } catch (error) {
            result.className = 'pivot-dag-test-result is-error';
            result.textContent = error.message || '节点测试失败';
        } finally {
            button.disabled = false;
            button.textContent = '测试节点';
        }
    };
    const schemaSummary = (schema = {}) => {
        const value = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
        const typeLabels = { object: '对象', array: '列表', string: '文本', number: '数值', integer: '整数', boolean: '布尔值' };
        const types = Array.isArray(value.type) ? value.type : (value.type ? [value.type] : []);
        const fieldCount = value.properties && typeof value.properties === 'object' ? Object.keys(value.properties).length : 0;
        const requiredCount = Array.isArray(value.required) ? value.required.length : 0;
        if (!Object.keys(value).length) return { configured: false, text: '未配置' };
        const label = types.map(type => typeLabels[type] || type).join(' / ') || '任意类型';
        return { configured: true, text: `${label}${fieldCount ? ` · ${fieldCount} 个字段` : ''}${requiredCount ? ` · ${requiredCount} 项必填` : ''}` };
    };
    const renderOutputPanel = (node) => {
        const toolName = String(node?.tool || '');
        const isLlm = toolName === 'agent.llm';
        const isWorkflowOutput = toolName === 'workflow.output';
        if (!isLlm && !isWorkflowOutput) return '';
        const input = node.input && typeof node.input === 'object' ? node.input : {};
        const format = isLlm
            ? (['markdown', 'text', 'json'].includes(String(input.responseFormat || input.response_format || 'markdown'))
                ? String(input.responseFormat || input.response_format || 'markdown')
                : 'markdown')
            : (['markdown', 'text', 'json'].includes(String(input.format || 'markdown'))
                ? String(input.format || 'markdown')
                : 'markdown');
        const options = isLlm
            ? [
                { value: 'markdown', label: '格式化文本', hint: '适合报告和说明' },
                { value: 'text', label: '纯文本', hint: '适合继续拼接' },
                { value: 'json', label: '结构化数据', hint: '适合字段引用' }
            ]
            : [
                { value: 'markdown', label: '格式化文本', hint: '适合报告和说明' },
                { value: 'text', label: '纯文本', hint: '适合继续拼接' },
                { value: 'json', label: '结构化数据', hint: '适合接口消费' }
            ];
        const presentation = isWorkflowOutput && ['default', 'table', 'file'].includes(String(input.presentation || 'default'))
            ? String(input.presentation || 'default')
            : 'default';
        const contract = schemaSummary(node.outputSchema || {});
        return `
            <section class="pivot-dag-output-panel">
                <div class="pivot-dag-output-panel-head">
                    <div>
                        <strong>输出模式</strong>
                        <span>${isLlm ? '选择下游节点最容易消费的形式' : '选择调用方接收最终结果的形式'}</span>
                    </div>
                    <span class="pivot-dag-output-current">${dagEscapeHtml(options.find(option => option.value === format)?.label || '格式化文本')}</span>
                </div>
                <div class="pivot-dag-output-modes" role="group" aria-label="输出模式">
                    ${options.map(option => `
                        <button type="button" class="pivot-dag-output-mode ${option.value === format ? 'is-active' : ''}" data-pivot-dag-output-format="${option.value}" aria-pressed="${option.value === format ? 'true' : 'false'}">
                            <strong>${option.label}</strong><span>${option.hint}</span>
                        </button>
                    `).join('')}
                </div>
                ${isWorkflowOutput ? `<div class="pivot-dag-output-presentation">
                    <div class="pivot-dag-output-contract"><div><span>增强交付</span><strong>${presentation === 'table' ? '表格' : presentation === 'file' ? '文件产物' : '默认结果'}</strong></div></div>
                    <div class="pivot-dag-output-presentation-modes" role="group" aria-label="增强交付">
                        ${[
                            { value: 'default', label: '默认结果', hint: '保留原始 JSON' },
                            { value: 'table', label: '表格', hint: '按行列展示' },
                            { value: 'file', label: '文件产物', hint: '保留文件引用' }
                        ].map(option => `<button type="button" class="pivot-dag-output-mode ${option.value === presentation ? 'is-active' : ''}" data-pivot-dag-output-presentation="${option.value}" aria-pressed="${option.value === presentation ? 'true' : 'false'}"><strong>${option.label}</strong><span>${option.hint}</span></button>`).join('')}
                    </div>
                    <div class="pivot-dag-output-presentation-note">${presentation === 'table' ? '上游值可为数组，或包含 rows / data / items 的对象。' : presentation === 'file' ? '上游值需包含文件 id、URL、路径或存储键。' : '可继续使用 markdown、纯文本或结构化数据格式。'}</div>
                </div>` : ''}
                ${isLlm ? `<div class="pivot-dag-output-contract ${format === 'json' ? 'is-json' : ''}">
                    <div>
                        <span>输出契约</span>
                        <strong>${format === 'json' ? dagEscapeHtml(contract.configured ? contract.text : '未设置（可选）') : '文本'}</strong>
                    </div>
                    ${format === 'json' ? '<button type="button" class="btn-secondary" data-pivot-dag-edit-contract-short="1">设置字段</button>' : ''}
                </div>` : ''}
            </section>
        `;
    };
    const effectiveInputSchema = (node, tool) => {
        const explicit = node?.inputSchema && typeof node.inputSchema === 'object' ? node.inputSchema : {};
        return Object.keys(explicit).length ? explicit : getToolSchema(tool);
    };
    const notifySelectionChange = (node) => {
        if (typeof onNodeSelectionChange !== 'function') return;
        if (ctx.readOnly) return onNodeSelectionChange(null);
        onNodeSelectionChange(node ? {
            id: node.id,
            title: node.title,
            tool: node.tool
        } : null);
    };

    const openNodeJsonEditor = (nodeId) => {
        const node = ctx.spec.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const tool = resolveToolForNode(currentTools(), node.tool);
        let modal = document.getElementById('pivot-dag-json-input-editor');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pivot-dag-json-input-editor';
            modal.className = 'modal-overlay hidden pivot-dag-json-input-overlay';
            document.body.appendChild(modal);
        }
        const variableTokens = [
            { label: '任务目标', token: '{{goal}}' },
            { label: '运行输入', token: '{{inputs}}' },
            ...(node.dependsOn || []).flatMap(dep => ([
                { label: `${dep} 输出`, token: `{{nodes.${dep}.output}}` },
                { label: `${dep} 结构化结果`, token: `{{nodes.${dep}.output.structuredContent}}` },
                { label: `${dep} 数据行`, token: `{{nodes.${dep}.output.rows}}` },
                { label: `${dep} 状态`, token: `{{nodes.${dep}.status}}` }
            ]))
        ];
        PivotSafeHtml.setHtml(modal, `
            <div class="modal rag-detail-modal pivot-dag-json-input-editor">
                <div class="rag-detail-header pivot-dag-input-head">
                    <div>
                        <h3>编辑高级参数</h3>
                        <p class="model-modal-desc">${dagEscapeHtml([friendlyToolTitle(tool), node.title || node.id].filter(Boolean).join(' · '))}</p>
                    </div>
                    <button type="button" class="btn-danger-outline" data-pivot-dag-json-close="1">关闭</button>
                </div>
                <div class="pivot-dag-json-input-body">
                    <div class="pivot-dag-json-main">
                        <textarea class="form-input" data-pivot-dag-json-input spellcheck="false">${dagEscapeHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
                        <div class="pivot-dag-json-error" data-pivot-dag-json-error></div>
                    </div>
                    <aside class="pivot-dag-json-side">
                        <div class="pivot-dag-json-side-section">
                            <strong>参数字段</strong>
                            ${renderToolSchemaHint(tool)}
                        </div>
                        <div class="pivot-dag-json-side-section">
                            <strong>插入变量</strong>
                            <div class="pivot-dag-token-list">
                                ${variableTokens.map(item => `<button type="button" class="pivot-dag-token-btn" data-pivot-dag-json-token="${dagEscapeAttr(item.token)}" title="${dagEscapeAttr(item.token)}">${dagEscapeHtml(item.label)}</button>`).join('')}
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
            ctx.recordHistory?.();
            node.input = parsed;
            ctx.render?.();
            ctx.flushOut?.();
            closeJson();
            window.showToast?.('高级参数已更新', 'success');
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
    };

    const openNodeContractEditor = (nodeId) => {
        const node = ctx.spec.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const tool = resolveToolForNode(currentTools(), node.tool);
        const schemaTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
        const cloneSchema = value => {
            try { return JSON.parse(JSON.stringify(value || {})); } catch (e) { return {}; }
        };
        const normalizeVisualSchema = value => {
            const schema = value && typeof value === 'object' && !Array.isArray(value) ? cloneSchema(value) : {};
            const type = schemaTypes.includes(schema.type) ? schema.type : 'object';
            if (type === 'object') {
                schema.type = 'object';
                schema.properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
                schema.required = Array.isArray(schema.required) ? schema.required.filter(key => Object.hasOwn(schema.properties, key)) : [];
                schema.additionalProperties = false;
            } else if (type === 'array') {
                schema.type = 'array';
                schema.items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? schema.items : { type: 'string' };
            } else {
                schema.type = type;
                delete schema.properties;
                delete schema.required;
                delete schema.additionalProperties;
            }
            return schema;
        };
        const sampleForSchema = schema => {
            const type = schema?.type;
            if (type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, child]) => [key, sampleForSchema(child)]));
            if (type === 'array') return [sampleForSchema(schema.items || { type: 'string' })];
            if (type === 'number' || type === 'integer') return 0;
            if (type === 'boolean') return false;
            return '示例文本';
        };
        const validateSample = (value, schema, path = '示例') => {
            const issues = [];
            const type = schema?.type;
            if (type === 'object') {
                if (!value || typeof value !== 'object' || Array.isArray(value)) issues.push(`${path} 应为对象`);
                (schema.required || []).forEach(key => {
                    if (!Object.hasOwn(value || {}, key)) issues.push(`${path}.${key} 缺少必填字段`);
                });
                Object.entries(schema.properties || {}).forEach(([key, child]) => {
                    if (Object.hasOwn(value || {}, key)) issues.push(...validateSample(value[key], child, `${path}.${key}`));
                });
            } else if (type === 'array') {
                if (!Array.isArray(value)) issues.push(`${path} 应为数组`);
                else value.slice(0, 10).forEach((item, index) => issues.push(...validateSample(item, schema.items || {}, `${path}[${index}]`)));
            } else if (type === 'number' && typeof value !== 'number') issues.push(`${path} 应为数值`);
            else if (type === 'integer' && (!Number.isInteger(value))) issues.push(`${path} 应为整数`);
            else if (type === 'boolean' && typeof value !== 'boolean') issues.push(`${path} 应为布尔值`);
            else if (type === 'string' && typeof value !== 'string') issues.push(`${path} 应为文本`);
            return issues;
        };
        let outputSchema = normalizeVisualSchema(node.outputSchema || {});
        let modal = document.getElementById('pivot-dag-contract-editor');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pivot-dag-contract-editor';
            modal.className = 'modal-overlay hidden pivot-dag-json-input-overlay';
            document.body.appendChild(modal);
        }
        PivotSafeHtml.setHtml(modal, `
            <div class="modal rag-detail-modal pivot-dag-contract-editor">
                <div class="rag-detail-header pivot-dag-input-head">
                    <div>
                        <h3>节点数据契约</h3>
                        <p class="model-modal-desc">${dagEscapeHtml(node.title || node.id)} · ${dagEscapeHtml(friendlyToolTitle(tool) || node.tool)}</p>
                    </div>
                    <button type="button" class="btn-danger-outline" data-pivot-contract-close="1">关闭</button>
                </div>
                <div class="pivot-dag-contract-editor-body">
                    <label>
                        <span><strong>输入契约</strong><em>留空时自动使用工具参数契约</em></span>
                        <textarea class="form-input" data-pivot-contract-input spellcheck="false">${dagEscapeHtml(JSON.stringify(node.inputSchema || {}, null, 2))}</textarea>
                    </label>
                    <div class="pivot-dag-schema-builder-wrap">
                        <div class="pivot-dag-schema-builder-head">
                            <span><strong>输出契约</strong><em>用字段和类型定义 JSON 输出，运行时会自动校验</em></span>
                            <button type="button" class="btn-secondary" data-pivot-schema-add-field="1">添加字段</button>
                        </div>
                        <div class="pivot-dag-schema-builder" data-pivot-schema-builder></div>
                        <div class="pivot-dag-schema-preview-head"><strong>输出预览</strong><span data-pivot-schema-validation></span></div>
                        <pre class="pivot-dag-schema-preview" data-pivot-schema-preview></pre>
                        <details class="pivot-dag-schema-raw">
                            <summary>高级 JSON Schema</summary>
                            <textarea class="form-input" data-pivot-contract-output spellcheck="false"></textarea>
                            <button type="button" class="btn-secondary" data-pivot-schema-import="1">从 JSON 同步</button>
                        </details>
                    </div>
                </div>
                <div class="pivot-dag-json-error" data-pivot-contract-error></div>
                <div class="agent-workflow-create-actions pivot-dag-json-actions">
                    <button type="button" class="btn-secondary" data-pivot-contract-sync="1">同步工具输入契约</button>
                    <button type="button" class="btn-secondary" data-pivot-contract-format="1">格式化</button>
                    <button type="button" class="btn-primary" data-pivot-contract-apply="1">应用契约</button>
                </div>
            </div>
        `);
        const inputEl = modal.querySelector('[data-pivot-contract-input]');
        const outputEl = modal.querySelector('[data-pivot-contract-output]');
        const errorEl = modal.querySelector('[data-pivot-contract-error]');
        const builderEl = modal.querySelector('[data-pivot-schema-builder]');
        const previewEl = modal.querySelector('[data-pivot-schema-preview]');
        const validationEl = modal.querySelector('[data-pivot-schema-validation]');
        const syncOutputRaw = () => { outputEl.value = JSON.stringify(outputSchema, null, 2); };
        const schemaNodeAtPath = path => (Array.isArray(path) ? path : []).reduce((current, part) => {
            if (!current || typeof current !== 'object') return {};
            if (part === '@items') return current.items && typeof current.items === 'object' ? current.items : {};
            return current.properties && current.properties[part] && typeof current.properties[part] === 'object'
                ? current.properties[part]
                : {};
        }, outputSchema);
        const parseSchemaPath = value => {
            try {
                const path = JSON.parse(value || '[]');
                return Array.isArray(path) ? path : [];
            } catch (e) {
                return [];
            }
        };
        const renderObjectFields = (schema, path = []) => {
            const props = schema.properties || {};
            return `<div class="pivot-dag-schema-fields ${path.length ? 'is-nested' : ''}">
                ${Object.entries(props).map(([name, child]) => {
                    const propertyPath = [...path, name];
                    const childObject = child?.type === 'object' || child?.properties;
                    const childArrayObject = child?.type === 'array' && child?.items?.type === 'object';
                    return `<div class="pivot-dag-schema-field-block">
                        <div class="pivot-dag-schema-field" data-pivot-schema-path="${dagEscapeAttr(JSON.stringify(propertyPath))}">
                            <input class="form-input" data-pivot-schema-name value="${dagEscapeAttr(name)}" placeholder="字段名">
                            <select class="form-input" data-pivot-schema-type>${schemaTypes.map(item => `<option value="${item}" ${item === child.type ? 'selected' : ''}>${item === 'object' ? '对象' : item === 'array' ? '列表' : item === 'string' ? '文本' : item === 'boolean' ? '布尔值' : item === 'integer' ? '整数' : '数值'}</option>`).join('')}</select>
                            <input class="form-input" data-pivot-schema-description value="${dagEscapeAttr(child.description || '')}" placeholder="字段说明">
                            <label class="pivot-dag-schema-required"><input type="checkbox" data-pivot-schema-required ${schema.required?.includes(name) ? 'checked' : ''}>必填</label>
                            <button type="button" class="btn-danger-outline" data-pivot-schema-remove="1" title="删除字段">删除</button>
                        </div>
                        ${childObject ? renderObjectFields(child, propertyPath) : ''}
                        ${childArrayObject ? renderObjectFields(child.items, [...propertyPath, '@items']) : ''}
                    </div>`;
                }).join('') || `<div class="pivot-dag-schema-empty">${path.length ? '还没有子字段。' : '还没有字段，点击“添加字段”开始定义输出。'}</div>`}
                ${path.length ? `<button type="button" class="btn-secondary pivot-dag-schema-add-nested" data-pivot-schema-add-nested="${dagEscapeAttr(JSON.stringify(path))}">添加子字段</button>` : ''}
            </div>`;
        };
        const renderSchemaBuilder = () => {
            const type = outputSchema.type;
            PivotSafeHtml.setHtml(builderEl, `
                <label class="pivot-dag-schema-root-type"><span>根类型</span>
                    <select data-pivot-schema-root-type>${schemaTypes.map(item => `<option value="${item}" ${item === type ? 'selected' : ''}>${item === 'object' ? '对象' : item === 'array' ? '列表' : item === 'string' ? '文本' : item === 'boolean' ? '布尔值' : item === 'integer' ? '整数' : '数值'}</option>`).join('')}</select>
                </label>
                ${type === 'object' ? renderObjectFields(outputSchema) : type === 'array' ? `<label class="pivot-dag-schema-item-type"><span>列表项类型</span><select data-pivot-schema-item-type>${schemaTypes.map(item => `<option value="${item}" ${item === outputSchema.items?.type ? 'selected' : ''}>${item}</option>`).join('')}</select></label>${outputSchema.items?.type === 'object' ? renderObjectFields(outputSchema.items, ['@items']) : ''}` : '<div class="pivot-dag-schema-empty">基础类型不需要额外字段。</div>'}
            `);
            syncOutputRaw();
            const sample = sampleForSchema(outputSchema);
            previewEl.textContent = JSON.stringify(sample, null, 2);
            const issues = validateSample(sample, outputSchema);
            validationEl.textContent = issues.length ? issues.join('；') : '示例校验通过';
            validationEl.className = issues.length ? 'is-error' : 'is-valid';
            builderEl.querySelector('[data-pivot-schema-root-type]')?.addEventListener('change', event => {
                outputSchema = normalizeVisualSchema({ type: event.target.value });
                renderSchemaBuilder();
            });
            builderEl.querySelector('[data-pivot-schema-item-type]')?.addEventListener('change', event => {
                outputSchema.items = { ...(outputSchema.items || {}), type: event.target.value };
                renderSchemaBuilder();
            });
            builderEl.querySelectorAll('[data-pivot-schema-path]').forEach(row => {
                const fieldPath = parseSchemaPath(row.dataset.pivotSchemaPath);
                const originalName = fieldPath[fieldPath.length - 1] || '';
                const parent = schemaNodeAtPath(fieldPath.slice(0, -1));
                row.querySelector('[data-pivot-schema-name]')?.addEventListener('change', event => {
                    const nextName = String(event.target.value || '').trim();
                    if (!nextName || nextName === originalName || Object.hasOwn(parent.properties || {}, nextName)) {
                        event.target.value = originalName;
                        return;
                    }
                    parent.properties[nextName] = parent.properties[originalName] || { type: 'string' };
                    delete parent.properties[originalName];
                    parent.required = (parent.required || []).map(key => key === originalName ? nextName : key);
                    renderSchemaBuilder();
                });
                row.querySelector('[data-pivot-schema-type]')?.addEventListener('change', event => {
                    const previous = parent.properties[originalName] || {};
                    const type = event.target.value;
                    parent.properties[originalName] = type === 'object'
                        ? { ...previous, type, properties: previous.properties || {}, required: previous.required || [], additionalProperties: false }
                        : type === 'array'
                            ? { ...previous, type, items: previous.items || { type: 'string' } }
                            : { ...previous, type };
                    renderSchemaBuilder();
                });
                row.querySelector('[data-pivot-schema-description]')?.addEventListener('change', event => {
                    const schema = parent.properties[originalName] || { type: 'string' };
                    schema.description = String(event.target.value || '').trim();
                    if (!schema.description) delete schema.description;
                    parent.properties[originalName] = schema;
                    syncOutputRaw();
                });
                row.querySelector('[data-pivot-schema-required]')?.addEventListener('change', event => {
                    const required = new Set(parent.required || []);
                    if (event.target.checked) required.add(originalName); else required.delete(originalName);
                    parent.required = [...required];
                    renderSchemaBuilder();
                });
                row.querySelector('[data-pivot-schema-remove]')?.addEventListener('click', () => {
                    delete parent.properties[originalName];
                    parent.required = (parent.required || []).filter(key => key !== originalName);
                    renderSchemaBuilder();
                });
            });
            builderEl.querySelectorAll('[data-pivot-schema-add-nested]').forEach(button => {
                button.addEventListener('click', () => {
                    const path = parseSchemaPath(button.dataset.pivotSchemaAddNested);
                    const parent = schemaNodeAtPath(path);
                    parent.type = 'object';
                    parent.properties = parent.properties || {};
                    parent.required = parent.required || [];
                    let name = 'field';
                    let index = 1;
                    while (Object.hasOwn(parent.properties, name)) name = `field_${index++}`;
                    parent.properties[name] = { type: 'string' };
                    renderSchemaBuilder();
                });
            });
        };
        const inputSchemaValue = () => {
            try {
                const value = JSON.parse(inputEl.value || '{}');
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入契约必须是结构化对象。');
                return value;
            } catch (e) {
                inputEl.classList.add('is-invalid');
                throw e;
            }
        };
        syncOutputRaw();
        renderSchemaBuilder();
        const parseSchemas = () => {
            try {
                const inputSchema = inputSchemaValue();
                if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) throw new Error('输出契约必须是结构化对象。');
                inputEl.classList.remove('is-invalid');
                outputEl.classList.remove('is-invalid');
                errorEl.textContent = '';
                return { inputSchema, outputSchema: cloneSchema(outputSchema) };
            } catch (e) {
                errorEl.textContent = e.message || '契约格式不正确。';
                return null;
            }
        };
        const close = () => modal.classList.add('hidden');
        modal.querySelector('[data-pivot-contract-close]')?.addEventListener('click', close);
        modal.querySelector('[data-pivot-contract-sync]')?.addEventListener('click', () => {
            inputEl.value = JSON.stringify(getToolSchema(tool), null, 2);
        });
        modal.querySelector('[data-pivot-schema-add-field]')?.addEventListener('click', () => {
            if (outputSchema.type !== 'object') outputSchema = normalizeVisualSchema({ type: 'object' });
            const base = 'field';
            let name = base;
            let index = 1;
            while (Object.hasOwn(outputSchema.properties, name)) name = `${base}_${index++}`;
            outputSchema.properties[name] = { type: 'string', description: '' };
            renderSchemaBuilder();
            builderEl.querySelector('[data-pivot-schema-name]')?.focus();
        });
        modal.querySelector('[data-pivot-schema-import]')?.addEventListener('click', () => {
            try {
                outputSchema = normalizeVisualSchema(JSON.parse(outputEl.value || '{}'));
                renderSchemaBuilder();
                errorEl.textContent = '';
            } catch (e) {
                errorEl.textContent = e.message || 'JSON Schema 格式不正确。';
            }
        });
        modal.querySelector('[data-pivot-contract-format]')?.addEventListener('click', () => {
            const schemas = parseSchemas();
            if (!schemas) return;
            inputEl.value = JSON.stringify(schemas.inputSchema, null, 2);
            outputEl.value = JSON.stringify(schemas.outputSchema, null, 2);
        });
        modal.querySelector('[data-pivot-contract-apply]')?.addEventListener('click', () => {
            const schemas = parseSchemas();
            if (!schemas) return;
            ctx.recordHistory?.();
            node.inputSchema = schemas.inputSchema;
            node.outputSchema = schemas.outputSchema;
            ctx.render?.();
            ctx.flushOut?.();
            close();
            window.showToast?.('节点契约已更新', 'success');
        });
        modal.classList.remove('hidden');
        requestAnimationFrame(() => inputEl?.focus?.({ preventScroll: true }));
    };

    // ── when 条件规则（Dify 风格条件分支）─────────────────
    const WHEN_OPERATORS = [
        { value: 'equals', label: '等于' },
        { value: 'not_equals', label: '不等于' },
        { value: 'contains', label: '包含' },
        { value: 'not_contains', label: '不包含' },
        { value: 'starts_with', label: '开头是' },
        { value: 'ends_with', label: '结尾是' },
        { value: 'greater_than', label: '大于' },
        { value: 'greater_or_equal', label: '大于等于' },
        { value: 'less_than', label: '小于' },
        { value: 'less_or_equal', label: '小于等于' },
        { value: 'empty', label: '为空' },
        { value: 'not_empty', label: '不为空' },
        { value: 'exists', label: '存在' },
        { value: 'not_exists', label: '不存在' },
        { value: 'is_true', label: '为真' },
        { value: 'is_false', label: '为假' }
    ];
    // 这些操作符只看变量本身，不需要比较值。
    const WHEN_UNARY_OPERATORS = ['empty', 'not_empty', 'exists', 'not_exists', 'is_true', 'is_false'];

    const renderWhenPanel = (node) => {
        const when = node.when && typeof node.when === 'object' ? node.when : null;
        const enabled = Boolean(when && String(when.source || '').trim());
        const operator = String(when?.operator || 'equals');
        const needsValue = !WHEN_UNARY_OPERATORS.includes(operator);
        // 变量候选：上游节点输出 + 工作流目标/输入
        const suggestions = [
            { label: '任务目标', value: 'goal' },
            { label: '运行输入', value: 'inputs' },
            ...(node.dependsOn || []).flatMap(dep => ([
                { label: `${dep} 输出`, value: `nodes.${dep}.output` },
                { label: `${dep} 状态`, value: `nodes.${dep}.status` }
            ]))
        ];
        return `
            <div class="pivot-dag-when-panel ${enabled ? 'is-active' : ''}">
                <div class="pivot-dag-when-head">
                    <label class="pivot-dag-when-toggle">
                        <input type="checkbox" data-pivot-dag-when-enabled ${enabled ? 'checked' : ''}>
                        <strong>条件分支</strong>
                    </label>
                    <span>只有条件成立时才执行本节点，否则自动跳过</span>
                </div>
                ${enabled ? `
                <div class="pivot-dag-when-body">
                    <label class="pivot-dag-when-source">
                        <span>变量</span>
                        <input type="text" data-pivot-dag-when="source" value="${dagEscapeAttr(when.source || '')}"
                               placeholder="例如 nodes.search.output.rows" list="pivot-dag-when-vars">
                        <datalist id="pivot-dag-when-vars">
                            ${suggestions.map(s => `<option value="${dagEscapeAttr(s.value)}">${dagEscapeHtml(s.label)}</option>`).join('')}
                        </datalist>
                    </label>
                    <label class="pivot-dag-when-operator">
                        <span>判断</span>
                        <select data-pivot-dag-when="operator">
                            ${WHEN_OPERATORS.map(op => `<option value="${op.value}" ${operator === op.value ? 'selected' : ''}>${dagEscapeHtml(op.label)}</option>`).join('')}
                        </select>
                    </label>
                    ${needsValue ? `
                    <label class="pivot-dag-when-value">
                        <span>值</span>
                        <input type="text" data-pivot-dag-when="value" value="${dagEscapeAttr(String(when.value ?? ''))}" placeholder="比较值">
                    </label>` : ''}
                </div>
                <div class="pivot-dag-when-hint">
                    ${suggestions.length > 2
                        ? `可用变量：${suggestions.slice(2, 6).map(s => `<code>${dagEscapeHtml(s.value)}</code>`).join('、')}`
                        : '连接上游节点后可引用其输出作为判断变量'}
                </div>` : ''}
            </div>
        `;
    };

    const bindWhenPanelEvents = (node) => {
        inspector.querySelector('[data-pivot-dag-when-enabled]')?.addEventListener('change', (e) => {
            ctx.recordHistory?.();
            if (e.target.checked) {
                const firstDep = (node.dependsOn || [])[0];
                node.when = {
                    source: firstDep ? `nodes.${firstDep}.status` : 'goal',
                    operator: 'equals',
                    value: firstDep ? 'completed' : ''
                };
            } else {
                node.when = null;
            }
            ctx.render?.();
            ctx.flushOut?.();
        });
        inspector.querySelectorAll('[data-pivot-dag-when]').forEach(field => {
            const commit = (target) => {
                const key = target.dataset.pivotDagWhen;
                if (!key) return;
                ctx.recordHistory?.();
                node.when = node.when && typeof node.when === 'object' ? node.when : { source: '', operator: 'equals', value: '' };
                node.when[key] = target.value;
                ctx.flushOut?.();
                // operator 变化会影响"值"输入框的显隐，需要整体重绘
                if (key === 'operator') ctx.render?.();
            };
            field.addEventListener('change', (e) => commit(e.target));
            if (field.tagName === 'INPUT') {
                field.addEventListener('input', (e) => commit(e.target));
            }
        });
    };

    const renderInspector = () => {
        if (!inspector) return;
        inspector.classList.toggle('is-readonly', ctx.readOnly === true);
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        const active = document.activeElement;
        const focusSnapshot = active && inspector.contains(active) ? {
            field: active.dataset?.pivotDagField || '',
            depend: active.dataset?.pivotDagDepend || '',
            start: null,
            end: null
        } : null;
        if (focusSnapshot) {
            try {
                focusSnapshot.start = active.selectionStart;
                focusSnapshot.end = active.selectionEnd;
            } catch (e) {
                // 部分输入类型不支持文本选区。
            }
        }
        if (!node) {
            PivotSafeHtml.setHtml(inspector, '<div class="pivot-dag-inspector-empty">选中节点后可在此编辑标题、工具与输入。</div>');
            notifySelectionChange(null);
            return;
        }
        notifySelectionChange(node);
        const tools = currentTools();
        const selectedTool = resolveToolForNode(tools, node.tool);
        const inputContract = schemaSummary(effectiveInputSchema(node, selectedTool));
        const outputContract = schemaSummary(node.outputSchema || {});
        const upstreamNodes = getDependencyCandidateNodes(node);
        const dependsChecks = upstreamNodes.map(upstreamNode => `
            <label class="pivot-dag-depends-item">
                <input type="checkbox" data-pivot-dag-depend="${dagEscapeAttr(upstreamNode.id)}" ${node.dependsOn.includes(upstreamNode.id) ? 'checked' : ''}>
                <span>
                    <strong>${dagEscapeHtml(upstreamNode.title || upstreamNode.id)}</strong>
                    <em>${dagEscapeHtml(upstreamNode.id)}</em>
                </span>
            </label>
        `).join('') || '<span class="pivot-dag-inspector-empty">这是起始节点，没有可选上游节点。</span>';
        const toolOptions = renderToolOptions(tools, node.tool);
        PivotSafeHtml.setHtml(inspector, `
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-main">
                <label class="pivot-dag-node-id-field">
                    <span>节点 ID</span>
                    <input type="text" data-pivot-dag-node-id-display value="${dagEscapeHtml(node.id)}" readonly aria-readonly="true" title="系统自动生成，用于依赖和变量引用，默认不可修改">
                    <small>系统自动生成，用于依赖和变量引用</small>
                </label>
                <label><span>标题</span><input type="text" data-pivot-dag-field="title" value="${dagEscapeHtml(node.title)}" maxlength="120"></label>
            </div>
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-tool">
                <label class="pivot-dag-tool-field"><span>工具</span>
                    <select data-pivot-dag-field="tool">${toolOptions}</select>
                </label>
                <label><span>条件</span>
                    <select data-pivot-dag-field="condition">
                        <option value="success" ${node.condition === 'success' ? 'selected' : ''}>上游成功后执行</option>
                        <option value="failure" ${node.condition === 'failure' ? 'selected' : ''}>上游失败后执行</option>
                        <option value="always" ${node.condition === 'always' ? 'selected' : ''}>始终执行</option>
                    </select>
                </label>
            </div>
            ${renderWhenPanel(node)}
            ${renderSelectedToolMeta(selectedTool)}
            ${renderOutputPanel(node)}
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-runtime">
                <label><span>失败策略</span>
                    <select data-pivot-dag-field="onError">
                        <option value="skip_dependents" ${node.onError === 'skip_dependents' ? 'selected' : ''}>失败后跳过下游</option>
                        <option value="continue" ${node.onError === 'continue' ? 'selected' : ''}>失败后继续下游</option>
                        <option value="stop" ${node.onError === 'stop' ? 'selected' : ''}>失败后停止工作流</option>
                    </select>
                </label>
                <label><span>重试次数</span><input type="number" min="0" max="5" data-pivot-dag-field="retryLimit" value="${Number(node.retryLimit || 0)}" placeholder="0" title="失败后自动重试次数，0 表示不重试，最多 5 次"></label>
                <label><span>调用超时（毫秒）</span><input type="number" min="0" max="600000" step="1000" data-pivot-dag-field="timeoutMs" value="${Number(node.timeoutMs || 0)}" placeholder="默认" title="节点工具调用超时毫秒数，0 表示使用智能体全局超时设置"></label>
            </div>
            <details class="pivot-dag-contract-panel">
                <summary class="pivot-dag-contract-panel-head">
                    <strong>高级：数据契约</strong>
                    <span>输入 / 输出运行时校验</span>
                </summary>
                <button type="button" class="btn-secondary" data-pivot-dag-edit-contract="1">编辑契约</button>
                <div class="pivot-dag-contract-grid">
                    <div class="pivot-dag-contract-card ${inputContract.configured ? 'is-ready' : 'is-warning'}">
                        <span>输入</span>
                        <strong>${dagEscapeHtml(inputContract.text)}</strong>
                        <em>${Object.keys(node.inputSchema || {}).length ? '节点覆盖' : '继承工具'}</em>
                    </div>
                    <div class="pivot-dag-contract-card ${outputContract.configured ? 'is-ready' : 'is-warning'}">
                        <span>输出</span>
                        <strong>${dagEscapeHtml(outputContract.text)}</strong>
                        <em>${outputContract.configured ? '运行时校验' : '待补充'}</em>
                    </div>
                </div>
                <div class="pivot-dag-contract-presets">
                    <span>输出类型</span>
                    <button type="button" data-pivot-contract-preset="string">文本</button>
                    <button type="button" data-pivot-contract-preset="object">对象</button>
                    <button type="button" data-pivot-contract-preset="array">列表</button>
                    <button type="button" data-pivot-contract-preset="clear">清除</button>
                </div>
            </details>
            <div class="pivot-dag-inspector-depends">
                <div class="pivot-dag-inspector-depends-head">
                    <strong>上游节点</strong>
                    <span>本节点会等待这些前置节点完成，并可引用其输出</span>
                </div>
                <div class="pivot-dag-inspector-depends-list">${dependsChecks}</div>
            </div>
            <div class="pivot-dag-input-overview">
                <div class="pivot-dag-input-overview-head">
                    <div>
                        <strong>参数输入</strong>
                        <span>侧栏只显示摘要，点击按钮进入弹窗编辑。</span>
                    </div>
                </div>
                <div class="pivot-dag-input-overview-summary">${renderInputSummary(node.input, selectedTool, tools)}</div>
                <div class="pivot-dag-input-overview-actions">
                    <button type="button" class="btn-primary" data-pivot-dag-open-wizard="1">配置参数</button>
                    <button type="button" class="btn-secondary" data-pivot-dag-open-json="1">编辑高级参数</button>
                    <button type="button" class="btn-secondary" data-pivot-dag-apply-template="1">套用模板</button>
                    <button type="button" class="btn-secondary" data-pivot-dag-test-node="1">测试节点</button>
                </div>
                <pre class="pivot-dag-test-result" data-pivot-dag-test-result hidden></pre>
            </div>
        `);
        if (ctx.readOnly) {
            inspector.querySelectorAll('input, select, textarea, button').forEach(control => {
                if (control.tagName === 'TEXTAREA') control.readOnly = true;
                else control.disabled = true;
            });
            return;
        }
        inspector.querySelector('[data-pivot-dag-open-wizard]')?.addEventListener('click', () => openNodeInputWizard(node.id));
        inspector.querySelector('[data-pivot-dag-open-json]')?.addEventListener('click', () => openNodeJsonEditor(node.id));
        inspector.querySelectorAll('[data-pivot-dag-edit-contract], [data-pivot-dag-edit-contract-short]').forEach(button => {
            button.addEventListener('click', () => openNodeContractEditor(node.id));
        });
        inspector.querySelectorAll('[data-pivot-dag-output-format]').forEach(button => {
            button.addEventListener('click', () => {
                const format = button.dataset.pivotDagOutputFormat || 'markdown';
                ctx.recordHistory?.();
                node.input = node.input && typeof node.input === 'object' ? node.input : {};
                if (node.tool === 'workflow.output') {
                    node.input.format = format;
                } else {
                    node.input.responseFormat = format;
                    syncLlmOutputContract(node, node.input);
                }
                ctx.render?.();
                ctx.flushOut?.();
            });
        });
        inspector.querySelectorAll('[data-pivot-dag-output-presentation]').forEach(button => {
            button.addEventListener('click', () => {
                const presentation = button.dataset.pivotDagOutputPresentation || 'default';
                ctx.recordHistory?.();
                node.input = node.input && typeof node.input === 'object' ? node.input : {};
                node.input.presentation = presentation;
                ctx.render?.();
                ctx.flushOut?.();
            });
        });
        bindWhenPanelEvents(node);
        inspector.querySelectorAll('[data-pivot-contract-preset]').forEach(button => {
            button.addEventListener('click', () => {
                const preset = button.dataset.pivotContractPreset;
                ctx.recordHistory?.();
                node.outputSchema = preset === 'clear' ? {} : preset === 'array'
                    ? { type: 'array', items: {} }
                    : { type: preset };
                ctx.render?.();
                ctx.flushOut?.();
            });
        });

        inspector.querySelectorAll('[data-pivot-dag-field]').forEach(input => {
            if (input.dataset.pivotDagField === 'title') {
                input.addEventListener('input', (e) => handleInspectorEdit(e.target, { deferCommit: true }));
                input.addEventListener('blur', (e) => handleInspectorEdit(e.target));
                input.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    e.target.blur();
                });
                return;
            }
            input.addEventListener('input', (e) => handleInspectorEdit(e.target));
            input.addEventListener('change', (e) => handleInspectorEdit(e.target));
        });
        inspector.querySelectorAll('[data-pivot-dag-depend]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => handleDependsToggle(e.target));
        });
        inspector.querySelector('[data-pivot-dag-apply-template]')?.addEventListener('click', () => applyToolInputTemplate(node.id));
        inspector.querySelector('[data-pivot-dag-test-node]')?.addEventListener('click', () => testNode(node));
        if (focusSnapshot?.field) {
            const next = inspector.querySelector(`[data-pivot-dag-field="${cssEscape(focusSnapshot.field)}"]`);
            next?.focus?.({ preventScroll: true });
            if (next && focusSnapshot.start !== null && typeof next.setSelectionRange === 'function') {
                try {
                    next.setSelectionRange(focusSnapshot.start, focusSnapshot.end ?? focusSnapshot.start);
                } catch (e) {
                    // 忽略无法恢复光标范围的控件。
                }
            }
        } else if (focusSnapshot?.depend) {
            inspector.querySelector(`[data-pivot-dag-depend="${cssEscape(focusSnapshot.depend)}"]`)?.focus?.({ preventScroll: true });
        }
    };

    const applyToolInputTemplate = (nodeId) => {
        const node = ctx.spec.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const tool = resolveToolForNode(currentTools(), node.tool);
        const template = buildToolInputTemplate(tool);
        ctx.recordHistory?.();
        node.input = { ...template };
        ctx.render?.();
        ctx.flushOut?.();
        window.showToast?.('已套用工具参数模板', 'success');
    };

    const handleInspectorEdit = (input, options = {}) => {
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        if (!node) return;
        const field = input.dataset.pivotDagField;
        if (field === 'title') {
            if (input.dataset.pivotDagHistoryRecorded !== '1') {
                ctx.recordHistory?.();
                input.dataset.pivotDagHistoryRecorded = '1';
            }
            node.title = String(input.value || '').slice(0, 120);
            if (options.deferCommit) return;
        } else if (field === 'tool') {
            ctx.recordHistory?.();
            const nextTool = String(input.value || '');
            node.tool = nextTool;
            node.inputSchema = {};
            node.outputSchema = nextTool === 'agent.llm' ? { type: 'string' } : {};
            if (node.tool === 'agent.llm') {
                node.input = { ...defaultLlmInput() };
                ensureLlmNodeInput(node);
            } else {
                node.input = { ...buildToolInputTemplate(resolveToolForNode(currentTools(), nextTool)) };
            }
        } else if (field === 'condition') {
            ctx.recordHistory?.();
            node.condition = ['always', 'success', 'failure'].includes(input.value) ? input.value : 'success';
        } else if (field === 'onError') {
            ctx.recordHistory?.();
            node.onError = ['skip_dependents', 'continue', 'stop'].includes(input.value) ? input.value : 'skip_dependents';
        } else if (field === 'retryLimit') {
            ctx.recordHistory?.();
            node.retryLimit = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 5));
        } else if (field === 'timeoutMs') {
            ctx.recordHistory?.();
            node.timeoutMs = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 600000));
        } else if (field === 'input') {
            try {
                const parsed = JSON.parse(input.value || '{}');
                ctx.recordHistory?.();
                node.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                input.classList.remove('is-invalid');
            } catch (e) {
                input.classList.add('is-invalid');
                return;
            }
        }
        ctx.render?.();
        ctx.flushOut?.();
    };

    const handleDependsToggle = (checkbox) => {
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        if (!node) return;
        const dep = checkbox.dataset.pivotDagDepend;
        const deps = new Set(node.dependsOn || []);
        if (checkbox.checked) {
            if (wouldCreateCycle(dep, node.id)) {
                checkbox.checked = false;
                window.showToast?.('不能添加循环依赖', 'error');
                return;
            }
            deps.add(dep);
        } else {
            deps.delete(dep);
        }
        ctx.recordHistory?.();
        node.dependsOn = [...deps];
        clampDependsOn(ctx.spec.nodes);
        ctx.render?.();
        ctx.flushOut?.();
    };

    return {
        renderInspector
    };
}
