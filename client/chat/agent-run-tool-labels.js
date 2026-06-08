// Agent 工具标签 Agent run tool labels
// Split from agent-run-renderers.js.
// Agent model capability and tool label helpers.
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
    caps.innerHTML = agentModelCapabilityMarkup(model);
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
    'agent.llm': { title: '大模型节点', description: '在工作流中调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。' },
    'rag.search': { title: '知识库检索', description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。' },
    'sessions.search': { title: '会话检索', description: '按关键词检索当前用户的历史会话内容。' },
    'sessions.recent': { title: '最近会话', description: '列出当前用户最近的未删除会话。' },
    'knowledge.list': { title: '知识库文档', description: '列出当前用户的知识库文档及索引状态。' },
    'models.list': { title: '可用模型', description: '列出当前用户可以使用的模型。' },
    'system.health': { title: '系统健康', description: '查看数据库、存储、内存和磁盘健康状态。' },
    'system.modelRuntime': { title: '模型运行状态', description: '查看模型端点队列、熔断器和监控状态。' },
    'db.list_tables': { title: '列出数据表', description: '列出当前数据库中可查询的表和视图。' },
    'db.count_tables': { title: '统计数据表数量', description: '统计当前数据库中可查询的数据表和视图数量。' },
    'db.describe_table': { title: '查看表结构', description: '查看表字段、类型和可空性。' },
    'db.run_readonly_query': { title: '只读 SQL 查询', description: '执行 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等只读查询。' },
    'db.group_count': { title: '分组统计', description: '按指定表字段分组并统计数量。' },
    'db.list_collections': { title: '列出集合', description: '列出 MongoDB 数据库集合。' },
    'db.count_collections': { title: '统计集合数量', description: '统计 MongoDB 数据库中的集合数量。' },
    'db.sample_collection': { title: '读取集合样本', description: '读取 MongoDB 集合的小样本，辅助理解字段结构。' },
    'db.aggregate': { title: 'Mongo 聚合查询', description: '执行只读统计分析聚合管道。' }
};

function agentToolShortName(toolOrName) {
    const name = typeof toolOrName === 'string' ? toolOrName : (toolOrName?.name || toolOrName?.fullName || '');
    const match = String(name || '').match(/^mcp\.\d+\.(.+)$/);
    return match ? match[1] : String(name || '');
}

function agentToolTitle(tool) {
    const name = typeof tool === 'string' ? tool : (tool?.name || tool?.fullName);
    const shortName = agentToolShortName(tool);
    return agentToolDisplayMap[shortName]?.title || tool?.title || shortName || name || '工具';
}

function agentToolDescription(tool) {
    const shortName = agentToolShortName(tool);
    const description = agentToolDisplayMap[shortName]?.description || tool?.description || '';
    if (String(tool?.name || '').startsWith('mcp.') && tool?.serverName) {
        return `来自「${tool.serverName}」：${description || '已保存的能力服务，可由智能体任务按需调用。'}`;
    }
    return description;
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
    return '能力服务';
}

function isAdminOnlyAgentTool(tool) {
    return Boolean(tool?.admin) || String(tool?.name || '').startsWith('system.');
}

function agentStepTitle(step) {
    const raw = step?.title || step?.type || '';
    if (raw === 'Planning') return '规划下一步';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    return raw || '执行步骤';
}
