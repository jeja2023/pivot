/* Agent DAG 参数与预设工作流向导（拆自 agents-dag-editor.js） */



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
            const fields = Object.entries(properties).filter(([name]) => !isVisualSqlQuery || !['sql', 'limit'].includes(name));
            const dependencyNodes = buildWizardDependencyNodes(node, ctx.spec.nodes);
            let modal = document.getElementById('pivot-dag-input-wizard');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'pivot-dag-input-wizard';
                modal.className = 'modal-overlay hidden pivot-dag-input-wizard-overlay';
                document.body.appendChild(modal);
            }
            const templateInput = buildToolInputTemplate(tool);
            const currentInput = cloneDagInput(node.input);
            if (tool?.databaseTool && !databaseConnectionInputValue(currentInput)) {
                const legacyConnectionId = databaseConnectionIdFromToolValue(node.tool);
                if (legacyConnectionId) currentInput.connectionId = legacyConnectionId;
            }
            const initialInput = { ...templateInput, ...currentInput };
            const fieldMarkup = fields.length
                ? fields.map(([name, fieldSchema]) => renderWizardField(name, fieldSchema, initialInput[name], required.has(name), dependencyNodes, tool, wizardTools)).join('')
                : '<div class="pivot-dag-wizard-empty">当前工具不需要配置参数，直接应用即可。</div>';
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
                                    <span>表单会保存到节点参数；需要填写复杂结构时再打开高级参数编辑。</span>
                                </div>
                                <div class="pivot-dag-wizard-overview-body">
                                    ${renderInputSummary(initialInput, tool, wizardTools)}
                                </div>
                            </section>
                            ${isVisualSqlQuery ? fieldMarkup : ''}
                            ${isVisualSqlQuery
                                ? renderVisualSqlBuilder(initialInput)
                                : renderDatabaseAssistPanel(node, tool, initialInput, wizardTools)}
                            ${isVisualSqlQuery ? '' : fieldMarkup}
                        </div>
                        <aside class="pivot-dag-wizard-sources">
                            <div class="pivot-dag-wizard-sources-title">变量引用</div>
                            ${renderWizardFieldSources(node, dependencyNodes)}
                        </aside>
                    </div>
                    <div class="agent-workflow-create-actions pivot-dag-wizard-actions">
                        <button type="button" class="btn-secondary" data-pivot-dag-wizard-template="1">套用模板</button>
                        <button type="button" class="btn-secondary" data-pivot-dag-wizard-clear="1">清空</button>
                        <button type="button" class="btn-primary" data-pivot-dag-wizard-apply="1">应用</button>
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

            const populateFields = (draftInput = {}) => {
                fields.forEach(([name, fieldSchema]) => {
                    const control = fieldsByName.get(name);
                    if (!control) return;
                    const nextValue = draftInput[name];
                    const type = normalizeSchemaType(fieldSchema);
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
            };

            const getFieldValue = (control, fieldSchema) => {
                const type = normalizeSchemaType(fieldSchema);
                if (control.type === 'checkbox' || type === 'boolean') return Boolean(control.checked);
                const raw = String(control.value ?? '').trim();
                if (!raw) return undefined;
                if (type === 'integer') {
                    const value = Number.parseInt(raw, 10);
                    return Number.isFinite(value) ? value : undefined;
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
            const setActiveField = (control) => {
                activeFieldControl = control;
            };

            const insertWizardToken = (token, targetFieldName = '') => {
                const control = targetFieldName ? fieldsByName.get(targetFieldName) : activeFieldControl;
                if (!token || !control) return;
                setActiveField(control);
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
                const nextInput = cloneDagInput(node.input);
                const missing = [];
                fields.forEach(([name, fieldSchema]) => {
                    const control = fieldsByName.get(name);
                    if (!control) return;
                    const value = getFieldValue(control, fieldSchema);
                    if (value === undefined) {
                        if (required.has(name)) missing.push(name);
                        else delete nextInput[name];
                        return;
                    }
                    nextInput[name] = value;
                });
                if (tool?.databaseTool) {
                    const connectionId = databaseConnectionInputValue(nextInput);
                    delete nextInput.connection_id;
                    delete nextInput.databaseConnectionId;
                    delete nextInput.database_connection_id;
                    delete nextInput.mcpServerId;
                    delete nextInput.mcp_server_id;
                    if (connectionId) nextInput.connectionId = connectionId;
                }
                if (queryBuilder) {
                    const built = queryBuilder.collect();
                    if (built.error) {
                        window.showToast?.(built.error, 'error');
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
                    window.showToast?.(`请先填写：${missingLabels.join('、')}`, 'error');
                    return null;
                }
                // 保留高级 JSON 里已有但向导没覆盖的字段。
                Object.keys(node.input || {}).forEach(key => {
                    if (
                        tool?.databaseTool
                        && ['connection_id', 'databaseConnectionId', 'database_connection_id', 'mcpServerId', 'mcp_server_id'].includes(key)
                    ) {
                        return;
                    }
                    if (!Object.prototype.hasOwnProperty.call(properties, key) && nextInput[key] === undefined) {
                        nextInput[key] = node.input[key];
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
                syncLlmOutputContract(node, nextInput);
                render();
                flushOut();
                closeWizard();
                window.showToast?.('节点参数已更新', 'success');
            };

            const resetWizard = (draftInput = {}) => {
                syncFormWithDraft(draftInput);
                queryBuilder?.hydrate(draftInput);
            };

            modal.querySelectorAll('[data-pivot-dag-wizard-field]').forEach(control => {
                control.addEventListener('focus', () => setActiveField(control));
                control.addEventListener('click', () => setActiveField(control));
                control.addEventListener('input', () => setActiveField(control));
                control.addEventListener('change', () => setActiveField(control));
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
            modal.querySelector('[data-pivot-dag-assist-schema]')?.addEventListener('input', event => syncAssistValue('schema', event.target.value));
            modal.querySelector('[data-pivot-dag-assist-table]')?.addEventListener('input', event => syncAssistValue('table', event.target.value));
            modal.querySelector('[data-pivot-dag-assist-column]')?.addEventListener('input', event => syncAssistValue('groupBy', event.target.value));
            modal.querySelector('[data-pivot-dag-wizard-close]')?.addEventListener('click', closeWizard);
            modal.querySelector('[data-pivot-dag-wizard-apply]')?.addEventListener('click', applyWizard);
            modal.querySelector('[data-pivot-dag-wizard-clear]')?.addEventListener('click', () => resetWizard({}));
            modal.querySelector('[data-pivot-dag-wizard-template]')?.addEventListener('click', () => resetWizard(templateInput));
            modal.addEventListener('click', event => {
                if (event.target === modal) closeWizard();
            }, { once: true });

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

