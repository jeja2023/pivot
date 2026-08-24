// Agent 工具标签
// 拆自 agent-run-renderers.js。
// Agent 模型能力与工具标签辅助函数。
function agentModelCapabilityMarkup(model) {
    const textIcon = '<span class="cap-icon text" title="文本模型"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>';
    if (!model) return textIcon;
    const hasVision = Number(model.supports_vision || 0) === 1 || model.capabilities?.includes?.('vision');
    const hasReasoning = Number(model.supports_reasoning || 0) === 1 || model.capabilities?.includes?.('reasoning');
    const icons = [textIcon];
    if (hasVision) icons.push('<span class="cap-icon vision" title="支持视觉输入"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    if (hasReasoning) icons.push('<span class="cap-icon reasoning" title="支持推理/思考"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    return icons.join('');
}

function updateAgentModelCaps() {
    const select = document.getElementById('agent-model-select');
    const caps = document.getElementById('agent-selected-model-caps');
    const name = document.getElementById('agent-selected-model-name');
    if (!select || !caps || !name) return;
    const model = (window._cachedAgentModels || []).find(item => String(item.id) === String(select.value));
    name.textContent = model ? `${model.name}${model.user_id ? ' (个人)' : ''}` : '请选择模型';
    PivotSafeHtml.setHtml(caps, agentModelCapabilityMarkup(model));
}

function setAgentModelListOpen(open) {
    const trigger = document.getElementById('agent-model-trigger');
    const list = document.getElementById('agent-model-list');
    if (!trigger || !list) return;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    list.classList.toggle('hidden', !open);
}

function selectAgentModel(id, close = true) {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    select.value = id;
    updateAgentModelCaps();
    document.querySelectorAll('[data-agent-model-id]').forEach(item => {
        const active = String(item.dataset.agentModelId) === String(id);
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (close) setAgentModelListOpen(false);
}

const agentToolDisplayMap = {
    plan: { title: '任务规划', description: '根据当前任务安排后续执行步骤。' },
    flow_rule: { title: '流程规则', description: '按照工作流规则推进任务。' },
    'agent.llm': { title: '大模型节点', description: '在工作流中调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。' },
    'agent.content_review': { title: '富文本内容校对', description: '清洗富文本记录，按上下文预算逐条校对并生成完整报告。' },
    'agent.delegate': { title: '委派智能体', description: '调用独立模型运行具名专家，返回专家结果并自动附带结构化交接上下文。' },
    'agent.handoff': { title: '智能体交接', description: '将已有结论、证据、风险和待决问题整理为结构化交接文档。' },
    'agent.code': { title: '代码执行', description: '在受限沙箱中执行 JavaScript 代码对数据进行转换与计算。' },
    'agent.http': { title: 'HTTP 请求', description: '调用外部 REST API 并返回状态码与响应数据。' },
    'agent.browser': { title: '浏览器自动化', description: '在受控浏览器沙箱中打开目标页面并提取关键内容。' },
    'agent.merge': { title: '变量聚合', description: '把多个上游节点的输出合并为一个结构化对象。' },
    'workflow.input': { title: '工作流输入', description: '声明并读取运行参数，支持类型转换与默认值。' },
    'workflow.output': { title: '工作流输出', description: '声明工作流最终输出，便于按名称读取交付结果。' },
    'workflow.condition': { title: '条件路由', description: '比较输入值并返回匹配路由，供下游条件分支引用。' },
    'workflow.approval': { title: '人工审批', description: '暂停工作流等待指定人员审批，支持多级审批与超时策略。' },
    'workflow.foreach': { title: '循环 / 批处理', description: '对列表逐项执行受限转换并汇总结果。' },
    'workflow.subworkflow': { title: '子工作流', description: '调用另一个已发布工作流。' },
    'workflow.delay': { title: '延时等待', description: '挂起工作流到指定时间后继续执行。' },

    // 知识库与系统
    'rag.search': { title: '知识库检索', description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。' },
    'sessions.search': { title: '会话检索', description: '按关键词检索当前用户的历史会话内容。' },
    'sessions.recent': { title: '最近会话', description: '列出当前用户最近的未删除会话。' },
    'knowledge.list': { title: '知识库文档', description: '列出当前用户的知识库文档及索引状态。' },
    'knowledge.graph.query': { title: '知识图谱查询', description: '查询知识图谱中的实体与关联关系。' },
    'models.list': { title: '可用模型', description: '列出当前用户可以使用的模型。' },
    'system.health': { title: '系统故障', description: '查看数据库、存储、内存和磁盘健康状态。' },
    'system.modelRuntime': { title: '模型运行状态', description: '查看模型端点队列、熔断器和监控状态。' },

    // 数据库能力
    'db.list_tables': { title: '列出数据表', description: '列出当前数据库中可查询的表和视图。' },
    'db.count_tables': { title: '统计数据表数量', description: '统计当前数据库中可查询的数据表和视图数量。' },
    'db.describe_table': { title: '查看表结构', description: '查看表字段、类型和可空性。' },
    'db.run_readonly_query': { title: '只读数据查询', description: '执行安全的只读查询，并遵守权限和返回数量限制。' },
    'db.group_count': { title: '分组统计', description: '按指定表字段分组并统计数量。' },
    'db.list_collections': { title: '列出集合', description: '列出 MongoDB 数据库集合。' },
    'db.count_collections': { title: '统计集合数量', description: '统计 MongoDB 数据库中的集合数量。' },
    'db.sample_collection': { title: '读取集合样本', description: '读取 MongoDB 集合的小样本，辅助理解字段结构。' },
    'db.aggregate': { title: 'Mongo 聚合查询', description: '执行只读统计分析聚合管道。' },

    // 报表与文件能力
    'reports.list_files': { title: '列出报表文件', description: '列出授权目录中的 Excel/CSV 报表文件。' },
    'reports.read_file_summary': { title: '读取文件摘要', description: '读取报表文件结构、工作表列表和字段信息。' },
    'reports.query_table': { title: '查询报表数据', description: '对指定数据表或 Sheet 进行结构化查询与过滤。' },
    'reports.compare_files': { title: '比对报表差异', description: '比对两个报表文件或 Sheet 之间的数据变动。' },
    'report.compose': { title: '报告编排', description: '将摘要和章节组装为结构化 Markdown 报告。' },
    'report.validate_template': { title: '校验报告模板', description: '在执行多步骤编排前验证预备报告模板与章节定义的有效性。' },

    // 图表与可视化
    'viz.build_chart': { title: '生成图表', description: '基于传入的表格行生成可直接渲染的统计图表配置。' },
    'viz.build_table': { title: '表格展示', description: '基于输入表格行生成可直接显示的 Markdown 表格。' },

    // 数据处理
    'data.profile_rows': { title: '数据画像分析', description: '分析表格数据行结构，生成字段名、类型分布、填充率及样本值画像。' },
    'data.filter_rows': { title: '筛选表格行', description: '使用精确匹配或包含匹配规则筛选表格数据行。' },
    'data.group_summary': { title: '分组汇总数据', description: '按指定字段对表格行分组，并计算计数、求和、均值、最小值或最大值。' },
    'data.normalize_fields': { title: '规整字段名称与内容', description: '重命名字段、修剪字符串首尾空白，并规范化表格数据结构。' },

    // 文档解析
    'doc.extract_outline': { title: '提取文档大纲', description: '从纯文本或 Markdown 内容中轻量提取标题层级与大纲结构。' },
    'doc.extract_key_values': { title: '提取关键信息', description: '从文档文本中提取键值对风格的关键信息条目。' },
    'doc.chunk_text': { title: '切分文档文本', description: '按段落感知将长文本智能切分为适合下游分析的文本分块。' },

    // 格式转换
    'format.to_markdown_table': { title: '转换 Markdown 表格', description: '将数据行数组转换为标准 Markdown 表格块。' },
    'format.to_json': { title: '转换为 JSON', description: '将输入值序列化为紧凑或美化格式的 JSON 字符串。' },
    'format.extract_json': { title: '提取 JSON', description: '从非结构化文本中查找并解析第一个有效 JSON 对象或数组。' },
    'format.normalize_text': { title: '规范化文本', description: '规范化文本中的空白字符，并可选转换为指定的大小写模式。' },

    // 消息通知
    'im.list_allowed_targets': { title: '列出通讯录目标', description: '列出允许发送消息的用户或群组。' },
    'im.send_user_message': { title: '发送私聊消息', description: '向指定用户发送即时通讯消息。' },
    'im.send_group_message': { title: '发送群组消息', description: '向指定群组发送即时通讯消息。' },
    'im.send_markdown': { title: '发送富文本通知', description: '向用户或群组发送 Markdown 格式通知。' },

    // 沙箱与文件系统
    'code.python_execute': { title: 'Python 脚本执行', description: '在隔离沙箱中执行 Python 数据处理与建模脚本。' },
    'code.duckdb_query': { title: 'DuckDB 高性能查询', description: '使用 DuckDB 列式引擎对多格式数据进行快速 SQL 分析。' },
    'browser.navigate': { title: '浏览器访问页面', description: '在受控浏览器沙箱中打开目标页面。' },
    'browser.extract_text': { title: '网页内容提取', description: '提取当前网页的正文结构与关键文本。' },
    'filesystem.read_workspace': { title: '读取工作区文件', description: '读取任务受控工作区内的文件内容。' },
    'filesystem.write_workspace': { title: '写入工作区文件', description: '在任务受控工作区内安全保存生成的文件。' }
};

function agentToolShortName(toolOrName) {
    const name = typeof toolOrName === 'string' ? toolOrName : (toolOrName?.name || toolOrName?.fullName || '');
    const match = String(name || '').match(/^(?:mcp\.\d+\.)?(.+)$/);
    return match ? match[1] : String(name || '');
}

function agentToolTitle(tool) {
    const name = typeof tool === 'string' ? tool : (tool?.name || tool?.fullName || '');
    const shortName = agentToolShortName(tool);
    if (agentToolDisplayMap[shortName]?.title) {
        return agentToolDisplayMap[shortName].title;
    }
    if (typeof tool === 'object' && tool?.title && tool.title !== shortName && tool.title !== name && !/^[a-z_]+(?:\.[a-z0-9_-]+)+$/i.test(tool.title)) {
        return tool.title;
    }
    return shortName || name || '工具';
}

function agentToolDescription(tool) {
    const shortName = agentToolShortName(tool);
    const mappedDesc = agentToolDisplayMap[shortName]?.description;
    let description = mappedDesc || (typeof tool === 'object' ? tool?.description : '') || '';
    if (typeof tool === 'object' && tool?.serverName) {
        const prefixRegex = new RegExp(`^\\[${tool.serverName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\]\\s*`, 'i');
        description = description.replace(prefixRegex, '');
    }
    if (mappedDesc) {
        description = mappedDesc;
    }
    if (typeof tool === 'object' && String(tool?.name || '').startsWith('mcp.') && tool?.serverName) {
        return `来自「${tool.serverName}」：${description || '已保存的工具服务，可由智能体任务按需调用。'}`;
    }
    return description;
}

function agentToolOwnerDisplayName(owner = {}) {
    if (owner.scope === 'global' || owner.id === null) return '全局';
    return owner.displayName || owner.nickname || owner.username || (owner.id ? `用户 ${owner.id}` : '');
}

function agentToolOwnerLabel(tool = {}) {
    const owners = [];
    const addOwner = (owner) => {
        if (!owner) return;
        const label = agentToolOwnerDisplayName(owner);
        if (label && !owners.includes(label)) owners.push(label);
    };
    if (tool.owner) addOwner(tool.owner);
    (tool.databaseConnections || []).forEach(connection => addOwner(connection.owner));
    if (!owners.length) return '';
    if (owners.length === 1) return owners[0];
    return `${owners[0]}等 ${owners.length} 人`;
}

function agentShouldShowToolOwner(tool = {}) {
    const owner = tool.owner || {};
    if (owner.scope === 'global' || owner.id === null) return true;
    if (owner.id && String(owner.id) !== String(currentUser?.id || '')) return true;
    const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
    return connections.some(connection => {
        const connectionOwner = connection.owner || {};
        return connectionOwner.scope === 'global'
            || connectionOwner.id === null
            || (connectionOwner.id && String(connectionOwner.id) !== String(currentUser?.id || ''));
    });
}

function agentCleanCapabilityName(name) {
    return String(name || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function agentCapabilityTypeLabel(type) {
    if (type === 'builtin_tool') return '系统工具';
    if (type === 'database_connection') return '数据库连接';
    return '工具服务';
}

function isAdminOnlyAgentTool(tool) {
    return Boolean(tool?.admin) || String(tool?.name || '').startsWith('system.');
}

function agentStepTitle(step) {
    const raw = step?.title || step?.type || '';
    if (raw === 'plan') return '任务规划';
    if (raw === 'flow_rule') return '流程规则';
    if (raw === 'tool') return `调用工具：${agentToolTitle(step?.tool_name)}`;
    if (raw === 'dag_node') return `工作流节点：${agentToolTitle(step?.tool_name)}`;
    if (raw === 'control') return '任务控制';
    if (raw === 'thought') return '思考推理';
    if (raw === 'action') return '执行动作';
    if (raw === 'approval') return '人工审批';
    if (raw === 'note') return '执行记录';
    if (raw === 'Planning') return '规划下一步';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    return raw || '执行步骤';
}
