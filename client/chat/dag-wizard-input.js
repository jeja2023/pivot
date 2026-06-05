/* DAG 向导共享辅助函数（拆自 dag-wizard.js） */




const cloneDagInput = (value) => {
            if (!value || typeof value !== 'object') return {};
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (e) {
                return {};
            }
        };

        const isTextualSchemaField = (name, schema = {}) => {
            const type = normalizeSchemaType(schema);
            return type === 'string'
                || type === 'array'
                || type === 'object'
                || /query|keyword|prompt|text|title|name|rows|sections|content|message|markdown|sql|json/i.test(String(name || ''));
        };

        const formatWizardFieldValue = (schema = {}, value) => {
            if (value === undefined || value === null) return '';
            if (typeof value === 'string') return value;
            const type = normalizeSchemaType(schema);
            if (type === 'boolean') return Boolean(value);
            if (type === 'integer' || type === 'number') return String(value);
            if (type === 'array' || type === 'object') {
                try {
                    return JSON.stringify(value, null, 2);
                } catch (e) {
                    return String(value);
                }
            }
            return String(value);
        };

        const fieldUsageHint = (name, schema = {}, tool = null) => {
            const key = normalizeFieldKey(name);
            if (isDatabaseConnectionField(name, tool)) return '选择要执行该数据库工具的连接；读取表/字段会跟随这个选择。';
            if (name === 'schema') return '不确定时保持为空，工具会使用当前连接的默认数据库范围。';
            if (name === 'table' || name === 'groupBy' || name === 'collection') return '可手动输入，也可用上方数据库辅助读取候选项。';
            if (name === 'sql') return '适合精确查询；需要统计图时优先使用统计图模板或分组统计工具。';
            if (key === 'query' || key === 'prompt') return '可直接输入，也可以插入任务目标或上游节点输出作为上下文。';
            if (key === 'rows' || key === 'columns' || key === 'filters') return '适合引用上游结构化结果；手动填写时请保持 JSON 格式。';
            if (key === 'model' || key === 'temperature' || key === 'max_tokens') return '属于模型调用控制参数，不确定时保持默认或留空。';
            const type = normalizeSchemaType(schema);
            if (type === 'array' || type === 'object') return '适合填结构化数据，也可以直接插入上游结果行。';
            return isTextualSchemaField(name, schema)
                ? '适合填文字、提示词、SQL 或 Markdown。'
                : '可以直接填写，必要时也能插入变量。';
        };

        const renderInputSummary = (input = {}, tool = null) => {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
                return '<span class="pivot-dag-input-summary-empty">未配置</span>';
            }
            const entries = Object.entries(input).slice(0, 6);
            if (!entries.length) {
                return '<span class="pivot-dag-input-summary-empty">未配置</span>';
            }
            const previewValue = (key, value) => {
                if (isDatabaseConnectionField(key, tool)) return databaseConnectionLabel(tool, value);
                if (value === undefined || value === null || value === '') return '空';
                if (typeof value === 'string') {
                    const normalized = value.replace(/\s+/g, ' ').trim();
                    return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
                }
                if (typeof value === 'number' || typeof value === 'boolean') return String(value);
                if (Array.isArray(value)) return `数组 ${value.length}`;
                if (typeof value === 'object') return `对象 ${Object.keys(value).length}`;
                return String(value);
            };
            const properties = getToolSchema(tool).properties || {};
            return entries.map(([key, value]) => {
                const preview = previewValue(key, value);
                const title = isDatabaseConnectionField(key, tool)
                    ? preview
                    : typeof value === 'string'
                        ? value.replace(/\s+/g, ' ').trim()
                        : preview;
                return `
                <span class="pivot-dag-input-summary-chip" title="${dagEscapeAttr(title)}">
                    <strong>${dagEscapeHtml(friendlyFieldLabel(key, properties[key], tool))}</strong>
                    <em>${dagEscapeHtml(preview)}</em>
                </span>
            `;
            }).join('');
        };

        const buildWizardDependencyNodes = (node, specNodes = []) => (node?.dependsOn || [])
            .map(depId => specNodes.find(n => n.id === depId))
            .filter(Boolean);

        const buildWizardReferenceGroups = (node, dependencyNodes = buildWizardDependencyNodes(node)) => {
            const groups = [
                {
                    label: '运行上下文',
                    note: '这些引用可以先写进去，等运行时再自动替换成真实值。',
                    tokens: [
                        { label: '任务目标', token: '{{goal}}' },
                        { label: '运行输入', token: '{{inputs}}' }
                    ]
                }
            ];
            if (dependencyNodes.length) {
                dependencyNodes.forEach(depNode => {
                    const depLabel = depNode.title || depNode.id;
                    groups.push({
                        label: depLabel,
                        note: '前序节点还没运行也没关系，先写路径，执行时会自动解析。',
                        tokens: [
                            { label: '完整结果', token: `{{nodes.${depNode.id}.output}}` },
                            { label: '结构化结果', token: `{{nodes.${depNode.id}.output.structuredContent}}` },
                            { label: '结果行', token: `{{nodes.${depNode.id}.output.rows}}` },
                            { label: '结构化行', token: `{{nodes.${depNode.id}.output.structuredContent.rows}}` },
                            { label: '状态', token: `{{nodes.${depNode.id}.status}}` },
                            { label: '错误', token: `{{nodes.${depNode.id}.error}}` }
                        ]
                    });
                });
            } else {
                groups.push({
                    label: '上游节点',
                    note: '先给节点连上上游节点，再回来挑选输出引用。',
                    tokens: []
                });
            }
            return groups;
        };

        const buildWizardFieldSuggestions = (name, schema = {}, dependencyNodes = []) => {
            const type = normalizeSchemaType(schema);
            const canSuggest = type === 'string' || type === 'array' || type === 'object' || isTextualSchemaField(name, schema);
            if (!canSuggest) return [];
            const suggestions = [
                { label: '任务目标', token: '{{goal}}' },
                { label: '运行输入', token: '{{inputs}}' }
            ];
            const isListLike = type === 'array'
                || /rows|items|data|list|table|sections|messages|records/i.test(String(name || ''));
            const primaryDep = dependencyNodes[0];
            if (primaryDep) {
                const depLabel = primaryDep.title || primaryDep.id;
                suggestions.push(isListLike
                    ? { label: `${depLabel} 结果行`, token: `{{nodes.${primaryDep.id}.output.rows}}` }
                    : { label: `${depLabel} 完整结果`, token: `{{nodes.${primaryDep.id}.output}}` });
                suggestions.push(isListLike
                    ? { label: `${depLabel} 结构化行`, token: `{{nodes.${primaryDep.id}.output.structuredContent.rows}}` }
                    : { label: `${depLabel} 结构化结果`, token: `{{nodes.${primaryDep.id}.output.structuredContent}}` });
            }
            if (dependencyNodes.length > 1) {
                const secondaryDep = dependencyNodes[1];
                const depLabel = secondaryDep.title || secondaryDep.id;
                suggestions.push({
                    label: `${depLabel} 完整结果`,
                    token: `{{nodes.${secondaryDep.id}.output}}`
                });
            }
            return [...new Map(suggestions.map(item => [item.token, item])).values()].slice(0, 4);
        };

        const renderWizardFieldSources = (node, dependencyNodes = buildWizardDependencyNodes(node)) => buildWizardReferenceGroups(node, dependencyNodes).map(group => `
            <section class="pivot-dag-wizard-sources-group">
                <div class="pivot-dag-wizard-sources-head">${dagEscapeHtml(group.label)}</div>
                ${group.note ? `<div class="pivot-dag-wizard-sources-note">${dagEscapeHtml(group.note)}</div>` : ''}
                <div class="pivot-dag-wizard-sources-list">
                    ${group.tokens.length
                        ? group.tokens.map(item => `
                            <button type="button" class="pivot-dag-token-btn pivot-dag-wizard-token-btn" data-pivot-dag-wizard-token="${dagEscapeAttr(item.token)}" title="${dagEscapeAttr(item.token)}">${dagEscapeHtml(item.label)}</button>
                        `).join('')
                        : '<div class="pivot-dag-wizard-sources-empty">暂无可直接引用的输出</div>'}
                </div>
            </section>
        `).join('');
