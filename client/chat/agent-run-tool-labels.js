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
    const model = (window.Pivot.legacy._cachedAgentModels || []).find(item => String(item.id) === String(select.value));
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
    'agent.code': { title: '代码执行', description: '需要独立受控 Worker 沙箱；服务端不会直接执行 JavaScript。' },
    'agent.http': { title: 'HTTP 请求', description: '调用外部 REST API 并返回状态码与响应数据。' },
    'agent.browser': { title: '浏览器自动化', description: '在受控浏览器沙箱中打开目标页面并提取关键内容。' },
    'agent.merge': { title: '变量聚合', description: '把多个上游节点的输出合并为一个结构化对象。' },
    'workflow.input': { title: '工作流输入', description: '声明并读取运行参数，支持类型转换与默认值。' },
    'workflow.template': { title: '文本模板', description: '使用工作流变量拼接确定性文本，不调用模型。' },
    'workflow.notify': { title: '受控通知', description: '通过已配置的企业微信、飞书或钉钉渠道绑定排队发送通知。' },
    'workflow.output': { title: '工作流输出', description: '声明工作流最终输出，便于按名称读取交付结果。' },
    'workflow.condition': { title: '条件路由', description: '比较输入值并返回匹配路由，供下游条件分支引用。' },
    'workflow.approval': { title: '人工审批', description: '暂停工作流等待指定人员审批，支持多级审批与超时策略。' },
    'workflow.foreach': { title: '循环 / 批处理', description: '需要独立受控 Worker 沙箱；服务端不会直接执行循环代码。' },
    'workflow.subworkflow': { title: '子工作流', description: '调用另一个已发布工作流。' },
    'workflow.iteration': { title: '逐项调用子工作流', description: '对数组中的每一项调用已发布子工作流。' },
    'workflow.delay': { title: '延时等待', description: '挂起工作流到指定时间后继续执行。' },
    'workflow.embed_page': { title: '嵌入页面', description: '在工作流结果中展示受限页面嵌入。' },
    'workflow.embed_image': { title: '嵌入图片', description: '在工作流结果中展示图片资源。' },
    'workflow.embed_video': { title: '嵌入视频', description: '在工作流结果中展示带控件的视频资源。' },
    'workflow.embed_audio': { title: '嵌入音频', description: '在工作流结果中展示带控件的音频资源。' },
    'workflow.link_card': { title: '链接卡片', description: '生成安全的链接卡片并在新窗口打开。' },
    'workflow.embed_code': { title: '网站嵌入代码', description: '生成可复制到其它网站页面的 HTML iframe 代码。' },
    'artifact.render': { title: '文档渲染', description: '将受控 Document IR 渲染为正式文档。' },
    'artifact.list_renditions': { title: '渲染结果列表', description: '列出某个产物已有的渲染结果。' },

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
    'db.group_count': { title: '数据库分组计数', description: '直接查询数据库表，按指定字段分组并统计每组数量。' },
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
    'data.aggregate': { title: '数据汇总', description: '对全部数据计算一个或多个计数、求和、均值、最小值或最大值。' },
    'data.group_summary': { title: '表格分组汇总', description: '对上游表格行按指定字段分组后计算一个或多个统计指标。' },
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
    'browser.open': { title: '打开本机浏览器页面', description: '在当前设备已授权的隔离浏览器中打开页面，用户可自行完成登录。' },
    'browser.inspect': { title: '读取本机网页内容', description: '在当前设备已授权的隔离浏览器中读取标题和受限正文。' },
    'browser.click': { title: '点击本机网页元素', description: '在当前设备已授权的隔离浏览器中点击目标，须经本机确认。' },
    'browser.screenshot': { title: '截取本机网页', description: '在当前设备已授权的隔离浏览器中截取页面，须经本机确认。' },
    'filesystem.read_workspace': { title: '读取工作区文件', description: '读取任务受控工作区内的文件内容。' },
    'filesystem.write_workspace': { title: '写入工作区文件', description: '在任务受控工作区内安全保存生成的文件。' }
};

