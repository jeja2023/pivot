/* DAG 输入向导字段渲染（拆自 dag-wizard-input.js） */




        const renderWizardField = (name, schema = {}, value, required = false, dependencyNodes = [], tool = null, wizardTools = []) => {
            const type = normalizeSchemaType(schema);
            const typeLabel = friendlySchemaTypeLabel(schema);
            const label = friendlyFieldLabel(name, schema, tool);
            const description = friendlyFieldDescription(name, schema, tool);
            const placeholder = friendlyFieldPlaceholder(name, schema, required, tool);
            const isEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
            const fieldName = String(name || '');
            const isDatabaseConnection = isDatabaseConnectionField(name, tool);
            const isSubworkflowSelector = toolValue(tool) === 'workflow.subworkflow' && normalizeFieldKey(name) === 'workflowid';
            const codeTextArea = type === 'array'
                || type === 'object'
                || /rows|sections|sql|json/i.test(fieldName);
            const wideRichTextArea = /content|instructions|markdown|message|prompt/i.test(fieldName);
            const proseTextArea = /query|summary|text/i.test(fieldName);
            const useTextArea = codeTextArea || wideRichTextArea || proseTextArea;
            const fieldValue = formatWizardFieldValue(schema, value);
            const suggestions = isDatabaseConnection ? [] : buildWizardFieldSuggestions(name, schema, dependencyNodes);
            const isLlmModelField = toolValue(tool) === 'agent.llm' && normalizeFieldKey(name) === 'model';
            const isSelect = isDatabaseConnection || isSubworkflowSelector || isLlmModelField || isEnum;
            const isNumber = type === 'integer' || type === 'number';
            const fieldClasses = [
                'pivot-dag-wizard-field',
                useTextArea ? 'is-textarea' : '',
                codeTextArea || wideRichTextArea ? 'is-wide' : '',
                codeTextArea ? 'is-code' : '',
                useTextArea && !codeTextArea ? 'is-rich' : '',
                proseTextArea && !codeTextArea && !wideRichTextArea ? 'is-prose' : '',
                isSelect ? 'is-select' : '',
                isNumber ? 'is-number' : '',
                type === 'boolean' ? 'is-boolean' : '',
                isDatabaseConnection ? 'is-database-connection' : ''
            ].filter(Boolean).join(' ');
            let controlHtml = '';
            if (isDatabaseConnection) {
                const options = databaseToolConnectionOptions(tool, wizardTools);
                const selectedId = selectedDatabaseConnectionId(tool, { [name]: value }, wizardTools);
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-db-connection-select="1">
                        ${options.length
                            ? options.map(option => {
                                const optionLabel = [option.serverName || `数据库 ${option.serverId}`, option.databaseType].filter(Boolean).join(' · ');
                                return `<option value="${dagEscapeAttr(option.serverId)}" ${String(option.serverId) === String(selectedId) ? 'selected' : ''}>${dagEscapeHtml(optionLabel)}</option>`;
                            }).join('')
                            : '<option value="">暂无可用数据库连接</option>'}
                    </select>
                `;
            } else if (isSubworkflowSelector) {
                const automation = window.Pivot.moduleApi('agent.automation');
                const currentId = automation.currentWorkflowId?.() || '';
                const workflows = (automation.listWorkflows?.() || [])
                    .filter(item => Number(item.published_version || 0) > 0 && String(item.id) !== String(currentId));
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}">
                        <option value="">— 选择已发布工作流 —</option>
                        ${workflows.map(item => `<option value="${dagEscapeAttr(item.id)}" ${String(item.id) === String(value ?? '') ? 'selected' : ''}>${dagEscapeHtml(`${item.name} · v${item.published_version}`)}</option>`).join('')}
                    </select>
                `;
            } else if (type === 'boolean') {
                controlHtml = `
                    <span class="pivot-dag-wizard-toggle">
                        <input type="checkbox" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" ${Boolean(value) ? 'checked' : ''}>
                        <span>${dagEscapeHtml(required ? '必填' : '可选')}</span>
                    </span>
                `;
            } else if (isLlmModelField && workflowModelOptions().length) {
                const modelOptions = workflowModelOptions();
                const selectedModelId = String(fieldValue || defaultWorkflowModelId() || '').trim();
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}">
                        ${modelOptions.map(model => {
                            const valueId = String(model.id || '').trim();
                            const labelText = `${model.name || model.model_name || valueId}${model.user_id ? '（个人）' : ''}`;
                            return `<option value="${dagEscapeAttr(valueId)}" ${String(valueId) === selectedModelId ? 'selected' : ''}>${dagEscapeHtml(labelText)}</option>`;
                        }).join('')}
                    </select>
                `;
            } else if (isEnum) {
                const emptyOption = required ? '' : '<option value="">— 选择 —</option>';
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}">
                        ${emptyOption}
                        ${schema.enum.map(option => `<option value="${dagEscapeAttr(option)}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${dagEscapeHtml(friendlyEnumOptionLabel(name, option))}</option>`).join('')}
                    </select>
                `;
            } else if (type === 'integer' || type === 'number') {
                const step = type === 'integer' ? '1' : 'any';
                controlHtml = `<input class="form-input" type="number" step="${step}" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" value="${dagEscapeAttr(fieldValue)}" placeholder="${dagEscapeAttr(placeholder)}">`;
            } else if (useTextArea) {
                const rows = codeTextArea ? 9 : (wideRichTextArea ? 7 : 5);
                const spellcheck = codeTextArea ? ' spellcheck="false"' : '';
                controlHtml = `<textarea class="form-input pivot-dag-wizard-textarea" rows="${rows}" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" placeholder="${dagEscapeAttr(placeholder)}"${spellcheck}>${dagEscapeHtml(fieldValue)}</textarea>`;
            } else {
                controlHtml = `<input class="form-input" type="text" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" value="${dagEscapeAttr(fieldValue)}" placeholder="${dagEscapeAttr(placeholder)}">`;
            }

            const usageHint = type === 'array' || type === 'object'
                ? '适合填结构化数据，也可以直接插入上游结果行。'
                : isTextualSchemaField(name, schema)
                    ? '适合填文字、提示词、SQL 或 Markdown。'
                    : '可以直接填写，必要时也能插入变量。';
            const suggestionHtml = suggestions.length
                ? `
                    <div class="pivot-dag-wizard-field-suggestions">
                        <span class="pivot-dag-wizard-field-suggestions-label">推荐引用</span>
                        <div class="pivot-dag-wizard-field-suggestions-list">
                            ${suggestions.map(item => `
                                <button type="button" class="pivot-dag-token-btn pivot-dag-wizard-suggestion-btn" data-pivot-dag-wizard-token="${dagEscapeAttr(item.token)}" data-pivot-dag-wizard-target="${dagEscapeAttr(name)}" title="${dagEscapeAttr(item.token)}">${dagEscapeHtml(item.label)}</button>
                            `).join('')}
                        </div>
                    </div>
                `
                : '';

            return `
                <label class="${fieldClasses}" data-pivot-dag-wizard-field-wrap="${dagEscapeAttr(name)}">
                    <span class="pivot-dag-wizard-field-head">
                        <strong>${dagEscapeHtml(label)}</strong>
                        <span>
                            <em>${dagEscapeHtml(typeLabel)}</em>
                            ${required ? '<em class="is-required">必填</em>' : '<em>可选</em>'}
                        </span>
                    </span>
                    ${controlHtml}
                    ${description ? `<span class="pivot-dag-wizard-field-desc">${dagEscapeHtml(description)}</span>` : ''}
                    <span class="pivot-dag-wizard-field-usage">${dagEscapeHtml(fieldUsageHint(name, schema, tool) || usageHint)}</span>
                    ${suggestionHtml}
                </label>
            `;
        };

        const renderDatabaseAssistPanel = (node, tool, initialInput = {}, wizardTools = []) => {
            const shortName = toolShortName(tool);
            if (!shortName.startsWith('db.')) return '';
            const selectedServerId = selectedDatabaseConnectionId(tool, initialInput, wizardTools);
            const entries = databaseWizardConnections(wizardTools);
            const selectedEntry = entries.find(item => item.serverId === selectedServerId);
            if (!selectedEntry && !databaseToolConnectionOptions(tool, wizardTools).length) return '';
            const canPickTable = ['db.describe_table', 'db.group_count'].includes(shortName);
            const canPickColumn = shortName === 'db.group_count';
            const canLoadTables = canPickTable && entries.some(entry => Boolean(entry.tools['db.list_tables']));
            const canLoadColumns = canPickColumn && entries.some(entry => Boolean(entry.tools['db.describe_table']));
            if (!canLoadTables && !canLoadColumns) return '';
            return `
                <section class="pivot-dag-wizard-assist" data-pivot-dag-db-assist="${dagEscapeAttr(selectedServerId)}">
                    <div class="pivot-dag-wizard-assist-head">
                        <div>
                            <strong>数据库辅助</strong>
                            <span data-pivot-dag-assist-connection-label>${dagEscapeHtml(selectedEntry?.serverName || databaseConnectionLabel(tool, selectedServerId, wizardTools) || '当前数据库')}</span>
                        </div>
                        <div class="pivot-dag-wizard-assist-actions">
                            ${canLoadTables ? '<button type="button" class="btn-secondary" data-pivot-dag-load-tables="1">读取表</button>' : ''}
                            ${canLoadColumns ? '<button type="button" class="btn-secondary" data-pivot-dag-load-columns="1">读取字段</button>' : ''}
                        </div>
                    </div>
                    <div class="pivot-dag-wizard-assist-grid">
                        <label>
                            <span>Schema / 命名空间</span>
                            <input class="form-input" data-pivot-dag-assist-schema value="${dagEscapeAttr(initialInput.schema || '')}" placeholder="可选，例如 public / dbo">
                        </label>
                        ${canLoadTables ? `
                            <label>
                                <span>数据表</span>
                                <input class="form-input" list="pivot-dag-assist-table-options" data-pivot-dag-assist-table value="${dagEscapeAttr(initialInput.table || '')}" placeholder="读取后选择或手动输入">
                            </label>
                            <datalist id="pivot-dag-assist-table-options"></datalist>
                        ` : ''}
                        ${canLoadColumns ? `
                            <label>
                                <span>字段</span>
                                <input class="form-input" list="pivot-dag-assist-column-options" data-pivot-dag-assist-column value="${dagEscapeAttr(initialInput.groupBy || '')}" placeholder="读取字段后选择">
                            </label>
                            <datalist id="pivot-dag-assist-column-options"></datalist>
                        ` : ''}
                    </div>
                    <div class="pivot-dag-wizard-assist-status" data-pivot-dag-assist-status></div>
                </section>
            `;
        };
