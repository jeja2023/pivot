/* Agent DAG 参数与预设工作流向导（拆自 agents-dag-editor.js） */
/* global createDagWizardSpecialFieldControls, createDagWizardReportAssist */
/* global partitionWizardFields, isWizardFieldRelevant */
function createDagWizardController(ctx) {
        const currentTools = () => typeof ctx.currentTools === 'function' ? (ctx.currentTools() || []) : [];
        const openNodeInputWizard = (nodeId) => {
            const node = ctx.spec.nodes.find(n => n.id === nodeId);
            if (!node) return;
            const wizardTools = currentTools();
            const tool = resolveToolForNode(wizardTools, node.tool);
            const schema = getToolSchema(tool);
            const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            const isVisualSqlQuery = isVisualSqlQueryTool(tool);
            const isRuntimeParameterDeclaration = toolShortName(tool) === 'workflow.input';
            const fieldEntries = Object.entries(properties).filter(([name]) => !isVisualSqlQuery || !['sql', 'limit'].includes(name));
            const fieldGroups = partitionWizardFields(fieldEntries, required, tool);
            const fields = fieldGroups.all;
            const nodeTestOutputs = typeof ctx.getNodeTestOutputSnapshots === 'function'
                ? ctx.getNodeTestOutputSnapshots()
                : new Map();
            const dependencyNodes = buildWizardDependencyNodes(node, ctx.spec.nodes).map(item => ({
                ...item,
                _testOutput: nodeTestOutputs.get(String(item.id || ''))?.output
            }));
            let modal = document.getElementById('pivot-dag-input-wizard');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'pivot-dag-input-wizard';
                modal.className = 'modal-overlay hidden pivot-dag-input-wizard-overlay';
                document.body.appendChild(modal);
            }
            const templateInput = buildToolInputTemplate(tool);
            const currentInput = cloneDagInput(node.input);
            // 变量来源仅保存在向导局部副本，避免把会话对象挂到可持久化的节点上。
            const referenceNode = {
                ...node,
                _workflowNodes: ctx.spec.nodes,
                _workflowInputNodes: ctx.spec.nodes
                .filter(item => item?.tool === 'workflow.input' && item.id !== node.id)
                .map(item => ({ id: item.id, title: item.title, tool: item.tool, input: cloneDagInput(item.input) }))
            };
            if (tool?.databaseTool && !databaseConnectionInputValue(currentInput)) {
                const legacyConnectionId = databaseConnectionIdFromToolValue(node.tool);
                if (legacyConnectionId) currentInput.connectionId = legacyConnectionId;
            }
            const initialInput = { ...templateInput, ...currentInput };
            let wizardBaseInput = cloneDagInput(currentInput);
            const renderFieldEntries = (entries) => entries
                .filter(([name]) => isWizardFieldRelevant(name, initialInput, tool))
                .map(([name, fieldSchema]) => renderWizardField(name, fieldSchema, initialInput[name], required.has(name), dependencyNodes, tool, wizardTools, node.tool, node.title)).join('');
            const primaryFieldMarkup = fieldGroups.primary.length
                ? renderFieldEntries(fieldGroups.primary)
                : '<div class="pivot-dag-wizard-empty">当前工具不需要配置参数，直接应用即可。</div>';
            const advancedFieldMarkup = fieldGroups.advanced.length
                ? `<details class="pivot-dag-wizard-more-settings"><summary>更多设置 <span>一般无需修改</span></summary><div class="pivot-dag-wizard-more-grid">${renderFieldEntries(fieldGroups.advanced)}</div></details>`
                : '';
            PivotSafeHtml.setHtml(modal, `
                <div class="modal rag-detail-modal pivot-dag-input-wizard">
                    <div class="rag-detail-header pivot-dag-input-head">
                        <div>
                            <h3>配置节点参数</h3>
                            <p class="model-modal-desc">${dagEscapeHtml(friendlyToolTitle(tool) || node.tool || '当前节点')}</p>
                        </div>
                        <button type="button" class="btn-danger-outline" data-pivot-dag-wizard-close="1">关闭</button>
                    </div>
                    <div class="pivot-dag-wizard-body">
                        <div class="pivot-dag-wizard-form${isVisualSqlQuery ? ' is-visual-sql' : ''}">
                            <section class="pivot-dag-wizard-overview">
                                <div class="pivot-dag-wizard-overview-head">
                                    <strong>当前配置</strong>
                                    <span>${isRuntimeParameterDeclaration ? '这是可选的参数声明，不是流程起点；只有需要类型、默认值或必填校验时才配置。' : '表单会保存到节点参数；需要填写复杂结构时再打开高级参数编辑。'}</span>
                                </div>
                                <div class="pivot-dag-wizard-overview-body">
                                    ${renderInputSummary(initialInput, tool, wizardTools)}
                                </div>
                            </section>
                            ${isVisualSqlQuery ? primaryFieldMarkup : ''}
                            ${isVisualSqlQuery
                                ? renderVisualSqlBuilder(initialInput)
                                : renderDatabaseAssistPanel(node, tool, initialInput, wizardTools)}
                            ${isVisualSqlQuery ? '' : primaryFieldMarkup}
                            ${advancedFieldMarkup}
                        </div>
                        <aside class="pivot-dag-wizard-sources">
                            <div class="pivot-dag-wizard-sources-title">变量引用</div>
                            ${renderWizardFieldSources(referenceNode, dependencyNodes)}
                        </aside>
                    </div>
                    <div class="agent-workflow-create-actions pivot-dag-wizard-actions">
                        <button type="button" class="btn-secondary" data-pivot-dag-wizard-template="1">套用模板</button>
                        <button type="button" class="btn-secondary" data-pivot-dag-wizard-clear="1">清空</button>
                        <button type="button" class="btn-primary" data-pivot-dag-wizard-apply="1">应用到画布</button>
                    </div>
                </div>
            `);
            const wizardHeader = modal.querySelector('.pivot-dag-input-head > div');
            if (wizardHeader) {
                const meta = document.createElement('div');
                meta.className = 'pivot-dag-wizard-meta';
                PivotSafeHtml.setHtml(meta, `
                    <span>${dagEscapeHtml(`${fields.length} 个参数`)}</span>
                    <span>${dagEscapeHtml(`${required.size} 个必填`)}</span>
                    <span>${dagEscapeHtml(`${dependencyNodes.length} 个依赖`)}</span>
                `);
                wizardHeader.appendChild(meta);
            }
            const wizardDesc = modal.querySelector('.pivot-dag-input-head .model-modal-desc');
            if (wizardDesc) {
                wizardDesc.textContent = [wizardDesc.textContent, node.title || node.id].filter(Boolean).join(' · ');
            }
            const wizardSources = modal.querySelector('.pivot-dag-wizard-sources');
            if (wizardSources) {
                const help = document.createElement('div');
                help.className = 'pivot-dag-wizard-sources-help';
                help.textContent = '变量会在运行时替换成真实值。先选中左侧字段，再点击变量即可插入。';
                const title = wizardSources.querySelector('.pivot-dag-wizard-sources-title');
                if (title) title.insertAdjacentElement('afterend', help);
                else wizardSources.prepend(help);
            }
            const fieldsByName = new Map();
            modal.querySelectorAll('[data-pivot-dag-wizard-field]').forEach(control => {
                const fieldName = control.dataset.pivotDagWizardField || '';
                if (!fieldName) return;
                fieldsByName.set(fieldName, control);
            });
            const referencePickerFor = fieldName => modal.querySelector(`[data-pivot-dag-wizard-reference-picker="${fieldName}"]`);
            const referenceCustomFor = fieldName => modal.querySelector(`[data-pivot-dag-wizard-reference-custom="${fieldName}"]`);
            const manualControlFor = fieldName => modal.querySelector(`[data-pivot-dag-wizard-manual-control="${fieldName}"]`);
            const { aggregationMetricsFromControl, approvalLevelsFromControl, approvalTagsFromControl, bindAggregationMetrics, bindBrowserTargetVisibility, bindChannelBindingPicker, bindConditionCompareField, bindCredentialPicker, bindKeyValueMap, bindOutputPresentationFields, bindTagList, bindWorkflowInputDefault, browserTargetFromControl, columnFieldsFromControl, credentialValueFromControl, groupFieldsFromControl, hydrateWorkflowInputDefault, keyValueMapFromControl, renderAggregationMetrics, renderApprovalLevels, renderApprovalTags, renderColumnFields, renderDataFieldPicker, renderGroupFields, renderKeyValueRows, renderResourceOptions, renderTagList, syncApprovalLevelSource, syncBrowserTargetMode, syncCredentialPicker, syncResourcePicker, tagListValuesFromControl, workflowInputDefaultFromControl } = createDagWizardSpecialFieldControls();
            const { bindReportSheetPicker, hydrateSheet, setManualSheet, sheetValue } = createDagWizardReportAssist();
            let syncBrowserTargetVisibility = () => {}, syncConditionCompareField = () => {}, syncOutputPresentationFields = () => {};
            const syncReferencePicker = (fieldName, nextValue) => {
                const picker = referencePickerFor(fieldName);
                if (!picker) return;
                const options = [...picker.options].map(option => option.value);
                const exactReference = typeof nextValue === 'string' && /^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(nextValue);
                const selected = typeof nextValue === 'string' && options.includes(nextValue)
                    ? nextValue
                    : (exactReference ? '__custom__' : '');
                picker.value = selected;
                const custom = referenceCustomFor(fieldName);
                if (custom) {
                    custom.value = selected === '__custom__' ? String(nextValue || '') : '';
                    custom.classList.toggle('is-visible', selected === '__custom__');
                }
                manualControlFor(fieldName)?.classList.toggle('is-reference-active', Boolean(selected));
            };
            const populateFields = (draftInput = {}) => {
                fields.forEach(([name, fieldSchema]) => {
                    const control = fieldsByName.get(name);
                    if (!control) return;
                    const nextValue = draftInput[name];
                    const type = normalizeSchemaType(fieldSchema);
                    if (control.dataset.pivotDagAggregationMetrics) { renderAggregationMetrics(control, nextValue); return; }
                    if (control.dataset.pivotDagGroupFields) { renderGroupFields(control, nextValue); return; }
                    if (control.dataset.pivotDagColumnFields) {
                        renderColumnFields(control, nextValue);
                        return;
                    }
                    if (control.dataset.pivotDagApprovalTags) {
                        renderApprovalTags(control, nextValue);
                        return;
                    }
                    if (control.dataset.pivotDagTagList) { renderTagList(control, nextValue); return; }
                    if (control.dataset.pivotDagWorkflowInputDefault) { hydrateWorkflowInputDefault(control, fieldsByName.get('type')?.value || 'text', nextValue); return; }
                    if (control.dataset.pivotDagApprovalLevels) {
                        const source = control.querySelector('[data-pivot-dag-approval-level-source]');
                        const custom = control.querySelector('[data-pivot-dag-approval-level-custom]');
                        const options = source ? [...source.options].map(option => option.value) : [];
                        const selected = typeof nextValue === 'string' && options.includes(nextValue)
                            ? nextValue
                            : (typeof nextValue === 'string' && nextValue ? '__custom__' : '');
                        if (source) source.value = selected;
                        if (custom) custom.value = selected === '__custom__' ? String(nextValue || '') : '';
                        renderApprovalLevels(control, selected ? [] : nextValue);
                        syncApprovalLevelSource(control);
                        return;
                    }
                    if (control.dataset.pivotDagBrowserTarget) {
                        const source = control.querySelector('[data-pivot-dag-browser-target-source]');
                        const custom = control.querySelector('[data-pivot-dag-browser-target-custom]');
                        const options = source ? [...source.options].map(option => option.value) : [];
                        const selected = typeof nextValue === 'string' && options.includes(nextValue)
                            ? nextValue
                            : (typeof nextValue === 'string' && nextValue ? '__custom__' : '');
                        if (source) source.value = selected;
                        if (custom) custom.value = selected === '__custom__' ? String(nextValue || '') : '';
                        const target = nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue) ? nextValue : {};
                        const mode = target.role || target.name ? 'role' : (target.text ? 'text' : 'selector');
                        const modeControl = control.querySelector('[data-pivot-dag-browser-target-mode]');
                        if (modeControl) modeControl.value = mode;
                        const assign = (selector, value) => {
                            const input = control.querySelector(selector);
                            if (input) input.value = value || '';
                        };
                        assign('[data-pivot-dag-browser-target-selector-input]', target.selector);
                        assign('[data-pivot-dag-browser-target-role-input]', target.role);
                        assign('[data-pivot-dag-browser-target-name-input]', target.name);
                        assign('[data-pivot-dag-browser-target-text-input]', target.text);
                        const exact = control.querySelector('[data-pivot-dag-browser-target-exact]');
                        if (exact) exact.checked = target.exact === true;
                        syncBrowserTargetMode(control);
                        return;
                    }
                    if (control.dataset.pivotDagChannelBindingPicker) {
                        const select = control.querySelector('[data-pivot-dag-channel-binding-select]');
                        if (select) select.value = nextValue === undefined || nextValue === null ? '' : String(nextValue);
                        return;
                    }
                    if (control.dataset.pivotDagCredentialPicker) { syncCredentialPicker(control, nextValue); return; }
                    if (control.dataset.pivotDagReportSheetPicker) { hydrateSheet(control, nextValue); return; }
                    if (control.dataset.pivotDagReportPathPicker) {
                        syncResourcePicker(control, nextValue, '请选择可访问文件', path => `当前文件：${path}`);
                        return;
                    }
                    if (control.dataset.pivotDagArtifactPicker) {
                        syncResourcePicker(control, nextValue, '请选择可用产物', id => `当前产物 #${id}`);
                        return;
                    }
                    if (control.dataset.pivotDagDataFieldPicker) {
                        renderDataFieldPicker(control, nextValue);
                        return;
                    }
                    if (control.dataset.pivotDagKeyvalueMap) {
                        renderKeyValueRows(control, nextValue);
                        return;
                    }
                    if (control.dataset.pivotDagStructuredReference === '1') {
                        const optionValues = [...control.options].map(option => option.value);
                        const selected = typeof nextValue === 'string' && optionValues.includes(nextValue) ? nextValue : (nextValue ? '__manual__' : '');
                        control.value = selected;
                        const manual = modal.querySelector(`[data-pivot-dag-structured-manual="${name}"]`);
                        if (manual) manual.value = selected === '__manual__' ? formatWizardFieldValue(fieldSchema, nextValue) : '';
                        return;
                    }
                    syncReferencePicker(name, nextValue);
                    if (control.type === 'checkbox') {
                        control.checked = Boolean(nextValue);
                    } else if (type === 'boolean') {
                        control.checked = Boolean(nextValue);
                    } else if (type === 'integer' || type === 'number') {
                        control.value = nextValue === undefined || nextValue === null ? '' : String(nextValue);
                    } else if (control.tagName === 'TEXTAREA' || isTextualSchemaField(name, fieldSchema)) {
                        control.value = formatWizardFieldValue(fieldSchema, nextValue);
                    } else {
                        control.value = nextValue === undefined || nextValue === null ? '' : String(nextValue);
                    }
                });
                syncConditionCompareField(); syncBrowserTargetVisibility(); syncOutputPresentationFields();
            };
            const getFieldValue = (control, fieldSchema, fieldName = '') => {
                const type = normalizeSchemaType(fieldSchema);
                if (control.dataset.pivotDagAggregationMetrics) { const metrics = aggregationMetricsFromControl(control); return metrics.length ? metrics : undefined; }
                if (control.dataset.pivotDagGroupFields) {
                    const fields = groupFieldsFromControl(control);
                    return fields.length ? fields : undefined;
                }
                if (control.dataset.pivotDagColumnFields) {
                    const fields = columnFieldsFromControl(control);
                    return fields.length ? fields : undefined;
                }
                if (control.dataset.pivotDagApprovalTags) {
                    const tags = approvalTagsFromControl(control);
                    if (!tags.length) return undefined;
                    return control.dataset.pivotDagTagNumeric === '1'
                        ? tags.map(value => Number.parseInt(value, 10)).filter(Number.isSafeInteger)
                        : tags;
                }
                if (control.dataset.pivotDagTagList) { const tags = tagListValuesFromControl(control); return tags.length ? tags : undefined; }
                if (control.dataset.pivotDagWorkflowInputDefault) return workflowInputDefaultFromControl(control, fieldsByName.get('type')?.value || 'text');
                if (control.dataset.pivotDagApprovalLevels) {
                    return approvalLevelsFromControl(control);
                }
                if (control.dataset.pivotDagBrowserTarget) {
                    return browserTargetFromControl(control);
                }
                if (control.dataset.pivotDagChannelBindingPicker) {
                    return String(control.querySelector('[data-pivot-dag-channel-binding-select]')?.value || '').trim() || undefined;
                }
                if (control.dataset.pivotDagCredentialPicker) return credentialValueFromControl(control);
                if (control.dataset.pivotDagReportSheetPicker) return sheetValue(control);
                if (control.dataset.pivotDagReportPathPicker) {
                    const selected = String(control.querySelector('[data-pivot-dag-report-path-select]')?.value || '').trim();
                    if (selected === '__custom__') return String(control.querySelector('[data-pivot-dag-report-path-custom]')?.value || '').trim() || undefined;
                    return selected || undefined;
                }
                if (control.dataset.pivotDagArtifactPicker) {
                    const selected = String(control.querySelector('[data-pivot-dag-artifact-select]')?.value || '').trim();
                    if (selected === '__custom__') return String(control.querySelector('[data-pivot-dag-artifact-custom]')?.value || '').trim() || undefined;
                    const value = Number.parseInt(selected, 10);
                    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
                }
                if (control.dataset.pivotDagDataFieldPicker) {
                    const selected = String(control.querySelector('[data-pivot-dag-data-field-select]')?.value || '').trim();
                    if (!selected) return undefined;
                    if (selected !== '__manual__') return selected;
                    return String(control.querySelector('[data-pivot-dag-data-field-manual]')?.value || '').trim() || undefined;
                }
                if (control.dataset.pivotDagKeyvalueMap) {
                    return keyValueMapFromControl(control);
                }
                if (control.type === 'checkbox' || type === 'boolean') return Boolean(control.checked);
                const referencePicker = referencePickerFor(fieldName);
                if (referencePicker?.value) {
                    if (referencePicker.value !== '__custom__') return referencePicker.value;
                    const customReference = String(referenceCustomFor(fieldName)?.value || '').trim();
                    if (!customReference) return undefined;
                    return customReference;
                }
                let raw = String(control.value ?? '').trim();
                if (control.dataset.pivotDagStructuredReference === '1' && raw === '__manual__') {
                    raw = String(modal.querySelector(`[data-pivot-dag-structured-manual="${fieldName}"]`)?.value || '').trim();
                }
                if (!raw) return undefined;
                if (toolShortName(tool) === 'agent.content_review' && normalizeFieldKey(fieldName) === 'records') {
                    if (/^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(raw)) return raw;
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed && typeof parsed === 'object') return parsed;
                    } catch (e) {
                        return raw;
                    }
                    return raw;
                }
                if (type === 'integer') {
                    const value = Number.parseInt(raw, 10);
                    if (!Number.isFinite(value)) return undefined;
                    return toolShortName(tool) === 'workflow.delay' && normalizeFieldKey(fieldName) === 'duration_ms'
                        ? value * 1000
                        : value;
                }
                if (type === 'number') {
                    const value = Number(raw);
                    return Number.isFinite(value) ? value : undefined;
                }
                if (type === 'array' || type === 'object') {
                    if (/^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(raw)) return raw;
                    try {
                        const parsed = JSON.parse(raw);
                        if (type === 'array') return Array.isArray(parsed) ? parsed : undefined;
                        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
                    } catch (e) {
                        return undefined;
                    }
                }
                return raw;
            };
            let activeFieldControl = null;
            let activeKeyValueInput = null;
            const setActiveField = (control) => {
                activeFieldControl = control;
            };
            const insertWizardToken = (token, targetFieldName = '') => {
                const control = targetFieldName ? fieldsByName.get(targetFieldName) : activeFieldControl;
                if (!token || !control) return;
                setActiveField(control);
                if (control.dataset.pivotDagKeyvalueMap) {
                    let target = activeKeyValueInput && control.contains(activeKeyValueInput)
                        ? activeKeyValueInput
                        : control.querySelector('[data-pivot-dag-keyvalue-value]');
                    if (!target) {
                        renderKeyValueRows(control, { '': token });
                        target = control.querySelector('[data-pivot-dag-keyvalue-value]');
                    }
                    if (!target) return;
                    const start = target.selectionStart ?? target.value.length;
                    const end = target.selectionEnd ?? target.value.length;
                    target.value = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
                    target.focus?.({ preventScroll: true });
                    return;
                }
                if (control.dataset.pivotDagDataFieldPicker) {
                    const select = control.querySelector('[data-pivot-dag-data-field-select]');
                    const manual = control.querySelector('[data-pivot-dag-data-field-manual]');
                    if (select) select.value = '__manual__';
                    if (manual) {
                        manual.value = token;
                        manual.classList.add('is-visible');
                        manual.focus?.({ preventScroll: true });
                    }
                    return;
                }
                if (control.dataset.pivotDagCredentialPicker) return;
                if (control.dataset.pivotDagReportSheetPicker) {
                    setManualSheet(control, token);
                    return;
                }
                if (control.dataset.pivotDagApprovalLevels) {
                    const source = control.querySelector('[data-pivot-dag-approval-level-source]');
                    const custom = control.querySelector('[data-pivot-dag-approval-level-custom]');
                    const hasOption = [...(source?.options || [])].some(option => option.value === token);
                    if (source) source.value = hasOption ? token : '__custom__';
                    if (!hasOption && custom) custom.value = token;
                    syncApprovalLevelSource(control);
                    return;
                }
                if (control.dataset.pivotDagBrowserTarget) {
                    const source = control.querySelector('[data-pivot-dag-browser-target-source]');
                    const custom = control.querySelector('[data-pivot-dag-browser-target-custom]');
                    const hasOption = [...(source?.options || [])].some(option => option.value === token);
                    if (source) source.value = hasOption ? token : '__custom__';
                    if (!hasOption && custom) custom.value = token;
                    syncBrowserTargetMode(control);
                    return;
                }
                if (control.dataset.pivotDagStructuredReference === '1') {
                    const hasOption = [...control.options].some(option => option.value === token);
                    const manual = modal.querySelector(`[data-pivot-dag-structured-manual="${targetFieldName || control.dataset.pivotDagWizardField || ''}"]`);
                    control.value = hasOption ? token : '__manual__';
                    if (!hasOption && manual) {
                        manual.value = token;
                        manual.classList.add('is-visible');
                    }
                    control.dispatchEvent(new Event('input', { bubbles: true }));
                    control.dispatchEvent(new Event('change', { bubbles: true }));
                    control.focus?.({ preventScroll: true });
                    return;
                }
                const referencePicker = targetFieldName ? referencePickerFor(targetFieldName) : null;
                if (referencePicker && /^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(token)) {
                    const hasOption = [...referencePicker.options].some(option => option.value === token);
                    referencePicker.value = hasOption ? token : '__custom__';
                    const custom = referenceCustomFor(targetFieldName);
                    if (!hasOption && custom) {
                        custom.value = token;
                        custom.classList.add('is-visible');
                    }
                    manualControlFor(targetFieldName)?.classList.add('is-reference-active');
                    referencePicker.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                }
                if (control.tagName === 'TEXTAREA' || (control.tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'password'].includes(control.type))) {
                    const start = control.selectionStart ?? control.value.length;
                    const end = control.selectionEnd ?? control.value.length;
                    const before = control.value.slice(0, start);
                    const after = control.value.slice(end);
                    control.value = `${before}${token}${after}`;
                } else if (control.tagName === 'INPUT' && (control.type === 'number' || control.type === 'checkbox')) {
                    return;
                } else {
                    control.value = token;
                }
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
                control.focus?.({ preventScroll: true });
            };
            const setAssistStatus = (message, type = '') => {
                const status = modal.querySelector('[data-pivot-dag-assist-status]');
                if (!status) return;
                status.textContent = message || '';
                status.className = `pivot-dag-wizard-assist-status ${type}`;
            };
            const syncAssistValue = (fieldName, value) => {
                const control = fieldsByName.get(fieldName);
                if (!control) return;
                control.value = value || '';
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const currentDatabaseConnectionId = () => {
                const selector = modal.querySelector('[data-pivot-dag-db-connection-select]');
                const selected = String(selector?.value || '').trim();
                return selected || modal.querySelector('[data-pivot-dag-db-assist]')?.dataset.pivotDagDbAssist || '';
            };
            const queryBuilder = isVisualSqlQuery
                ? mountVisualSqlBuilder({
                    modal,
                    initialInput,
                    tool,
                    wizardTools,
                    getConnectionId: currentDatabaseConnectionId,
                    callTool: callWizardTool
                })
                : null;
            const assistEntry = () => {
                const serverId = currentDatabaseConnectionId();
                return databaseWizardConnections(wizardTools).find(entry => entry.serverId === serverId) || null;
            };
            const syncAssistConnection = () => {
                const serverId = currentDatabaseConnectionId();
                const assist = modal.querySelector('[data-pivot-dag-db-assist]');
                if (assist) assist.dataset.pivotDagDbAssist = serverId;
                const label = modal.querySelector('[data-pivot-dag-assist-connection-label]');
                if (label) label.textContent = databaseConnectionLabel(tool, serverId, wizardTools);
                const tableList = modal.querySelector('#pivot-dag-assist-table-options');
                const columnList = modal.querySelector('#pivot-dag-assist-column-options');
                if (tableList) PivotSafeHtml.setHtml(tableList, '');
                if (columnList) PivotSafeHtml.setHtml(columnList, '');
                setAssistStatus(serverId ? '已切换数据库连接，可重新读取表或字段。' : '请选择数据库连接。', serverId ? '' : 'warn');
            };
            const loadAssistTables = async () => {
                syncAssistConnection();
                const entry = assistEntry();
                const tableTool = entry?.tools?.['db.list_tables'];
                if (!tableTool) return setAssistStatus('当前数据库连接没有表列表工具。', 'error');
                const schemaValue = modal.querySelector('[data-pivot-dag-assist-schema]')?.value.trim() || '';
                setAssistStatus('正在读取数据表...');
                try {
                    const result = await callWizardTool(tableTool, schemaValue ? { schema: schemaValue } : {});
                    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
                    const tables = [...new Set(rows.map(tableNameFromRow).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
                    const list = modal.querySelector('#pivot-dag-assist-table-options');
                    if (list) PivotSafeHtml.setHtml(list, tables.map(name => `<option value="${dagEscapeAttr(name)}"></option>`).join(''));
                    if (schemaValue) syncAssistValue('schema', schemaValue);
                    setAssistStatus(tables.length ? `已读取 ${tables.length} 个数据表，可在数据表输入框选择。` : '没有读取到数据表，可手动输入。', tables.length ? '' : 'warn');
                } catch (e) {
                    setAssistStatus(e.message || '读取数据表失败。', 'error');
                }
            };
            const loadAssistColumns = async () => {
                syncAssistConnection();
                const entry = assistEntry();
                const columnTool = entry?.tools?.['db.describe_table'];
                if (!columnTool) return setAssistStatus('当前数据库连接没有字段读取工具。', 'error');
                const tableValue = modal.querySelector('[data-pivot-dag-assist-table]')?.value.trim()
                    || fieldsByName.get('table')?.value.trim()
                    || '';
                const schemaValue = modal.querySelector('[data-pivot-dag-assist-schema]')?.value.trim() || '';
                if (!tableValue) return setAssistStatus('请先选择或输入数据表。', 'error');
                syncAssistValue('table', tableValue);
                if (schemaValue) syncAssistValue('schema', schemaValue);
                setAssistStatus('正在读取字段...');
                try {
                    const result = await callWizardTool(columnTool, { table: tableValue, ...(schemaValue ? { schema: schemaValue } : {}) });
                    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
                    const columns = [...new Set(rows.map(columnNameFromRow).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
                    const list = modal.querySelector('#pivot-dag-assist-column-options');
                    if (list) PivotSafeHtml.setHtml(list, columns.map(name => `<option value="${dagEscapeAttr(name)}"></option>`).join(''));
                    setAssistStatus(columns.length ? `已读取 ${columns.length} 个字段，可在字段输入框选择。` : '没有读取到字段，可手动输入。', columns.length ? '' : 'warn');
                } catch (e) {
                    setAssistStatus(e.message || '读取字段失败。', 'error');
                }
            };
            const collectWizardInput = () => {
                const nextInput = cloneDagInput(wizardBaseInput);
                const missing = [];
                let invalidField = '';
                fields.forEach(([name, fieldSchema]) => {
                    const control = fieldsByName.get(name);
                    if (!control) return;
                    const value = getFieldValue(control, fieldSchema, name);
                    if (value === null) {
                        invalidField = invalidField || name;
                        return;
                    }
                    if (value === undefined) {
                        if (required.has(name)) missing.push(name);
                        else delete nextInput[name];
                        return;
                    }
                    nextInput[name] = value;
                });
                if (invalidField) {
                    const control = fieldsByName.get(invalidField);
                    control?.focus?.({ preventScroll: true });
                    window.Pivot.legacy.showToast?.(`请检查“${friendlyFieldLabel(invalidField, properties[invalidField], tool)}”中的无效配置。`, 'error');
                    return null;
                }
                if (tool?.databaseTool) {
                    const connectionId = databaseConnectionInputValue(nextInput);
                    delete nextInput.connection_id;
                    delete nextInput.databaseConnectionId;
                    delete nextInput.database_connection_id;
                    delete nextInput.mcpServerId;
                    delete nextInput.mcp_server_id;
                    if (connectionId) nextInput.connectionId = connectionId;
                }
                // 平台由受控渠道绑定决定；编辑过的旧通知节点不再保存冗余平台字段。
                if (toolShortName(tool) === 'workflow.notify') delete nextInput.platform;
                if (queryBuilder) {
                    const built = queryBuilder.collect();
                    if (built.error) {
                        window.Pivot.legacy.showToast?.(built.error, 'error');
                        return null;
                    }
                    nextInput.sql = built.sql;
                    nextInput.queryBuilder = built.queryBuilder;
                    nextInput.limit = built.queryBuilder.limit;
                }
                if (missing.length) {
                    const first = fieldsByName.get(missing[0]);
                    const missingLabels = missing.map(name => friendlyFieldLabel(name, properties[name], tool));
                    first?.focus?.({ preventScroll: true });
                    window.Pivot.legacy.showToast?.(`请先填写：${missingLabels.join('、')}`, 'error');
                    return null;
                }
                // 保留高级 JSON 里已有但向导没覆盖的字段。
                Object.keys(wizardBaseInput || {}).forEach(key => {
                    if (
                        tool?.databaseTool
                        && ['connection_id', 'databaseConnectionId', 'database_connection_id', 'mcpServerId', 'mcp_server_id'].includes(key)
                    ) {
                        return;
                    }
                    if (!Object.prototype.hasOwnProperty.call(properties, key) && nextInput[key] === undefined) {
                        nextInput[key] = wizardBaseInput[key];
                    }
                });
                return nextInput;
            };
            const syncFormWithDraft = (draftInput = {}) => {
                populateFields(draftInput);
                const firstField = fieldsByName.get(fields[0]?.[0] || '');
                if (firstField) {
                    activeFieldControl = firstField;
                    requestAnimationFrame(() => firstField.focus?.({ preventScroll: true }));
                }
            };
            const closeWizard = () => {
                modal.classList.add('hidden');
            };
            const applyWizard = () => {
                const nextInput = collectWizardInput();
                if (!nextInput) return;
                ctx.recordHistory?.();
                if (tool && toolValue(tool)) node.tool = toolValue(tool);
                node.input = nextInput;
                if (typeof syncLlmOutputContract === 'function') {
                    syncLlmOutputContract(node, nextInput);
                }
                closeWizard();
                let renderError = null;
                try {
                    ctx.render?.();
                } catch (error) {
                    renderError = error;
                    console.error('DAG 节点参数应用后刷新画布失败', error);
                }
                try {
                    ctx.flushOut?.();
                } catch (error) {
                    renderError = renderError || error;
                    console.error('DAG 节点参数应用后同步 JSON 失败', error);
                }
                window.Pivot.legacy.showToast?.(
                    renderError
                        ? '节点参数已写入，但画布刷新失败，请点击顶部“保存”后重试'
                        : '节点参数已应用到画布，请点击顶部“保存”完成保存',
                    renderError ? 'warning' : 'success'
                );
            };
            const resetWizard = (draftInput = {}) => {
                wizardBaseInput = cloneDagInput(draftInput);
                syncFormWithDraft(draftInput);
                queryBuilder?.hydrate(draftInput);
            };
            modal.querySelectorAll('[data-pivot-dag-wizard-field]').forEach(control => {
                control.addEventListener('focus', () => setActiveField(control));
                control.addEventListener('click', () => setActiveField(control));
                control.addEventListener('input', () => setActiveField(control));
                control.addEventListener('change', () => setActiveField(control));
            });
            modal.querySelectorAll('[data-pivot-dag-wizard-reference-picker]').forEach(picker => {
                const fieldName = picker.dataset.pivotDagWizardReferencePicker || '';
                const custom = referenceCustomFor(fieldName);
                const manualControl = manualControlFor(fieldName);
                const syncSourceMode = () => {
                    const selected = String(picker.value || '');
                    manualControl?.classList.toggle('is-reference-active', Boolean(selected));
                    if (custom) custom.classList.toggle('is-visible', selected === '__custom__');
                    if (!selected) fieldsByName.get(fieldName)?.focus?.({ preventScroll: true });
                    else if (selected === '__custom__') custom?.focus?.({ preventScroll: true });
                };
                picker.addEventListener('change', syncSourceMode);
                syncSourceMode();
                custom?.addEventListener('input', () => setActiveField(fieldsByName.get(fieldName)));
            });
            modal.querySelectorAll('[data-pivot-dag-aggregation-metrics]').forEach(control => bindAggregationMetrics({ control, setActiveField, showToast: (...args) => window.Pivot.legacy.showToast?.(...args) }));
            modal.querySelectorAll('[data-pivot-dag-group-fields]').forEach(control => {
                const addInput = control.querySelector('[data-pivot-dag-group-field-input]');
                const syncCandidateState = () => {
                    const selected = new Set(groupFieldsFromControl(control));
                    control.querySelectorAll('[data-pivot-dag-group-field-option]').forEach(option => {
                        const value = String(option.dataset.pivotDagGroupFieldOption || '').trim();
                        const isSelected = selected.has(value);
                        option.classList.toggle('is-selected', isSelected);
                        option.disabled = isSelected;
                        option.setAttribute('aria-pressed', String(isSelected));
                    });
                };
                const addField = (value = addInput?.value) => {
                    const next = String(value || '').trim();
                    if (!next) return;
                    const fields = groupFieldsFromControl(control);
                    if (fields.includes(next)) {
                        window.Pivot.legacy.showToast?.('该分组字段已存在。', 'warning');
                        return;
                    }
                    if (fields.length >= 12) {
                        window.Pivot.legacy.showToast?.('分组字段最多 12 个。', 'warning');
                        return;
                    }
                    renderGroupFields(control, [...fields, next]);
                    addInput.value = '';
                    syncCandidateState();
                    addInput.focus?.({ preventScroll: true });
                };
                control.querySelector('[data-pivot-dag-group-field-add]')?.addEventListener('click', addField);
                control.querySelectorAll('[data-pivot-dag-group-field-option]').forEach(option => {
                    option.addEventListener('click', () => addField(option.dataset.pivotDagGroupFieldOption));
                });
                addInput?.addEventListener('keydown', event => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addField();
                });
                control.addEventListener('click', event => {
                    const remove = event.target.closest('[data-pivot-dag-group-field-remove]');
                    if (!remove) return;
                    const field = String(remove.dataset.pivotDagGroupFieldRemove || '').trim();
                    renderGroupFields(control, groupFieldsFromControl(control).filter(item => item !== field));
                    syncCandidateState();
                });
                syncCandidateState();
            });
            modal.querySelectorAll('[data-pivot-dag-column-fields]').forEach(control => {
                const addInput = control.querySelector('[data-pivot-dag-column-field-input]');
                const addField = () => {
                    const next = String(addInput?.value || '').trim();
                    if (!next) return;
                    const fields = columnFieldsFromControl(control);
                    if (fields.includes(next)) {
                        window.Pivot.legacy.showToast?.('该字段已存在。', 'warning');
                        return;
                    }
                    if (fields.length >= 50) {
                        window.Pivot.legacy.showToast?.('最多选择 50 个字段。', 'warning');
                        return;
                    }
                    renderColumnFields(control, [...fields, next]);
                    addInput.value = '';
                    addInput.focus?.({ preventScroll: true });
                };
                control.querySelector('[data-pivot-dag-column-field-add]')?.addEventListener('click', addField);
                addInput?.addEventListener('keydown', event => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addField();
                });
                control.addEventListener('click', event => {
                    const remove = event.target.closest('[data-pivot-dag-column-field-remove]');
                    if (!remove) return;
                    const field = String(remove.dataset.pivotDagColumnFieldRemove || '').trim();
                    renderColumnFields(control, columnFieldsFromControl(control).filter(item => item !== field));
                });
            });
            modal.querySelectorAll('[data-pivot-dag-approval-tags]').forEach(control => {
                const addInput = control.querySelector('[data-pivot-dag-approval-tag-input]');
                const numericOnly = control.dataset.pivotDagTagNumeric === '1';
                const addTag = () => {
                    const next = String(addInput?.value || '').trim();
                    if (!next) return;
                    if (numericOnly && !Number.isSafeInteger(Number.parseInt(next, 10))) {
                        window.Pivot.legacy.showToast?.('审批用户 ID 必须是正整数。', 'warning');
                        return;
                    }
                    const tags = approvalTagsFromControl(control);
                    if (tags.includes(next)) {
                        window.Pivot.legacy.showToast?.('该审批对象已存在。', 'warning');
                        return;
                    }
                    if (tags.length >= 50) {
                        window.Pivot.legacy.showToast?.('审批对象最多 50 个。', 'warning');
                        return;
                    }
                    renderApprovalTags(control, [...tags, next]);
                    addInput.value = '';
                    addInput.focus?.({ preventScroll: true });
                };
                control.querySelector('[data-pivot-dag-approval-tag-add]')?.addEventListener('click', addTag);
                addInput?.addEventListener('keydown', event => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addTag();
                });
                control.addEventListener('click', event => {
                    const remove = event.target.closest('[data-pivot-dag-approval-tag-remove]');
                    if (!remove) return;
                    const tag = String(remove.dataset.pivotDagApprovalTagRemove || '').trim();
                    renderApprovalTags(control, approvalTagsFromControl(control).filter(item => item !== tag));
                });
            });
            modal.querySelectorAll('[data-pivot-dag-tag-list]').forEach(control => bindTagList({ control, setActiveField, showToast: (...args) => window.Pivot.legacy.showToast?.(...args) }));
            modal.querySelectorAll('[data-pivot-dag-workflow-input-default]').forEach(control => bindWorkflowInputDefault({ control, typeControl: fieldsByName.get('type'), setActiveField, showToast: (...args) => window.Pivot.legacy.showToast?.(...args) }));
            modal.querySelectorAll('[data-pivot-dag-approval-levels]').forEach(control => {
                const source = control.querySelector('[data-pivot-dag-approval-level-source]');
                const custom = control.querySelector('[data-pivot-dag-approval-level-custom]');
                source?.addEventListener('change', () => {
                    syncApprovalLevelSource(control);
                    if (source.value === '__custom__') custom?.focus?.({ preventScroll: true });
                });
                custom?.addEventListener('input', () => setActiveField(control));
                control.querySelector('[data-pivot-dag-approval-level-add]')?.addEventListener('click', () => {
                    const current = approvalLevelsFromControl(control);
                    if (current === null) return;
                    if (typeof current === 'string') {
                        source.value = '';
                        custom.value = '';
                        syncApprovalLevelSource(control);
                    }
                    const levels = Array.isArray(current) ? current : [];
                    if (levels.length >= 10) {
                        window.Pivot.legacy.showToast?.('审批级别最多 10 级。', 'warning');
                        return;
                    }
                    renderApprovalLevels(control, [...levels, {}]);
                });
                control.addEventListener('click', event => {
                    const remove = event.target.closest('[data-pivot-dag-approval-level-remove]');
                    if (!remove) return;
                    const level = remove.closest('[data-pivot-dag-approval-level]');
                    level?.remove();
                    const remaining = [...control.querySelectorAll('[data-pivot-dag-approval-level]')];
                    if (!remaining.length) {
                        renderApprovalLevels(control, [{}]);
                        return;
                    }
                    remaining.forEach((item, index) => {
                        const position = index + 1;
                        const heading = item.querySelector('.pivot-dag-approval-level-head strong');
                        const button = item.querySelector('[data-pivot-dag-approval-level-remove]');
                        if (heading) heading.textContent = `第 ${position} 级审批`;
                        if (button) button.setAttribute('aria-label', `删除第 ${position} 级审批`);
                    });
                });
                control.addEventListener('focusin', () => setActiveField(control));
                syncApprovalLevelSource(control);
            });
            modal.querySelectorAll('[data-pivot-dag-browser-target]').forEach(control => {
                const source = control.querySelector('[data-pivot-dag-browser-target-source]');
                const custom = control.querySelector('[data-pivot-dag-browser-target-custom]');
                const mode = control.querySelector('[data-pivot-dag-browser-target-mode]');
                source?.addEventListener('change', () => {
                    syncBrowserTargetMode(control);
                    if (source.value === '__custom__') custom?.focus?.({ preventScroll: true });
                });
                mode?.addEventListener('change', () => syncBrowserTargetMode(control));
                control.addEventListener('focusin', () => setActiveField(control));
                syncBrowserTargetMode(control);
            });
            modal.querySelectorAll('[data-pivot-dag-data-field-picker]').forEach(control => {
                const select = control.querySelector('[data-pivot-dag-data-field-select]');
                const manual = control.querySelector('[data-pivot-dag-data-field-manual]');
                const sync = () => {
                    const manualMode = select?.value === '__manual__';
                    manual?.classList.toggle('is-visible', manualMode);
                    if (manualMode) manual?.focus?.({ preventScroll: true });
                };
                select?.addEventListener('change', sync);
                sync();
            });
            modal.querySelectorAll('[data-pivot-dag-keyvalue-map]').forEach(control => bindKeyValueMap({
                control,
                setActiveField,
                onActiveInput: input => { activeKeyValueInput = input; }
            }));
            modal.querySelectorAll('[data-pivot-dag-channel-binding-picker]').forEach(control => bindChannelBindingPicker({
                control, setActiveField, apiFetchFn: apiFetch, apiBase: API_BASE,
                showToast: (...args) => window.Pivot.legacy.showToast?.(...args)
            }));
            modal.querySelectorAll('[data-pivot-dag-credential-picker]').forEach(control => bindCredentialPicker({ control, setActiveField, apiFetchFn: apiFetch, apiBase: API_BASE, showToast: (...args) => window.Pivot.legacy.showToast?.(...args) }));
            syncConditionCompareField = bindConditionCompareField({ fieldsByName, setActiveField });
            syncBrowserTargetVisibility = bindBrowserTargetVisibility({ fieldsByName, setActiveField });
            syncOutputPresentationFields = bindOutputPresentationFields({ fieldsByName, setActiveField });
            modal.querySelectorAll('[data-pivot-dag-report-sheet-picker]').forEach(control => bindReportSheetPicker({ control, fieldsByName, properties, tool, wizardTools, callTool: callWizardTool, getFieldValue, setActiveField, showToast: (...args) => window.Pivot.legacy.showToast?.(...args) }));
            modal.querySelectorAll('[data-pivot-dag-report-path-picker]').forEach(control => {
                const select = control.querySelector('[data-pivot-dag-report-path-select]');
                const custom = control.querySelector('[data-pivot-dag-report-path-custom]');
                const loadButton = control.querySelector('[data-pivot-dag-report-path-load]');
                const syncCustom = () => {
                    const active = select?.value === '__custom__';
                    custom?.classList.toggle('is-visible', active);
                    if (active) custom?.focus?.({ preventScroll: true });
                };
                select?.addEventListener('change', () => {
                    setActiveField(control);
                    syncCustom();
                });
                custom?.addEventListener('input', () => setActiveField(control));
                syncCustom();
                loadButton?.addEventListener('click', async () => {
                    const listTool = wizardTools.find(item => toolShortName(item) === 'reports.list_files');
                    if (!listTool) {
                        window.Pivot.legacy.showToast?.('当前工作流没有可用的“列出报表文件”权限。', 'warning');
                        return;
                    }
                    const originalText = loadButton.textContent;
                    loadButton.disabled = true;
                    loadButton.textContent = '正在读取…';
                    try {
                        const result = await callWizardTool(listTool, { limit: 100 });
                        const files = Array.isArray(result?.files) ? result.files : (Array.isArray(result) ? result : []);
                        const entries = files.map(file => {
                            const value = typeof file === 'string'
                                ? file
                                : (file?.relativePath || file?.relative_path || file?.path || file?.name || '');
                            const name = typeof file === 'string' ? file : (file?.name || value);
                            const size = Number(file?.size || file?.sizeBytes || 0);
                            return { value, label: size > 0 ? `${name} · ${Math.ceil(size / 1024)} KB` : name };
                        });
                        renderResourceOptions(
                            select,
                            entries,
                            select?.value || '',
                            '请选择可访问文件',
                            path => `当前文件：${path}`
                        );
                        window.Pivot.legacy.showToast?.(entries.length ? `已读取 ${entries.length} 个可访问文件。` : '没有读取到可访问文件。', entries.length ? 'success' : 'warning');
                    } catch (error) {
                        window.Pivot.legacy.showToast?.(error.message || '读取可访问文件失败。', 'error');
                    } finally {
                        loadButton.disabled = false;
                        loadButton.textContent = originalText;
                    }
                });
            });
            modal.querySelectorAll('[data-pivot-dag-artifact-picker]').forEach(control => {
                const select = control.querySelector('[data-pivot-dag-artifact-select]');
                const custom = control.querySelector('[data-pivot-dag-artifact-custom]');
                const loadButton = control.querySelector('[data-pivot-dag-artifact-load]');
                const syncCustom = () => {
                    const active = select?.value === '__custom__';
                    custom?.classList.toggle('is-visible', active);
                    if (active) custom?.focus?.({ preventScroll: true });
                };
                select?.addEventListener('change', () => {
                    setActiveField(control);
                    syncCustom();
                });
                custom?.addEventListener('input', () => setActiveField(control));
                syncCustom();
                loadButton?.addEventListener('click', async () => {
                    const originalText = loadButton.textContent;
                    loadButton.disabled = true;
                    loadButton.textContent = '正在读取…';
                    try {
                        const response = await apiFetch(`${API_BASE}/agents/artifacts?limit=100`, { cache: 'no-store' });
                        const data = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(data.error || '读取可用产物失败。');
                        const artifacts = Array.isArray(data.data) ? data.data : [];
                        const entries = artifacts.map(artifact => {
                            const title = String(artifact.title || `产物 #${artifact.id}`).trim();
                            const details = [artifact.type, artifact.current_version ? `版本 ${artifact.current_version}` : ''].filter(Boolean).join(' · ');
                            return { value: artifact.id, label: details ? `${title} · ${details}` : title };
                        });
                        renderResourceOptions(
                            select,
                            entries,
                            select?.value || '',
                            '请选择可用产物',
                            id => `当前产物 #${id}`
                        );
                        window.Pivot.legacy.showToast?.(entries.length ? `已读取 ${entries.length} 个可用产物。` : '没有可用产物。', entries.length ? 'success' : 'warning');
                    } catch (error) {
                        window.Pivot.legacy.showToast?.(error.message || '读取可用产物失败。', 'error');
                    } finally {
                        loadButton.disabled = false;
                        loadButton.textContent = originalText;
                    }
                });
            });
            modal.querySelectorAll('[data-pivot-dag-structured-reference]').forEach(control => {
                const manual = modal.querySelector(`[data-pivot-dag-structured-manual="${control.dataset.pivotDagStructuredReference}"]`);
                const syncManual = () => {
                    const advanced = control.value === '__manual__';
                    if (manual) manual.classList.toggle('is-visible', advanced);
                    if (!advanced && manual) manual.value = '';
                };
                control.addEventListener('change', syncManual);
                syncManual();
                manual?.addEventListener('focus', () => setActiveField(control));
                manual?.addEventListener('input', () => setActiveField(control));
            });
            modal.querySelectorAll('[data-pivot-dag-wizard-token]').forEach(btn => {
                btn.addEventListener('click', () => insertWizardToken(btn.dataset.pivotDagWizardToken || '', btn.dataset.pivotDagWizardTarget || ''));
            });
            modal.querySelector('[data-pivot-dag-load-tables]')?.addEventListener('click', loadAssistTables);
            modal.querySelector('[data-pivot-dag-load-columns]')?.addEventListener('click', loadAssistColumns);
            modal.querySelector('[data-pivot-dag-db-connection-select]')?.addEventListener('change', () => {
                syncAssistConnection();
                queryBuilder?.onConnectionChange();
            });
            modal.querySelector('[data-pivot-dag-assist-column]')?.addEventListener('input', event => syncAssistValue('groupBy', event.target.value));
            modal.querySelector('[data-pivot-dag-wizard-close]')?.addEventListener('click', closeWizard);
            modal.querySelector('[data-pivot-dag-wizard-apply]')?.addEventListener('click', applyWizard);
            modal.querySelector('[data-pivot-dag-wizard-clear]')?.addEventListener('click', () => resetWizard({}));
            modal.querySelector('[data-pivot-dag-wizard-template]')?.addEventListener('click', () => resetWizard(templateInput));
            syncFormWithDraft(initialInput);
            modal.classList.remove('hidden');
        };
        const { openStatsChartWizard } = createDagWizardStatsController(ctx);
        return {
            renderInputSummary,
            openNodeInputWizard,
            openStatsChartWizard
        };
    }
