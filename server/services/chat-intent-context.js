'use strict';

const { listAgentCapabilities } = require('./agent-capability-registry');
const { currentRequestText } = require('./chat-request-constraints');

function compactText(value, limit) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    const marker = '\n[中段已省略]\n';
    const head = Math.floor((limit - marker.length) * 0.6);
    return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

function strings(value, limit = 16) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, limit).map(item => compactText(item, 240)) : [];
}

function describeTextContext(value, limit) {
    const original = String(value || '');
    const text = compactText(original, limit);
    if (text === original) return { text, complete: true, constraintExcerpts: [], constraintsComplete: true };
    const request = currentRequestText(original);
    const pattern = /(?:仅限|只限|仅统计|只统计|只查询|仅查询|不得|不要|禁止|只读|改为|改成|统计范围|统计时间|统计地区|输出格式|\b(?:only|must|never|do\s+not|don't|read.only|instead)\b)/giu;
    const excerpts = [];
    const offsets = [];
    for (const match of request.matchAll(pattern)) {
        if (offsets.some(offset => match.index >= offset && match.index < offset + 240)) continue;
        offsets.push(match.index);
        excerpts.push({ offset: match.index, text: request.slice(match.index, match.index + 240).split(/[。；;\n]/)[0] });
        if (excerpts.length > 12) break;
    }
    return { text, complete: false, originalCharacters: original.length, constraintExcerpts: excerpts.slice(0, 12), constraintsComplete: excerpts.length <= 12 };
}

function buildChatIntentContext(input = {}) {
    const history = (Array.isArray(input.history) ? input.history : []).filter(item => ['user', 'assistant'].includes(item.role)).slice(-12);
    const tasks = (Array.isArray(input.tasks) ? input.tasks : []).slice().sort((left, right) => Number(right.active === true) - Number(left.active === true)).slice(0, 8);
    const tools = Array.isArray(input.availability?.tools) ? input.availability.tools : [];
    const selectedNames = new Set(input.availability?.selectedToolNames || []);
    const ordered = [...tools.filter(tool => selectedNames.has(tool.name)), ...tools.filter(tool => !selectedNames.has(tool.name))];
    const visible = ordered.slice(0, Math.max(24, Math.min(selectedNames.size, 100)));
    const totalTools = Math.max(Number(input.availability?.totalTools) || 0, tools.length);
    const request = describeTextContext(input.prompt, 12000);
    const { text: prompt, ...requestContext } = request;
    return {
        prompt, requestContext,
        currentTime: new Date().toISOString(), timezone: 'Asia/Shanghai',
        history: history.map(item => {
            const summary = describeTextContext(item.content, 2400);
            return { id: item.id, role: item.role, content: summary.text,
                ...(!summary.complete ? { contextIncomplete: true, constraintExcerpts: summary.constraintExcerpts } : {}) };
        }),
        tasks: tasks.map(item => ({ id: item.id, status: item.status, active: item.active === true, goal: compactText(item.goal, 1600),
            constraints: strings(item.constraints), deliverables: strings(item.deliverables), requiredCapabilities: strings(item.requiredCapabilities),
            businessScope: Object.fromEntries(['timeRange', 'region', 'audience', 'format'].filter(field => typeof item.businessScope?.[field] === 'string').map(field => [field, compactText(item.businessScope[field], 240)])),
            acceptance: { requireEvidence: item.acceptance?.requireEvidence === true, artifactRequired: item.acceptance?.artifactRequired === true } })),
        preferences: (Array.isArray(input.preferences) ? input.preferences : []).slice(0, 4).map(item => ({ id: item.id, scope: item.scope, content: compactText(item.content, 500) })),
        providedSources: (Array.isArray(input.providedSources) ? input.providedSources : []).slice(0, 20).map(item => ({ kind: item.kind, name: compactText(item.name, 240), available: item.available === true, sourceMessageId: item.sourceMessageId })),
        availability: { kind: 'external_mcp_tools', status: input.availability?.status === 'unavailable' ? 'unavailable'
            : input.availability?.status === 'partial' || visible.length < totalTools ? 'partial' : input.availability?.status || 'unknown', totalTools,
        tools: visible.map(item => ({ name: item.name, sourceName: compactText(item.sourceName, 80), description: compactText(item.description, 240),
            capabilities: strings(item.capabilities), readOnly: item.readOnly === true, requiresApproval: item.requiresApproval === true, idempotent: item.idempotent })) },
        capabilities: listAgentCapabilities().filter(({ id }) => id !== 'artifact.deliver').map(({ id, title }) => ({ id, description: title }))
    };
}

module.exports = { buildChatIntentContext };