const GENERIC_TOOL_TITLES = {
    plan: '任务规划', flow_rule: '流程规则', tool: '工具调用',
    llm: '大模型分析', 'agent.llm': '大模型节点', thought: '思考推理',
    action: '执行动作', observation: '观察结果', message: '消息交互',
    approval: '人工审批', routing: '条件路由', delegate: '委派智能体',
    'agent.delegate': '委派智能体', handoff: '智能体交接', 'agent.handoff': '智能体交接',
    'agent.code': '代码执行', 'agent.http': 'HTTP 请求', 'agent.browser': '浏览器自动化',
    'agent.merge': '变量聚合', 'agent.content_review': '富文本校对',
    'agent.plan': '任务规划', 'agent_plan': '任务规划', 'agent plan': '任务规划',
    dag_node: '工作流节点', control: '任务控制', note: '执行记录',
    checkpoint: '检查点状态恢复', recovery: '通道平滑切换', heal: '系统自愈',
    error: '执行异常', completed: '执行完成', pending: '等待执行',
    running: '正在运行', skipped: '已跳过', failed: '执行失败',
    web_search: '网络搜索', search: '搜索', browser: '网页浏览',
    python: 'Python 脚本', terminal: '命令行终端', bash: '命令行终端',
    shell: 'Shell 终端', read_file: '读取文件', write_file: '保存文件',
    edit_file: '编辑文件', replace_file_content: '修改文件内容',
    run_command: '运行命令', view_file: '查看文件', grep_search: '代码搜索',
    list_dir: '查看目录', duckduckgo: '网络检索', browse: '访问网页',
    execute: '执行操作', eval: '评测分析', download: '下载文件', upload: '上传文件'
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
    const lowerKey = shortName?.toLowerCase?.();
    if (lowerKey && GENERIC_TOOL_TITLES[lowerKey]) {
        return GENERIC_TOOL_TITLES[lowerKey];
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
        .replace(/^Viz\s*MCP\s*/iu, '图表生成 ')
        .replace(/^Report\s*MCP\s*/iu, '报告编排 ')
        .replace(/^Documents\s*MCP\s*/iu, '文档解析 ')
        .replace(/^Data\s*MCP\s*/iu, '数据处理 ')
        .replace(/^Format\s*MCP\s*/iu, '格式转换 ')
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
    const raw = String(step?.title || step?.type || '').trim();
    if (!raw) return '执行步骤';
    if (raw === 'plan' || /^agent[\s._-]?plan$/i.test(raw)) return '任务规划';
    if (raw.toLowerCase() === 'agent plan' || raw.toLowerCase() === 'agent.plan' || raw.toLowerCase() === 'agent_plan') return '任务规划';
    if (raw === 'flow_rule') return '流程规则';
    if (raw === 'tool') return `调用工具：${agentToolTitle(step?.tool_name)}`;
    if (raw === 'dag_node') return `工作流节点：${agentToolTitle(step?.tool_name)}`;
    if (raw === 'control') return '任务控制';
    if (raw === 'thought') return '思考推理';
    if (raw === 'action') return '执行动作';
    if (raw === 'observation') return '观察结果';
    if (raw === 'approval') return '人工审批';
    if (raw === 'llm' || raw === 'agent.llm') return '大模型分析';
    if (raw === 'delegate' || raw === 'agent.delegate') return '委派智能体';
    if (raw === 'handoff' || raw === 'agent.handoff') return '智能体交接';
    if (raw === 'note') return '执行记录';
    if (raw === 'Planning' || raw === 'planning') return '规划下一步';
    if (raw === 'Finished' || raw === 'completed') return '执行完成';
    if (raw.toLowerCase() === 'user input' || raw.toLowerCase() === 'user_input' || raw.toLowerCase() === 'user') return '用户输入';
    if (raw.toLowerCase() === 'assistant' || raw.toLowerCase() === 'model') return '模型回复';
    if (raw.toLowerCase() === 'system' || raw.toLowerCase() === 'system prompt') return '系统指令';
    if (raw.includes('流式工具') || raw.includes('通道兜底') || raw.includes('通道自适应')) return '通道自适应平滑切换';
    if (raw.includes('恢复上下文') || raw.includes('持久化检查点') || /checkpoint/i.test(raw)) return '检查点状态恢复';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    if (raw.startsWith('LLM: ')) return `大模型分析：${raw.replace('LLM: ', '')}`;
    if (raw.startsWith('Delegate: ')) return `委派智能体：${raw.replace('Delegate: ', '')}`;
    if (raw.startsWith('Handoff: ')) return `智能体交接：${raw.replace('Handoff: ', '')}`;
    if (/^Step \d+$/i.test(raw)) return `执行第 ${raw.replace(/Step /i, '')} 步`;
    return agentToolTitle(raw) || raw;
}

const AGENT_RESULT_FIELD_LABELS = {
    answer: '结果', content: '内容', text: '内容', markdown: '内容', summary: '摘要', description: '说明', message: '消息',
    title: '标题', name: '名称', id: '标识', arguments: '参数', argument: '参数', status: '状态', state: '状态', type: '类型',
    error: '错误', warning: '提示', warnings: '提示', query: '查询条件', sql: '查询语句', total: '总数', count: '数量', limit: '返回上限',
    score: '相关度', confidence: '置信度', rows: '数据明细', data: '数据明细', items: '结果列表', result: '结果', results: '结果列表',
    matches: '匹配结果', documents: '文档', sessions: '会话', models: '模型', files: '文件', recommendations: '建议', findings: '分析发现',
    insights: '洞察', metrics: '关键指标', details: '详细信息', path: '路径', url: '链接', createdAt: '创建时间', created_at: '创建时间',
    updatedAt: '更新时间', updated_at: '更新时间', completedAt: '完成时间', completed_at: '完成时间', duration: '耗时', durationMs: '耗时（毫秒）',
    duration_ms: '耗时（毫秒）', checked: '已检查', size: '大小', table: '数据表', schema: '数据库模式', groupBy: '分组字段', group_by: '分组字段',
    value: '值', ok: '执行状态', governance: '数据安全', tableAllowlistActive: '数据表白名单', fieldAllowlistActive: '字段白名单',
    sensitiveMaskingActive: '敏感信息脱敏', queryTimeoutMs: '查询超时时间（毫秒）', cost: '计算开销', operation: '操作类型', databaseType: '数据库类型',
    database_type: '数据库类型', database_name: '数据库名称', boundedByLimit: '已限制返回数量', estimate: '预计开销', tables: '涉及数据表',
    fields: '涉及字段', columns: '字段信息', tableSchema: '数据库模式', table_schema: '数据库模式', TABLE_SCHEMA: '数据库模式',
    tableName: '数据表名称', table_name: '数据表名称', TABLE_NAME: '数据表名称', tableType: '数据表类型', table_type: '数据表类型',
    TABLE_TYPE: '数据表类型', columnName: '字段名称', column_name: '字段名称', dataType: '数据类型', data_type: '数据类型',
    isNullable: '允许为空', is_nullable: '允许为空', columnDefault: '默认值', column_default: '默认值', responseFormat: '返回格式',
    format: '输出格式', presentation: '交付方式', fileRef: '文件引用', file: '文件产物', temperature: '生成随机性', maxTokens: '最大输出量',
    max_tokens: '最大输出量', finishReason: '结束原因', finish_reason: '结束原因', toolCalls: '工具调用', modelName: '模型文件',
    model_name: '模型名称', modelId: '模型标识', model_id: '模型标识', model: '调用模型', input: '输入数据', output: '输出数据',
    stats: '指标统计', records: '校对明细', artifact: '任务产物', artifacts: '任务产物', reviewComplete: '校对完成', review_complete: '校对完成',
    sourceRowCount: '原始数据行数', source_row_count: '原始数据行数', processedRecords: '已处理记录数', processed_records: '已处理记录数',
    skippedRecords: '已跳过记录数', skipped_records: '已跳过记录数', completedRecords: '已完成记录数', completed_records: '已完成记录数',
    passedRecords: '无问题记录数', passed_records: '无问题记录数', issueRecords: '存在问题记录数', issue_records: '存在问题记录数',
    incompleteRecords: '未完整处理记录数', incomplete_records: '未完整处理记录数', titleIssues: '标题问题数', title_issues: '标题问题数',
    contentIssues: '正文问题数', content_issues: '正文问题数', titleIssueCount: '标题问题数', title_issue_count: '标题问题数',
    contentIssueCount: '正文问题数', content_issue_count: '正文问题数', originalChars: '原始字符数', original_chars: '原始字符数',
    cleanChars: '清洗后字符数', clean_chars: '清洗后字符数', removedChars: '移除字符数', removed_chars: '移除字符数', modelCallCount: '模型调用次数',
    model_call_count: '模型调用次数', chunkTokens: '分块 Token 预算', chunk_tokens: '分块 Token 预算', overlapTokens: '重叠 Token 数',
    overlap_tokens: '重叠 Token 数', upstreamPartial: '上游数据截断', upstream_partial: '上游数据截断', oversizedRowCount: '超长记录数',
    oversized_row_count: '超长记录数', inputTruncated: '输入已截断', input_truncated: '输入已截断', recordId: '记录标识', record_id: '记录标识',
    issues: '发现问题', issue: '问题', original: '原文内容', suggestion: '建议修改', reason: '修改理由', category: '问题类型',
    field: '涉及字段', chunkCount: '分块数量', chunk_count: '分块数量', contextAdjusted: '上下文预算调整', context_adjusted: '上下文预算调整',
    reportTitle: '报告标题', report_title: '报告标题', instructions: '补充规则', idField: '主键字段', id_field: '主键字段',
    titleField: '标题字段', title_field: '标题字段', contentField: '正文字段', content_field: '正文字段', maxRecords: '最大记录数',
    max_records: '最大记录数', maxSummaryChars: '摘要字符上限', max_summary_chars: '摘要字符上限', concurrency: '并发数量', fromAgent: '发起智能体',
    from_agent: '发起智能体', toAgent: '接收智能体', to_agent: '接收智能体', agentName: '专家智能体', agent_name: '专家智能体', role: '角色设定',
    task: '指派任务', context: '上下文', evidence: '支撑证据', risks: '潜在风险', openQuestions: '待决问题', open_questions: '待决问题',
    route: '匹配路由', matched: '匹配状态', operator: '比较操作符', compareTo: '比较目标值', compare_to: '比较目标值', vars: '注入变量',
    code: '代码内容', stopOnError: '出错时终止', stop_on_error: '出错时终止', sectionCount: '章节数量', section_count: '章节数量',
    sections: '报告章节', includeToc: '包含目录', include_toc: '包含目录', workflowId: '工作流标识', workflow_id: '工作流标识',
    workflowName: '工作流名称', workflow_name: '工作流名称', inputs: '输入参数', credentialSecret: '凭据名称', credentialHeader: '凭据请求头',
    credentialPrefix: '凭据前缀', timeoutMs: '超时时间（毫秒）', timeout_ms: '超时时间（毫秒）', timeoutAction: '超时处理', timeoutHours: '超时小时数',
    approvers: '审批人员', approverUserIds: '审批用户标识', approverUnits: '审批部门', approvalLevels: '多级审批流', imServerId: '即时通讯服务',
    imTargetType: '目标类型', imTarget: '发送目标', callbackBaseUrl: '回调地址', callbackCredential: '回调凭据', target: '发送目标',
    allowedTargets: '允许目标', defaultTarget: '默认目标', allowAtAll: '允许 @所有人', selectedSheet: '选定工作表', selected_sheet: '选定工作表',
    sheets: '工作表列表', sheetName: '工作表名称', sheet_name: '工作表名称', lineCount: '代码行数', line_count: '代码行数', headers: '响应头',
    statusCode: '状态码', status_code: '状态码', response: '响应数据', retryable: '可重试', originalRowCount: '原始数据行数',
    original_row_count: '原始数据行数', rowCount: '数据行数', row_count: '数据行数', columnCount: '字段列数', column_count: '字段列数',
    cellCount: '单元格数', differenceCount: '差异数量', diffCount: '差异数量', provenance: '数据溯源', docName: '文档名称', doc_name: '文档名称',
    hit: '匹配命中', prompt: '提示词', systemPrompt: '系统提示词', system_prompt: '系统提示词', topK: '检索数量', top_k: '检索数量',
    candidateLimit: '候选上限', candidate_limit: '候选上限', usage: '资源用量', inputTokens: '输入 Token', input_tokens: '输入 Token',
    outputTokens: '输出 Token', output_tokens: '输出 Token', totalTokens: '总计 Token', total_tokens: '总计 Token', reasoningTokens: '推理 Token',
    reasoning_tokens: '推理 Token', cachedTokens: '缓存 Token', cached_tokens: '缓存 Token', notes: '补充说明', note: '说明',
    attempt: '尝试次数', attempt_count: '尝试次数', condition: '执行条件', depends_on: '前置步骤', dependsOn: '前置步骤', node_key: '节点标识',
    nodeKey: '节点标识', tool_name: '工具名称', toolName: '工具名称', tool: '工具名称', draft: '工作流草稿', version: '版本',
    endpointHost: '服务主机', password: '密码', relativePath: '相对路径', extension: '文件扩展名', sample: '数据样本', trace: '调用链追踪',
    step: '步骤', nodes: '节点列表', variables: '变量列表', keys: '键列表', options: '配置项', additionalProperties: '附加属性', _owner: '所有者',
    tokens: 'Token 用量', latency: '响应延迟', latencyMs: '响应延迟（毫秒）', latency_ms: '响应延迟（毫秒）', errorMessage: '异常信息',
    error_message: '异常信息', errorType: '异常类型', error_type: '异常类型', traceId: '追踪标识', trace_id: '追踪标识', spanId: '环节标识',
    span_id: '环节标识', parentId: '父级标识', parent_id: '父级标识', stepIndex: '步骤序号', step_index: '步骤序号', roundIndex: '执行轮次',
    round_index: '执行轮次', sessionId: '会话标识', session_id: '会话标识', userId: '用户标识', user_id: '用户标识', runId: '运行标识',
    run_id: '运行标识', startedAt: '开始时间', started_at: '开始时间', timestamp: '时间戳', properties: '属性参数', metadata: '运行元数据',
    payload: '数据载荷', contextMode: '上下文模式', context_mode: '上下文模式', thought: '思考推理', action: '执行动作', observation: '观察结果',
    query_type: '查询类型', queryType: '查询类型', execution_time: '执行时间', executionTime: '执行时间', execution_time_ms: '执行耗时（毫秒）',
    executionTimeMs: '执行耗时（毫秒）', confidence_score: '置信度', confidenceScore: '置信度', match_score: '匹配得分', matchScore: '匹配得分',
    similarity: '相似度', sourceRunId: '来源任务 ID', source_run_id: '来源任务 ID', 'Source Run Id': '来源任务 ID',
    checkpointId: '检查点 ID', checkpoint_id: '检查点 ID', 'Checkpoint Id': '检查点 ID', latestCheckpointId: '最新检查点 ID',
    latest_checkpoint_id: '最新检查点 ID', restoredObservations: '已恢复观察记录', restored_observations: '已恢复观察记录',
    'Restored Observations': '已恢复观察记录', restored: '已恢复', checkpoint: '检查点', checkpoints: '检查点',
    capability: '所需能力', capabilities: '所需能力', builtin: '系统内置', standard: '标准', custom: '自定义',
    transaction: '事务', transactionId: '事务 ID', transaction_id: '事务 ID', contextHash: '上下文哈希',
    context_hash: '上下文哈希', fromRunId: '发起任务 ID', from_run_id: '发起任务 ID', messageId: '消息 ID',
    message_id: '消息 ID', messageType: '消息类型', message_type: '消息类型', sourceId: '来源标识',
    source_id: '来源标识', workingMemory: '工作记忆', working_memory: '工作记忆', retryReason: '重试原因',
    retry_reason: '重试原因', retryCount: '重试次数', retry_count: '重试次数',
    goal: '任务目标', goals: '任务目标', params: '参数配置', parameters: '参数配置', param: '参数',
    args: '执行参数', arg: '参数', command: '执行命令', cmd: '执行命令', stdout: '标准输出',
    stderr: '错误输出', exitCode: '退出码', exit_code: '退出码', returnCode: '返回码', return_code: '返回码',
    filepath: '文件路径', file_path: '文件路径', filename: '文件名', file_name: '文件名', dir: '目录',
    directory: '目录', remediation: '建议修复方案', remediations: '建议修复方案', remedy: '修复方案',
    solution: '解决方案', action_type: '动作类型', actionType: '动作类型', target_type: '目标类型',
    targetType: '目标类型', filter: '过滤条件', filters: '过滤条件', sort: '排序规则', sorting: '排序规则',
    order: '排序', direction: '方向', offset: '偏移量', page: '页码', pageSize: '每页条数', page_size: '每页条数',
    headers: '请求头', body: '请求体', method: '请求方法', encoding: '字符编码', mimeType: '媒体类型',
    mime_type: '媒体类型', is_directory: '是否为目录', isDirectory: '是否为目录', file_size: '文件大小',
    fileSize: '文件大小', line_number: '行号', lineNumber: '行号', line_content: '行内容', lineContent: '行内容',
    total_matches: '匹配总数', totalMatches: '匹配总数', matches: '匹配结果', match: '匹配项'
};

function agentResultFieldLabel(key) {
    const value = String(key || '').trim();
    if (!value) return '信息';
    if (AGENT_RESULT_FIELD_LABELS[value]) return AGENT_RESULT_FIELD_LABELS[value];
    const compact = value.replace(/[\s_-]+/g, '').toLowerCase();
    const knownKey = Object.keys(AGENT_RESULT_FIELD_LABELS).find(item => item.replace(/[\s_-]+/g, '').toLowerCase() === compact);
    if (knownKey) return AGENT_RESULT_FIELD_LABELS[knownKey];

    // 智能子词与后缀翻译匹配
    const wordMap = {
        count: '数量', list: '列表', name: '名称', type: '类型', time: '时间',
        size: '大小', status: '状态', ratio: '比例', percent: '百分比', rate: '比率',
        limit: '上限', code: '编码', error: '错误', msg: '消息', message: '消息',
        title: '标题', desc: '说明', description: '说明', id: '标识', url: '链接',
        path: '路径', text: '文本', value: '值', total: '总计', max: '最大',
        min: '最小', avg: '平均', rows: '行数', columns: '列数', tokens: 'Token',
        source: '来源', target: '目标', input: '输入', output: '输出',
        processed: '已处理', skipped: '已跳过', completed: '已完成', passed: '通过',
        failed: '失败', issue: '问题', clean: '清洗', raw: '原始', user: '用户',
        group: '群组', file: '文件', item: '条目', record: '记录', data: '数据',
        table: '数据表', field: '字段', column: '列', row: '行', chunk: '分块',
        model: '模型', rule: '规则', workflow: '工作流', agent: '智能体', server: '服务',
        db: '数据库', info: '信息', config: '配置', param: '参数', params: '参数',
        result: '结果', detail: '详情', details: '详情', header: '请求头', body: '正文',
        run: '任务', checkpoint: '检查点', observation: '观察', observations: '观察记录',
        restored: '已恢复', memory: '记忆', state: '状态', contract: '契约',
        transaction: '事务', batch: '批次', scope: '范围', reason: '原因',
        action: '动作', plan: '规划', token: 'Token', duration: '耗时',
        budget: '预算', mode: '模式', policy: '策略', capability: '能力',
        capabilities: '能力', event: '事件', trigger: '触发', proposal: '提议',
        evolution: '进化', learning: '经验学习', evaluation: '评测'
    };

    const parts = value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .split(/[_\s-]+/)
        .map(p => p.toLowerCase())
        .filter(Boolean);

    if (parts.length > 1 && parts.every(p => wordMap[p])) {
        return parts.map(p => wordMap[p]).join('');
    }

    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function agentResultIsScalar(value) {
    return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

function agentResultScalarText(value) {
    if (value === undefined || value === null || value === '') return '-';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
    return String(value);
}

function agentResultDisplayValue(key, value) {
    if (value === undefined || value === null || value === '') return '-';
    const normalizedKey = String(key || '').replace(/[\s_-]+/g, '').toLowerCase();

    // 布尔值本地化
    if (typeof value === 'boolean') {
        if (['ok', 'success'].includes(normalizedKey)) return value ? '成功' : '失败';
        return value ? '是' : '否';
    }

    // 数值格式化
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (normalizedKey.includes('percent') || normalizedKey.includes('ratio') || normalizedKey.includes('rate')) {
            if (value <= 1 && value >= 0) return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
        }
        return value.toLocaleString('zh-CN');
    }

    // 状态枚举
    if (['status', 'statuscode', 'state'].includes(normalizedKey)) {
        const statusLabels = {
            awaiting_approval: '等待审批',
            approval_required: '待审批',
            waiting_approval: '待审批',
            queued: '排队中',
            planning: '规划中',
            executing: '执行中',
            observing: '观察中',
            diagnosing: '诊断中',
            replanning: '重规划中',
            resuming: '恢复中',
            pending: '待执行',
            running: '运行中',
            completed: '已完成',
            completed_with_errors: '完成但有告警',
            continued_error: '失败后继续',
            issues_found: '存在问题',
            passed: '未发现问题',
            incomplete: '未完整处理',
            success: '成功',
            error: '失败',
            failed: '失败',
            cancelled: '已停止',
            skipped: '已跳过',
            deleted: '已删除',
            active: '已启用',
            inactive: '已停用',
            paused: '已暂停',
            ready: '就绪',
            draft: '草稿',
            published: '已发布',
            archived: '已归档',
            blocked: '已阻塞',
            timeout: '已超时',
            waiting: '等待中',
            unknown: '未知'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (statusLabels[normalized]) return statusLabels[normalized];
    }

    // 类型与产物
    if (['type', 'tabletype', 'table_type', 'artifacttype', 'spantype', 'tasktype', 'runtype', 'presentation', 'format', 'responseformat', 'datatype'].includes(normalizedKey)) {
        const typeLabels = {
            content_review_report: '内容校对报告',
            pivot_chart: '图表',
            pivot_table: '数据表格',
            pivot_report: '结构化报告',
            format_markdown_table: '数据表格',
            markdown: 'Markdown 格式',
            text: '纯文本',
            json: 'JSON 数据',
            table: '数据表格',
            file: '文件产物',
            default: '默认交付',
            'base table': '数据表',
            view: '视图',
            'system view': '系统视图',
            builtin_tool: '系统工具',
            database_connection: '数据库连接',
            mcp_server: 'MCP 工具服务',
            user: '用户私聊',
            group: '群组消息',
            free: '自主任务',
            workflow: '工作流任务',
            scheduled: '计划任务',
            model: '模型调用',
            tool: '工具执行',
            plan: '任务规划',
            dag: '工作流',
            dag_node: '工作流节点',
            agent: '智能体',
            handoff: '交接上下文',
            routing: '条件路由',
            control: '任务控制',
            note: '执行记录',
            string: '字符串',
            number: '数值',
            integer: '整数',
            boolean: '布尔值',
            object: '对象',
            array: '列表'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (typeLabels[normalized]) return typeLabels[normalized];
    }

    // 智能体角色
    if (['role', 'agentrole'].includes(normalizedKey)) {
        const roleLabels = {
            analyst: '分析师',
            researcher: '研究员',
            reviewer: '审查员',
            writer: '撰稿人',
            custom: '自定义角色',
            assistant: '智能助手',
            user: '用户',
            system: '系统',
            admin: '管理员'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (roleLabels[normalized]) return roleLabels[normalized];
    }

    // 分类与问题类型
    if (['category', 'issuecategory', 'errorcategory', 'error_type'].includes(normalizedKey)) {
        const categoryLabels = {
            typo: '错别字',
            grammar: '语法语病',
            punctuation: '标点符号',
            terminology: '业务术语',
            sensitive: '敏感词汇',
            clarity: '表述不清',
            style: '文风格式',
            syntax: '语法错误',
            schema: '结构模式',
            data_quality: '数据质量',
            permission: '权限问题',
            policy: '安全策略',
            network: '网络问题',
            resource: '资源限制',
            timeout: '执行超时'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (categoryLabels[normalized]) return categoryLabels[normalized];
    }

    // 操作符与条件
    if (['operator', 'condition'].includes(normalizedKey)) {
        const conditionLabels = {
            always: '始终执行',
            success: '上游成功时',
            failure: '上游失败时',
            error: '上游异常时',
            equals: '等于',
            not_equals: '不等于',
            contains: '包含',
            not_contains: '不包含',
            greater_than: '大于',
            less_than: '小于',
            is_empty: '为空',
            not_empty: '非空',
            is_true: '为真',
            is_false: '为假'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (conditionLabels[normalized]) return conditionLabels[normalized];
    }

    // 运行模式
    if (['mode', 'runmode', 'contextmode'].includes(normalizedKey)) {
        const modeLabels = {
            any: '任一满足',
            all: '全部满足',
            standard: '标准模式',
            deep: '深度模式',
            audit: '审查模式',
            dag: '工作流',
            auto: '自动选择',
            recent: '最近会话',
            knowledge: '知识库优先',
            custom: '自定义说明',
            none: '不扩展'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (modeLabels[normalized]) return modeLabels[normalized];
    }

    // 工具名称转换
    if (['name', 'toolname', 'tool_name', 'tool'].includes(normalizedKey) && typeof value === 'string' && typeof agentToolTitle === 'function') {
        const friendlyName = agentToolTitle(value);
        if (friendlyName && friendlyName !== value) return friendlyName;
    }

    // 模型结束原因
    if (['finishreason', 'finish_reason'].includes(normalizedKey)) {
        const finishReasonLabels = {
            stop: '正常结束',
            tool_calls: '调用工具',
            function_call: '调用函数',
            length: '达到输出上限',
            content_filter: '内容安全拦截'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (finishReasonLabels[normalized]) return finishReasonLabels[normalized];
    }

    // 数据库与系统操作
    if (normalizedKey === 'operation') {
        const operationLabels = {
            readonly_sql: '只读查询',
            query: '数据查询',
            aggregate: '聚合分析',
            describe: '表结构分析',
            count: '统计计数'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (operationLabels[normalized]) return operationLabels[normalized];
    }

    // 涉及字段
    if (normalizedKey === 'field') {
        const fieldLabels = {
            title: '标题',
            content: '正文',
            body: '正文',
            summary: '摘要',
            description: '说明'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (fieldLabels[normalized]) return fieldLabels[normalized];
    }

    // 全局常见枚举值直译
    const globalScalarTranslations = {
        content_review_report: '内容校对报告',
        issues_found: '存在问题',
        passed: '未发现问题',
        incomplete: '未完整处理',
        readonly_sql: '只读查询',
        stop: '正常结束',
        tool_calls: '调用工具',
        function_call: '调用函数',
        length: '达到输出上限',
        content_filter: '内容安全拦截',
        'base table': '数据表',
        view: '视图',
        'system view': '系统视图',
        builtin: '系统内置',
        builtin_tool: '系统工具',
        standard: '标准',
        custom: '自定义',
        restored: '已恢复',
        active: '已启用',
        inactive: '已停用',
        pending: '待处理',
        success: '成功',
        failed: '失败',
        error: '异常',
        running: '运行中',
        completed: '已完成',
        queued: '排队中',
        planning: '规划中',
        cancelled: '已取消',
        dag: '工作流',
        free: '自主任务',
        true: '是',
        false: '否',
        null: '-',
        none: '无',
        enabled: '已开启',
        disabled: '已关闭',
        enable: '已开启',
        disable: '已关闭',
        open: '已开启',
        closed: '已关闭',
        allow: '允许',
        deny: '拒绝',
        admin: '管理员',
        user: '用户',
        system: '系统',
        read: '只读',
        write: '读写',
        all: '全部',
        high: '高',
        low: '低',
        medium: '中',
        critical: '紧急',
        info: '提示',
        warning: '警告',
        warn: '警告',
        pass: '通过',
        fail: '未通过',
        failure: '失败',
        healthy: '健康',
        loss: '有遗漏',
        stable: '稳定',
        dynamic: '动态',
        ok: '正常',
        yes: '是',
        no: '否'
    };
    if (typeof value === 'string' && globalScalarTranslations[value.trim().toLowerCase()]) {
        return globalScalarTranslations[value.trim().toLowerCase()];
    }

    return agentResultScalarText(value);
}

