/**
 * server/services/agent-tool-capabilities.js
 * 内置工具 → 显式能力标识的登记表
 *
 * 落地方案 v1.2 阶段 0.3：能力标识必须由显式注册表和工具契约提供，
 * 禁止再按工具名称关键字推断放大（例如原先「名称含 duckdb ⇒ code.execute」）。
 *
 * 三层解析顺序：
 * 1. 工具契约自带 capabilities（最高优先，需全部在能力注册表登记）；
 * 2. 本表按工具全名精确登记，或按受控前缀登记（db.* / mcp.*）；
 * 3. 兜底为最小能力 agent.execute（MCP 来源兜底为 network.request），
 *    不再按名称包含 write/report/code 等关键字放大能力。
 *
 * 本模块是叶子节点，仅依赖能力注册表。
 */
const { normalizeCapabilityList } = require('./agent-capability-registry');

/** 内置工具的精确能力登记。新增内置工具必须在此登记，否则只获得最小能力。 */
const BUILTIN_TOOL_CAPABILITIES = Object.freeze({
    'agent.llm': ['model.invoke'],
    'agent.content_review': ['model.invoke', 'agent.review'],
    'agent.delegate': ['agent.delegate', 'model.invoke'],
    'agent.handoff': ['agent.execute'],
    'agent.code': ['code.sandbox_eval'],
    'agent.http': ['network.http_request'],
    'agent.browser': ['network.browser_visit'],
    'agent.merge': ['agent.execute'],
    'workflow.input': ['workflow.control'],
    'workflow.output': ['workflow.control'],
    'workflow.condition': ['workflow.control'],
    'workflow.approval': ['workflow.approval'],
    'workflow.foreach': ['workflow.control'],
    'workflow.subworkflow': ['workflow.orchestrate'],
    'workflow.delay': ['workflow.control'],
    'report.compose': ['viz.render'],
    'rag.search': ['knowledge.search'],
    'sessions.search': ['knowledge.read'],
    'sessions.recent': ['knowledge.read'],
    'knowledge.list': ['knowledge.read'],
    'knowledge.graph.query': ['knowledge.graph_query'],
    'viz.build_chart': ['viz.render'],
    'viz.build_table': ['viz.render'],
    'models.list': ['system.observe'],
    'system.health': ['system.observe'],
    'system.modelRuntime': ['system.observe'],
    // 文档渲染与产物交付（落地方案 §7）
    'artifact.render': ['document.render'],
    'artifact.list_renditions': ['artifact.read']
});

/** 受控前缀登记：用于运行期动态发现、无法逐一枚举的工具族。 */
const TOOL_PREFIX_CAPABILITIES = Object.freeze([
    // 数据库 MCP 工具族统一归入关系库查询能力，与代码执行域彻底分离。
    { prefix: 'db.', capabilities: ['data.sql.query'] },
    // DuckDB 分析工具族归入数据查询能力，不再匹配 code.execute。
    { prefix: 'duckdb.', capabilities: ['data.duckdb.query'] },
    { prefix: 'dataset.', capabilities: ['data.dataset.read'] },
    { prefix: 'mcp.', capabilities: ['network.request'] }
]);

/**
 * MCP 工具的全名形如 mcp.<serverId>.<裸工具名>，而同一个工具在服务端还会以裸名
 * （如 db.run_readonly_query）被调用。若不剥离前缀，同一工具会因调用名不同拿到
 * 不同能力（network.request 与 data.sql.query），使 Skill 声明在一条路径上失效。
 */
function stripMcpServerPrefix(name) {
    const match = /^mcp\.\d+\.(.+)$/.exec(name);
    return match ? match[1] : '';
}

function resolveRegisteredToolCapabilities(toolName, source = 'builtin') {
    const name = String(toolName || '').trim();
    if (!name) return [];
    const exact = BUILTIN_TOOL_CAPABILITIES[name];
    if (exact) return normalizeCapabilityList(exact);
    const bare = stripMcpServerPrefix(name);
    if (bare) {
        const bareExact = BUILTIN_TOOL_CAPABILITIES[bare];
        if (bareExact) return normalizeCapabilityList(bareExact);
        const barePrefixed = TOOL_PREFIX_CAPABILITIES.find(item => item.prefix !== 'mcp.' && bare.startsWith(item.prefix));
        if (barePrefixed) return normalizeCapabilityList(barePrefixed.capabilities);
    }
    const prefixed = TOOL_PREFIX_CAPABILITIES.find(item => name.startsWith(item.prefix));
    if (prefixed) return normalizeCapabilityList(prefixed.capabilities);
    if (String(source) === 'mcp') return ['network.request'];
    return ['agent.execute'];
}

function isRegisteredToolName(toolName) {
    const name = String(toolName || '').trim();
    if (!name) return false;
    if (BUILTIN_TOOL_CAPABILITIES[name]) return true;
    return TOOL_PREFIX_CAPABILITIES.some(item => name.startsWith(item.prefix));
}

module.exports = {
    BUILTIN_TOOL_CAPABILITIES,
    TOOL_PREFIX_CAPABILITIES,
    isRegisteredToolName,
    resolveRegisteredToolCapabilities
};
