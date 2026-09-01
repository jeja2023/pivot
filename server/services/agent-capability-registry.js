/**
 * server/services/agent-capability-registry.js
 * Agent 能力（capability）显式注册表
 *
 * 落地方案 v1.2 §6.4、阶段 0.2 / 0.3 的实现基础：
 * 1. 能力标识必须在本注册表登记，未登记能力不得写入 Skill 声明，也不得由工具契约声明；
 * 2. 能力之间只允许「父能力包含子能力」这一种收敛关系，禁止出现窄能力匹配宽能力的放大路径；
 * 3. 工具能力不再依赖名称关键字推断放大——名称推断只能产出注册表内的粗粒度能力，
 *    细粒度能力（如 data.duckdb.query）必须由工具契约显式声明。
 *
 * 本模块是无业务依赖的叶子节点，禁止 require 数据库或其他服务，避免循环依赖。
 */

/**
 * 能力定义。parent 表示「父能力在语义上完全包含本能力」。
 * 每条父子关系都必须满足：声明父能力的主体，其被授予的操作面 ⊇ 子能力的操作面。
 */
const AGENT_CAPABILITY_DEFINITIONS = Object.freeze([
    // ── 基础执行域：仅代表「可以调用一般无副作用工具」，不含文件、网络、代码执行 ──
    { id: 'agent.execute', title: '基础工具执行', parent: null, risk: 'low' },
    { id: 'agent.delegate', title: '委派子任务', parent: 'agent.execute', risk: 'medium' },
    { id: 'agent.review', title: '内容审查', parent: 'agent.execute', risk: 'low' },

    // ── 工作流编排域：与基础执行分离，避免声明 agent.execute 就顺带拿到审批与子工作流 ──
    { id: 'workflow.orchestrate', title: '工作流编排', parent: null, risk: 'medium' },
    { id: 'workflow.control', title: '工作流控制节点', parent: 'workflow.orchestrate', risk: 'low' },
    { id: 'workflow.approval', title: '工作流人工审批', parent: 'workflow.orchestrate', risk: 'high' },

    // ── 可视化与报告组装域 ──
    { id: 'viz.render', title: '图表与表格组装', parent: null, risk: 'low' },

    // ── 平台观测域 ──
    { id: 'system.observe', title: '平台状态查看', parent: null, risk: 'low' },

    // ── 文件读域：filesystem.read 覆盖工作区读，工作区读是其真子集 ──
    { id: 'filesystem.read', title: '文件读取', parent: null, risk: 'medium' },
    { id: 'filesystem.read_workspace', title: '工作区文件读取', parent: 'filesystem.read', risk: 'low' },

    // ── 文件写域：filesystem.write 覆盖工作区写 ──
    { id: 'filesystem.write', title: '文件写入', parent: null, risk: 'high' },
    { id: 'filesystem.write_workspace', title: '工作区文件写入', parent: 'filesystem.write', risk: 'medium' },

    // ── 代码执行域：code.execute 是最宽能力，任何具体解释器执行都是其子集 ──
    { id: 'code.execute', title: '代码执行', parent: null, risk: 'high' },
    { id: 'code.python_execute', title: 'Python 代码执行', parent: 'code.execute', risk: 'high' },
    { id: 'code.sandbox_eval', title: '沙箱表达式求值', parent: 'code.execute', risk: 'medium' },

    // ── 数据查询域：与代码执行域彻底分离。SQL / DuckDB 查询不再归入 code.execute ──
    { id: 'data.query', title: '数据查询', parent: null, risk: 'medium' },
    { id: 'data.duckdb.query', title: 'DuckDB 数据查询', parent: 'data.query', risk: 'medium' },
    { id: 'data.sql.query', title: '关系库数据查询', parent: 'data.query', risk: 'medium' },
    { id: 'data.dataset.read', title: '分析数据集读取', parent: 'data.query', risk: 'low' },

    // ── 网络域 ──
    { id: 'network.request', title: '网络访问', parent: null, risk: 'high' },
    { id: 'network.http_request', title: 'HTTP 请求', parent: 'network.request', risk: 'high' },
    { id: 'network.browser_visit', title: '浏览器访问', parent: 'network.request', risk: 'high' },

    // ── 知识与检索域 ──
    { id: 'knowledge.read', title: '知识库读取', parent: null, risk: 'low' },
    { id: 'knowledge.search', title: '知识库检索', parent: 'knowledge.read', risk: 'low' },
    { id: 'knowledge.graph_query', title: '知识图谱查询', parent: 'knowledge.read', risk: 'low' },

    // ── 模型调用域 ──
    { id: 'model.invoke', title: '模型调用', parent: null, risk: 'medium' },

    // ── 文档生成与交付域（落地方案 §7）──
    { id: 'document.render', title: '文档渲染', parent: null, risk: 'medium' },
    { id: 'artifact.read', title: '产物读取', parent: null, risk: 'low' },
    { id: 'artifact.deliver', title: '产物交付写入', parent: null, risk: 'critical' }
]);

