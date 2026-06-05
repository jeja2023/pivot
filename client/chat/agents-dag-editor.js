/* 智能体 DAG 可视化编辑器 Agent DAG Visual Editor
 *
 * 用法：
 *   window.PivotDagEditor.mount({
 *       canvas:    HTMLElement,    // SVG 容器
 *       textarea:  HTMLTextAreaElement, // 双向同步的 JSON textarea
 *       toolbar:   HTMLElement,    // 工具栏容器（[+节点] 等按钮注入到这里）
 *       inspector: HTMLElement,    // 节点详情面板
 *       getTools:  () => [{name, title}], // 可用工具列表
 *       onChange:  (spec) => void,
 *       onOpenJson: () => void, // 打开高级 JSON 弹窗
 *       onNodeSelectionChange: (node|null) => void // 控制节点属性抽屉
 *   })
 *
 * 数据格式与 server/services/agent-validators.js 中的 normalizeDagSpec 完全一致：
 *   { nodes: [{ id, title, tool, input, dependsOn: [], condition: 'always'|'success' }] }
 *
 * 节点坐标 (x, y) 仅在编辑器内部维护，写入 textarea 时不会保留（normalizeDagSpec 会丢弃），
 * 加载已有 JSON 时编辑器会用拓扑层次自动布局重新生成坐标。
 *
 * 设计原则：
 *   - 零依赖，纯原生 JS + SVG
 *   - 不破坏现有 textarea 的存在；textarea 仍可手动编辑作为"专家模式"
 *   - CSP 兼容：所有事件都用 addEventListener，无内联 onclick
 *   - 多次 mount 同一容器幂等：先 destroy 旧实例
 */
