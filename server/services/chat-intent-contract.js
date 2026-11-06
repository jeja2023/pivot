'use strict';

const { isRegisteredCapability, capabilitiesCoverTool } = require('./agent-capability-registry');
const { normalizeCapabilityDecision } = require('./chat-capability-decision');
const { resolveChatRequestScope, constrainChatDecision, toolAllowedByRequestScope, capabilityAllowedByRequestScope } = require('./chat-request-scope');
const { BUSINESS_FIELDS, mergeTaskContract } = require('./chat-task-contract-update');

const ACTIONS = ['direct_answer', 'plan_only', 'agent_run', 'continue_run', 'clarify'];
const NON_READ_CAPABILITY = /^(?:filesystem\.write|code\.|artifact\.deliver|document\.render|viz\.render|media\.|desktop\.|workflow\.)/;

function strings(value, max = 16) {
    return Array.isArray(value) ? value.slice(0, max).filter(item => typeof item === 'string').map(item => item.trim().slice(0, 500)).filter(Boolean) : [];
}

function invalid(message) {
    return Object.assign(new Error(message), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
}

function normalizeIntent(raw, { baseline = {}, tasks = [], history = [], userMessageId, availability = {}, prompt = '', requestScope = null, requireRouting = false } = {}) {
    if (!raw || Array.isArray(raw) || !ACTIONS.includes(raw.action) || typeof raw.objective !== 'string' || !raw.objective.trim()) throw invalid('意图响应契约无效');
    if (raw.requiredCapabilities !== undefined && (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.some(cap => typeof cap !== 'string' || !isRegisteredCapability(cap)))) throw invalid('意图响应包含未注册能力');
    if (raw.routing !== undefined && (!raw.routing || typeof raw.routing !== 'object' || Array.isArray(raw.routing))) throw invalid('依据与工具决策格式无效');
    let route = raw.routing || {};
    if (requireRouting && (!raw.routing || !Object.hasOwn(route, 'knowledge') || !Object.hasOwn(route, 'tools'))) throw invalid('意图响应缺少必填的依据与工具决策');
    for (const field of ['constraints', 'deliverables', 'missingFacts', 'evidenceRefs', 'removedCapabilities']) {
        if (raw[field] !== undefined && (!Array.isArray(raw[field]) || raw[field].some(value => typeof value !== 'string'))) throw invalid('意图响应的列表字段格式无效');
    }
    if (raw.removedCapabilities?.some(capability => !isRegisteredCapability(capability))) throw invalid('意图响应撤销了未注册能力');
    for (const field of ['question', 'intent', 'continuationOf']) {
        if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') throw invalid('意图响应的文本字段格式无效');
    }
    if (raw.confidence !== undefined && (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) throw invalid('意图响应的置信度格式无效');
    if (raw.acceptance !== undefined && (!raw.acceptance || typeof raw.acceptance !== 'object' || Array.isArray(raw.acceptance)
        || Object.values(raw.acceptance).some(value => typeof value !== 'boolean'))) throw invalid('意图响应的验收要求格式无效');
    if (raw.businessScope !== undefined && (!raw.businessScope || typeof raw.businessScope !== 'object' || Array.isArray(raw.businessScope)
        || Object.entries(raw.businessScope).some(([field, value]) => !BUSINESS_FIELDS.includes(field) || (value !== null && (typeof value !== 'string' || value.length > 500))))) throw invalid('意图响应的业务范围格式无效');
    for (const [field, allowed] of [['knowledge', ['required', 'none', 'auto']], ['tools', ['read_only', 'task', 'none']]]) {
        if (route[field] !== undefined && !allowed.includes(route[field])) throw invalid('依据与工具决策包含未知值');
    }
    const target = raw.action === 'continue_run' ? tasks.find(task => task.id === raw.continuationOf) : null;
    if (raw.action === 'continue_run' && !target) throw invalid('续接目标不属于当前会话');
    const scope = { ...(requestScope || resolveChatRequestScope(prompt)),
        ...Object.fromEntries(['excludeKnowledge', 'excludeWeb', 'excludeData', 'sourceOnly'].filter(field => target?.requestScope?.[field] === true).map(field => [field, true])) };
    raw = constrainChatDecision(raw, scope);
    route = raw.routing || {};
    if (scope.excludeWeb || scope.excludeKnowledge || scope.excludeData || scope.sourceOnly) {
        const allowedTools = (availability.tools || []).filter(tool => toolAllowedByRequestScope(tool, scope));
        const disallowedNames = new Set((availability.tools || []).filter(tool => !toolAllowedByRequestScope(tool, scope)).map(tool => tool.name));
        if (Array.isArray(route.toolNames)) route.toolNames = route.toolNames.filter(name => !disallowedNames.has(name));
        availability = { ...availability, tools: allowedTools };
        if (route.tools === 'read_only' && !raw.requiredCapabilities?.length) route.tools = 'none';
    }
    const contract = mergeTaskContract({ prior: target || {}, constraints: strings(raw.constraints), capabilities: strings(raw.requiredCapabilities),
        removedCapabilities: strings(raw.removedCapabilities), businessScope: Object.fromEntries(Object.entries(raw.businessScope || {}).filter(([, value]) => value)), inheritCapabilities: route.tools !== 'none' });
    const caps = contract.requiredCapabilities.filter(capability => isRegisteredCapability(capability) && capabilityAllowedByRequestScope(capability, scope));
    const ids = new Set(history.filter(item => item.id && ['user', 'assistant'].includes(item.role)).map(item => `message:${item.id}`));
    ids.add('current_message');
    const refs = strings(raw.evidenceRefs).filter(ref => ids.has(ref));
    let action = baseline.action === 'plan_only' ? 'plan_only' : raw.action;
    if (!['plan_only', 'clarify'].includes(action) && route.knowledge === 'required' && !caps.some(cap => cap.startsWith('knowledge.'))) caps.push('knowledge.search');
    // 内置知识检索由 RAG 链处理；仅有知识能力且未指定外部工具时，不额外
    // 打开 MCP 规划。显式指向可见知识工具的请求仍按原只读工具契约复核。
    if (action === 'direct_answer' && route.knowledge === 'required' && route.tools === 'read_only' && !route.toolNames?.length
        && caps.some(cap => cap.startsWith('knowledge.')) && caps.every(cap => cap.startsWith('knowledge.') || ['agent.execute', 'system.observe'].includes(cap))) route.tools = 'none';
    const routing = normalizeCapabilityDecision(raw, { action, prompt: raw.objective, capabilities: caps, availability });
    if (requireRouting && ['agent_run', 'continue_run'].includes(action) && routing.tools !== 'task') throw invalid('持久任务必须包含明确的任务处理决策');
    if (requireRouting && routing.tools === 'none' && routing.toolNames.length) throw invalid('不调用工具的决策不能指定工具名称');
    if (action === 'direct_answer' && routing.tools === 'task') throw invalid('普通回复不能直接承载需要持久任务的操作');
    if (requireRouting && action === 'direct_answer' && caps.some(cap => NON_READ_CAPABILITY.test(cap))) throw invalid('普通回复不能申请写入或交付能力');
    if (route.tools === 'read_only' && action !== 'plan_only' && caps.some(cap => NON_READ_CAPABILITY.test(cap))) throw invalid('只读决策不能申请写入或执行能力');
    if (route.toolNames !== undefined && (!Array.isArray(route.toolNames) || route.toolNames.some(name => !routing.toolNames.includes(name)))) throw invalid('意图响应指定了不可见的工具来源');
    const matches = (availability.tools || []).filter(tool => tool.readOnly === true && tool.requiresApproval !== true && tool.idempotent !== false
        && tool.capabilities?.length && tool.capabilities.every(cap => capabilitiesCoverTool(caps, [cap])));
    if (routing.toolNames.some(name => !matches.some(tool => tool.name === name)) && routing.tools === 'read_only') throw invalid('指定工具不属于可用只读能力范围');
    const sources = new Set(matches.map(tool => String(tool.name).match(/^mcp\.(\d+)\./)?.[1] || tool.sourceName || tool.name));
    const ambiguousSource = routing.allowAutomaticRead && (sources.size > 1 || availability.status === 'partial') && !routing.toolNames.length;
    if (ambiguousSource) { action = 'clarify'; routing.allowAutomaticRead = false; routing.tools = 'none'; }
    routing.allowAutomaticRead = routing.allowAutomaticRead && matches.length > 0;
    if (action === 'clarify') { routing.tools = 'none'; routing.allowAutomaticRead = false; }
    const providedQuestion = typeof raw.question === 'string' ? raw.question.trim().slice(0, 500) : '';
    const missingFacts = ambiguousSource ? ['本次查询的业务数据来源'] : strings(raw.missingFacts, 4);
    const question = ambiguousSource ? '本次需要查询哪个业务系统的数据？' : providedQuestion;
    if (action === 'clarify' && (!question || /普通模式|Agent|智能体模式|是否.{0,10}(?:工具|检索)|直接回答.{0,12}工具/i.test(question))) throw invalid('澄清必须包含具体业务问题');
    const prior = action === 'continue_run' ? target : null;
    const constraints = [...new Set([...contract.constraints, ...(action === 'plan_only' ? strings(baseline.constraints) : [])])];
    const deliverables = strings(raw.deliverables);
    return constrainChatDecision({
        version: 5, action, sourceMessageId: userMessageId || null, intent: String(raw.intent || '').slice(0, 32), objective: raw.objective.trim().slice(0, 12000),
        businessScope: contract.businessScope,
        constraints, deliverables: deliverables.length ? deliverables : strings(prior?.deliverables), requiredCapabilities: [...new Set(['agent.execute', 'system.observe', ...caps])],
        missingFacts, evidenceRefs: refs.length ? refs.map(ref => ref === 'current_message' && userMessageId ? `message:${userMessageId}` : ref) : userMessageId ? [`message:${userMessageId}`] : ['current_message'],
        continuationOf: prior?.id || null, conversationTaskId: prior?.conversationTaskId || prior?.id || null,
        question: action === 'clarify' ? question : '',
        acceptance: { requireEvidence: raw.acceptance?.requireEvidence === true || routing.requireEvidence || prior?.acceptance?.requireEvidence === true,
            artifactRequired: raw.acceptance?.artifactRequired === true || caps.includes('artifact.deliver') || prior?.acceptance?.artifactRequired === true },
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
        reasonCode: 'semantic_intent', continuation: action === 'continue_run', delegated: ['agent_run', 'continue_run'].includes(action),
        allowMcp: baseline.allowMcp === true || caps.some(cap => /^(?:network\.|data\.)/.test(cap)), nextAction: action,
        routing
    }, scope);
}

module.exports = { ACTIONS, normalizeIntent };
