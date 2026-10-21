'use strict';

const { isRegisteredCapability, capabilitiesCoverTool } = require('./agent-capability-registry');
const { normalizeCapabilityDecision } = require('./chat-capability-decision');

const ACTIONS = ['direct_answer', 'plan_only', 'agent_run', 'continue_run', 'clarify'];
const NON_READ_CAPABILITY = /^(?:filesystem\.write|code\.|artifact\.deliver|document\.render|viz\.render|media\.|desktop\.|workflow\.)/;

function strings(value, max = 16) {
    return Array.isArray(value) ? value.slice(0, max).filter(item => typeof item === 'string').map(item => item.trim().slice(0, 500)).filter(Boolean) : [];
}

function invalid(message) {
    return Object.assign(new Error(message), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
}

function normalizeIntent(raw, { baseline = {}, tasks = [], history = [], userMessageId, availability = {} } = {}) {
    if (!raw || Array.isArray(raw) || !ACTIONS.includes(raw.action) || typeof raw.objective !== 'string' || !raw.objective.trim()) throw invalid('意图响应契约无效');
    if (raw.requiredCapabilities !== undefined && (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.some(cap => typeof cap !== 'string' || !isRegisteredCapability(cap)))) throw invalid('意图响应包含未注册能力');
    if (raw.routing !== undefined && (!raw.routing || typeof raw.routing !== 'object' || Array.isArray(raw.routing))) throw invalid('依据与工具决策格式无效');
    const route = raw.routing || {};
    for (const [field, allowed] of [['knowledge', ['required', 'none', 'auto']], ['tools', ['read_only', 'task', 'none']]]) {
        if (route[field] !== undefined && !allowed.includes(route[field])) throw invalid('依据与工具决策包含未知值');
    }
    const target = raw.action === 'continue_run' ? tasks.find(task => task.id === raw.continuationOf) : null;
    if (raw.action === 'continue_run' && !target) throw invalid('续接目标不属于当前会话');
    const caps = strings(raw.requiredCapabilities);
    if (target && !caps.length && route.tools !== 'none') caps.push(...strings(target.requiredCapabilities).filter(isRegisteredCapability));
    const ids = new Set(history.filter(item => item.id && ['user', 'assistant'].includes(item.role)).map(item => `message:${item.id}`));
    ids.add('current_message');
    const refs = strings(raw.evidenceRefs).filter(ref => ids.has(ref));
    let action = baseline.action === 'plan_only' ? 'plan_only' : raw.action;
    if (!['plan_only', 'clarify'].includes(action) && route.knowledge === 'required' && !caps.some(cap => cap.startsWith('knowledge.'))) caps.push('knowledge.search');
    const routing = normalizeCapabilityDecision(raw, { action, prompt: raw.objective, capabilities: caps, availability });
    if (action === 'direct_answer' && routing.tools === 'task') throw invalid('普通回复不能直接承载需要持久任务的操作');
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
    const constraints = [...new Set([...strings(prior?.constraints), ...(action === 'plan_only' ? strings(baseline.constraints) : []), ...strings(raw.constraints)])];
    const deliverables = strings(raw.deliverables);
    return {
        version: 4, action, sourceMessageId: userMessageId || null, intent: String(raw.intent || '').slice(0, 32), objective: raw.objective.trim().slice(0, 12000),
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
    };
}

module.exports = { ACTIONS, normalizeIntent };
