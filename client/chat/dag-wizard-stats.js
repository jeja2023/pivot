/* Agent DAG 统计工作流向导（拆自 dag-wizard.js） */



function createDagWizardStatsController(ctx) {
    const currentTools = () => typeof ctx.currentTools === 'function' ? (ctx.currentTools() || []) : [];

    const openStatsChartWizard = () => {
        const wizardTools = currentTools();
        const connections = databaseWizardConnections(wizardTools);
        const chartTool = wizardTools.find(tool => toolValue(tool) === 'viz.build_chart')
            || findPreferredTool(wizardTools, ['viz.build_chart', 'chart']);
        const llmTool = wizardTools.find(tool => toolValue(tool) === 'agent.llm')
            || findPreferredTool(wizardTools, ['agent.llm']);
        if (!connections.length) {
            window.showToast?.('请先在工具箱启用数据库连接，并刷新工具。', 'error');
            return;
        }
        if (!chartTool) {
            window.showToast?.('请先启用图表生成工具。', 'error');
            return;
        }
        let modal = document.getElementById('pivot-dag-stats-wizard');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pivot-dag-stats-wizard';
            modal.className = 'modal-overlay hidden pivot-dag-stats-wizard-overlay';
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div class="modal rag-detail-modal pivot-dag-stats-wizard">
                <div class="rag-detail-header pivot-dag-stats-head">
                    <div>
                        <h3>统计图向导</h3>
                        <p class="model-modal-desc">选择数据表和字段，生成可继续编辑的查询与图表节点。</p>
                    </div>
                    <button type="button" class="btn-danger-outline" data-stats-close="1">关闭</button>
                </div>
                <div class="agent-workflow-create-form pivot-dag-stats-form">
                    <div class="pivot-dag-stats-grid">
                    <label class="agent-workflow-create-field"><span>数据库</span>
                        <select class="form-input" data-stats-field="database">
                            ${connections.map(entry => `<option value="${dagEscapeAttr(entry.serverId)}">${dagEscapeHtml(entry.serverName)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="agent-workflow-create-field pivot-dag-stats-schema">
                        <span>Schema / 命名空间（可选）</span>
                        <input class="form-input" data-stats-field="schema" placeholder="SQLite/MySQL 通常留空；PostgreSQL 可填 public，SQL Server 可填 dbo">
                        <small>不确定就留空，系统会使用当前连接的默认数据库范围。</small>
                    </label>
                    <label class="agent-workflow-create-field"><span>数据表</span><input class="form-input" list="pivot-stats-table-options" data-stats-field="table" placeholder="选择或输入表名"></label>
                    <label class="agent-workflow-create-field"><span>分组字段</span><input class="form-input" list="pivot-stats-column-options" data-stats-field="groupBy" placeholder="选择或输入字段"></label>
                    <label class="agent-workflow-create-field"><span>图表类型</span>
                        <select class="form-input" data-stats-field="chartType">
                            <option value="bar">柱状图</option>
                            <option value="line">折线图</option>
                            <option value="pie">饼图</option>
                        </select>
                    </label>
                    <label class="agent-workflow-create-field"><span>返回数量</span><input class="form-input" type="number" min="1" max="1000" value="50" data-stats-field="limit"></label>
                    <label class="agent-workflow-create-field pivot-dag-stats-title"><span>图表标题</span><input class="form-input" data-stats-field="title" placeholder="自动生成"></label>
                    </div>
                    <datalist id="pivot-stats-table-options"></datalist>
                    <datalist id="pivot-stats-column-options"></datalist>
                    <div class="pivot-dag-stats-status" data-stats-status></div>
                    <div class="agent-workflow-create-actions pivot-dag-stats-actions">
                        <button type="button" class="btn-secondary" data-stats-load-fields="1">读取字段</button>
                        <button type="button" class="btn-primary" data-stats-create="1">生成节点</button>
                    </div>
                </div>
            </div>
        `;
        const status = modal.querySelector('[data-stats-status]');
        const setStatus = (text, type = '') => {
            status.textContent = text || '';
            status.className = `pivot-dag-stats-status ${type}`;
        };
        const selectedEntry = () => connections.find(entry => entry.serverId === modal.querySelector('[data-stats-field="database"]')?.value) || connections[0];
        const loadTables = async () => {
            const entry = selectedEntry();
            if (!entry?.tools['db.list_tables']) {
                setStatus('当前连接未提供表列表工具，可直接输入表名。', 'warn');
                return;
            }
            const schema = modal.querySelector('[data-stats-field="schema"]')?.value.trim();
            setStatus(schema ? `正在读取 ${schema} 下的数据表...` : '正在读取默认范围的数据表...');
            try {
                const result = await callWizardTool(entry.tools['db.list_tables'], schema ? { schema } : {});
                const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
                const tables = [...new Set(rows.map(tableNameFromRow).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
                modal.querySelector('#pivot-stats-table-options').innerHTML = tables.map(name => `<option value="${dagEscapeAttr(name)}"></option>`).join('');
                setStatus(tables.length ? `已读取 ${tables.length} 个数据表。` : '没有读取到数据表，可手动输入。', tables.length ? '' : 'warn');
            } catch (e) {
                setStatus(e.message || '读取数据表失败，可手动输入表名。', 'error');
            }
        };
        const loadColumns = async () => {
            const entry = selectedEntry();
            const table = modal.querySelector('[data-stats-field="table"]')?.value.trim();
            if (!table) {
                setStatus('请先选择或输入数据表。', 'error');
                return;
            }
            if (!entry?.tools['db.describe_table']) {
                setStatus('当前连接未提供字段读取工具，可直接输入字段名。', 'warn');
                return;
            }
            const schema = modal.querySelector('[data-stats-field="schema"]')?.value.trim();
            setStatus(schema ? `正在读取 ${schema}.${table} 的字段...` : `正在读取 ${table} 的字段...`);
            try {
                const result = await callWizardTool(entry.tools['db.describe_table'], { table, ...(schema ? { schema } : {}) });
                const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
                const columns = [...new Set(rows.map(columnNameFromRow).filter(Boolean))];
                modal.querySelector('#pivot-stats-column-options').innerHTML = columns.map(name => `<option value="${dagEscapeAttr(name)}"></option>`).join('');
                setStatus(columns.length ? `已读取 ${columns.length} 个字段。` : '没有读取到字段，可手动输入。', columns.length ? '' : 'warn');
            } catch (e) {
                setStatus(e.message || '读取字段失败，可手动输入字段名。', 'error');
            }
        };
        const createNodes = () => {
            const entry = selectedEntry();
            const table = modal.querySelector('[data-stats-field="table"]')?.value.trim();
            const groupBy = modal.querySelector('[data-stats-field="groupBy"]')?.value.trim();
            const schema = modal.querySelector('[data-stats-field="schema"]')?.value.trim();
            const limit = Math.max(1, Math.min(Number(modal.querySelector('[data-stats-field="limit"]')?.value) || 50, 1000));
            const chartType = modal.querySelector('[data-stats-field="chartType"]')?.value || 'bar';
            if (!table || !groupBy) {
                setStatus('请填写数据表和分组字段。', 'error');
                return;
            }
            const groupAlias = safeAlias(groupBy, 'group_value');
            const countAlias = 'account_count';
            const title = modal.querySelector('[data-stats-field="title"]')?.value.trim()
                || `${table} ${groupBy} 分布`;
            const queryTool = entry.tools['db.group_count'] || entry.tools['db.run_readonly_query'];
            const queryInput = entry.tools['db.group_count']
                ? { connectionId: entry.serverId, table, groupBy, groupAlias, countAlias, limit, sortOrder: 'desc', ...(schema ? { schema } : {}) }
                : {
                    connectionId: entry.serverId,
                    sql: buildWizardGroupCountSql({ table: schema ? `${schema}.${table}` : table, groupBy, groupAlias, countAlias, limit }),
                    limit
                };
            const llmInput = {
                ...defaultLlmInput(),
                prompt: [
                    `请基于「${title}」的统计查询结果，输出简洁的数据解读，并指出适合图表呈现的关键分组。`,
                    '',
                    '工作流目标：',
                    '{{goal}}',
                    '',
                    '分组统计结果：',
                    '{{nodes.group_count.output.rows}}',
                    '',
                    `图表类型：${chartType}`,
                    `横轴字段：${groupAlias}`,
                    `纵轴字段：${countAlias}`
                ].join('\n')
            };
            const nextSpec = {
                nodes: [
                    {
                        id: 'group_count',
                        title: '分组统计',
                        tool: toolShortName(queryTool),
                        input: queryInput,
                        dependsOn: [],
                        condition: 'success',
                        retryLimit: 0,
                        timeoutMs: 0,
                        onError: 'skip_dependents'
                    },
                    {
                        id: 'llm_summary',
                        title: '大模型处理',
                        tool: toolValue(llmTool) || 'agent.llm',
                        input: llmInput,
                        dependsOn: ['group_count'],
                        condition: 'success',
                        retryLimit: 0,
                        timeoutMs: 0,
                        onError: 'skip_dependents'
                    },
                    {
                        id: 'group_chart',
                        title: '生成统计图',
                        tool: toolValue(chartTool),
                        input: {
                            rows: '{{nodes.group_count.output.rows}}',
                            chartType,
                            title,
                            xAxis: groupAlias,
                            yAxis: countAlias,
                            xAxisLabel: groupBy,
                            yAxisLabel: '数量',
                            sortBy: 'value',
                            sortOrder: 'desc',
                            limit
                        },
                        dependsOn: ['llm_summary'],
                        condition: 'success',
                        retryLimit: 0,
                        timeoutMs: 0,
                        onError: 'skip_dependents'
                    }
                ]
            };
            const apply = () => {
                ctx.spec = ensureDefaults(nextSpec);
                ctx.selectedId = 'llm_summary';
                window.setAgentWorkflowDraftName?.(title, { ifEmpty: true });
                ctx.render?.();
                ctx.fitToContent?.();
                ctx.flushOut?.();
                modal.classList.add('hidden');
                window.showToast?.('已生成统计图模板节点，可继续自定义编排。', 'success');
            };
            // 检查当前画布是否有未保存的更改
            const hasUnsavedChanges = (() => {
                if (!ctx.textarea) return false;
                const saved = readJson(ctx.textarea.value);
                if (!saved) return false;
                return JSON.stringify(serialize(ctx.spec)) !== JSON.stringify(serialize(ensureDefaults(saved)));
            })();
            if (ctx.spec.nodes.length && typeof window.showConfirm === 'function') {
                const message = hasUnsavedChanges
                    ? '当前画布有未保存的更改，替换将被丢弃。确定用统计图模板生成的节点替换当前画布吗？'
                    : '确定用统计图模板生成的节点替换当前画布吗？';
                window.showConfirm('替换当前画布', message, apply);
            } else {
                apply();
            }
        };
        modal.querySelector('[data-stats-close]')?.addEventListener('click', () => modal.classList.add('hidden'));
        if (modal.dataset.boundStatsWizardOverlay !== '1') {
            modal.dataset.boundStatsWizardOverlay = '1';
            modal.addEventListener('click', event => {
                if (event.target === modal) modal.classList.add('hidden');
            });
        }
        modal.querySelector('[data-stats-field="database"]')?.addEventListener('change', loadTables);
        modal.querySelector('[data-stats-field="table"]')?.addEventListener('change', loadColumns);
        modal.querySelector('[data-stats-load-fields]')?.addEventListener('click', loadColumns);
        modal.querySelector('[data-stats-create]')?.addEventListener('click', createNodes);
        modal.classList.remove('hidden');
        loadTables();
    };

    return {
        openStatsChartWizard
    };
}
