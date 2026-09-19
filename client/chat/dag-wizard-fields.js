/* DAG 输入向导字段渲染（拆自 dag-wizard-input.js） */
/* global buildSchemaReferenceTokens, buildWizardDataFieldOptions, toolShortName */

const resolveToolShortName = tool => {
    if (typeof toolShortName === 'function') {
        try {
            return toolShortName(tool);
        } catch {
            // 回退到工具全名或别名解析
        }
    }
    const raw = String(tool?.fullName || tool?.full_name || tool?.toolName || tool?.name || '').trim();
    const match = raw.match(/^(?:mcp\.[^.]+\.)?(.+)$/i);
    return match ? match[1] : raw;
};

        const renderWizardField = (name, schema = {}, value, required = false, dependencyNodes = [], tool = null, wizardTools = [], nodeToolName = '', nodeTitle = '') => {
            const type = normalizeSchemaType(schema);
            const typeLabel = friendlySchemaTypeLabel(schema);
            const label = friendlyFieldLabel(name, schema, tool);
            const description = friendlyFieldDescription(name, schema, tool);
            const placeholder = friendlyFieldPlaceholder(name, schema, required, tool);
            const isEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
            const fieldName = String(name || '');
            const fieldKey = normalizeFieldKey(name);
            const shortToolName = resolveToolShortName(tool);
            const normalizedToolNames = [...new Set([
                nodeToolName,
                tool?.fullName,
                tool?.full_name,
                tool?.name,
                tool?.toolName,
                tool?.tool_name,
                shortToolName
            ].map(item => String(item || '').trim().replace(/^mcp\.[^.]+\./i, '')).filter(Boolean))];
            const matchesTool = toolName => normalizedToolNames.includes(toolName);
            const isDatabaseConnection = isDatabaseConnectionField(name, tool);
            const isSubworkflowSelector = matchesTool('workflow.subworkflow') && normalizeFieldKey(name) === 'workflowid';
            const isContentReviewRecords = matchesTool('agent.content_review') && normalizeFieldKey(name) === 'records';
            const isContentReviewSourceField = matchesTool('agent.content_review')
                && ['records', 'rows', 'data'].includes(normalizeFieldKey(name));
            const isGroupSummaryGroupBy = normalizeFieldKey(name) === 'groupby'
                && (matchesTool('data.group_summary')
                    || /^(?:数据)?分组汇总(?:数据)?$/.test(String(tool?.title || '').trim())
                    || /^(?:数据)?分组汇总(?:数据)?$/.test(String(nodeTitle || '').trim())
                    || /一个或多个分组字段|多个字段组合/.test(String(schema?.description || ''))
                    || Array.isArray(value));
            const isApprovalTagField = matchesTool('workflow.approval')
                && ['approvers', 'approveruserids', 'approverunits'].includes(normalizeFieldKey(name));
            const isHandoffTagField = matchesTool('agent.handoff')
                && type === 'array'
                && ['findings', 'evidence', 'risks', 'open_questions', 'openquestions'].includes(fieldKey);
            const isWorkflowInputDefaultField = matchesTool('workflow.input') && ['default_value', 'defaultvalue'].includes(fieldKey);
            const isApprovalLevels = matchesTool('workflow.approval')
                && normalizeFieldKey(name) === 'approvallevels';
            const isChannelBindingField = matchesTool('workflow.notify') && /^(?:binding_id|bindingid)$/.test(fieldKey);
            const isBrowserTargetField = ['agent.browser', 'browser.click'].includes(shortToolName)
                && normalizeFieldKey(name) === 'target';
            const isReportPathField = ['reports.read_file_summary', 'reports.query_table', 'reports.compare_files'].includes(shortToolName)
                && ['path', 'leftpath', 'rightpath'].includes(normalizeFieldKey(name));
            const isReportSheetField = ['reports.read_file_summary', 'reports.query_table', 'reports.compare_files'].includes(shortToolName)
                && fieldKey === 'sheet';
            const isReportQueryColumns = shortToolName === 'reports.query_table' && fieldKey === 'columns';
            const isReportQueryFilters = shortToolName === 'reports.query_table' && fieldKey === 'filters';
            const isArtifactSelector = /^artifactid$/i.test(fieldName) && /^artifact\./.test(shortToolName);
            const isWorkflowCredentialField = matchesTool('agent.http') && /^(?:credential_secret|credentialsecret)$/.test(fieldKey);
            const isDataFieldSelector = /^(valuefield|xaxis|yaxis|idfield|titlefield|contentfield)$/i.test(fieldName)
                || (matchesTool('viz.build_chart') && fieldKey === 'groupby');
            const isColumnSelector = /^(columns|tablecolumns)$/i.test(fieldName) && type === 'array';
            const isKeyValueMapField = type === 'object'
                && /^(filters|renamemap|fields|headers|body|vars|inputs|sections)$/i.test(fieldName)
                && (!value || (typeof value === 'object' && !Array.isArray(value)));
            const isDelayDuration = matchesTool('workflow.delay') && normalizeFieldKey(name) === 'duration_ms';
            const dataFieldOptions = (isGroupSummaryGroupBy || isDataFieldSelector || isColumnSelector || isKeyValueMapField)
                && typeof buildWizardDataFieldOptions === 'function'
                ? buildWizardDataFieldOptions(dependencyNodes)
                : [];
            const groupByFields = (Array.isArray(value) ? value : [value])
                .flatMap(item => typeof item === 'string' ? item.split(',') : [item])
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .filter((item, index, items) => items.indexOf(item) === index);
            const isStructuredReferenceField = !isGroupSummaryGroupBy
                && !isApprovalTagField
                && !isHandoffTagField
                && !isWorkflowInputDefaultField
                && !isApprovalLevels
                && !isBrowserTargetField
                && !isDataFieldSelector
                && !isColumnSelector
                && !isKeyValueMapField
                && (isContentReviewSourceField || type === 'array' || type === 'object');
            const codeTextArea = !isStructuredReferenceField
                && !isDataFieldSelector
                && !isColumnSelector
                && !isKeyValueMapField
                && !isApprovalTagField
                && !isHandoffTagField
                && !isWorkflowInputDefaultField
                && !isReportPathField
                && !isReportSheetField
                && !isArtifactSelector
                && (type === 'array'
                || type === 'object'
                || isContentReviewRecords
                || /rows|sections|sql|json/i.test(fieldName));
            const wideRichTextArea = /content|instructions|markdown|message|prompt/i.test(fieldName);
            const proseTextArea = /query|summary|text/i.test(fieldName);
            const useTextArea = codeTextArea || wideRichTextArea || proseTextArea;
            const fieldValue = isDelayDuration
                ? String(Math.max(0, Number(value ?? schema.default ?? 0)) / 1000)
                : formatWizardFieldValue(schema, value);
            const suggestions = isDatabaseConnection ? [] : buildWizardFieldSuggestions(name, schema, dependencyNodes);
            const supportsStructuredReference = isStructuredReferenceField || isApprovalLevels || isBrowserTargetField;
            const structuredReferenceOptions = supportsStructuredReference
                ? [...new Map([
                    ...suggestions
                        .filter(item => /^\{\{nodes\./.test(String(item.token || '')))
                        .map(item => [item.token, { token: item.token, label: item.label }]),
                    ...dependencyNodes.flatMap(depNode => {
                        const title = depNode.title || depNode.id;
                        return [
                            { token: `{{nodes.${depNode.id}.output}}`, label: `${title} · 完整结果` },
                            { token: `{{nodes.${depNode.id}.output.rows}}`, label: `${title} · 数据行` },
                            { token: `{{nodes.${depNode.id}.output.data}}`, label: `${title} · data` },
                            { token: `{{nodes.${depNode.id}.output.items}}`, label: `${title} · items` },
                            { token: `{{nodes.${depNode.id}.output.structuredContent.rows}}`, label: `${title} · structuredContent.rows` }
                        ];
                    })
                ].map(item => [item.token, item])).values()]
                : [];
            const hasManualStructuredValue = Array.isArray(value)
                ? value.length > 0
                : (value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(String(value || '').trim()));
            const isKnownStructuredReference = structuredReferenceOptions.some(item => item.token === fieldValue);
            const visualStructureReference = isKnownStructuredReference
                ? fieldValue
                : (typeof value === 'string' && value.trim() ? '__custom__' : '');
            const isLlmModelField = (['agent.llm', 'agent.content_review', 'agent.delegate'].includes(toolValue(tool))
                || ['agent.llm', 'agent.content_review', 'agent.delegate'].some(matchesTool))
                && normalizeFieldKey(name) === 'model';
            const modelOptions = isLlmModelField ? workflowModelOptions() : [];
            const isSelect = isChannelBindingField || isWorkflowCredentialField || isDatabaseConnection || isSubworkflowSelector || isLlmModelField || isEnum;
            const isNumber = type === 'integer' || type === 'number';
            const isStaticConfigurationField = /^(name|label|default_value|description|binding_id|workflow_id|version|credential_ref|credential_secret|credential_header|credential_prefix|event_type|callback_base_url|callback_credential|im_server_id|im_target_type|agent_name|from_agent|to_agent|role|task_id)$/i.test(fieldKey);
            const isExecutionTuningField = /^(?:limit|outputlimit|max(?:steps|tokens|records|summarychars|width|height)|timeout(?:ms|hours)?|concurrency|retrylimit|samplerows|chunktokens|overlaptokens|temperature|height|width|maxwidth|maxheight)$/i.test(fieldName);
            const isRuntimeContentField = /^(prompt|system_prompt|instructions|task|context|summary|body|message|markdown|template|text|query|url|value|compare_to|goal|reason|subject|title|subtitle|footer|im_target|idempotency_key)$/i.test(fieldKey);
            const allowsVisualReference = !isStructuredReferenceField
                && !isGroupSummaryGroupBy
                && !isDataFieldSelector
                && !isColumnSelector
                && !isKeyValueMapField
                && !isApprovalLevels
                && !isBrowserTargetField
                && !isReportPathField
                && !isArtifactSelector
                && !isDatabaseConnection
                && !isSubworkflowSelector
                && !isLlmModelField
                && !isEnum
                && type !== 'boolean'
                && !isNumber
                && !isExecutionTuningField
                && !isDelayDuration
                && !isStaticConfigurationField
                && isRuntimeContentField
                && !/^(code|sql)$/i.test(fieldName);
            const fieldReferenceOptions = allowsVisualReference
                ? [...new Map([
                    { token: '{{goal}}', label: '运行上下文 · 任务目标' },
                    { token: '{{inputs}}', label: '运行上下文 · 全部运行输入' },
                    ...dependencyNodes.flatMap(depNode => {
                        const title = depNode.title || depNode.id;
                        const common = [
                            { token: `{{nodes.${depNode.id}.output}}`, label: `${title} · 完整结果` },
                            { token: `{{nodes.${depNode.id}.output.text}}`, label: `${title} · 文本结果` },
                            { token: `{{nodes.${depNode.id}.output.content}}`, label: `${title} · 内容` },
                            { token: `{{nodes.${depNode.id}.output.data}}`, label: `${title} · data` },
                            { token: `{{nodes.${depNode.id}.output.rows}}`, label: `${title} · 数据行` },
                            { token: `{{nodes.${depNode.id}.output.items}}`, label: `${title} · items` },
                            { token: `{{nodes.${depNode.id}.output.matched}}`, label: `${title} · 条件是否满足` }
                        ];
                        const schemaFields = typeof buildSchemaReferenceTokens === 'function'
                            ? buildSchemaReferenceTokens(depNode, 12).map(item => ({ token: item.token, label: `${title} · ${item.label}` }))
                            : [];
                        return [...common, ...schemaFields];
                    })
                ].map(item => [item.token, item])).values()].slice(0, 48)
                : [];
            const hasExactReference = typeof value === 'string' && /^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(value);
            const hasKnownFieldReference = fieldReferenceOptions.some(item => item.token === fieldValue);
            const initialReferenceValue = hasKnownFieldReference ? fieldValue : (hasExactReference ? '__custom__' : '');
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
                isGroupSummaryGroupBy ? 'is-group-fields' : '',
                isApprovalTagField ? 'is-group-fields is-wide' : '',
                isHandoffTagField ? 'is-special-fields is-wide' : '',
                isWorkflowInputDefaultField ? 'is-special-fields' : '',
                isApprovalLevels || isBrowserTargetField ? 'is-special-fields is-wide' : '',
                isColumnSelector || isKeyValueMapField ? 'is-special-fields is-wide' : '',
                isDataFieldSelector ? 'is-special-fields' : '',
                isChannelBindingField ? 'is-channel-binding' : '',
                isWorkflowCredentialField ? 'is-credential-picker' : '',
                isReportPathField || isArtifactSelector ? 'is-resource-selector' : '',
                isReportSheetField ? 'is-resource-selector' : '',
                isStructuredReferenceField ? 'is-structured-reference is-wide' : '',
                allowsVisualReference ? 'has-visual-reference' : '',
                isDatabaseConnection ? 'is-database-connection' : ''
            ].filter(Boolean).join(' ');
            let controlHtml = '';
            if (isGroupSummaryGroupBy) {
                controlHtml = `
                    <div class="pivot-dag-group-fields" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-group-fields="${dagEscapeAttr(name)}">
                        <div class="pivot-dag-group-fields-list" data-pivot-dag-group-fields-list>
                            ${groupByFields.length
                                ? groupByFields.map(field => `<span class="pivot-dag-group-field-chip" data-pivot-dag-group-field-value="${dagEscapeAttr(field)}">${dagEscapeHtml(field)}<button type="button" class="btn-secondary" data-pivot-dag-group-field-remove="${dagEscapeAttr(field)}" aria-label="移除字段 ${dagEscapeAttr(field)}">×</button></span>`).join('')
                                : '<span class="pivot-dag-group-fields-empty">尚未添加分组字段</span>'}
                        </div>
                        <div class="pivot-dag-group-fields-add">
                            <input class="form-input" type="text" list="pivot-dag-data-field-options-${dagEscapeAttr(name)}" data-pivot-dag-group-field-input placeholder="选择或输入字段名，例如 部门">
                            <button type="button" class="btn-secondary" data-pivot-dag-group-field-add>添加字段</button>
                        </div>
                        <datalist id="pivot-dag-data-field-options-${dagEscapeAttr(name)}">${dataFieldOptions.map(item => `<option value="${dagEscapeAttr(item.value)}">${dagEscapeHtml(item.label)}</option>`).join('')}</datalist>
                        <span class="pivot-dag-group-fields-help">按字段组合分组；字段顺序会保留在结果元数据中。</span>
                    </div>
                `;
            } else if (isWorkflowInputDefaultField) {
                controlHtml = `
                    <div class="pivot-dag-workflow-input-default" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-workflow-input-default="${dagEscapeAttr(name)}">
                        <input class="form-input" type="text" data-pivot-dag-input-default-editor="text" placeholder="不填则由运行时输入决定">
                        <input class="form-input" type="number" step="any" data-pivot-dag-input-default-editor="number" placeholder="例如 100">
                        <select class="form-input" data-pivot-dag-input-default-editor="boolean"><option value="">不设置默认值</option><option value="true">是</option><option value="false">否</option></select>
                        <textarea class="form-input" rows="4" spellcheck="false" data-pivot-dag-input-default-editor="json" placeholder="填写合法 JSON，例如 {&quot;department&quot;:&quot;财务部&quot;}"></textarea>
                        <span class="pivot-dag-structured-ref-help" data-pivot-dag-workflow-input-default-hint>默认值会跟随参数类型显示对应控件。</span>
                    </div>
                `;
            } else if (isWorkflowCredentialField) {
                const resources = typeof window !== 'undefined'
                    ? window.Pivot?.moduleApi?.('agent.automationResources')
                    : null;
                const credentialList = typeof resources?.listCredentials === 'function' ? resources.listCredentials() : [];
                const credentials = Array.isArray(credentialList) ? credentialList : [];
                const currentCredential = String(fieldValue || '').trim();
                const knownCurrent = credentials.some(credential => String(credential?.slug || '').trim() === currentCredential);
                controlHtml = `
                    <div class="pivot-dag-credential-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-credential-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-credential-select>
                            <option value="">不使用受控凭据</option>
                            ${credentials.map(credential => {
                                const slug = String(credential?.slug || '').trim();
                                if (!slug) return '';
                                const label = `${credential.name || slug} · ${slug}`;
                                return `<option value="${dagEscapeAttr(slug)}" ${slug === currentCredential ? 'selected' : ''}>${dagEscapeHtml(label)}</option>`;
                            }).join('')}
                            <option value="__manual__" ${currentCredential && !knownCurrent ? 'selected' : ''}>${currentCredential && !knownCurrent ? '当前引用（未在凭据库中）' : '兼容：手动填写引用名'}</option>
                        </select>
                        <input class="form-input pivot-dag-credential-manual${currentCredential && !knownCurrent ? ' is-visible' : ''}" data-pivot-dag-credential-manual value="${dagEscapeAttr(currentCredential && !knownCurrent ? currentCredential : '')}" placeholder="例如 ERP_API_KEY">
                        <button type="button" class="btn-secondary" data-pivot-dag-credential-load>刷新凭据</button>
                        <span class="pivot-dag-structured-ref-help">选择已授权的凭据引用；密钥内容不会显示、不会写入工作流。旧版环境变量引用可在兼容模式下保留。</span>
                    </div>
                `;
            } else if (isReportPathField) {
                controlHtml = `
                    <div class="pivot-dag-resource-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-report-path-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-report-path-select>
                            <option value="${dagEscapeAttr(fieldValue)}" selected>${fieldValue ? dagEscapeHtml(`当前文件：${fieldValue}`) : '读取授权文件清单后选择'}</option>
                            <option value="__custom__">高级：自定义变量路径</option>
                        </select>
                        <input class="form-input pivot-dag-resource-picker-custom" data-pivot-dag-report-path-custom placeholder="例如 {{nodes.files.output.path}}">
                        <button type="button" class="btn-secondary" data-pivot-dag-report-path-load>读取可访问文件</button>
                        <span class="pivot-dag-structured-ref-help">只显示已由报表服务授权的文件；也可在高级参数中使用变量路径。</span>
                    </div>
                `;
            } else if (isArtifactSelector) {
                controlHtml = `
                    <div class="pivot-dag-resource-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-artifact-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-artifact-select>
                            <option value="${dagEscapeAttr(fieldValue)}" selected>${fieldValue ? dagEscapeHtml(`当前产物 #${fieldValue}`) : '读取当前用户产物后选择'}</option>
                            <option value="__custom__">高级：自定义变量表达式</option>
                        </select>
                        <input class="form-input pivot-dag-resource-picker-custom" data-pivot-dag-artifact-custom placeholder="例如 {{nodes.document.output.artifactId}}">
                        <button type="button" class="btn-secondary" data-pivot-dag-artifact-load>读取可用产物</button>
                        <span class="pivot-dag-structured-ref-help">只显示当前用户可访问的产物；渲染节点仍需提供受控 Document IR。</span>
                    </div>
                `;
            } else if (isReportSheetField) {
                const selectedSheet = fieldValue ? '__manual__' : '';
                const compareSheets = shortToolName === 'reports.compare_files';
                controlHtml = `
                    <div class="pivot-dag-report-sheet-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-report-sheet-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-report-sheet-select>
                            <option value="" ${selectedSheet ? '' : 'selected'}>使用文件默认工作表</option>
                            <option value="__manual__" ${selectedSheet === '__manual__' ? 'selected' : ''}>手动填写工作表名称</option>
                        </select>
                        <input class="form-input pivot-dag-report-sheet-manual${selectedSheet ? ' is-visible' : ''}" data-pivot-dag-report-sheet-manual value="${dagEscapeAttr(fieldValue)}" placeholder="例如 Sheet1">
                        <button type="button" class="btn-secondary" data-pivot-dag-report-sheet-load>${compareSheets ? '读取共同工作表' : '读取工作表和字段'}</button>
                        <span class="pivot-dag-structured-ref-help" data-pivot-dag-report-sheet-status>${compareSheets ? '先选择两份具体文件，再读取它们的共同工作表。' : '先选择具体文件，再读取其工作表和字段。'}</span>
                    </div>
                `;
            } else if (isApprovalLevels) {
                const levels = Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 10) : [];
                const renderLevel = (level = {}, index = 0) => {
                    const userIds = Array.isArray(level.approverUserIds)
                        ? level.approverUserIds
                        : (Array.isArray(level.approver_user_ids) ? level.approver_user_ids : []);
                    const units = Array.isArray(level.approverUnits)
                        ? level.approverUnits
                        : (Array.isArray(level.approver_units) ? level.approver_units : []);
                    return `
                        <article class="pivot-dag-approval-level" data-pivot-dag-approval-level>
                            <div class="pivot-dag-approval-level-head">
                                <strong>第 ${index + 1} 级审批</strong>
                                <button type="button" class="btn-secondary" data-pivot-dag-approval-level-remove aria-label="删除第 ${index + 1} 级审批">删除</button>
                            </div>
                            <div class="pivot-dag-approval-level-grid">
                                <label><span>本级说明</span><input class="form-input" data-pivot-dag-approval-level-title value="${dagEscapeAttr(level.title || '')}" placeholder="例如：直属负责人审批"></label>
                                <label><span>通过规则</span><select class="form-input" data-pivot-dag-approval-level-mode><option value="any" ${String(level.mode || '').toLowerCase() !== 'all' ? 'selected' : ''}>任一人通过即可</option><option value="all" ${String(level.mode || '').toLowerCase() === 'all' ? 'selected' : ''}>所有对象均需通过</option></select></label>
                                <label><span>审批用户 ID</span><input class="form-input" data-pivot-dag-approval-level-user-ids value="${dagEscapeAttr(userIds.join(', '))}" placeholder="多个 ID 用逗号分隔，例如 1001, 1002"></label>
                                <label><span>审批部门</span><input class="form-input" data-pivot-dag-approval-level-units value="${dagEscapeAttr(units.join(', '))}" placeholder="多个部门用逗号分隔，例如 财务部, 法务部"></label>
                            </div>
                        </article>
                    `;
                };
                controlHtml = `
                    <div class="pivot-dag-approval-levels" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-approval-levels="${dagEscapeAttr(name)}">
                        <div class="pivot-dag-structured-ref pivot-dag-approval-level-source">
                            <select class="form-input" data-pivot-dag-approval-level-source>
                                <option value="" ${visualStructureReference ? '' : 'selected'}>逐级可视化配置</option>
                                ${structuredReferenceOptions.map(item => `<option value="${dagEscapeAttr(item.token)}" ${visualStructureReference === item.token ? 'selected' : ''}>${dagEscapeHtml(item.label)}</option>`).join('')}
                                <option value="__custom__" ${visualStructureReference === '__custom__' ? 'selected' : ''}>高级：自定义变量表达式</option>
                            </select>
                            <input class="form-input pivot-dag-structured-ref-manual" data-pivot-dag-approval-level-custom value="${dagEscapeAttr(visualStructureReference === '__custom__' ? fieldValue : '')}" placeholder="例如 {{nodes.policy.output.approvalLevels}}">
                        </div>
                        <div class="pivot-dag-approval-level-list" data-pivot-dag-approval-level-list>
                            ${levels.map(renderLevel).join('') || renderLevel({}, 0)}
                        </div>
                        <button type="button" class="btn-secondary" data-pivot-dag-approval-level-add>+ 添加下一审批级</button>
                        <span class="pivot-dag-group-fields-help">逐级串签时按顺序推进；每一级至少填写一个审批用户 ID 或审批部门。</span>
                    </div>
                `;
            } else if (isBrowserTargetField) {
                const target = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
                const hasRoleTarget = Boolean(target.role || target.name);
                const hasTextTarget = !hasRoleTarget && Boolean(target.text);
                const targetMode = hasRoleTarget ? 'role' : (hasTextTarget ? 'text' : 'selector');
                controlHtml = `
                    <div class="pivot-dag-browser-target" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-browser-target="${dagEscapeAttr(name)}">
                        <div class="pivot-dag-structured-ref pivot-dag-browser-target-source">
                            <select class="form-input" data-pivot-dag-browser-target-source>
                                <option value="" ${visualStructureReference ? '' : 'selected'}>手动定位页面元素</option>
                                ${structuredReferenceOptions.map(item => `<option value="${dagEscapeAttr(item.token)}" ${visualStructureReference === item.token ? 'selected' : ''}>${dagEscapeHtml(item.label)}</option>`).join('')}
                                <option value="__custom__" ${visualStructureReference === '__custom__' ? 'selected' : ''}>高级：自定义变量表达式</option>
                            </select>
                            <input class="form-input pivot-dag-structured-ref-manual" data-pivot-dag-browser-target-custom value="${dagEscapeAttr(visualStructureReference === '__custom__' ? fieldValue : '')}" placeholder="例如 {{nodes.locate.output.target}}">
                        </div>
                        <div class="pivot-dag-browser-target-editor" data-pivot-dag-browser-target-editor>
                            <label><span>定位方式</span><select class="form-input" data-pivot-dag-browser-target-mode><option value="selector" ${targetMode === 'selector' ? 'selected' : ''}>CSS 选择器</option><option value="role" ${targetMode === 'role' ? 'selected' : ''}>无障碍角色和名称</option><option value="text" ${targetMode === 'text' ? 'selected' : ''}>页面可见文字</option></select></label>
                            <label data-pivot-dag-browser-target-selector><span>CSS 选择器</span><input class="form-input" data-pivot-dag-browser-target-selector-input value="${dagEscapeAttr(target.selector || '')}" placeholder="例如 button[data-action=submit]"></label>
                            <div class="pivot-dag-browser-target-role" data-pivot-dag-browser-target-role>
                                <label><span>元素角色</span><input class="form-input" data-pivot-dag-browser-target-role-input value="${dagEscapeAttr(target.role || '')}" placeholder="例如 button"></label>
                                <label><span>元素名称</span><input class="form-input" data-pivot-dag-browser-target-name-input value="${dagEscapeAttr(target.name || '')}" placeholder="例如 提交"></label>
                            </div>
                            <label data-pivot-dag-browser-target-text><span>页面文字</span><input class="form-input" data-pivot-dag-browser-target-text-input value="${dagEscapeAttr(target.text || '')}" placeholder="例如 提交订单"></label>
                            <label class="pivot-dag-wizard-toggle"><input type="checkbox" data-pivot-dag-browser-target-exact ${target.exact === true ? 'checked' : ''}><span>精确匹配</span></label>
                        </div>
                        <span class="pivot-dag-structured-ref-help">优先使用角色/名称或可见文字；仅在页面结构稳定时使用 CSS 选择器。</span>
                    </div>
                `;
            } else if (isApprovalTagField) {
                const tags = (Array.isArray(value) ? value : [value])
                    .map(item => String(item || '').trim())
                    .filter(Boolean)
                    .filter((item, index, items) => items.indexOf(item) === index);
                const numericOnly = normalizeFieldKey(name) === 'approveruserids';
                const targetLabel = numericOnly ? '用户 ID' : (normalizeFieldKey(name) === 'approverunits' ? '部门' : '审批人用户名或 ID');
                controlHtml = `
                    <div class="pivot-dag-group-fields" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-approval-tags="${dagEscapeAttr(name)}" ${numericOnly ? 'data-pivot-dag-tag-numeric="1"' : ''}>
                        <div class="pivot-dag-group-fields-list" data-pivot-dag-approval-tags-list>
                            ${tags.length
                                ? tags.map(tag => `<span class="pivot-dag-group-field-chip" data-pivot-dag-approval-tag-value="${dagEscapeAttr(tag)}">${dagEscapeHtml(tag)}<button type="button" class="btn-secondary" data-pivot-dag-approval-tag-remove="${dagEscapeAttr(tag)}" aria-label="移除 ${dagEscapeAttr(tag)}">×</button></span>`).join('')
                                : '<span class="pivot-dag-group-fields-empty">尚未添加审批对象</span>'}
                        </div>
                        <div class="pivot-dag-group-fields-add">
                            <input class="form-input" type="text" data-pivot-dag-approval-tag-input placeholder="输入${dagEscapeAttr(targetLabel)}后添加">
                            <button type="button" class="btn-secondary" data-pivot-dag-approval-tag-add>添加</button>
                        </div>
                        <span class="pivot-dag-group-fields-help">可添加多个${dagEscapeHtml(targetLabel)}；多级审批流仍可在高级配置中设置。</span>
                    </div>
                `;
            } else if (isHandoffTagField) {
                const tags = (Array.isArray(value) ? value : [value])
                    .map(item => String(item || '').trim())
                    .filter(Boolean)
                    .filter((item, index, items) => items.indexOf(item) === index);
                controlHtml = `
                    <div class="pivot-dag-group-fields" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-tag-list="${dagEscapeAttr(name)}">
                        <div class="pivot-dag-group-fields-list" data-pivot-dag-tag-list-list>
                            ${tags.length
                                ? tags.map(tag => `<span class="pivot-dag-group-field-chip" data-pivot-dag-tag-list-value="${dagEscapeAttr(tag)}">${dagEscapeHtml(tag)}<button type="button" class="btn-secondary" data-pivot-dag-tag-list-remove="${dagEscapeAttr(tag)}" aria-label="移除 ${dagEscapeAttr(tag)}">×</button></span>`).join('')
                                : '<span class="pivot-dag-group-fields-empty">尚未添加条目</span>'}
                        </div>
                        <div class="pivot-dag-group-fields-add">
                            <input class="form-input" type="text" data-pivot-dag-tag-list-input placeholder="输入一条内容后添加">
                            <button type="button" class="btn-secondary" data-pivot-dag-tag-list-add>添加条目</button>
                        </div>
                        <span class="pivot-dag-group-fields-help">逐条添加交接要点；需要整体引用上游数组时，可在高级参数中设置。</span>
                    </div>
                `;
            } else if (isColumnSelector) {
                const selectedFields = (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean);
                controlHtml = `
                    <div class="pivot-dag-group-fields" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-column-fields="${dagEscapeAttr(name)}" ${isReportQueryColumns ? 'data-pivot-dag-report-columns="1"' : ''}>
                        <div class="pivot-dag-group-fields-list" data-pivot-dag-column-fields-list>
                            ${selectedFields.length
                                ? selectedFields.map(field => `<span class="pivot-dag-group-field-chip" data-pivot-dag-column-field-value="${dagEscapeAttr(field)}">${dagEscapeHtml(field)}<button type="button" class="btn-secondary" data-pivot-dag-column-field-remove="${dagEscapeAttr(field)}" aria-label="移除字段 ${dagEscapeAttr(field)}">×</button></span>`).join('')
                                : '<span class="pivot-dag-group-fields-empty">留空时将使用全部字段</span>'}
                        </div>
                        <div class="pivot-dag-group-fields-add">
                            <input class="form-input" type="text" list="pivot-dag-data-field-options-${dagEscapeAttr(name)}" data-pivot-dag-column-field-input placeholder="选择或输入要保留的字段">
                            <button type="button" class="btn-secondary" data-pivot-dag-column-field-add>添加字段</button>
                        </div>
                        <datalist id="pivot-dag-data-field-options-${dagEscapeAttr(name)}" ${isReportQueryColumns ? 'data-pivot-dag-report-columns-list' : ''}>${dataFieldOptions.map(item => `<option value="${dagEscapeAttr(item.value)}">${dagEscapeHtml(item.label)}</option>`).join('')}</datalist>
                        <span class="pivot-dag-group-fields-help" ${isReportQueryColumns ? 'data-pivot-dag-report-columns-hint' : ''}>${isReportQueryColumns ? '选定报表文件后，可通过“读取工作表和字段”加载候选项。' : '字段顺序决定表格或查询结果的显示顺序。'}</span>
                    </div>
                `;
            } else if (isDataFieldSelector) {
                const selectedValue = dataFieldOptions.some(item => item.value === fieldValue) ? fieldValue : (fieldValue ? '__manual__' : '');
                controlHtml = `
                    <div class="pivot-dag-data-field-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-data-field-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-data-field-select>
                            <option value="">请选择上游数据字段</option>
                            ${dataFieldOptions.map(item => `<option value="${dagEscapeAttr(item.value)}" ${selectedValue === item.value ? 'selected' : ''}>${dagEscapeHtml(item.label)}</option>`).join('')}
                            <option value="__manual__" ${selectedValue === '__manual__' ? 'selected' : ''}>手动输入字段名</option>
                        </select>
                        <input class="form-input pivot-dag-data-field-manual" data-pivot-dag-data-field-manual value="${dagEscapeAttr(selectedValue === '__manual__' ? fieldValue : '')}" placeholder="例如 部门">
                        <span class="pivot-dag-structured-ref-help">可先测试上游节点，以获得实际字段候选。</span>
                    </div>
                `;
            } else if (isKeyValueMapField) {
                const entries = Object.entries(value || {});
                controlHtml = `
                    <div class="pivot-dag-keyvalue-map" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-keyvalue-map="${dagEscapeAttr(name)}" ${isReportQueryFilters ? 'data-pivot-dag-report-filter-fields="1"' : ''}>
                        <div class="pivot-dag-keyvalue-map-list" data-pivot-dag-keyvalue-map-list>
                            ${(entries.length ? entries : [['', '']]).map(([key, entryValue]) => `<div class="pivot-dag-keyvalue-map-row"><input class="form-input" list="pivot-dag-data-field-options-${dagEscapeAttr(name)}" data-pivot-dag-keyvalue-key value="${dagEscapeAttr(key)}" placeholder="字段或键名"><textarea class="form-input" rows="2" data-pivot-dag-keyvalue-value placeholder="填写值或插入变量">${dagEscapeHtml(typeof entryValue === 'string' ? entryValue : JSON.stringify(entryValue))}</textarea><button type="button" class="btn-secondary" data-pivot-dag-keyvalue-remove aria-label="删除此项">×</button></div>`).join('')}
                        </div>
                        <datalist id="pivot-dag-data-field-options-${dagEscapeAttr(name)}" ${isReportQueryFilters ? 'data-pivot-dag-report-filter-fields-list' : ''}>${dataFieldOptions.map(item => `<option value="${dagEscapeAttr(item.value)}">${dagEscapeHtml(item.label)}</option>`).join('')}</datalist>
                        <button type="button" class="btn-secondary" data-pivot-dag-keyvalue-add>+ 添加一项</button>
                        <span class="pivot-dag-group-fields-help" ${isReportQueryFilters ? 'data-pivot-dag-report-filter-fields-hint' : ''}>${isReportQueryFilters ? '选定报表文件后，可读取字段并按字段添加筛选条件。' : '可填写固定值，也可通过右侧变量引用插入上游结果。'}</span>
                    </div>
                `;
            } else if (isStructuredReferenceField) {
                const selectedValue = isKnownStructuredReference ? fieldValue : (hasManualStructuredValue ? '__manual__' : '');
                const manualValue = selectedValue === '__manual__' ? fieldValue : '';
                controlHtml = `
                    <div class="pivot-dag-structured-ref" data-pivot-dag-structured-ref="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-structured-reference="1">
                            <option value="">请选择上游结构化结果</option>
                            ${structuredReferenceOptions.map(item => `<option value="${dagEscapeAttr(item.token)}" ${selectedValue === item.token ? 'selected' : ''}>${dagEscapeHtml(item.label)}</option>`).join('')}
                            <option value="__manual__" ${selectedValue === '__manual__' ? 'selected' : ''}>高级：自定义变量或 JSON</option>
                        </select>
                        <textarea class="form-input pivot-dag-structured-ref-manual" data-pivot-dag-structured-manual="${dagEscapeAttr(name)}" rows="4" placeholder="仅在需要时填写 JSON 或变量表达式">${dagEscapeHtml(formatWizardFieldValue(schema, manualValue))}</textarea>
                        <span class="pivot-dag-structured-ref-help">${dependencyNodes.length ? '优先选择上游节点的结构化输出；通常不需要手写 JSON。' : '尚未建立上游依赖；请先在画布连接上游节点，或仅在确有必要时使用高级变量。'}</span>
                    </div>
                `;
            } else if (isChannelBindingField) {
                const platformLabels = { wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };
                const bindings = typeof window !== 'undefined'
                    ? (window.Pivot?.modules?.agentChannelBindings?.() || [])
                    : [];
                const activeBindings = bindings.filter(binding => {
                    const platform = String(binding?.config?.platform || '').trim().toLowerCase();
                    return binding?.status === 'active' && Object.hasOwn(platformLabels, platform);
                });
                const knownCurrent = activeBindings.some(binding => String(binding.id) === String(fieldValue));
                controlHtml = `
                    <div class="pivot-dag-channel-binding-picker" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-channel-binding-picker="${dagEscapeAttr(name)}">
                        <select class="form-input" data-pivot-dag-channel-binding-select="1" ${activeBindings.length || fieldValue ? '' : 'disabled aria-disabled="true"'}>
                            <option value="">${activeBindings.length ? '请选择受控渠道绑定' : '暂无可用渠道绑定'}</option>
                            ${fieldValue && !knownCurrent ? `<option value="${dagEscapeAttr(fieldValue)}" selected>${dagEscapeHtml(`当前绑定（不可用）：${fieldValue}`)}</option>` : ''}
                            ${activeBindings.map(binding => {
                                const platform = String(binding?.config?.platform || '').trim().toLowerCase();
                                const label = `${platformLabels[platform] || platform} · ${binding.channelKey || binding.id}`;
                                return `<option value="${dagEscapeAttr(binding.id)}" data-pivot-dag-channel-platform="${dagEscapeAttr(platform)}" ${String(binding.id) === String(fieldValue) ? 'selected' : ''}>${dagEscapeHtml(label)}</option>`;
                            }).join('')}
                        </select>
                        <button type="button" class="btn-secondary" data-pivot-dag-channel-binding-load>刷新可用渠道</button>
                        <span class="pivot-dag-structured-ref-help">通知只能选择当前用户已启用的受控渠道；平台需与所选绑定一致。</span>
                    </div>
                `;
            } else if (isDatabaseConnection) {
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
                        ${workflows.map(item => `<option value="${dagEscapeAttr(item.id)}" ${String(item.id) === String(value ?? '') ? 'selected' : ''}>${dagEscapeHtml(`${item.name} · 已发布版本 ${item.published_version}`)}</option>`).join('')}
                    </select>
                `;
            } else if (type === 'boolean') {
                controlHtml = `
                    <span class="pivot-dag-wizard-toggle">
                        <input type="checkbox" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" ${Boolean(value) ? 'checked' : ''}>
                        <span>${dagEscapeHtml(required ? '必填' : '可选')}</span>
                    </span>
                `;
            } else if (isLlmModelField) {
                const configuredModel = String(fieldValue || '').trim();
                const selectedModel = modelOptions.find(model => (
                    String(model.id || '') === configuredModel
                    || String(model.model_name || '') === configuredModel
                ));
                const selectedModelId = String(selectedModel?.id || configuredModel || defaultWorkflowModelId() || '').trim();
                const hasConfiguredOption = modelOptions.some(model => String(model.id || '') === selectedModelId);
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-model-select="1" ${modelOptions.length || selectedModelId ? '' : 'disabled aria-disabled="true"'}>
                        ${!modelOptions.length && !selectedModelId ? '<option value="">暂无可用模型</option>' : ''}
                        ${selectedModelId && !hasConfiguredOption ? `<option value="${dagEscapeAttr(selectedModelId)}" selected>${dagEscapeHtml(`当前配置（不可用）：${selectedModelId}`)}</option>` : ''}
                        ${modelOptions.map(model => {
                            const valueId = String(model.id || '').trim();
                            const contextTokens = Number(model.context_window_tokens || 0);
                            const contextLabel = contextTokens > 0 ? ` · 上下文 ${Math.round(contextTokens / 1024)}K` : '';
                            const labelText = `${model.name || model.model_name || valueId}${model.user_id ? '（个人）' : ''}${contextLabel}`;
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
            } else if (isDelayDuration) {
                controlHtml = `<input class="form-input" type="number" step="1" min="0" max="2592000" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" data-pivot-dag-ms-multiplier="1000" value="${dagEscapeAttr(fieldValue)}" placeholder="例如 60">`;
            } else if (type === 'integer' || type === 'number') {
                const step = type === 'integer' ? '1' : 'any';
                const minimum = Number.isFinite(Number(schema.minimum)) ? ` min="${dagEscapeAttr(schema.minimum)}"` : '';
                const maximum = Number.isFinite(Number(schema.maximum)) ? ` max="${dagEscapeAttr(schema.maximum)}"` : '';
                controlHtml = `<input class="form-input" type="number" step="${step}"${minimum}${maximum} data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" value="${dagEscapeAttr(fieldValue)}" placeholder="${dagEscapeAttr(placeholder)}">`;
            } else if (useTextArea) {
                const rows = codeTextArea ? 9 : (wideRichTextArea ? 7 : 5);
                const spellcheck = codeTextArea ? ' spellcheck="false"' : '';
                controlHtml = `<textarea class="form-input pivot-dag-wizard-textarea" rows="${rows}" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" placeholder="${dagEscapeAttr(placeholder)}"${spellcheck}>${dagEscapeHtml(fieldValue)}</textarea>`;
            } else {
                controlHtml = `<input class="form-input" type="text" data-pivot-dag-wizard-field="${dagEscapeAttr(name)}" value="${dagEscapeAttr(fieldValue)}" placeholder="${dagEscapeAttr(placeholder)}">`;
            }

            const referencePickerHtml = allowsVisualReference ? `
                <div class="pivot-dag-wizard-value-source" data-pivot-dag-value-source="${dagEscapeAttr(name)}">
                    <span>取值方式</span>
                    <select class="form-input" data-pivot-dag-wizard-reference-picker="${dagEscapeAttr(name)}">
                        <option value="" ${initialReferenceValue ? '' : 'selected'}>手动填写</option>
                        ${fieldReferenceOptions.map(item => `<option value="${dagEscapeAttr(item.token)}" ${initialReferenceValue === item.token ? 'selected' : ''}>${dagEscapeHtml(item.label)}</option>`).join('')}
                        <option value="__custom__" ${initialReferenceValue === '__custom__' ? 'selected' : ''}>高级：自定义变量表达式</option>
                    </select>
                    <input class="form-input pivot-dag-wizard-reference-custom" data-pivot-dag-wizard-reference-custom="${dagEscapeAttr(name)}" value="${dagEscapeAttr(initialReferenceValue === '__custom__' ? fieldValue : '')}" placeholder="例如 {{nodes.query.output.total}}">
                    <small>选择后将使用运行时结果替代手动值；需要混合文字时请保持“手动填写”。</small>
                </div>
            ` : '';

            const usageHint = type === 'array' || type === 'object'
                ? '适合填结构化数据，也可以直接插入上游结果行。'
                : isTextualSchemaField(name, schema)
                    ? '适合填写文字、提示词、查询语句或格式化文本。'
                    : '可以直接填写，必要时也能插入变量。';
            // 运行时引用由字段本身的选择器和右侧变量面板承担，避免在每个参数下重复展示全局按钮。
            const suggestionHtml = '';

            return `
                <label class="${fieldClasses}" data-pivot-dag-wizard-field-wrap="${dagEscapeAttr(name)}">
                    <span class="pivot-dag-wizard-field-head">
                        <strong>${dagEscapeHtml(label)}</strong>
                        <span>
                            <em>${dagEscapeHtml(typeLabel)}</em>
                            ${required ? '<em class="is-required">必填</em>' : '<em>可选</em>'}
                        </span>
                    </span>
                    ${referencePickerHtml}
                    <div class="pivot-dag-wizard-manual-control${initialReferenceValue ? ' is-reference-active' : ''}" data-pivot-dag-wizard-manual-control="${dagEscapeAttr(name)}">${controlHtml}</div>
                    ${description ? `<span class="pivot-dag-wizard-field-desc">${dagEscapeHtml(description)}</span>` : ''}
                    <span class="pivot-dag-wizard-field-usage">${dagEscapeHtml(fieldUsageHint(name, schema, tool) || usageHint)}</span>
                    ${suggestionHtml}
                </label>
            `;
        };

        const renderDatabaseAssistPanel = (node, tool, initialInput = {}, wizardTools = []) => {
            const shortName = resolveToolShortName(tool);
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
                            <span>数据库模式 / 命名空间</span>
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