(function () {
    if (window.PivotDagEditor) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_WIDTH = 188;
    const NODE_HEIGHT = 62;
    const NODE_GAP_X = 72;
    const NODE_GAP_Y = 30;
    const PADDING = 24;
    const DEFAULT_VIEW_SCALE = 0.72;
    const MIN_CONTENT_WIDTH = 960;
    const MIN_CONTENT_HEIGHT = 360;
    const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (cb => setTimeout(cb, 16));
    const caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;
    const cssEscape = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape.bind(window.CSS)
        : (value) => String(value ?? '').replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, ch => `\\${ch}`);

    const escapeHtml = (window.PivotSafeHtml && window.PivotSafeHtml.escapeHtml)
        || ((value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const escapeAttr = (window.PivotSafeHtml && window.PivotSafeHtml.escapeAttr)
        || ((value) => escapeHtml(value).replace(/"/g, '&quot;'));

    function uniqueId(existing, base = 'node') {
        let i = existing.length + 1;
        const set = new Set(existing);
        while (set.has(`${base}_${i}`)) i += 1;
        return `${base}_${i}`;
    }

    function clampDependsOn(nodes) {
        const ids = new Set(nodes.map(n => n.id));
        nodes.forEach(node => {
            node.dependsOn = (node.dependsOn || []).filter(dep => ids.has(dep) && dep !== node.id);
        });
    }

    function toolValue(tool) {
        return tool?.fullName || tool?.name || '';
    }

    const TOOL_DISPLAY_OVERRIDES = {
        'agent.llm': ['大模型节点', '调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。'],
        'rag.search': ['知识库检索', '检索当前用户知识库，返回相关片段和来源。'],
        'sessions.search': ['会话检索', '按关键词检索当前用户历史会话。'],
        'sessions.recent': ['最近会话', '列出最近未删除会话。'],
        'knowledge.list': ['知识库文档', '查看知识库文档及索引状态。'],
        'models.list': ['可用模型', '列出当前用户可用模型。'],
        'system.health': ['系统健康检查', '查看数据库、存储、内存和磁盘健康状态。'],
        'system.modelRuntime': ['模型运行状态', '查看模型端点队列、熔断器和监控状态。'],
        'db.list_tables': ['列出数据表', '列出当前数据库中可查询的表和视图。'],
        'db.count_tables': ['统计数据表数量', '统计当前数据库中可查询的数据表和视图数量。'],
        'db.describe_table': ['查看表结构', '查看表字段、类型和可空性。'],
        'db.run_readonly_query': ['只读 SQL 查询', '执行 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等只读查询。'],
        'db.group_count': ['分组统计', '按指定表字段分组并统计数量，用于快速生成分布图。'],
        'db.list_collections': ['列出集合', '列出 MongoDB 数据库集合。'],
        'db.count_collections': ['统计集合数量', '统计 MongoDB 数据库中的集合数量。'],
        'db.sample_collection': ['读取集合样本', '读取集合小样本，辅助理解字段结构。'],
        'db.aggregate': ['Mongo 聚合查询', '执行只读统计分析聚合管道。'],
        'reports.list_files': ['列出报表文件', '列出可访问的报表或数据文件。'],
        'reports.read_file_summary': ['读取报表摘要', '读取报表文件元数据、工作表和样本行。'],
        'reports.query_table': ['查询报表表格', '按列筛选 CSV/XLS/XLSX 表格行。'],
        'reports.compare_files': ['对比报表文件', '对比两个报表文件的工作表、表头和样本行。'],
        'report.compose': ['组合报告', '将摘要、表格、图表和 Markdown 片段组合成报告。'],
        'report.validate_template': ['校验报告模板', '在执行编排前验证报告模板结构。'],
        'viz.build_chart': ['生成图表', '基于表格行生成可渲染图表配置。'],
        'viz.build_table': ['生成表格', '基于表格行生成 Markdown 表格。'],
        'data.profile_rows': ['分析表格字段', '分析字段类型、填充率和样本值。'],
        'data.filter_rows': ['筛选表格行', '按精确匹配或包含关系筛选行。'],
        'data.group_summary': ['分组汇总', '按字段分组并计算数量、求和、均值、最小值或最大值。'],
        'data.normalize_fields': ['规范字段', '重命名字段并清理字符串值。'],
        'doc.extract_outline': ['提取文档大纲', '从文本或 Markdown 中提取轻量大纲。'],
        'doc.extract_key_values': ['提取键值信息', '从文档文本中抽取键值样式信息。'],
        'doc.chunk_text': ['拆分长文本', '按段落拆分长文本供后续分析。'],
        'format.to_markdown_table': ['转 Markdown 表格', '将行数据转换为 Markdown 表格。'],
        'format.to_json': ['转 JSON', '将值序列化为紧凑或美化 JSON。'],
        'format.extract_json': ['提取 JSON', '从文本中提取并解析第一个 JSON 对象或数组。'],
        'format.normalize_text': ['规范文本', '清理空白并可选转换大小写。'],
        'im.list_allowed_targets': ['列出通知目标', '列出当前允许通知的 LAN IM 目标。'],
        'im.send_user_message': ['发送用户消息', '向允许的 LAN IM 用户发送纯文本消息。'],
        'im.send_group_message': ['发送群组消息', '向允许的 LAN IM 群组发送纯文本消息。'],
        'im.send_markdown': ['发送 Markdown 消息', '向允许的 LAN IM 目标发送 Markdown 消息。']
    };

    const TOOL_GROUPS = [
        { key: 'llm', label: '大模型', test: name => /^(agent\.llm|llm\.|model\.generate)/.test(name) },
        { key: 'knowledge', label: '知识与会话', test: name => /^(rag|sessions|knowledge)\./.test(name) },
        { key: 'database', label: '数据库', test: name => /(^|\.)(db)\./.test(name) },
        { key: 'reports', label: '报表与文件', test: name => /^(reports|report)\./.test(name) },
        { key: 'visual', label: '图表与展示', test: name => /^viz\./.test(name) },
        { key: 'data', label: '数据处理', test: name => /^data\./.test(name) },
        { key: 'document', label: '文档处理', test: name => /^doc\./.test(name) },
        { key: 'format', label: '格式转换', test: name => /^format\./.test(name) },
        { key: 'notify', label: '消息通知', test: name => /^im\./.test(name) },
        { key: 'system', label: '系统诊断', test: name => /^(models|system)\./.test(name) },
        { key: 'external', label: '外部能力', test: name => /^mcp\./.test(name) },
        { key: 'other', label: '其他工具', test: () => true }
    ];

    function toolShortName(tool) {
        const value = String(toolValue(tool) || '');
        const match = value.match(/^mcp\.\d+\.(.+)$/);
        return match ? match[1] : value;
    }

    function friendlyToolTitle(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[0] || tool?.title || shortName || toolValue(tool) || '未命名工具';
    }

    function friendlyToolDescription(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[1] || tool?.description || '暂无说明。';
    }

    function toolSourceLabel(tool) {
        if (tool?.source === 'builtin') return '系统内置';
        return String(tool?.serverName || '').trim();
    }

    function friendlyToolOptionTitle(tool, duplicateShortNames = new Set()) {
        const title = friendlyToolTitle(tool);
        const source = toolSourceLabel(tool);
        return duplicateShortNames.has(toolShortName(tool)) && source ? `${title} · ${source}` : title;
    }

    function toolGroupLabel(tool) {
        const shortName = toolShortName(tool);
        const group = TOOL_GROUPS.find(item => item.test(shortName) || item.test(String(toolValue(tool) || '')));
        return group?.label || '其他工具';
    }

    function renderToolOptions(tools, selectedValue) {
        const buckets = new Map();
        TOOL_GROUPS.forEach(group => buckets.set(group.label, []));
        const list = Array.isArray(tools) ? tools : [];
        const resolvedSelectedValue = toolValue(resolveToolForNode(list, selectedValue)) || selectedValue;
        const shortNameCounts = list.reduce((counts, tool) => {
            const value = toolValue(tool);
            const shortName = toolShortName(tool);
            if (value && shortName) counts.set(shortName, (counts.get(shortName) || 0) + 1);
            return counts;
        }, new Map());
        const duplicateShortNames = new Set([...shortNameCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([shortName]) => shortName));
        list.forEach(tool => {
            const value = toolValue(tool);
            if (!value) return;
            const label = toolGroupLabel(tool);
            if (!buckets.has(label)) buckets.set(label, []);
            buckets.get(label).push(tool);
        });
        const groups = [...buckets.entries()]
            .map(([label, items]) => [label, items.sort((a, b) => friendlyToolOptionTitle(a, duplicateShortNames).localeCompare(friendlyToolOptionTitle(b, duplicateShortNames), 'zh-Hans-CN'))])
            .filter(([, items]) => items.length);
        const optionGroups = groups.map(([label, items]) => `
            <optgroup label="${escapeAttr(label)}">
                ${items.map(tool => {
        const value = toolValue(tool);
        const title = friendlyToolOptionTitle(tool, duplicateShortNames);
        const optionTitle = [friendlyToolDescription(tool), toolSourceLabel(tool), value].filter(Boolean).join(' · ');
        return `<option value="${escapeAttr(value)}" ${resolvedSelectedValue === value ? 'selected' : ''} title="${escapeAttr(optionTitle)}">${escapeHtml(title)}</option>`;
    }).join('')}
            </optgroup>
        `).join('');
        return ['<option value="">— 选择工具 —</option>', optionGroups].join('');
    }

    function renderSelectedToolMeta(tool) {
        if (!tool) {
            return '<div class="pivot-dag-tool-meta is-empty">选择工具后显示用途、来源和内部标识。</div>';
        }
        const source = tool.source === 'builtin'
            ? '系统内置'
            : tool.serverName
                ? `能力库 · ${tool.serverName}`
                : '能力库';
        const badges = [
            toolGroupLabel(tool),
            source,
            tool.requiresApproval ? '需审批' : '',
            tool.admin ? '管理员' : ''
        ].filter(Boolean);
        return `
            <div class="pivot-dag-tool-meta">
                <div class="pivot-dag-tool-meta-head">
                    <strong>${escapeHtml(friendlyToolTitle(tool))}</strong>
                    <span class="pivot-dag-tool-meta-badges">${badges.map(item => `<em>${escapeHtml(item)}</em>`).join('')}</span>
                </div>
                <div class="pivot-dag-tool-meta-body">
                    <p>${escapeHtml(friendlyToolDescription(tool))}</p>
                    <div class="pivot-dag-tool-meta-id">
                        <span>工具 ID</span>
                        <code>${escapeHtml(toolValue(tool))}</code>
                    </div>
                </div>
            </div>
        `;
    }

    function findPreferredTool(tools, patterns) {
        const list = Array.isArray(tools) ? tools : [];
        return list.find(tool => {
            const value = String(toolValue(tool)).toLowerCase();
            const title = String(tool?.title || '').toLowerCase();
            return patterns.some(pattern => value.includes(pattern) || title.includes(pattern));
        }) || list[0] || null;
    }

    function findGenericDatabaseToolForFullName(tools, value) {
        const match = String(value || '').match(/^mcp\.(\d+)\.(db\..+)$/);
        if (!match) return null;
        const serverId = match[1];
        const shortName = match[2];
        return (Array.isArray(tools) ? tools : []).find(tool => (
            tool?.databaseTool
            && toolShortName(tool) === shortName
            && databaseConnectionsFromTool(tool).some(connection => (
                String(connection.connectionId || connection.serverId || '') === serverId
                || String(connection.serverId || '') === serverId
            ))
        )) || null;
    }

    function databaseConnectionIdFromToolValue(value) {
        const match = String(value || '').match(/^mcp\.(\d+)\.(db\..+)$/);
        return match ? match[1] : '';
    }

    function isKnownToolValue(tools, value) {
        const list = Array.isArray(tools) ? tools : [];
        return list.some(tool => toolValue(tool) === value) || Boolean(findGenericDatabaseToolForFullName(list, value));
    }

    function resolveToolForNode(tools, value) {
        const list = Array.isArray(tools) ? tools : [];
        const found = list.find(tool => toolValue(tool) === value) || findGenericDatabaseToolForFullName(list, value);
        if (found) return found;
        return value ? { name: value, title: '' } : null;
    }

    function buildNodeToolDisplay(tools, value) {
        const tool = resolveToolForNode(tools, value);
        if (!tool) {
            return {
                title: '未选择工具',
                shortId: '',
                fullId: '',
                tooltip: '未选择工具'
            };
        }
        const fullId = toolValue(tool) || value;
        const shortId = toolShortName(tool) || fullId;
        const title = friendlyToolTitle(tool);
        return {
            title,
            shortId,
            fullId,
            tooltip: `${title} · ${fullId}`
        };
    }

    // 按拓扑层次分层（Kahn 风格）；环边视作"已满足"避免死循环
    function mcpServerIdFromTool(tool) {
        if (tool?.serverId !== undefined && tool?.serverId !== null) return String(tool.serverId || '').trim();
        const match = String(toolValue(tool) || '').match(/^mcp\.(\d+)\./);
        return match ? match[1] : '';
    }

    function databaseConnectionsFromTool(tool) {
        const connections = Array.isArray(tool?.databaseConnections) ? tool.databaseConnections : [];
        if (connections.length) {
            return connections.map(item => ({
                serverId: String(item.serverId || '').trim(),
                connectionId: String(item.connectionId || item.serverId || '').trim(),
                serverName: item.serverName || `数据库 ${item.serverId || ''}`,
                databaseType: item.databaseType || '',
                fullName: item.fullName || ''
            })).filter(item => item.serverId || item.connectionId);
        }
        const serverId = mcpServerIdFromTool(tool);
        const shortName = toolShortName(tool);
        return serverId && shortName.startsWith('db.')
            ? [{
                serverId,
                connectionId: serverId,
                serverName: tool?.serverName || `数据库 ${serverId}`,
                databaseType: tool?.databaseType || '',
                fullName: toolValue(tool)
            }]
            : [];
    }

    function tableNameFromRow(row) {
        return String(row?.table_name || row?.TABLE_NAME || row?.name || row?.Name || '').trim();
    }

    function columnNameFromRow(row) {
        return String(row?.column_name || row?.COLUMN_NAME || row?.name || row?.Field || '').trim();
    }

    function safeAlias(value, fallback = 'value') {
        const alias = String(value || '').trim().replace(/[^\w]/g, '_').replace(/^_+/, '') || fallback;
        return /^[A-Za-z_]/.test(alias) ? alias.slice(0, 64) : `${fallback}_${alias}`.slice(0, 64);
    }

    function quoteWizardSqlIdentifier(value) {
        return String(value || '').split('.').map(part => {
            const clean = part.trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) return clean;
            return `\`${clean.replace(/`/g, '``')}\``;
        }).join('.');
    }

    function buildWizardGroupCountSql({ table, groupBy, groupAlias, countAlias, limit }) {
        const groupIdentifier = quoteWizardSqlIdentifier(groupBy);
        const tableIdentifier = quoteWizardSqlIdentifier(table);
        return [
            `SELECT ${groupIdentifier} AS ${quoteWizardSqlIdentifier(groupAlias)}, COUNT(*) AS ${quoteWizardSqlIdentifier(countAlias)}`,
            `FROM ${tableIdentifier}`,
            `GROUP BY ${groupIdentifier}`,
            `ORDER BY ${quoteWizardSqlIdentifier(countAlias)} DESC, ${quoteWizardSqlIdentifier(groupAlias)} ASC`,
            `LIMIT ${Math.max(1, Math.min(Number(limit) || 50, 1000))}`
        ].join('\n');
    }

    function autoLayout(nodes) {
        const remaining = new Map(nodes.map(n => [n.id, new Set(n.dependsOn || [])]));
        const layers = [];
        const placed = new Set();
        // 兜底：节点数 <= 50 时层次清晰；更多节点也接受较粗略布局
        while (placed.size < nodes.length) {
            const layer = [];
            nodes.forEach(node => {
                if (placed.has(node.id)) return;
                const deps = remaining.get(node.id);
                const ready = [...deps].every(dep => placed.has(dep));
                if (ready) layer.push(node);
            });
            if (layer.length === 0) {
                // 出现环时把还没排的节点全部放到下一层，避免死循环
                nodes.forEach(node => {
                    if (!placed.has(node.id)) layer.push(node);
                });
            }
            layers.push(layer);
            layer.forEach(node => placed.add(node.id));
        }
        layers.forEach((layer, layerIndex) => {
            layer.forEach((node, slot) => {
                node._x = PADDING + layerIndex * (NODE_WIDTH + NODE_GAP_X);
                node._y = PADDING + slot * (NODE_HEIGHT + NODE_GAP_Y);
            });
        });
    }

    function ensureDefaults(spec) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes.map(n => ({
            id: String(n.id || '').trim() || 'node',
            title: String(n.title || n.id || '').trim() || '未命名',
            tool: String(n.tool || '').trim(),
            input: n.input && typeof n.input === 'object' ? n.input : {},
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.slice() : [],
            condition: ['always', 'success'].includes(n.condition) ? n.condition : 'success',
            retryLimit: Math.max(0, Math.min(Number.parseInt(n.retryLimit ?? n.retry_limit ?? 0, 10) || 0, 5)),
            timeoutMs: Math.max(0, Math.min(Number.parseInt(n.timeoutMs ?? n.timeout_ms ?? 0, 10) || 0, 600000)),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(n.onError || n.on_error || 'skip_dependents')) ? String(n.onError || n.on_error || 'skip_dependents') : 'skip_dependents',
            // 保留已有坐标，避免 autoLayout 丢失用户手动调整的位置
            _x: Number.isFinite(Number(n._x)) ? Number(n._x) : undefined,
            _y: Number.isFinite(Number(n._y)) ? Number(n._y) : undefined
        })) : [];
        if (!nodes.length) nodes.push(createDefaultLlmNode([]));
        nodes.forEach(ensureLlmNodeInput);
        clampDependsOn(nodes);
        // 只有在新节点缺少坐标时才自动布局
        const hasMissingCoords = nodes.some(n => n._x === undefined || n._y === undefined);
        if (hasMissingCoords) autoLayout(nodes);
        return { nodes };
    }

    // 把内部带 _x/_y 的 spec 序列化为 normalizeDagSpec 接受的最小形态
    function serialize(spec) {
        return {
            nodes: spec.nodes.map(({ id, title, tool, input, dependsOn, condition, retryLimit, timeoutMs, onError, _x, _y }) => ({
                id,
                title,
                tool,
                input,
                dependsOn: [...(dependsOn || [])],
                condition,
                retryLimit: Number(retryLimit || 0),
                timeoutMs: Number(timeoutMs || 0),
                onError: onError || 'skip_dependents',
                // 保留坐标以便再次加载时恢复用户手动调整的布局
                _x: Number.isFinite(_x) ? _x : undefined,
                _y: Number.isFinite(_y) ? _y : undefined
            }))
        };
    }

    function readJson(text) {
        const raw = String(text || '').trim();
        if (!raw) return { nodes: [] };
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return { nodes: value };
            if (value && typeof value === 'object') return value;
        } catch (e) {
            // 静默 — 编辑器会保留上次成功的快照
        }
        return null;
    }

    function workflowModelOptions() {
        const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
            ? window.isSelectableModelForCurrentUser
            : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
        return (Array.isArray(window._cachedAgentModels) ? window._cachedAgentModels : [])
            .filter(model => model.type !== 'embedding' && canSelectModel(model));
    }

    function defaultWorkflowModelId() {
        const models = workflowModelOptions();
        const selectedId = String(
            document.getElementById('model-selector')?.value
            || document.getElementById('agent-model-select')?.value
            || ''
        ).trim();
        if (selectedId && models.some(model => String(model.id) === selectedId)) return selectedId;
        return String(models[0]?.id || '').trim();
    }

    function defaultLlmInput(selectedNode = null) {
        return {
            model: defaultWorkflowModelId(),
            maxSteps: 20,
            systemPrompt: '你是工作流中的分析节点。请严格基于输入和上游结果完成任务，输出使用中文。',
            prompt: selectedNode
                ? `请基于上游节点「${selectedNode.title || selectedNode.id}」的输出完成分析：\n{{nodes.${selectedNode.id}.output}}`
                : '请根据本次工作流目标完成分析：\n{{goal}}',
            responseFormat: 'markdown',
            temperature: 0.2,
            maxTokens: 1200
        };
    }

    function isLlmNode(node) {
        return String(node?.tool || '') === 'agent.llm';
    }

    function llmNodes(nodes = []) {
        return nodes.filter(isLlmNode);
    }

    function llmNodeModel(node) {
        return String(node?.input?.model || node?.input?.modelId || node?.input?.model_id || '').trim();
    }

    function ensureLlmNodeInput(node) {
        if (!isLlmNode(node)) return;
        node.input = node.input && typeof node.input === 'object' ? node.input : {};
        if (!llmNodeModel(node)) {
            node.input.model = defaultWorkflowModelId();
        }
    }

    function createDefaultLlmNode(existingIds = []) {
        return {
            id: uniqueId(existingIds, 'llm'),
            title: '大模型处理',
            tool: 'agent.llm',
            input: defaultLlmInput(),
            dependsOn: [],
            condition: 'success',
            retryLimit: 0,
            timeoutMs: 0,
            onError: 'skip_dependents',
            _x: PADDING,
            _y: PADDING
        };
    }

    function writeJson(textarea, spec) {
        if (!textarea) return;
        textarea.value = JSON.stringify(serialize(spec), null, 2);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function getToolSchema(tool) {
        const schema = tool?.input_schema || tool?.inputSchema || tool?.parameters || {};
        return schema && typeof schema === 'object' ? schema : {};
    }

    function isDatabaseConnectionField(name = '', tool = null) {
        if (!tool?.databaseTool) return false;
        return ['connection_id', 'database_connection_id', 'mcp_server_id'].includes(normalizeFieldKey(name));
    }

    const FIELD_LABEL_OVERRIDES = {
        aggregation: '聚合方式',
        apiKey: 'API 密钥',
        api_key: 'API 密钥',
        body: '请求内容',
        candidateLimit: '候选数量上限',
        candidate_limit: '候选数量上限',
        chartType: '图表类型',
        chart_type: '图表类型',
        collection: '集合',
        columns: '字段列表',
        content: '内容',
        countAlias: '数量列别名',
        count_alias: '数量列别名',
        data: '数据',
        file: '文件',
        filename: '文件名',
        filters: '筛选条件',
        footer: '页脚',
        groupAlias: '分组列别名',
        group_alias: '分组列别名',
        groupBy: '分组字段',
        group_by: '分组字段',
        headers: '请求头',
        input: '输入内容',
        instructions: '指令',
        items: '条目列表',
        language: '语言',
        leftPath: '左侧文件路径',
        left_path: '左侧文件路径',
        limit: '返回数量',
        markdown: 'Markdown 内容',
        matchMode: '匹配方式',
        match_mode: '匹配方式',
        maxChars: '最大字符数',
        max_chars: '最大字符数',
        maxHeadings: '最大标题数',
        max_headings: '最大标题数',
        maxItems: '最大条目数',
        max_items: '最大条目数',
        maxTokens: '最大输出长度',
        max_tokens: '最大输出长度',
        message: '消息内容',
        method: '请求方法',
        mode: '处理模式',
        model: '模型',
        path: '文件路径',
        pipeline: '聚合管道',
        pretty: '美化 JSON',
        prompt: '提示词',
        query: '检索问题 / 查询条件',
        renameMap: '字段重命名规则',
        rename_map: '字段重命名规则',
        responseFormat: '响应格式',
        response_format: '响应格式',
        rightPath: '右侧文件路径',
        right_path: '右侧文件路径',
        rows: '数据行',
        sampleRows: '样本行数',
        sample_rows: '样本行数',
        schema: '数据库 Schema / 命名空间',
        sections: '报告段落',
        sheet: '工作表',
        sortBy: '排序依据',
        sort_by: '排序依据',
        sortOrder: '排序方向',
        sort_order: '排序方向',
        sql: 'SQL 语句',
        stream: '流式输出',
        subtitle: '副标题',
        systemPrompt: '系统提示词',
        system_prompt: '系统提示词',
        table: '数据表',
        target: '接收对象',
        targetType: '接收对象类型',
        target_type: '接收对象类型',
        temperature: '随机性',
        text: '文本内容',
        title: '标题',
        tools: '工具列表',
        topK: '返回片段数',
        top_k: '返回片段数',
        trimStrings: '去除首尾空格',
        trim_strings: '去除首尾空格',
        url: '链接地址',
        value: '待处理内容',
        valueField: '指标字段',
        value_field: '指标字段',
        xAxis: '横轴字段',
        x_axis: '横轴字段',
        yAxis: '纵轴字段',
        y_axis: '纵轴字段'
    };

    const TOOL_FIELD_LABEL_OVERRIDES = {
        'rag.search': {
            query: '知识库检索问题',
            topK: '返回片段数',
            top_k: '返回片段数',
            candidateLimit: '候选片段上限',
            candidate_limit: '候选片段上限'
        },
        'agent.llm': {
            prompt: '用户提示词',
            systemPrompt: '系统提示词',
            system_prompt: '系统提示词',
            model: '节点模型',
            temperature: '随机性',
            maxTokens: '最大输出长度',
            max_tokens: '最大输出长度',
            responseFormat: '输出格式',
            response_format: '输出格式'
        },
        'sessions.search': {
            query: '会话关键词'
        },
        'reports.list_files': {
            query: '文件关键词',
            limit: '文件数量上限'
        },
        'reports.read_file_summary': {
            path: '报表文件路径',
            sheet: '工作表名称',
            sampleRows: '样本行数',
            sample_rows: '样本行数'
        },
        'reports.query_table': {
            path: '报表文件路径',
            columns: '返回字段',
            filters: '筛选条件',
            limit: '返回行数'
        },
        'reports.compare_files': {
            leftPath: '左侧报表路径',
            left_path: '左侧报表路径',
            rightPath: '右侧报表路径',
            right_path: '右侧报表路径'
        },
        'db.run_readonly_query': {
            sql: '只读 SQL 语句',
            limit: '最大返回行数'
        },
        'db.group_count': {
            table: '统计数据表',
            groupBy: '分组统计字段',
            group_by: '分组统计字段',
            limit: '分组数量上限'
        },
        'viz.build_chart': {
            rows: '图表数据行',
            xAxis: '横轴字段',
            x_axis: '横轴字段',
            yAxis: '数值字段',
            y_axis: '数值字段',
            groupBy: '系列分组字段',
            group_by: '系列分组字段',
            limit: '图表数据上限'
        },
        'viz.build_table': {
            rows: '表格数据行',
            columns: '展示字段',
            limit: '展示行数'
        },
        'format.to_markdown_table': {
            rows: '表格数据行',
            columns: '展示字段',
            limit: '展示行数'
        },
        'format.to_json': {
            value: '要转换的内容',
            pretty: '格式化输出'
        },
        'format.extract_json': {
            text: '包含 JSON 的文本'
        },
        'format.normalize_text': {
            text: '待规范化文本'
        },
        'im.send_user_message': {
            target: '接收用户',
            title: '消息标题',
            message: '消息正文'
        },
        'im.send_group_message': {
            target: '接收群组',
            title: '消息标题',
            message: '消息正文'
        },
        'im.send_markdown': {
            target: '接收对象',
            targetType: '接收对象类型',
            target_type: '接收对象类型',
            markdown: 'Markdown 消息'
        }
    };

    const FIELD_DESCRIPTION_OVERRIDES = {
        aggregation: '选择对数值字段执行求和、计数、平均值、最小值或最大值。',
        apiKey: '用于访问外部服务的密钥，通常不建议在节点参数里明文填写。',
        api_key: '用于访问外部服务的密钥，通常不建议在节点参数里明文填写。',
        candidateLimit: '系统初步召回的候选数量上限，越大越全面但可能更慢。',
        candidate_limit: '系统初步召回的候选数量上限，越大越全面但可能更慢。',
        chartType: '选择柱状图、折线图、面积图或饼图等展示方式。',
        chart_type: '选择柱状图、折线图、面积图或饼图等展示方式。',
        collection: 'MongoDB 集合名称。',
        columns: '需要读取、展示或输出的字段列表，可填写 JSON 数组。',
        filters: '按字段设置筛选条件，可填写 JSON 对象。',
        groupBy: '选择要按哪个字段分组统计。',
        group_by: '选择要按哪个字段分组统计。',
        groupAlias: '结果里分组字段的输出名称，通常保持默认即可。',
        group_alias: '结果里分组字段的输出名称，通常保持默认即可。',
        input: '传给工具或模型的主要输入内容。',
        instructions: '对工具或模型的执行指令。',
        language: '指定输出或处理使用的语言。',
        countAlias: '结果里数量字段的输出名称，通常保持默认即可。',
        count_alias: '结果里数量字段的输出名称，通常保持默认即可。',
        limit: '限制最多返回多少条结果，避免一次拉取过多数据。',
        markdown: '填写 Markdown 正文，支持插入上游变量。',
        matchMode: '选择精确匹配或包含匹配。',
        match_mode: '选择精确匹配或包含匹配。',
        maxChars: '限制每段或每次处理的最大字符数。',
        max_chars: '限制每段或每次处理的最大字符数。',
        maxHeadings: '最多提取多少个标题。',
        max_headings: '最多提取多少个标题。',
        maxItems: '最多提取多少个条目。',
        max_items: '最多提取多少个条目。',
        maxTokens: '限制模型最多输出多少 token。',
        max_tokens: '限制模型最多输出多少 token。',
        message: '要发送给目标用户或群组的正文。',
        model: '选择或填写本节点调用的模型名称。',
        path: '报表、数据文件或文档的路径。',
        pipeline: 'MongoDB 聚合管道，填写 JSON 数组。',
        pretty: '开启后输出带缩进的 JSON，便于阅读。',
        prompt: '写清任务目标、口径、约束和期望输出格式。',
        query: '输入要检索或查询的问题、关键词或条件。',
        renameMap: '字段旧名到新名的映射，填写 JSON 对象。',
        rename_map: '字段旧名到新名的映射，填写 JSON 对象。',
        responseFormat: '指定模型或工具返回内容的格式。',
        response_format: '指定模型或工具返回内容的格式。',
        rows: '表格数据行，通常引用上游节点的 rows 输出。',
        sampleRows: '读取文件摘要时展示的样本行数量。',
        sample_rows: '读取文件摘要时展示的样本行数量。',
        schema: '可选。用于限定数据库命名空间/模式，例如 PostgreSQL 的 public 或 SQL Server 的 dbo；MySQL、SQLite 通常留空。',
        sections: '报告段落配置，填写 JSON 数组。',
        sheet: 'Excel 工作表名称；CSV 文件通常留空。',
        sortBy: '选择按标签还是按数值排序。',
        sort_by: '选择按标签还是按数值排序。',
        sortOrder: '统计结果按升序或降序排列。',
        sort_order: '统计结果按升序或降序排列。',
        sql: '只允许填写 SELECT、WITH、SHOW、DESCRIBE、EXPLAIN 等只读语句。',
        stream: '开启后可流式返回内容；工作流节点通常保持默认即可。',
        table: '选择或输入要读取的数据表。',
        target: '要发送通知的用户、群组或目标标识。',
        targetType: '选择目标是用户还是群组。',
        target_type: '选择目标是用户还是群组。',
        temperature: '控制模型回复随机性，数值越高越发散。',
        text: '待处理的普通文本或 Markdown 内容。',
        title: '输出内容、图表、报告或消息标题。',
        tools: '可供模型或下游步骤调用的工具列表，填写 JSON 数组。',
        topK: '最终返回给下游节点的片段数量。',
        top_k: '最终返回给下游节点的片段数量。',
        trimStrings: '开启后会去除文本字段首尾空格。',
        trim_strings: '开启后会去除文本字段首尾空格。',
        value: '要转换、序列化或继续处理的内容。',
        valueField: '用于聚合计算的数值字段。',
        value_field: '用于聚合计算的数值字段。',
        xAxis: '作为图表横轴分类、时间或名称的字段。',
        x_axis: '作为图表横轴分类、时间或名称的字段。',
        yAxis: '作为图表纵轴数值的字段。',
        y_axis: '作为图表纵轴数值的字段。'
    };

    const TOOL_FIELD_DESCRIPTION_OVERRIDES = {
        'rag.search': {
            query: '输入要从知识库里检索的问题或关键词。',
            topK: '最终返回给下游节点的知识片段数量。',
            top_k: '最终返回给下游节点的知识片段数量。',
            candidateLimit: '初步召回的候选片段上限，越大越全面但会更慢。',
            candidate_limit: '初步召回的候选片段上限，越大越全面但会更慢。'
        },
        'agent.llm': {
            prompt: '写清本节点要模型完成的任务，可引用上游节点输出或运行输入。',
            systemPrompt: '限定模型角色、语气、安全边界和输出口径；不填则使用工作流默认提示。',
            system_prompt: '限定模型角色、语气、安全边界和输出口径；不填则使用工作流默认提示。',
            model: '必填。填写本节点调用的模型 ID 或 model_name，工作流运行会从这里读取模型。',
            maxSteps: '本工作流运行允许的最大步骤数，作为运行任务的上限。',
            max_steps: '本工作流运行允许的最大步骤数，作为运行任务的上限。',
            responseFormat: '选择 Markdown、纯文本或 JSON，JSON 模式会要求模型只返回合法 JSON。'
        },
        'sessions.search': {
            query: '输入要查找的历史会话关键词或问题。'
        },
        'reports.query_table': {
            filters: '用字段名和值组成筛选条件，例如按状态、日期或部门过滤。'
        },
        'db.group_count': {
            table: '要做分布统计的数据表。',
            groupBy: '按这个字段分组并统计每组数量。',
            group_by: '按这个字段分组并统计每组数量。'
        },
        'viz.build_chart': {
            rows: '图表来源数据，通常引用上游查询或统计节点的 rows 输出。',
            yAxis: '用于绘制高度、数值或占比的字段；饼图可使用数量字段。',
            y_axis: '用于绘制高度、数值或占比的字段；饼图可使用数量字段。'
        }
    };

    const FIELD_PLACEHOLDER_OVERRIDES = {
        apiKey: '建议改用系统配置，不在这里明文填写',
        api_key: '建议改用系统配置，不在这里明文填写',
        candidateLimit: '例如 80',
        candidate_limit: '例如 80',
        collection: '输入集合名',
        columns: '例如 ["name", "amount"]',
        filters: '例如 {"status": "active"}',
        groupBy: '选择或输入字段名',
        group_by: '选择或输入字段名',
        input: '输入内容，或插入上游变量',
        instructions: '写清执行要求和输出口径',
        language: '例如 中文',
        limit: '例如 50',
        markdown: '填写 Markdown 正文，或插入上游变量',
        maxChars: '例如 2000',
        max_chars: '例如 2000',
        maxHeadings: '例如 20',
        max_headings: '例如 20',
        maxItems: '例如 50',
        max_items: '例如 50',
        maxTokens: '例如 1024',
        max_tokens: '例如 1024',
        message: '填写要发送的消息内容',
        model: '填写模型名称',
        path: '选择或输入文件路径',
        pipeline: '填写 JSON 数组，例如 [{"$limit": 20}]',
        prompt: '写清任务、口径和输出要求',
        query: '输入要检索的问题或关键词',
        renameMap: '例如 {"old_name": "new_name"}',
        rename_map: '例如 {"old_name": "new_name"}',
        responseFormat: '例如 json 或 markdown',
        response_format: '例如 json 或 markdown',
        rows: '插入上游 rows 变量，或粘贴 JSON 数组',
        sampleRows: '例如 20',
        sample_rows: '例如 20',
        schema: '不确定就留空；PostgreSQL 可填 public，SQL Server 可填 dbo',
        sections: '填写报告段落 JSON 数组',
        sheet: '输入工作表名，CSV 可留空',
        sql: 'SELECT ... FROM ...',
        stream: '不确定时保持默认',
        table: '选择或输入表名',
        target: '输入用户、群组或目标标识',
        temperature: '0 到 2，越高越发散',
        text: '输入文本，或插入上游变量',
        title: '不填则自动生成',
        tools: '填写 JSON 数组，或留空使用默认工具',
        topK: '例如 5',
        top_k: '例如 5',
        value: '输入内容，或插入上游变量',
        valueField: '输入用于计算的字段名',
        value_field: '输入用于计算的字段名',
        xAxis: '输入横轴字段名',
        x_axis: '输入横轴字段名',
        yAxis: '输入数值字段名',
        y_axis: '输入数值字段名'
    };

    const TOOL_FIELD_PLACEHOLDER_OVERRIDES = {
        'rag.search': {
            query: '例如：最近 30 天哪个产品线投诉最多？',
            topK: '例如 5',
            top_k: '例如 5',
            candidateLimit: '例如 80',
            candidate_limit: '例如 80'
        },
        'agent.llm': {
            prompt: '例如：请基于 {{nodes.search.output}} 总结关键发现',
            systemPrompt: '例如：你是严谨的数据分析助手，只根据输入回答',
            system_prompt: '例如：你是严谨的数据分析助手，只根据输入回答',
            model: '必填：模型 ID 或 model_name',
            maxSteps: '例如 20',
            max_steps: '例如 20',
            maxTokens: '例如 1200',
            max_tokens: '例如 1200',
            responseFormat: 'markdown / text / json'
        },
        'sessions.search': {
            query: '输入会话关键词'
        },
        'reports.list_files': {
            query: '输入文件名或业务关键词'
        },
        'db.run_readonly_query': {
            sql: 'SELECT ... FROM ... LIMIT 100'
        },
        'db.group_count': {
            table: '选择统计数据表',
            groupBy: '选择分组字段',
            group_by: '选择分组字段'
        }
    };

    function normalizeFieldKey(name = '') {
        return String(name || '')
            .trim()
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/[\s.-]+/g, '_')
            .toLowerCase();
    }

    function fieldLookupKeys(name = '') {
        const raw = String(name || '').trim();
        const normalized = normalizeFieldKey(raw);
        return [...new Set([raw, normalized])].filter(Boolean);
    }

    function readFieldOverride(map, name) {
        if (!map || !name) return '';
        const keys = fieldLookupKeys(name);
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        }
        return '';
    }

    function readToolFieldOverride(map, name, tool) {
        if (!map || !tool) return '';
        const shortName = toolShortName(tool);
        const fullName = toolValue(tool);
        const toolMaps = [map[shortName], map[fullName]].filter(Boolean);
        for (const toolMap of toolMaps) {
            const value = readFieldOverride(toolMap, name);
            if (value) return value;
        }
        return '';
    }

    function hasChineseText(value = '') {
        return /[\u4e00-\u9fff]/.test(String(value || ''));
    }

    function normalizeSchemaType(schema = {}) {
        const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
        return String(type || '').trim() || 'string';
    }

    function friendlySchemaTypeLabel(schema = {}) {
        const rawType = Array.isArray(schema?.type) ? schema.type : [schema?.type || 'value'];
        const map = {
            array: '列表',
            boolean: '开关',
            integer: '整数',
            number: '数字',
            object: '对象',
            string: '文本',
            value: '任意值'
        };
        return rawType.map(type => map[String(type || 'value')] || '任意值').join(' / ');
    }

    function genericFieldLabel(name = '') {
        const raw = String(name || '').trim();
        if (!raw) return '参数';
        return `参数：${raw}`;
    }

    function genericFieldDescription(name, schema = {}) {
        const type = normalizeSchemaType(schema);
        if (type === 'boolean') return '开启或关闭该选项。';
        if (type === 'integer' || type === 'number') return '填写数字，具体范围以工具要求为准。';
        if (type === 'array') return '填写 JSON 数组，或插入上游节点输出。';
        if (type === 'object') return '填写 JSON 对象，用于传递结构化配置。';
        if (/id$/i.test(String(name || ''))) return '填写对应对象的标识。';
        return '填写文本内容，可直接输入或插入变量。';
    }

    function friendlyFieldLabel(name, schema = {}, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '数据库连接';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_LABEL_OVERRIDES, name, tool);
        if (toolOverride) return toolOverride;
        const globalOverride = readFieldOverride(FIELD_LABEL_OVERRIDES, name);
        if (globalOverride) return globalOverride;
        const explicitTitle = String(schema?.title || '').trim();
        if (hasChineseText(explicitTitle)) return explicitTitle;
        return genericFieldLabel(name);
    }

    function friendlyFieldDescription(name, schema = {}, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '选择本节点要读取的具体数据库连接。';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_DESCRIPTION_OVERRIDES, name, tool);
        if (toolOverride) return toolOverride;
        const globalOverride = readFieldOverride(FIELD_DESCRIPTION_OVERRIDES, name);
        if (globalOverride) return globalOverride;
        const explicit = String(schema?.description || '').trim();
        if (hasChineseText(explicit)) return explicit;
        return genericFieldDescription(name, schema);
    }

    function friendlyFieldPlaceholder(name, schema = {}, required = false, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '选择数据库连接';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_PLACEHOLDER_OVERRIDES, name, tool);
        const globalOverride = readFieldOverride(FIELD_PLACEHOLDER_OVERRIDES, name);
        const type = normalizeSchemaType(schema);
        const fallback = type === 'array'
            ? '填写 JSON 数组'
            : type === 'object'
                ? '填写 JSON 对象'
                : type === 'integer' || type === 'number'
                    ? '填写数字'
                    : '填写文本';
        const placeholder = toolOverride || globalOverride || fallback;
        return `${required ? '必填：' : '可选：'}${placeholder}`;
    }

    function friendlyEnumOptionLabel(name, option) {
        const key = `${normalizeFieldKey(name)}:${String(option)}`;
        const map = {
            'aggregation:avg': '平均值',
            'aggregation:count': '计数',
            'aggregation:max': '最大值',
            'aggregation:min': '最小值',
            'aggregation:sum': '求和',
            'chart_type:area': '面积图',
            'chart_type:bar': '柱状图',
            'chart_type:line': '折线图',
            'chart_type:pie': '饼图',
            'match_mode:contains': '包含匹配',
            'match_mode:exact': '精确匹配',
            'mode:lower': '转小写',
            'mode:plain': '保持原样',
            'mode:upper': '转大写',
            'response_format:json': 'JSON',
            'response_format:markdown': 'Markdown',
            'response_format:text': '纯文本',
            'sort_by:label': '按标签',
            'sort_by:value': '按数值',
            'sort_order:asc': '升序',
            'sort_order:desc': '降序',
            'target_type:group': '群组',
            'target_type:user': '用户'
        };
        return map[key] || String(option);
    }

    function schemaExampleValue(schema = {}, key = '') {
        if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default;
        if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        if (type === 'integer' || type === 'number') return schema.minimum || 0;
        if (type === 'boolean') return false;
        if (type === 'array') return [];
        if (type === 'object') {
            const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            return Object.fromEntries(Object.entries(props).slice(0, 6).map(([name, child]) => [name, schemaExampleValue(child, name)]));
        }
        if (/query|keyword|prompt|text|title|name/i.test(key)) return '';
        return '';
    }

    function buildToolInputTemplate(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
        const entries = Object.entries(props).filter(([name, child]) => required.has(name) || Object.prototype.hasOwnProperty.call(child || {}, 'default'));
        const selected = entries.length ? entries : Object.entries(props).slice(0, 8);
        return Object.fromEntries(selected.map(([name, child]) => [name, schemaExampleValue(child, name)]));
    }

    function renderToolSchemaHint(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const rows = Object.entries(props).slice(0, 8).map(([name, item]) => {
            const type = friendlySchemaTypeLabel(item);
            const mark = required.has(name) ? '必填' : '可选';
            const description = friendlyFieldDescription(name, item, tool);
            return `
                <div class="pivot-dag-schema-row">
                    <div class="pivot-dag-schema-row-head">
                        <strong>${escapeHtml(friendlyFieldLabel(name, item, tool))}</strong>
                        <em>${escapeHtml(type)} · ${mark}</em>
                        <code>${escapeHtml(name)}</code>
                    </div>
                    ${description ? `<small>${escapeHtml(description)}</small>` : ''}
                </div>
            `;
        });
        if (!rows.length) return '<div class="pivot-dag-schema-hint is-empty">当前工具不需要输入参数</div>';
        return `<div class="pivot-dag-schema-hint">${rows.join('')}</div>`;
    }

    function createEdgePath(fromNode, toNode) {
        const startX = fromNode._x + NODE_WIDTH;
        const startY = fromNode._y + NODE_HEIGHT / 2;
        const endX = toNode._x;
        const endY = toNode._y + NODE_HEIGHT / 2;
        const c1x = startX + Math.max(40, (endX - startX) / 2);
        const c2x = endX - Math.max(40, (endX - startX) / 2);
        return `M ${startX},${startY} C ${c1x},${startY} ${c2x},${endY} ${endX},${endY}`;
    }

    function makeSvgEl(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
        return el;
    }

    function makeButton(label, title, onClick, options = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const baseClass = options.variant === 'primary' ? 'btn-primary' : 'btn-secondary';
        btn.className = `${baseClass} pivot-dag-toolbar-btn${options.tone ? ` is-${options.tone}` : ''}`;
        if (options.icon) {
            const icon = document.createElement('span');
            icon.className = 'pivot-dag-toolbar-btn-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = options.icon;
            const text = document.createElement('span');
            text.className = 'pivot-dag-toolbar-btn-text';
            text.textContent = label;
            btn.appendChild(icon);
            btn.appendChild(text);
        } else {
            btn.textContent = label;
        }
        if (title) btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function makeToolbarDropdown(label, buttons, className = '') {
        const dropdown = document.createElement('details');
        dropdown.className = `pivot-dag-toolbar-dropdown${className ? ` ${className}` : ''}`;
        dropdown.setAttribute('aria-label', label);
        const summary = document.createElement('summary');
        summary.className = 'pivot-dag-toolbar-summary';
        summary.textContent = label;
        const menu = document.createElement('div');
        menu.className = 'pivot-dag-toolbar-menu';
        menu.setAttribute('role', 'menu');
        buttons.forEach(button => {
            button.setAttribute('role', 'menuitem');
            button.addEventListener('click', () => { dropdown.open = false; });
            menu.appendChild(button);
        });
        dropdown.appendChild(summary);
        dropdown.appendChild(menu);
        dropdown.addEventListener('toggle', () => {
            const host = dropdown.parentElement;
            if (!dropdown.open || !host) return;
            host.querySelectorAll('.pivot-dag-toolbar-dropdown[open]').forEach(item => {
                if (item !== dropdown) item.open = false;
            });
        });
        return dropdown;
    }

    function mount({ canvas, textarea, toolbar, inspector, getTools, onChange, onOpenJson, onNodeSelectionChange }) {
        if (!canvas) return null;

        // 幂等：如果已有实例先销毁
        if (canvas._pivotDagDestroy) canvas._pivotDagDestroy();

        const initialParsedSpec = readJson(textarea ? textarea.value : '');
        let spec = ensureDefaults(initialParsedSpec);
        const shouldFlushInitialDefaults = !Array.isArray(initialParsedSpec?.nodes) || initialParsedSpec.nodes.length === 0;
        let selectedId = null;
        let connecting = null; // { fromId, ghost: <path> }
        let pendingFlush = null;
        let suppressTextareaSync = false;
        let toolbarStatus = null;
        // v0.0.51 缩放与平移状态：内容坐标原点固定，通过 viewBox 偏移 + 缩放呈现
        const viewState = { x: 0, y: 0, scale: DEFAULT_VIEW_SCALE };
        const SCALE_MIN = 0.3;
        const SCALE_MAX = 2.5;
        let panning = null; // { startX, startY, originX, originY }

        const root = makeSvgEl('svg', {
            class: 'pivot-dag-svg',
            xmlns: SVG_NS,
            preserveAspectRatio: 'xMinYMin meet'
        });
        const defs = makeSvgEl('defs');
        const marker = makeSvgEl('marker', {
            id: 'pivot-dag-arrow',
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 6,
            markerHeight: 6,
            orient: 'auto-start-reverse'
        });
        marker.appendChild(makeSvgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#94a3b8' }));
        defs.appendChild(marker);
        root.appendChild(defs);
        const edgesLayer = makeSvgEl('g', { class: 'pivot-dag-edges' });
        const nodesLayer = makeSvgEl('g', { class: 'pivot-dag-nodes' });
        root.appendChild(edgesLayer);
        root.appendChild(nodesLayer);
        canvas.replaceChildren(root);

        // 小地图 overlay：固定在 canvas 右下角，独立 SVG，点击跳转视口
        const minimap = (() => {
            const wrap = document.createElement('div');
            wrap.className = 'pivot-dag-minimap';
            const mini = makeSvgEl('svg', { class: 'pivot-dag-minimap-svg', xmlns: SVG_NS });
            const miniNodes = makeSvgEl('g', { class: 'pivot-dag-minimap-nodes' });
            const viewport = makeSvgEl('rect', { class: 'pivot-dag-minimap-viewport', fill: 'rgba(59,130,246,0.18)', stroke: '#3b82f6', 'stroke-width': 1.5 });
            mini.appendChild(miniNodes);
            mini.appendChild(viewport);
            wrap.appendChild(mini);
            canvas.appendChild(wrap);
            return { wrap, svg: mini, nodesLayer: miniNodes, viewport };
        })();

        const updateMinimap = () => {
            if (!minimap) return;
            const { width, height } = contentBounds();
            minimap.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
            minimap.nodesLayer.replaceChildren();
            spec.nodes.forEach(node => {
                const rect = makeSvgEl('rect', {
                    x: node._x,
                    y: node._y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 4,
                    ry: 4,
                    fill: selectedId === node.id ? '#3b82f6' : '#cbd5e1',
                    opacity: '0.7'
                });
                minimap.nodesLayer.appendChild(rect);
            });
            // 视口框：viewState 对应内容坐标系下的矩形
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            minimap.viewport.setAttribute('x', viewState.x);
            minimap.viewport.setAttribute('y', viewState.y);
            minimap.viewport.setAttribute('width', vbWidth);
            minimap.viewport.setAttribute('height', vbHeight);
        };

        // 点击小地图：把视口中心移到点击位置
        const minimapClickHandler = (event) => {
            const rect = minimap.svg.getBoundingClientRect();
            const { width, height } = contentBounds();
            const contentX = (event.clientX - rect.left) * width / rect.width;
            const contentY = (event.clientY - rect.top) * height / rect.height;
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            viewState.x = Math.max(0, contentX - vbWidth / 2);
            viewState.y = Math.max(0, contentY - vbHeight / 2);
            updateViewBox();
        };
        minimap.svg.addEventListener('click', minimapClickHandler);

        const flushOut = () => {
            if (pendingFlush) caf(pendingFlush);
            pendingFlush = raf(() => {
                pendingFlush = null;
                suppressTextareaSync = true;
                writeJson(textarea, spec);
                suppressTextareaSync = false;
                if (typeof onChange === 'function') onChange(serialize(spec));
            });
        };

        // 计算内容包围盒；保证空 DAG 也有合理底盘
        const contentBounds = () => {
            const w = Math.max(MIN_CONTENT_WIDTH, ...spec.nodes.map(n => n._x + NODE_WIDTH)) + PADDING;
            const h = Math.max(MIN_CONTENT_HEIGHT, ...spec.nodes.map(n => n._y + NODE_HEIGHT)) + PADDING;
            return { width: w, height: h };
        };

        const updateViewBox = () => {
            const { width, height } = contentBounds();
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            root.setAttribute('viewBox', `${viewState.x} ${viewState.y} ${vbWidth} ${vbHeight}`);
            root.setAttribute('width', '100%');
            root.setAttribute('height', '100%');
            root.style.minHeight = '100%';
            updateMinimap();
        };

        // 重置缩放/平移到完整内容可见
        const fitToContent = () => {
            viewState.x = 0;
            viewState.y = 0;
            viewState.scale = DEFAULT_VIEW_SCALE;
            updateViewBox();
        };

        const currentTools = () => typeof getTools === 'function' ? (getTools() || []) : [];

        const databaseWizardConnections = () => {
            const entries = new Map();
            currentTools().forEach(tool => {
                const shortName = toolShortName(tool);
                if (!shortName.startsWith('db.')) return;
                databaseConnectionsFromTool(tool).forEach(connection => {
                    const serverId = String(connection.connectionId || connection.serverId || '').trim();
                    if (!serverId) return;
                    const entry = entries.get(serverId) || {
                        serverId,
                        serverName: connection.serverName || tool.serverName || `数据库 ${serverId}`,
                        databaseType: connection.databaseType || '',
                        tools: {}
                    };
                    entry.tools[shortName] = {
                        ...tool,
                        fullName: connection.fullName || toolValue(tool),
                        serverId,
                        connectionId: serverId,
                        serverName: connection.serverName || tool.serverName || entry.serverName,
                        databaseType: connection.databaseType || tool.databaseType || ''
                    };
                    entries.set(serverId, entry);
                });
            });
            return [...entries.values()]
                .filter(entry => Object.keys(entry.tools || {}).length)
                .sort((a, b) => a.serverName.localeCompare(b.serverName, 'zh-Hans-CN'));
        };

        const databaseToolConnectionOptions = (tool) => {
            const direct = databaseConnectionsFromTool(tool);
            if (direct.length) return direct;
            const serverId = mcpServerIdFromTool(tool);
            if (!serverId) return [];
            const entry = databaseWizardConnections().find(item => item.serverId === serverId);
            return entry ? [{
                serverId: entry.serverId,
                connectionId: entry.serverId,
                serverName: entry.serverName,
                databaseType: entry.databaseType || '',
                fullName: entry.tools?.[toolShortName(tool)]?.fullName || toolValue(tool)
            }] : [];
        };

        const databaseConnectionInputValue = (input = {}) => String(
            input?.connectionId
            ?? input?.connection_id
            ?? input?.databaseConnectionId
            ?? input?.database_connection_id
            ?? input?.mcpServerId
            ?? input?.mcp_server_id
            ?? ''
        ).trim();

        const selectedDatabaseConnectionId = (tool, input = {}) => {
            const options = databaseToolConnectionOptions(tool);
            const explicit = databaseConnectionInputValue(input);
            if (explicit && options.some(item => String(item.connectionId || item.serverId || '') === explicit)) return explicit;
            return options[0]?.connectionId || options[0]?.serverId || explicit || '';
        };

        const databaseConnectionLabel = (tool, serverId) => {
            const option = databaseToolConnectionOptions(tool).find(item => String(item.connectionId || item.serverId || '') === String(serverId || ''));
            if (!option) return String(serverId || '') || '未选择';
            return [option.serverName || `数据库 ${option.serverId}`, option.databaseType].filter(Boolean).join(' · ');
        };

        const callWizardTool = async (tool, input = {}) => {
            if (!tool) throw new Error('工具不可用。');
            const res = await apiFetch(`${API_BASE}/mcp/tools/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: toolValue(tool), input })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '工具调用失败。');
            return data.result?.structuredContent ?? data.result;
        };

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
                <span class="pivot-dag-input-summary-chip" title="${escapeAttr(title)}">
                    <strong>${escapeHtml(friendlyFieldLabel(key, properties[key], tool))}</strong>
                    <em>${escapeHtml(preview)}</em>
                </span>
            `;
            }).join('');
        };

        const buildWizardDependencyNodes = (node) => (node?.dependsOn || [])
            .map(depId => spec.nodes.find(n => n.id === depId))
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
                <div class="pivot-dag-wizard-sources-head">${escapeHtml(group.label)}</div>
                ${group.note ? `<div class="pivot-dag-wizard-sources-note">${escapeHtml(group.note)}</div>` : ''}
                <div class="pivot-dag-wizard-sources-list">
                    ${group.tokens.length
                        ? group.tokens.map(item => `
                            <button type="button" class="pivot-dag-token-btn pivot-dag-wizard-token-btn" data-pivot-dag-wizard-token="${escapeAttr(item.token)}" title="${escapeAttr(item.token)}">${escapeHtml(item.label)}</button>
                        `).join('')
                        : '<div class="pivot-dag-wizard-sources-empty">暂无可直接引用的输出</div>'}
                </div>
            </section>
        `).join('');

        const renderWizardField = (name, schema = {}, value, required = false, dependencyNodes = [], tool = null) => {
            const type = normalizeSchemaType(schema);
            const typeLabel = friendlySchemaTypeLabel(schema);
            const label = friendlyFieldLabel(name, schema, tool);
            const description = friendlyFieldDescription(name, schema, tool);
            const placeholder = friendlyFieldPlaceholder(name, schema, required, tool);
            const isEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
            const fieldName = String(name || '');
            const isDatabaseConnection = isDatabaseConnectionField(name, tool);
            const codeTextArea = type === 'array'
                || type === 'object'
                || /rows|sections|sql|json/i.test(fieldName);
            const wideRichTextArea = /content|instructions|markdown|message|prompt/i.test(fieldName);
            const proseTextArea = /query|summary|text/i.test(fieldName);
            const useTextArea = codeTextArea || wideRichTextArea || proseTextArea;
            const fieldValue = formatWizardFieldValue(schema, value);
            const suggestions = isDatabaseConnection ? [] : buildWizardFieldSuggestions(name, schema, dependencyNodes);
            const isLlmModelField = toolValue(tool) === 'agent.llm' && normalizeFieldKey(name) === 'model';
            const isSelect = isDatabaseConnection || isLlmModelField || isEnum;
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
                const options = databaseToolConnectionOptions(tool);
                const selectedId = selectedDatabaseConnectionId(tool, { [name]: value });
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${escapeAttr(name)}" data-pivot-dag-db-connection-select="1">
                        ${options.length
                            ? options.map(option => {
                                const optionLabel = [option.serverName || `数据库 ${option.serverId}`, option.databaseType].filter(Boolean).join(' · ');
                                return `<option value="${escapeAttr(option.serverId)}" ${String(option.serverId) === String(selectedId) ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`;
                            }).join('')
                            : '<option value="">暂无可用数据库连接</option>'}
                    </select>
                `;
            } else if (type === 'boolean') {
                controlHtml = `
                    <span class="pivot-dag-wizard-toggle">
                        <input type="checkbox" data-pivot-dag-wizard-field="${escapeAttr(name)}" ${Boolean(value) ? 'checked' : ''}>
                        <span>${escapeHtml(required ? '必填' : '可选')}</span>
                    </span>
                `;
            } else if (isLlmModelField && workflowModelOptions().length) {
                const modelOptions = workflowModelOptions();
                const selectedModelId = String(fieldValue || defaultWorkflowModelId() || '').trim();
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${escapeAttr(name)}">
                        ${modelOptions.map(model => {
                            const valueId = String(model.id || '').trim();
                            const labelText = `${model.name || model.model_name || valueId}${model.user_id ? '（个人）' : ''}`;
                            return `<option value="${escapeAttr(valueId)}" ${String(valueId) === selectedModelId ? 'selected' : ''}>${escapeHtml(labelText)}</option>`;
                        }).join('')}
                    </select>
                `;
            } else if (isEnum) {
                const emptyOption = required ? '' : '<option value="">— 选择 —</option>';
                controlHtml = `
                    <select class="form-input" data-pivot-dag-wizard-field="${escapeAttr(name)}">
                        ${emptyOption}
                        ${schema.enum.map(option => `<option value="${escapeAttr(option)}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${escapeHtml(friendlyEnumOptionLabel(name, option))}</option>`).join('')}
                    </select>
                `;
            } else if (type === 'integer' || type === 'number') {
                const step = type === 'integer' ? '1' : 'any';
                controlHtml = `<input class="form-input" type="number" step="${step}" data-pivot-dag-wizard-field="${escapeAttr(name)}" value="${escapeAttr(fieldValue)}" placeholder="${escapeAttr(placeholder)}">`;
            } else if (useTextArea) {
                const rows = codeTextArea ? 9 : (wideRichTextArea ? 7 : 5);
                const spellcheck = codeTextArea ? ' spellcheck="false"' : '';
                controlHtml = `<textarea class="form-input pivot-dag-wizard-textarea" rows="${rows}" data-pivot-dag-wizard-field="${escapeAttr(name)}" placeholder="${escapeAttr(placeholder)}"${spellcheck}>${escapeHtml(fieldValue)}</textarea>`;
            } else {
                controlHtml = `<input class="form-input" type="text" data-pivot-dag-wizard-field="${escapeAttr(name)}" value="${escapeAttr(fieldValue)}" placeholder="${escapeAttr(placeholder)}">`;
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
                                <button type="button" class="pivot-dag-token-btn pivot-dag-wizard-suggestion-btn" data-pivot-dag-wizard-token="${escapeAttr(item.token)}" data-pivot-dag-wizard-target="${escapeAttr(name)}" title="${escapeAttr(item.token)}">${escapeHtml(item.label)}</button>
                            `).join('')}
                        </div>
                    </div>
                `
                : '';

            return `
                <label class="${fieldClasses}" data-pivot-dag-wizard-field-wrap="${escapeAttr(name)}">
                    <span class="pivot-dag-wizard-field-head">
                        <strong>${escapeHtml(label)}</strong>
                        <span>
                            <em>${escapeHtml(typeLabel)}</em>
                            ${required ? '<em class="is-required">必填</em>' : '<em>可选</em>'}
                        </span>
                    </span>
                    ${controlHtml}
                    ${description ? `<span class="pivot-dag-wizard-field-desc">${escapeHtml(description)}</span>` : ''}
                    <span class="pivot-dag-wizard-field-usage">${escapeHtml(fieldUsageHint(name, schema, tool) || usageHint)}</span>
                    ${suggestionHtml}
                </label>
            `;
        };

        const renderDatabaseAssistPanel = (node, tool, initialInput = {}) => {
            const shortName = toolShortName(tool);
            if (!shortName.startsWith('db.')) return '';
            const selectedServerId = selectedDatabaseConnectionId(tool, initialInput);
            const entries = databaseWizardConnections();
            const selectedEntry = entries.find(item => item.serverId === selectedServerId);
            if (!selectedEntry && !databaseToolConnectionOptions(tool).length) return '';
            const canPickTable = ['db.describe_table', 'db.group_count'].includes(shortName);
            const canPickColumn = shortName === 'db.group_count';
            const canLoadTables = canPickTable && entries.some(entry => Boolean(entry.tools['db.list_tables']));
            const canLoadColumns = canPickColumn && entries.some(entry => Boolean(entry.tools['db.describe_table']));
            if (!canLoadTables && !canLoadColumns) return '';
            return `
                <section class="pivot-dag-wizard-assist" data-pivot-dag-db-assist="${escapeAttr(selectedServerId)}">
                    <div class="pivot-dag-wizard-assist-head">
                        <div>
                            <strong>数据库辅助</strong>
                            <span data-pivot-dag-assist-connection-label>${escapeHtml(selectedEntry?.serverName || databaseConnectionLabel(tool, selectedServerId) || '当前数据库')}</span>
                        </div>
                        <div class="pivot-dag-wizard-assist-actions">
                            ${canLoadTables ? '<button type="button" class="btn-secondary" data-pivot-dag-load-tables="1">读取表</button>' : ''}
                            ${canLoadColumns ? '<button type="button" class="btn-secondary" data-pivot-dag-load-columns="1">读取字段</button>' : ''}
                        </div>
                    </div>
                    <div class="pivot-dag-wizard-assist-grid">
                        <label>
                            <span>Schema / 命名空间</span>
                            <input class="form-input" data-pivot-dag-assist-schema value="${escapeAttr(initialInput.schema || '')}" placeholder="可选，例如 public / dbo">
                        </label>
                        ${canLoadTables ? `
                            <label>
                                <span>数据表</span>
                                <input class="form-input" list="pivot-dag-assist-table-options" data-pivot-dag-assist-table value="${escapeAttr(initialInput.table || '')}" placeholder="读取后选择或手动输入">
                            </label>
                            <datalist id="pivot-dag-assist-table-options"></datalist>
                        ` : ''}
                        ${canLoadColumns ? `
                            <label>
                                <span>字段</span>
                                <input class="form-input" list="pivot-dag-assist-column-options" data-pivot-dag-assist-column value="${escapeAttr(initialInput.groupBy || '')}" placeholder="读取字段后选择">
                            </label>
                            <datalist id="pivot-dag-assist-column-options"></datalist>
                        ` : ''}
                    </div>
                    <div class="pivot-dag-wizard-assist-status" data-pivot-dag-assist-status></div>
                </section>
            `;
        };

        const openNodeInputWizard = (nodeId) => {
            const node = spec.nodes.find(n => n.id === nodeId);
            if (!node) return;
            const tool = resolveToolForNode(currentTools(), node.tool);
            const schema = getToolSchema(tool);
            const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            const fields = Object.entries(properties);
            const dependencyNodes = buildWizardDependencyNodes(node);
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
                ? fields.map(([name, fieldSchema]) => renderWizardField(name, fieldSchema, initialInput[name], required.has(name), dependencyNodes, tool)).join('')
                : '<div class="pivot-dag-wizard-empty">当前工具不需要配置参数，直接应用即可。</div>';
            modal.innerHTML = `
                <div class="modal rag-detail-modal pivot-dag-input-wizard">
                    <div class="rag-detail-header pivot-dag-input-head">
                        <div>
                            <h3>配置节点参数</h3>
                            <p class="model-modal-desc">${escapeHtml(friendlyToolTitle(tool) || node.tool || '当前节点')}</p>
                        </div>
                        <button type="button" class="btn-danger-outline" data-pivot-dag-wizard-close="1">关闭</button>
                    </div>
                    <div class="pivot-dag-wizard-body">
                        <div class="pivot-dag-wizard-form">
                            <section class="pivot-dag-wizard-overview">
                                <div class="pivot-dag-wizard-overview-head">
                                    <strong>当前配置</strong>
                                    <span>表单会写入节点 input；需要写复杂结构时再打开 JSON 编辑。</span>
                                </div>
                                <div class="pivot-dag-wizard-overview-body">
                                    ${renderInputSummary(initialInput, tool)}
                                </div>
                            </section>
                            ${renderDatabaseAssistPanel(node, tool, initialInput)}
                            ${fieldMarkup}
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
            `;

            const wizardHeader = modal.querySelector('.pivot-dag-input-head > div');
            if (wizardHeader) {
                const meta = document.createElement('div');
                meta.className = 'pivot-dag-wizard-meta';
                meta.innerHTML = `
                    <span>${escapeHtml(`${fields.length} 个参数`)}</span>
                    <span>${escapeHtml(`${required.size} 个必填`)}</span>
                    <span>${escapeHtml(`${dependencyNodes.length} 个依赖`)}</span>
                `;
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

            const assistEntry = () => {
                const serverId = currentDatabaseConnectionId();
                return databaseWizardConnections().find(entry => entry.serverId === serverId) || null;
            };

            const syncAssistConnection = () => {
                const serverId = currentDatabaseConnectionId();
                const assist = modal.querySelector('[data-pivot-dag-db-assist]');
                if (assist) assist.dataset.pivotDagDbAssist = serverId;
                const label = modal.querySelector('[data-pivot-dag-assist-connection-label]');
                if (label) label.textContent = databaseConnectionLabel(tool, serverId);
                const tableList = modal.querySelector('#pivot-dag-assist-table-options');
                const columnList = modal.querySelector('#pivot-dag-assist-column-options');
                if (tableList) tableList.innerHTML = '';
                if (columnList) columnList.innerHTML = '';
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
                    if (list) list.innerHTML = tables.map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
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
                    if (list) list.innerHTML = columns.map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
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
                if (tool && toolValue(tool)) node.tool = toolValue(tool);
                node.input = nextInput;
                render();
                flushOut();
                closeWizard();
                window.showToast?.('节点参数已更新', 'success');
            };

            const resetWizard = (draftInput = {}) => {
                syncFormWithDraft(draftInput);
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
            modal.querySelector('[data-pivot-dag-db-connection-select]')?.addEventListener('change', syncAssistConnection);
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

        const openStatsChartWizard = () => {
            const connections = databaseWizardConnections();
            const chartTool = currentTools().find(tool => toolValue(tool) === 'viz.build_chart')
                || findPreferredTool(currentTools(), ['viz.build_chart', 'chart']);
            if (!connections.length) {
                window.showToast?.('请先在能力库启用数据库连接，并刷新工具。', 'error');
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
                                ${connections.map(entry => `<option value="${escapeAttr(entry.serverId)}">${escapeHtml(entry.serverName)}</option>`).join('')}
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
                    modal.querySelector('#pivot-stats-table-options').innerHTML = tables.map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
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
                    modal.querySelector('#pivot-stats-column-options').innerHTML = columns.map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
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
                            dependsOn: ['group_count'],
                            condition: 'success',
                            retryLimit: 0,
                            timeoutMs: 0,
                            onError: 'skip_dependents'
                        }
                    ]
                };
                const apply = () => {
                    spec = ensureDefaults(nextSpec);
                    selectedId = 'group_count';
                    window.setAgentWorkflowDraftName?.(title, { ifEmpty: true });
                    render();
                    fitToContent();
                    flushOut();
                    modal.classList.add('hidden');
                    window.showToast?.('已生成统计图模板节点，可继续自定义编排。', 'success');
                };
                // 检查当前画布是否有未保存的更改
                const hasUnsavedChanges = (() => {
                    if (!textarea) return false;
                    const saved = readJson(textarea.value);
                    if (!saved) return false;
                    return JSON.stringify(serialize(spec)) !== JSON.stringify(serialize(ensureDefaults(saved)));
                })();
                if (spec.nodes.length && typeof window.showConfirm === 'function') {
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

        const wouldCreateCycle = (dependencyId, targetId) => {
            if (!dependencyId || !targetId || dependencyId === targetId) return true;
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            const visit = (id, seen = new Set()) => {
                if (id === targetId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const node = byId.get(id);
                return Boolean(node?.dependsOn?.some(dep => visit(dep, seen)));
            };
            return visit(dependencyId);
        };

        const nodePositionRank = (node) => {
            const x = Number(node?._x);
            const y = Number(node?._y);
            const index = spec.nodes.findIndex(item => item.id === node?.id);
            return {
                x: Number.isFinite(x) ? x : index * (NODE_WIDTH + NODE_GAP_X),
                y: Number.isFinite(y) ? y : 0,
                index
            };
        };

        const isForwardDependency = (dependencyId, targetId) => {
            if (!dependencyId || !targetId || dependencyId === targetId) return false;
            const dependency = spec.nodes.find(item => item.id === dependencyId);
            const target = spec.nodes.find(item => item.id === targetId);
            if (!dependency || !target) return false;
            const depRank = nodePositionRank(dependency);
            const targetRank = nodePositionRank(target);
            if (depRank.x !== targetRank.x) return depRank.x < targetRank.x;
            return depRank.index >= 0 && targetRank.index >= 0 && depRank.index < targetRank.index;
        };

        const getDependencyCandidateNodes = (node) => spec.nodes
            .filter(candidate => isForwardDependency(candidate.id, node?.id))
            .sort((a, b) => {
                const rankA = nodePositionRank(a);
                const rankB = nodePositionRank(b);
                return rankA.x - rankB.x || rankA.y - rankB.y || rankA.index - rankB.index;
            });

        const validateWorkflow = () => {
            const tools = currentTools();
            const toolNames = new Set(tools.map(toolValue).filter(Boolean));
            const errors = [];
            const warnings = [];
            const byId = new Map(spec.nodes.map(node => [node.id, node]));
            const edgeCount = spec.nodes.reduce((sum, node) => sum + (node.dependsOn || []).length, 0);
            if (!spec.nodes.length) errors.push('至少需要 1 个节点');
            const requiredLlmNodes = llmNodes(spec.nodes);
            if (!requiredLlmNodes.length) errors.push('工作流必须包含 1 个大模型节点');
            requiredLlmNodes.forEach(node => {
                if (!llmNodeModel(node)) errors.push(`${node.title || node.id} 需要填写节点模型`);
            });
            spec.nodes.forEach(node => {
                if (!node.tool) errors.push(`${node.title || node.id} 未选择工具`);
                if (node.tool && toolNames.size && !isKnownToolValue(tools, node.tool)) warnings.push(`${node.title || node.id} 使用的工具当前不可用`);
                (node.dependsOn || []).forEach(dep => {
                    if (!byId.has(dep)) errors.push(`${node.title || node.id} 依赖了不存在的节点 ${dep}`);
                    else if (!isForwardDependency(dep, node.id)) errors.push(`${node.title || node.id} 只能连接左侧的上游节点 ${dep}`);
                });
            });
            const visiting = new Set();
            const visited = new Set();
            const hasCycle = (id) => {
                if (visiting.has(id)) return true;
                if (visited.has(id)) return false;
                visiting.add(id);
                const node = byId.get(id);
                const cyclic = Boolean(node?.dependsOn?.some(dep => byId.has(dep) && hasCycle(dep)));
                visiting.delete(id);
                visited.add(id);
                return cyclic;
            };
            if (spec.nodes.some(node => hasCycle(node.id))) errors.push('存在循环依赖');
            const dependencyTargets = new Set(spec.nodes.flatMap(node => node.dependsOn || []));
            const startCount = spec.nodes.filter(node => !(node.dependsOn || []).length).length;
            const endCount = spec.nodes.filter(node => !dependencyTargets.has(node.id)).length;
            if (spec.nodes.length > 1 && startCount === 0) errors.push('缺少起始节点');
            if (spec.nodes.length > 1 && endCount === 0) warnings.push('缺少结束节点');
            return { errors, warnings, nodeCount: spec.nodes.length, edgeCount, startCount, endCount };
        };

        const renderToolbarStatus = () => {
            if (!toolbarStatus) return;
            const report = validateWorkflow();
            const state = report.errors.length ? 'error' : report.warnings.length ? 'warn' : 'ok';
            toolbarStatus.className = `pivot-dag-toolbar-status ${state}`;
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            const parallelNote = report.nodeCount > 1 ? ` · 运行时最多并发执行` : '';
            toolbarStatus.textContent = `${report.nodeCount} 节点 · ${report.edgeCount} 依赖 · ${message}${parallelNote}`;
            toolbarStatus.title = [
                ...report.errors, ...report.warnings,
                '提示：互不依赖的节点会并行执行，可在环境变量 AGENT_DAG_NODE_CONCURRENCY 调整并发数（默认 4）。'
            ].join('\n') || '工作流校验通过';
        };

        const showValidationResult = () => {
            const report = validateWorkflow();
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            window.showToast?.(message, report.errors.length ? 'error' : report.warnings.length ? 'warning' : 'success');
            renderToolbarStatus();
        };

        const notifySelectionChange = (node) => {
            if (typeof onNodeSelectionChange !== 'function') return;
            onNodeSelectionChange(node ? {
                id: node.id,
                title: node.title,
                tool: node.tool
            } : null);
        };

        const openNodeJsonEditor = (nodeId) => {
            const node = spec.nodes.find(n => n.id === nodeId);
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
            modal.innerHTML = `
                <div class="modal rag-detail-modal pivot-dag-json-input-editor">
                    <div class="rag-detail-header pivot-dag-input-head">
                        <div>
                            <h3>编辑 JSON 参数</h3>
                            <p class="model-modal-desc">${escapeHtml([friendlyToolTitle(tool), node.title || node.id].filter(Boolean).join(' · '))}</p>
                        </div>
                        <button type="button" class="btn-danger-outline" data-pivot-dag-json-close="1">关闭</button>
                    </div>
                    <div class="pivot-dag-json-input-body">
                        <div class="pivot-dag-json-main">
                            <textarea class="form-input" data-pivot-dag-json-input spellcheck="false">${escapeHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
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
                                    ${variableTokens.map(item => `<button type="button" class="pivot-dag-token-btn" data-pivot-dag-json-token="${escapeAttr(item.token)}" title="${escapeAttr(item.token)}">${escapeHtml(item.label)}</button>`).join('')}
                                </div>
                            </div>
                        </aside>
                    </div>
                    <div class="agent-workflow-create-actions pivot-dag-json-actions">
                        <button type="button" class="btn-secondary" data-pivot-dag-json-format="1">格式化</button>
                        <button type="button" class="btn-primary" data-pivot-dag-json-apply="1">应用</button>
                    </div>
                </div>
            `;
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
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 参数必须是对象。');
                    setError('');
                    textareaEl.classList.remove('is-invalid');
                    return parsed;
                } catch (e) {
                    textareaEl.classList.add('is-invalid');
                    setError(e.message || 'JSON 格式不正确。');
                    return null;
                }
            };
            const applyJson = () => {
                const parsed = parseInput();
                if (!parsed) return;
                node.input = parsed;
                render();
                flushOut();
                closeJson();
                window.showToast?.('JSON 参数已更新', 'success');
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
            modal.addEventListener('click', event => {
                if (event.target === modal) closeJson();
            }, { once: true });
            modal.classList.remove('hidden');
            requestAnimationFrame(() => textareaEl?.focus?.({ preventScroll: true }));
        };

        const renderInspector = () => {
            if (!inspector) return;
            const node = spec.nodes.find(n => n.id === selectedId);
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
                    // Some input types do not expose text selection.
                }
            }
            if (!node) {
                inspector.innerHTML = '<div class="pivot-dag-inspector-empty">选中节点后可在此编辑标题、工具与输入。</div>';
                notifySelectionChange(null);
                return;
            }
            notifySelectionChange(node);
            const tools = currentTools();
            const selectedTool = resolveToolForNode(tools, node.tool);
            const upstreamNodes = getDependencyCandidateNodes(node);
            const dependsChecks = upstreamNodes.map(upstreamNode => `
                <label class="pivot-dag-depends-item">
                    <input type="checkbox" data-pivot-dag-depend="${escapeAttr(upstreamNode.id)}" ${node.dependsOn.includes(upstreamNode.id) ? 'checked' : ''}>
                    <span>
                        <strong>${escapeHtml(upstreamNode.title || upstreamNode.id)}</strong>
                        <em>${escapeHtml(upstreamNode.id)}</em>
                    </span>
                </label>
            `).join('') || '<span class="pivot-dag-inspector-empty">这是起始节点，没有可选上游节点。</span>';
            const toolOptions = renderToolOptions(tools, node.tool);
            inspector.innerHTML = `
                <div class="pivot-dag-inspector-row pivot-dag-inspector-row-main">
                    <label class="pivot-dag-node-id-field">
                        <span>节点 ID</span>
                        <input type="text" data-pivot-dag-node-id-display value="${escapeHtml(node.id)}" readonly aria-readonly="true" title="系统自动生成，用于依赖和变量引用，默认不可修改">
                        <small>系统自动生成，用于依赖和变量引用</small>
                    </label>
                    <label><span>标题</span><input type="text" data-pivot-dag-field="title" value="${escapeHtml(node.title)}" maxlength="120"></label>
                </div>
                <div class="pivot-dag-inspector-row pivot-dag-inspector-row-tool">
                    <label class="pivot-dag-tool-field"><span>工具</span>
                        <select data-pivot-dag-field="tool">${toolOptions}</select>
                    </label>
                    <label><span>条件</span>
                        <select data-pivot-dag-field="condition">
                            <option value="success" ${node.condition === 'success' ? 'selected' : ''}>上游成功后执行</option>
                            <option value="always" ${node.condition === 'always' ? 'selected' : ''}>始终执行</option>
                        </select>
                    </label>
                </div>
                ${renderSelectedToolMeta(selectedTool)}
                <div class="pivot-dag-inspector-row pivot-dag-inspector-row-runtime">
                    <label><span>失败策略</span>
                        <select data-pivot-dag-field="onError">
                            <option value="skip_dependents" ${node.onError === 'skip_dependents' ? 'selected' : ''}>失败后跳过下游</option>
                            <option value="continue" ${node.onError === 'continue' ? 'selected' : ''}>失败后继续下游</option>
                            <option value="stop" ${node.onError === 'stop' ? 'selected' : ''}>失败后停止工作流</option>
                        </select>
                    </label>
                    <label><span>重试次数</span><input type="number" min="0" max="5" data-pivot-dag-field="retryLimit" value="${Number(node.retryLimit || 0)}" placeholder="0" title="失败后自动重试次数，0 表示不重试，最多 5 次"></label>
                    <label><span>超时 ms</span><input type="number" min="0" max="600000" step="1000" data-pivot-dag-field="timeoutMs" value="${Number(node.timeoutMs || 0)}" placeholder="默认" title="节点工具调用超时毫秒数，0 表示使用智能体全局超时设置"></label>
                </div>
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
                    <div class="pivot-dag-input-overview-summary">${renderInputSummary(node.input, selectedTool)}</div>
                    <div class="pivot-dag-input-overview-actions">
                        <button type="button" class="btn-primary" data-pivot-dag-open-wizard="1">配置参数</button>
                        <button type="button" class="btn-secondary" data-pivot-dag-open-json="1">编辑 JSON</button>
                        <button type="button" class="btn-secondary" data-pivot-dag-apply-template="1">套用模板</button>
                    </div>
                </div>
            `;
            inspector.querySelector('[data-pivot-dag-open-wizard]')?.addEventListener('click', () => openNodeInputWizard(node.id));
            inspector.querySelector('[data-pivot-dag-open-json]')?.addEventListener('click', () => openNodeJsonEditor(node.id));

            inspector.querySelectorAll('[data-pivot-dag-field]').forEach(input => {
                input.addEventListener('input', (e) => handleInspectorEdit(e.target));
                input.addEventListener('change', (e) => handleInspectorEdit(e.target));
            });
            inspector.querySelectorAll('[data-pivot-dag-depend]').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => handleDependsToggle(e.target));
            });
            inspector.querySelector('[data-pivot-dag-apply-template]')?.addEventListener('click', () => applyToolInputTemplate(node.id));
            if (focusSnapshot?.field) {
                const next = inspector.querySelector(`[data-pivot-dag-field="${cssEscape(focusSnapshot.field)}"]`);
                next?.focus?.({ preventScroll: true });
                if (next && focusSnapshot.start !== null && typeof next.setSelectionRange === 'function') {
                    try {
                        next.setSelectionRange(focusSnapshot.start, focusSnapshot.end ?? focusSnapshot.start);
                    } catch (e) {
                        // Ignore controls that cannot restore a cursor range.
                    }
                }
            } else if (focusSnapshot?.depend) {
                inspector.querySelector(`[data-pivot-dag-depend="${cssEscape(focusSnapshot.depend)}"]`)?.focus?.({ preventScroll: true });
            }
        };

        const applyToolInputTemplate = (nodeId) => {
            const node = spec.nodes.find(n => n.id === nodeId);
            if (!node) return;
            const tool = resolveToolForNode(currentTools(), node.tool);
            const template = buildToolInputTemplate(tool);
            node.input = { ...template, ...(node.input || {}) };
            render();
            flushOut();
            window.showToast?.('已套用工具参数模板', 'success');
        };

        const handleInspectorEdit = (input) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const field = input.dataset.pivotDagField;
            if (field === 'title') {
                node.title = String(input.value || '').slice(0, 120);
            } else if (field === 'tool') {
                const nextTool = String(input.value || '');
                if (isLlmNode(node) && nextTool !== 'agent.llm' && llmNodes(spec.nodes).length <= 1) {
                    input.value = node.tool;
                    window.showToast?.('工作流必须保留 1 个大模型节点', 'warning');
                    return;
                }
                node.tool = nextTool;
                if (node.tool === 'agent.llm') {
                    node.input = { ...defaultLlmInput(), ...(node.input || {}) };
                    ensureLlmNodeInput(node);
                }
            } else if (field === 'condition') {
                node.condition = ['always', 'success'].includes(input.value) ? input.value : 'success';
            } else if (field === 'onError') {
                node.onError = ['skip_dependents', 'continue', 'stop'].includes(input.value) ? input.value : 'skip_dependents';
            } else if (field === 'retryLimit') {
                node.retryLimit = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 5));
            } else if (field === 'timeoutMs') {
                node.timeoutMs = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 600000));
            } else if (field === 'input') {
                try {
                    const parsed = JSON.parse(input.value || '{}');
                    node.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                    input.classList.remove('is-invalid');
                } catch (e) {
                    input.classList.add('is-invalid');
                    return;
                }
            }
            render();
            flushOut();
        };

        const handleDependsToggle = (checkbox) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const dep = checkbox.dataset.pivotDagDepend;
            const deps = new Set(node.dependsOn || []);
            if (checkbox.checked) {
                if (!isForwardDependency(dep, node.id)) {
                    checkbox.checked = false;
                    window.showToast?.('只能选择当前节点左侧的上游节点', 'error');
                    return;
                }
                if (wouldCreateCycle(dep, node.id)) {
                    checkbox.checked = false;
                    window.showToast?.('不能添加循环依赖', 'error');
                    return;
                }
                deps.add(dep);
            } else {
                deps.delete(dep);
            }
            node.dependsOn = [...deps];
            clampDependsOn(spec.nodes);
            render();
            flushOut();
        };

        const deleteNode = (id) => {
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return false;
            if (isLlmNode(node) && llmNodes(spec.nodes).length <= 1) {
                window.showToast?.('工作流必须保留 1 个大模型节点', 'warning');
                return false;
            }
            spec.nodes = spec.nodes.filter(n => n.id !== id);
            clampDependsOn(spec.nodes);
            if (selectedId === id) selectedId = null;
            autoLayout(spec.nodes);
            render();
            flushOut();
            return true;
        };

        const addNode = () => {
            const baseId = uniqueId(spec.nodes.map(n => n.id));
            const tools = currentTools();
            // 智能推断默认工具：统计当前画布上使用最多的工具
            const toolCounts = new Map();
            spec.nodes.forEach(n => { if (n.tool) toolCounts.set(n.tool, (toolCounts.get(n.tool) || 0) + 1); });
            const mostUsedTool = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];
            const defaultTool = mostUsedTool && mostUsedTool[1] >= 2 && tools.some(t => toolValue(t) === mostUsedTool[0])
                ? mostUsedTool[0]
                : '';
            const node = {
                id: baseId,
                title: '新节点',
                tool: defaultTool,
                input: {},
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
        };

        const addPresetNode = (preset) => {
            const tools = currentTools();
            const preferred = findPreferredTool(tools, preset.patterns || []);
            const baseId = uniqueId(spec.nodes.map(n => n.id), preset.base || 'node');
            const selectedNode = spec.nodes.find(n => n.id === selectedId);
            const inputTemplate = typeof preset.input === 'function'
                ? preset.input({ selectedId, selectedNode, baseId })
                : (preset.input || {});
            const node = {
                id: baseId,
                title: preset.title,
                tool: toolValue(preferred),
                input: { ...inputTemplate },
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
        };

        const resetLayout = () => {
            autoLayout(spec.nodes);
            render();
        };

        const renderEdges = () => {
            edgesLayer.replaceChildren();
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            spec.nodes.forEach(node => {
                (node.dependsOn || []).forEach(depId => {
                    const from = byId.get(depId);
                    if (!from) return;
                    const path = makeSvgEl('path', {
                        class: 'pivot-dag-edge',
                        d: createEdgePath(from, node),
                        'marker-end': 'url(#pivot-dag-arrow)'
                    });
                    edgesLayer.appendChild(path);
                });
            });
        };

        const renderNodes = () => {
            nodesLayer.replaceChildren();
            const tools = currentTools();
            spec.nodes.forEach(node => {
                const group = makeSvgEl('g', {
                    class: `pivot-dag-node ${selectedId === node.id ? 'is-selected' : ''} ${node.tool ? '' : 'has-warning'}`,
                    transform: `translate(${node._x}, ${node._y})`,
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(makeSvgEl('rect', {
                    class: 'pivot-dag-node-body',
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 8,
                    ry: 8
                }));
                const title = makeSvgEl('text', { class: 'pivot-dag-node-title', x: 10, y: 18 });
                title.textContent = node.title || node.id;
                group.appendChild(title);
                const toolDisplay = buildNodeToolDisplay(tools, node.tool);
                const toolWrap = makeSvgEl('foreignObject', {
                    class: 'pivot-dag-node-tool-foreign',
                    x: 10,
                    y: 27,
                    width: NODE_WIDTH - 20,
                    height: 30
                });
                const toolBody = document.createElement('div');
                toolBody.className = `pivot-dag-node-tool ${node.tool ? '' : 'is-empty'}`;
                toolBody.title = toolDisplay.tooltip;
                const toolArrow = document.createElement('span');
                toolArrow.className = 'pivot-dag-node-tool-arrow';
                toolArrow.textContent = '→';
                const toolName = document.createElement('span');
                toolName.className = 'pivot-dag-node-tool-name';
                toolName.textContent = toolDisplay.title;
                toolBody.appendChild(toolArrow);
                toolBody.appendChild(toolName);
                if (toolDisplay.shortId) {
                    const toolId = document.createElement('span');
                    toolId.className = 'pivot-dag-node-tool-id';
                    toolId.textContent = toolDisplay.shortId;
                    toolBody.appendChild(toolId);
                }
                toolWrap.appendChild(toolBody);
                group.appendChild(toolWrap);
                // 出端口（拖出去创建依赖）
                const outPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-out',
                    cx: NODE_WIDTH,
                    cy: NODE_HEIGHT / 2,
                    r: 5,
                    'data-pivot-dag-port': 'out',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(outPort);
                // 入端口（接收依赖的连接落点）
                const inPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-in',
                    cx: 0,
                    cy: NODE_HEIGHT / 2,
                    r: 5,
                    'data-pivot-dag-port': 'in',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(inPort);
                nodesLayer.appendChild(group);
            });
        };

        const render = () => {
            updateViewBox();
            renderEdges();
            renderNodes();
            renderInspector();
            renderToolbarStatus();
        };

        // —— 交互：节点拖拽、端口连线、选中 ——
        let dragging = null;
        const pointFromEvent = (event) => {
            const rect = root.getBoundingClientRect();
            const vb = root.viewBox.baseVal || { x: 0, y: 0, width: rect.width, height: rect.height };
            const scaleX = vb.width / rect.width;
            const scaleY = vb.height / rect.height;
            return {
                x: (event.clientX - rect.left) * scaleX + vb.x,
                y: (event.clientY - rect.top) * scaleY + vb.y
            };
        };

        const onPointerDown = (event) => {
            const target = event.target;
            if (target.dataset.pivotDagPort === 'out') {
                event.preventDefault();
                const node = spec.nodes.find(n => n.id === target.dataset.pivotDagId);
                if (!node) return;
                const ghost = makeSvgEl('path', { class: 'pivot-dag-edge pivot-dag-edge-ghost' });
                edgesLayer.appendChild(ghost);
                connecting = { fromId: node.id, ghost };
                root.setPointerCapture?.(event.pointerId);
                return;
            }
            const nodeGroup = target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) {
                selectedId = null;
                render();
                // 空白处按下：开始平移
                panning = {
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    originX: viewState.x,
                    originY: viewState.y
                };
                root.classList.add('is-panning');
                root.setPointerCapture?.(event.pointerId);
                return;
            }
            const id = nodeGroup.dataset.pivotDagId;
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return;
            selectedId = id;
            render();
            const pointer = pointFromEvent(event);
            dragging = { id, offsetX: pointer.x - node._x, offsetY: pointer.y - node._y };
            root.setPointerCapture?.(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (connecting) {
                const node = spec.nodes.find(n => n.id === connecting.fromId);
                if (!node) return;
                const pointer = pointFromEvent(event);
                const startX = node._x + NODE_WIDTH;
                const startY = node._y + NODE_HEIGHT / 2;
                connecting.ghost.setAttribute('d', `M ${startX},${startY} C ${startX + 60},${startY} ${pointer.x - 60},${pointer.y} ${pointer.x},${pointer.y}`);
                return;
            }
            if (dragging) {
                const node = spec.nodes.find(n => n.id === dragging.id);
                if (!node) return;
                const pointer = pointFromEvent(event);
                node._x = Math.max(0, pointer.x - dragging.offsetX);
                node._y = Math.max(0, pointer.y - dragging.offsetY);
                renderEdges();
                const group = nodesLayer.querySelector(`[data-pivot-dag-id="${cssEscape(dragging.id)}"]`);
                if (group) group.setAttribute('transform', `translate(${node._x}, ${node._y})`);
                updateViewBox();
                return;
            }
            if (panning) {
                // 把屏幕像素位移转回内容坐标位移：屏幕 px / (canvas px) * viewBox 宽 = 内容单位
                const rect = root.getBoundingClientRect();
                const { width, height } = contentBounds();
                const dxContent = (event.clientX - panning.startClientX) * (width / viewState.scale) / rect.width;
                const dyContent = (event.clientY - panning.startClientY) * (height / viewState.scale) / rect.height;
                viewState.x = panning.originX - dxContent;
                viewState.y = panning.originY - dyContent;
                updateViewBox();
            }
        };

        const onPointerUp = (event) => {
            if (connecting) {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                const inPort = target?.closest?.('[data-pivot-dag-port="in"]');
                const targetId = inPort?.dataset?.pivotDagId;
                if (targetId && targetId !== connecting.fromId) {
                    const targetNode = spec.nodes.find(n => n.id === targetId);
                    if (targetNode && !targetNode.dependsOn.includes(connecting.fromId)) {
                        if (!isForwardDependency(connecting.fromId, targetId)) {
                            window.showToast?.('只能从左侧上游节点连接到右侧下游节点', 'error');
                            connecting.ghost.remove();
                            connecting = null;
                            render();
                            return;
                        }
                        if (wouldCreateCycle(connecting.fromId, targetId)) {
                            window.showToast?.('不能添加循环依赖', 'error');
                            connecting.ghost.remove();
                            connecting = null;
                            render();
                            return;
                        }
                        targetNode.dependsOn.push(connecting.fromId);
                        clampDependsOn(spec.nodes);
                        flushOut();
                    }
                }
                connecting.ghost.remove();
                connecting = null;
                render();
                return;
            }
            if (dragging) {
                dragging = null;
                flushOut();
            }
            if (panning) {
                panning = null;
                root.classList.remove('is-panning');
            }
        };

        // 滚轮缩放：以光标位置为锚点
        const onWheel = (event) => {
            event.preventDefault();
            const factor = event.deltaY > 0 ? 0.9 : 1.1;
            const nextScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, viewState.scale * factor));
            if (nextScale === viewState.scale) return;
            const anchor = pointFromEvent(event); // 缩放前光标所在内容坐标
            viewState.scale = nextScale;
            // 缩放后保持光标对应同一内容点：anchor 在新视口中仍位于相同屏幕位置
            const rect = root.getBoundingClientRect();
            const { width, height } = contentBounds();
            const newVbWidth = width / viewState.scale;
            const newVbHeight = height / viewState.scale;
            const offsetX = (event.clientX - rect.left) / rect.width;
            const offsetY = (event.clientY - rect.top) / rect.height;
            viewState.x = anchor.x - offsetX * newVbWidth;
            viewState.y = anchor.y - offsetY * newVbHeight;
            updateViewBox();
        };

        const onDoubleClick = (event) => {
            const nodeGroup = event.target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) return;
            selectedId = nodeGroup.dataset.pivotDagId;
            render();
            // 把焦点放到 inspector 第一个输入，便于直接改名
            inspector?.querySelector('input[data-pivot-dag-field="title"]')?.focus();
        };

        // 键盘快捷键：Delete/Escape
        const onKeyDown = (event) => {
            // 仅在画布或节点有焦点时响应，避免与文本输入冲突
            const activeTag = (document.activeElement?.tagName || '').toLowerCase();
            const editingInput = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';
            if (editingInput) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (selectedId) {
                    event.preventDefault();
                    deleteNode(selectedId);
                }
            } else if (event.key === 'Escape') {
                if (selectedId) {
                    event.preventDefault();
                    selectedId = null;
                    render();
                    if (typeof onNodeSelectionChange === 'function') onNodeSelectionChange(null);
                }
            }
        };
        const closeToolbarDropdowns = (event) => {
            if (!toolbar || event.target?.closest?.('.pivot-dag-toolbar-dropdown')) return;
            toolbar.querySelectorAll('.pivot-dag-toolbar-dropdown[open]').forEach(item => {
                item.open = false;
            });
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', closeToolbarDropdowns);

        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        root.addEventListener('dblclick', onDoubleClick);
        root.addEventListener('wheel', onWheel, { passive: false });

        // —— 工具栏 ——
        if (toolbar) {
            toolbar.replaceChildren();
            toolbar.appendChild(makeToolbarDropdown('节点', [
                makeButton('自定义节点', '从空白节点开始，自选工具、输入和依赖', addNode, { icon: '+' }),
                makeButton('大模型', '添加大模型处理节点，可总结、抽取或生成内容', () => addPresetNode({
                    base: 'llm',
                    title: '大模型处理',
                    patterns: ['agent.llm'],
                    input: ({ selectedNode }) => defaultLlmInput(selectedNode)
                }), { icon: '+' }),
                makeButton('检索', '添加知识检索节点', () => addPresetNode({
                    base: 'search',
                    title: '知识检索',
                    patterns: ['rag.search', 'knowledge', 'search'],
                    input: { query: '' }
                }), { icon: '+' }),
                makeButton('数据', '添加数据查询节点', () => addPresetNode({
                    base: 'data',
                    title: '数据查询',
                    patterns: ['db.run_readonly_query', 'db.list_tables', 'database'],
                    input: {}
                }), { icon: '+' }),
                makeButton('图表', '添加图表生成节点', () => addPresetNode({
                    base: 'chart',
                    title: '图表生成',
                    patterns: ['viz.build_chart', 'chart'],
                    input: {}
                }), { icon: '+' }),
                makeButton('报告', '添加报告编排节点', () => addPresetNode({
                    base: 'report',
                    title: '报告编排',
                    patterns: ['report.compose', 'report'],
                    input: {}
                }), { icon: '+' })
            ], 'is-node-group'));
            toolbar.appendChild(makeToolbarDropdown('模板', [
                makeButton('统计图模板', '从数据库表和字段快速生成可编辑的统计图工作流', openStatsChartWizard)
            ], 'is-template-group'));
            toolbar.appendChild(makeToolbarDropdown('操作', [
                makeButton('校验', '校验节点、依赖和工具可用性', showValidationResult),
                makeButton('自动布局', '按依赖层次重新排列', resetLayout),
                makeButton('适配画布', '重置缩放和平移到默认视角', fitToContent),
                makeButton('JSON 视图', '打开高级 JSON 编辑弹窗', () => {
                    if (typeof onOpenJson === 'function') onOpenJson();
                })
            ], 'is-action-group'));
            toolbar.appendChild(makeToolbarDropdown('发布', [
                makeButton('发布当前版本', '保存并发布当前工作流版本', () => window.publishSelectedAgentWorkflow?.('current'))
            ], 'is-publish-group'));
            toolbar.appendChild(makeToolbarDropdown('运行', [
                makeButton('预览运行', '使用当前画布快照运行一次', () => window.runAgentWorkflowPreview?.()),
                makeButton('运行发布版', '使用最近发布的稳定版本运行', () => window.runAgentWorkflowPublished?.())
            ], 'is-run-group'));
            toolbarStatus = document.createElement('div');
            toolbarStatus.className = 'pivot-dag-toolbar-status';
            toolbar.appendChild(toolbarStatus);
        }

        // —— textarea 外部改动同步回画布 ——
        const onTextareaInput = () => {
            if (suppressTextareaSync) return;
            const parsed = readJson(textarea.value);
            if (!parsed) return;
            spec = ensureDefaults(parsed);
            selectedId = null;
            render();
        };
        if (textarea) textarea.addEventListener('input', onTextareaInput);

        render();
        if (shouldFlushInitialDefaults && spec.nodes.length) flushOut();

        const destroy = () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', closeToolbarDropdowns);
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('pointerup', onPointerUp);
            root.removeEventListener('pointercancel', onPointerUp);
            root.removeEventListener('dblclick', onDoubleClick);
            root.removeEventListener('wheel', onWheel);
            if (minimap?.svg && typeof minimapClickHandler === 'function') {
                minimap.svg.removeEventListener('click', minimapClickHandler);
            }
            if (textarea) textarea.removeEventListener('input', onTextareaInput);
            canvas.replaceChildren();
            if (minimap?.wrap?.parentNode === canvas) {
                // canvas.replaceChildren 已清空
            }
            if (inspector) inspector.replaceChildren();
            if (toolbar) toolbar.replaceChildren();
            canvas._pivotDagDestroy = null;
        };
        canvas._pivotDagDestroy = destroy;

        return {
            destroy,
            getValue: () => serialize(spec),
            setValue: (value) => {
                spec = ensureDefaults(value || { nodes: [] });
                selectedId = null;
                render();
                flushOut();
            },
            clearSelection: () => {
                selectedId = null;
                render();
            },
            deleteSelectedNode: () => {
                if (!selectedId) return false;
                return deleteNode(selectedId);
            },
            syncFromJson: () => {
                const parsed = readJson(textarea ? textarea.value : '');
                if (!parsed) {
                    if (typeof onChange === 'function') onChange({ error: 'invalid_json' });
                    return false;
                }
                spec = ensureDefaults(parsed);
                selectedId = null;
                render();
                flushOut();
                return true;
            },
            refresh: () => render(),
            // 暴露校验方法用于保存/发布前门禁
            validate: () => validateWorkflow()
        };
    }

    window.PivotDagEditor = { mount };
})();