const CAPABILITY_INDEX = new Map(AGENT_CAPABILITY_DEFINITIONS.map(item => [item.id, item]));

/** 能力 id → 其全部祖先能力集合（不含自身）。用于收敛方向的包含判定。 */
const ANCESTOR_INDEX = new Map();
AGENT_CAPABILITY_DEFINITIONS.forEach(definition => {
    const ancestors = new Set();
    let cursor = definition.parent;
    let guard = 0;
    while (cursor && guard < 16) {
        if (ancestors.has(cursor)) break;
        ancestors.add(cursor);
        cursor = CAPABILITY_INDEX.get(cursor)?.parent || null;
        guard += 1;
    }
    ANCESTOR_INDEX.set(definition.id, ancestors);
});

function normalizeCapabilityId(value) {
    return String(value ?? '').trim();
}

function isRegisteredCapability(value) {
    return CAPABILITY_INDEX.has(normalizeCapabilityId(value));
}

function getCapabilityDefinition(value) {
    return CAPABILITY_INDEX.get(normalizeCapabilityId(value)) || null;
}

function listAgentCapabilities() {
    return AGENT_CAPABILITY_DEFINITIONS.map(item => ({ ...item }));
}

/**
 * 规范化能力清单：去重、去空、保持原始顺序。不在此处过滤未登记能力，
 * 以便调用方能明确报出「未登记能力」这一类错误。
 */
function normalizeCapabilityList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === 'string' ? value.split(',') : [];
    return [...new Set(source.map(normalizeCapabilityId).filter(Boolean))];
}

/**
 * 判定「声明的能力」是否覆盖「工具要求的能力」。
 * 唯一允许的放宽方向是：声明的是父能力，工具要求的是其子能力。
 * 反向（声明窄能力、匹配宽能力）一律不成立，这是 v1.2 A3 缺口的修复点。
 */
function capabilityCoveredBy(declared, required) {
    const declaredId = normalizeCapabilityId(declared);
    const requiredId = normalizeCapabilityId(required);
    if (!declaredId || !requiredId) return false;
    if (declaredId === requiredId) return true;
    if (!CAPABILITY_INDEX.has(declaredId) || !CAPABILITY_INDEX.has(requiredId)) return false;
    return (ANCESTOR_INDEX.get(requiredId) || new Set()).has(declaredId);
}

/**
 * 判定一组声明能力是否覆盖工具所需能力中的任意一项。
 * 工具能力为空视为不可覆盖（默认拒绝），调用方需据此拒绝。
 */
function capabilitiesCoverTool(declaredList, toolCapabilities) {
    const declared = normalizeCapabilityList(declaredList);
    const required = normalizeCapabilityList(toolCapabilities);
    if (!declared.length || !required.length) return false;
    return required.some(capability => declared.some(item => capabilityCoveredBy(item, capability)));
}

/** 校验能力清单是否全部已登记，返回未登记项供调用方生成中文错误。 */
function assertRegisteredCapabilities(value) {
    const capabilities = normalizeCapabilityList(value);
    const unknown = capabilities.filter(item => !CAPABILITY_INDEX.has(item));
    return { valid: unknown.length === 0, capabilities, unknown };
}

/**
 * 解析工具契约的能力集合。
 * 显式声明优先；显式声明中出现未登记能力时按 strict 决定是丢弃还是抛错。
 */
function resolveDeclaredToolCapabilities(value, { strict = false, toolName = '' } = {}) {
    const { capabilities, unknown } = assertRegisteredCapabilities(value);
    if (unknown.length && strict) {
        const error = new Error(`工具 ${toolName || '未命名'} 声明了未登记的能力：${unknown.join('、')}。`);
        error.code = 'AGENT_CAPABILITY_UNREGISTERED';
        throw error;
    }
    return capabilities.filter(item => CAPABILITY_INDEX.has(item));
}

module.exports = {
    AGENT_CAPABILITY_DEFINITIONS,
    assertRegisteredCapabilities,
    capabilitiesCoverTool,
    capabilityCoveredBy,
    getCapabilityDefinition,
    isRegisteredCapability,
    listAgentCapabilities,
    normalizeCapabilityId,
    normalizeCapabilityList,
    resolveDeclaredToolCapabilities
};
