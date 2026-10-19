'use strict';

const crypto = require('crypto');
const { recordUserDecisionFeedback } = require('./decision-observability');
const { redactRoutingText } = require('./decision-provider');

// 只读取本轮用户自己表达的限制；引用、代码和附件不能撤销或授予任务权限。
function detectChatRouteCorrection(prompt = '') {
    const text = String(prompt).split(/\n---\s*\n【参考文档/)[0]
        .replace(/```[\s\S]*?```/g, '').replace(/^[ \t]*>.*$/gm, '')
        .replace(/[“「][^”」]*[”」]|"[^"\n]*"/g, '').trim();
    const clauses = text.split(/[，,。！!；;\n]/).map(item => item.trim()).filter(Boolean);
    const prefix = '(?:(?:不对|不是这个意思|刚才|这次|这轮|当前|请|我|你|现在|先)[，,：: ]*)*';
    const matches = pattern => clauses.some(clause => new RegExp(`^${prefix}${pattern}$`, 'i').test(clause));
    const answerOnly = matches('(?:只是|只想|就是)?(?:问(?:一)?下|问问|咨询(?:一下)?|想了解(?:一下)?)(?:而已|就好|罢了)?')
        || matches('(?:不需要|无需|不用|不要|先别|暂不)(?:实际|真的|自动|继续|再)?(?:执行|操作|处理任务|启动任务)(?:了|吧)?')
        || matches('(?:不是|并非)让你(?:执行|操作|启动任务)')
        || matches('(?:只需要|只要|直接)(?:回答|解释)(?:问题|一下)?(?:就好|即可|就行|吧)?');
    const planOnly = matches('(?:只|仅|先)(?:给出|给|提供|输出)?(?:我)?[^?？：:]{0,12}(?:方案|计划|建议|思路)(?:就好|即可|就行|吧)?')
        || matches('(?:不要|不用|先别|暂不)(?:修改|改代码|写入|删除|发送|发布)(?:文件|代码|数据)?(?:了|吧)?');
    const excludeTools = answerOnly || planOnly || matches('(?:不要|不用|无需|先别)(?:再|继续)?(?:调用|使用|用)?(?:任何|外部)?工具(?:了|吧)?');
    const excludeRag = answerOnly || planOnly || matches('(?:不要|不用|无需|先别)(?:再|继续)?(?:检索|搜索|查|使用|用)?(?:知识库|资料库)(?:检索|搜索)?(?:了|吧)?');
    const forceRag = !excludeRag && /不对|不是这个意思|应该|应当/.test(text)
        && matches('(?:应该|需要|应当|要|先)?(?:查|检索|搜索)(?:一下)?(?:知识库|资料库)(?:依据|资料)?(?:再回答|吧)?');
    if (!excludeTools && !excludeRag && !forceRag) return null;
    return {
        kind: answerOnly ? 'answer_only' : planOnly ? 'plan_only' : forceRag ? 'require_evidence' : excludeTools ? 'exclude_tools' : 'exclude_rag',
        action: planOnly ? 'plan_only' : 'direct_answer',
        routeOverrides: { ...(excludeTools ? { excludeTools: true } : {}), ...(excludeRag ? { excludeRag: true } : {}), ...(forceRag ? { forceRag: true } : {}) },
        pauseExecution: Boolean(answerOnly || planOnly || excludeTools),
        constraint: planOnly ? '本轮只提供方案，不执行操作。' : answerOnly ? '本轮只回答问题，不执行任务或调用工具。'
            : forceRag ? '本轮在已有授权范围内检索知识库依据后回答。' : excludeTools ? '本轮不调用工具。' : '本轮不检索知识库。'
    };
}

function parseMetadata(value) {
    try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch (_) { return {}; }
}

function applyAutomaticExecutionDecision(state, decision) {
    state.intentDecision = decision;
    const routing = decision.shadow !== true && decision.routing;
    if (routing?.source === 'semantic_intent') {
        if (routing.knowledge === 'required') state.routeOverrides = { ...state.routeOverrides, forceRag: true };
        if (routing.allowAutomaticRead && routing.tools === 'read_only') {
            state.automaticReadCapabilities = routing.requestedCapabilities;
            state.mcpEnabled = true;
        }
    }
    if (decision.correction) {
        state.routeOverrides = { ...state.routeOverrides, ...decision.correction.routeOverrides };
        if (decision.correction.routeOverrides.excludeTools) state.mcpEnabled = false;
        if (decision.correction.routeOverrides.excludeRag) state.ragEnabled = false;
    }
    return { mcpEnabled: state.mcpEnabled, ragEnabled: state.ragEnabled };
}

function correctionRetrievalQuery(prompt, history = []) {
    const question = String(prompt).replace(/^(?:不对|不是这个意思)[，,：: ]*/, '').replace(/[。！!\s]+$/g, '');
    if (!/^(?:这次|请|应该|需要|应当|要|先)*(?:查|检索|搜索)(?:一下)?(?:知识库|资料库)(?:依据|资料)?(?:再回答|吧)?$/.test(question)) return question;
    return String([...history].reverse().find(item => item.role === 'user')?.content || question).slice(0, 4000);
}

async function recordChatRouteCorrection({ correction, history = [], tasks = [], prompt, userId, sessionId, userMessageId, applied = {} }, deps = {}) {
    const previous = [...history].reverse().find(item => item.role === 'assistant');
    const storedDecisions = parseMetadata(previous?.route_metadata).decisions;
    const decisions = Array.isArray(storedDecisions) ? [...storedDecisions] : [];
    const active = tasks.filter(task => task.active);
    if (active.length === 1 && active[0].decisionId && !decisions.some(item => item.decisionId === active[0].decisionId)) {
        decisions.push({ decisionId: active[0].decisionId, scenario: 'chat.execution' });
    }
    const evidence = [];
    for (const decision of decisions.slice(0, 8)) {
        const correctedActionId = decision.scenario === 'chat.execution' ? correction.action
            : decision.scenario === 'chat.tools' && correction.routeOverrides.excludeTools ? 'skip'
            : decision.scenario === 'chat.rag' && correction.routeOverrides.excludeRag ? 'skip'
            : decision.scenario === 'chat.rag' && correction.routeOverrides.forceRag ? 'retrieve' : null;
        if (!correctedActionId) continue;
        const saved = await (deps.recordUserDecisionFeedback || recordUserDecisionFeedback)({
            decisionId: decision.decisionId, correctedActionId, userId, sessionId, reason: 'intent_mismatch',
            note: redactRoutingText(String(prompt)).slice(0, 500),
            naturalCorrection: { kind: correction.kind, sourceMessageId: userMessageId, priorMessageId: previous?.id || null,
                promptHash: crypto.createHash('sha256').update(String(prompt)).digest('hex'),
                applied: { ...applied, routeOverrides: correction.routeOverrides }, runId: active.length === 1 ? active[0].id : null }
        });
        if (saved) evidence.push({ id: saved.id, decisionId: saved.decisionId, reviewStatus: saved.reviewStatus });
    }
    return evidence;
}

module.exports = { detectChatRouteCorrection, recordChatRouteCorrection, applyAutomaticExecutionDecision, correctionRetrievalQuery };
