const { forwardChatCompletion } = require('../model-forwarder');
const { buildChatCompletionsUrl, buildModelHeaders } = require('../model-adapter');
const { buildThinkingControlPayload } = require('../models');
const {
    MEMORY_TYPES,
    MIN_MEMORY_CONTENT_CHARS,
    MODEL_EXTRACTION_TIMEOUT_MS,
    MODEL_EXTRACTION_MAX_OUTPUT_TOKENS,
    MODEL_EXTRACTION_MAX_CANDIDATES,
    MODEL_EXTRACTION_DISABLED,
    clamp,
    normalizeMemoryType,
    normalizeMemoryContent,
    normalizeSourceMessageIds,
    hasSensitiveContent,
    hasUnsafeMemoryInstruction,
    MEMORY_ORIGINS,
    MEMORY_ASSERTED_BY,
    fingerprintMemory,
    contentText
} = require('./memory-utils');
const { classifyMemory } = require('../memory-governance');

const MODEL_EXTRACTION_FAILURE_COOLDOWN_MS = Math.max(
    10000,
    Number.parseInt(process.env.LONG_TERM_MEMORY_LLM_FAILURE_COOLDOWN_MS, 10) || 120000
);
const modelExtractionCooldowns = new Map();

function modelExtractionKey(modelCfg = {}) {
    return String(modelCfg.id || modelCfg.url || modelCfg.model_name || modelCfg.name || 'default');
}

function isModelExtractionCircuitOpen(modelCfg = {}) {
    const key = modelExtractionKey(modelCfg);
    const until = Number(modelExtractionCooldowns.get(key) || 0);
    if (!until) return false;
    if (until <= Date.now()) {
        modelExtractionCooldowns.delete(key);
        return false;
    }
    return true;
}

function markModelExtractionTimeout(modelCfg = {}) {
    modelExtractionCooldowns.set(modelExtractionKey(modelCfg), Date.now() + MODEL_EXTRACTION_FAILURE_COOLDOWN_MS);
}

function clearModelExtractionCooldown(modelCfg = {}) {
    modelExtractionCooldowns.delete(modelExtractionKey(modelCfg));
}

function normalizeExtractorCandidates(rawCandidates = [], context = {}) {
    const sourceMessageIds = normalizeSourceMessageIds(context.sourceMessageIds);
    const sourceSessionId = context.sessionId || null;
    const byKey = new Map();
    (Array.isArray(rawCandidates) ? rawCandidates : []).forEach(raw => {
        if (!raw || typeof raw !== 'object') return;
        const content = normalizeMemoryContent(raw.content || raw.memory || raw.text || raw.value || '');
        if (content.length < MIN_MEMORY_CONTENT_CHARS || hasSensitiveContent(content) || hasUnsafeMemoryInstruction(content)) return;
        const requestedType = normalizeMemoryType(raw.type || raw.category);
        const candidate = buildCandidate({
            type: requestedType,
            governanceClass: classifyMemory({ type: requestedType, category: raw.category, content }),
            content,
            salience: clamp(raw.salience ?? raw.importance, 0, 1, 0.55),
            confidence: clamp(raw.confidence, 0, 1, 0.62),
            sourceSessionId: raw.sourceSessionId || sourceSessionId,
            sourceMessageIds: normalizeSourceMessageIds(raw.sourceMessageIds || sourceMessageIds),
            origin: MEMORY_ORIGINS.automatic,
            assertedBy: MEMORY_ASSERTED_BY.user,
            factKey: raw.factKey || raw.fact_key || ''
        });
        const key = fingerprintMemory(candidate.type, candidate.content);
        const existing = byKey.get(key);
        if (!existing || candidate.salience > existing.salience) byKey.set(key, candidate);
    });
    return Array.from(byKey.values()).slice(0, MODEL_EXTRACTION_MAX_CANDIDATES);
}

function parseExtractorJsonResult(text) {
    const raw = String(text || '').trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
    const attempts = [raw];
    const firstObject = raw.indexOf('{');
    const lastObject = raw.lastIndexOf('}');
    if (firstObject !== -1 && lastObject > firstObject) attempts.push(raw.slice(firstObject, lastObject + 1));
    const firstArray = raw.indexOf('[');
    const lastArray = raw.lastIndexOf(']');
    if (firstArray !== -1 && lastArray > firstArray) attempts.push(raw.slice(firstArray, lastArray + 1));

    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (Array.isArray(parsed)) return { candidates: parsed, valid: true };
            if (Array.isArray(parsed?.memories)) return { candidates: parsed.memories, valid: true };
            if (Array.isArray(parsed?.candidates)) return { candidates: parsed.candidates, valid: true };
        } catch (_err) {
            // 尝试下一个宽松 JSON 边界提取
        }
    }
    return { candidates: [], valid: false };
}

function parseExtractorJson(text) {
    return parseExtractorJsonResult(text).candidates;
}

function extractModelMessageText(data) {
    const message = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text;
    return contentText(message);
}

function isModelExtractionTimeoutError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || error || '').toLowerCase();
    return ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)
        || /timeout|timed out|超时/.test(message);
}

function buildExtractorMessages(messages = []) {
    const source = messages
        // 助手回答可能包含推测；自动提取的稳定事实必须以用户实际声明为依据。
        .filter(message => message?.role === 'user')
        .map(message => {
            const text = contentText(message.content).slice(0, 4000);
            return `[message_id:${message.id} role:${message.role}]\n${text}`;
        })
        .join('\n\n');
    return [
        {
            role: 'system',
            content: [
                'Extract durable long-term memory candidates from the conversation.',
                'Return only JSON with this shape: {"memories":[{"type":"preference|fact|decision|episode","category":"preference|fact|temporary","factKey":"stable-subject:attribute","content":"...","salience":0.0,"confidence":0.0}]}',
                'Keep only stable user preferences, project/task facts, long-term decisions, or useful historical episodes.',
                'Do not include secrets, tokens, passwords, private keys, payment card numbers, phone numbers, government IDs, or transient chit-chat.',
                'Use concise standalone content. Return at most 8 memories.'
            ].join('\n')
        },
        {
            role: 'user',
            content: source || 'No source messages.'
        }
    ];
}

async function extractMemoryCandidatesWithModel(messages = [], context = {}) {
    if (MODEL_EXTRACTION_DISABLED || !context.modelCfg?.url) return { candidates: [], completed: false, reason: 'disabled_or_unavailable' };
    const modelCfg = context.modelCfg;
    const url = buildChatCompletionsUrl(modelCfg.url);
    const res = await forwardChatCompletion({
        modelCfg,
        user: context.user || null,
        url,
        headers: buildModelHeaders(modelCfg, { acceptJson: true }),
        timeout: MODEL_EXTRACTION_TIMEOUT_MS,
        signal: context.signal || null,
        data: {
            model: modelCfg.model_name || modelCfg.name || modelCfg.model || 'memory-extractor',
            messages: buildExtractorMessages(messages),
            temperature: 0,
            stream: false,
            max_tokens: MODEL_EXTRACTION_MAX_OUTPUT_TOKENS,
            response_format: { type: 'json_object' },
            // 抽取要求严格 JSON，思维链会挤占有限的输出预算并把 JSON 截断。
            ...buildThinkingControlPayload(modelCfg)
        }
    });
    const parsed = parseExtractorJsonResult(extractModelMessageText(res.data));
    return {
        candidates: normalizeExtractorCandidates(parsed.candidates, {
        sessionId: context.sessionId,
        sourceMessageIds: messages.filter(message => message?.role === 'user').map(message => message.id)
        }),
        completed: parsed.valid,
        reason: parsed.valid ? '' : 'invalid_response'
    };
}

function buildCandidate({ type, governanceClass = '', retentionMode = '', factKey = '', scope = 'user', scopeReference = '', projectId = '', expiresAt = null, content, salience, confidence, sourceSessionId, sourceMessageIds, origin = MEMORY_ORIGINS.automatic, assertedBy = MEMORY_ASSERTED_BY.user }) {
    const normalizedType = normalizeMemoryType(type);
    const temporary = normalizedType === MEMORY_TYPES.episode;
    return {
        type: normalizedType,
        governanceClass,
        retentionMode,
        factKey,
        // 历史片段在来源会话内有用，但不能静默升级为跨会话的用户事实。
        scope: temporary ? 'session' : scope,
        scopeReference: temporary ? String(sourceSessionId || scopeReference || '').slice(0, 160) : scopeReference,
        projectId,
        expiresAt,
        content: normalizeMemoryContent(content),
        salience,
        confidence,
        sourceSessionId,
        sourceMessageIds,
        origin,
        assertedBy
    };
}

function splitMeaningfulLines(text) {
    return String(text || '')
        .split(/[\r\n。！？!?；;]+/)
        .map(line => line.trim())
        .filter(line => line.length >= MIN_MEMORY_CONTENT_CHARS)
        .slice(0, 20);
}

function classifyLine(line) {
    const text = String(line || '').trim();
    if (!text || hasSensitiveContent(text) || hasUnsafeMemoryInstruction(text)) return null;
    if (/(我|本人|用户).{0,8}(喜欢|偏好|习惯|希望|倾向|不喜欢|不要|默认|优先|更喜欢)/.test(text)
        || /(prefer|preference|like|dislike|default|always|never)/i.test(text)) {
        return { type: MEMORY_TYPES.preference, salience: 0.78, confidence: 0.72 };
    }
    if (/(决定|约定|确认|以后|长期|固定|统一|最终|不再|保持|采用)/.test(text)
        || /(decided|decision|agreed|keep using|standardize)/i.test(text)) {
        return { type: MEMORY_TYPES.decision, salience: 0.86, confidence: 0.7 };
    }
    if (/(项目|任务|系统|模块|接口|数据库|表|字段|版本|部署|环境|模型|用户|团队|客户|需求).{0,80}(是|为|叫|使用|采用|位于|属于|负责|需要|已经|正在)/.test(text)
        || /(project|task|module|database|api|service|version|uses|requires|located)/i.test(text)) {
        return { type: MEMORY_TYPES.fact, salience: 0.68, confidence: 0.64 };
    }
    if (text.length >= 24 && /(今天|刚才|上次|这轮|之前|已经|完成|修复|新增|讨论|提到)/.test(text)) {
        return { type: MEMORY_TYPES.episode, salience: 0.48, confidence: 0.52 };
    }
    return null;
}

function extractMemoryCandidatesFromMessages(messages = [], context = {}) {
    const sourceSessionId = context.sessionId || messages.find(message => message.session_id)?.session_id || null;
    const candidates = [];
    messages
        .filter(message => message?.role === 'user')
        .forEach(message => {
            splitMeaningfulLines(contentText(message.content)).forEach(line => {
                const classification = classifyLine(line);
                if (!classification) return;
                candidates.push(buildCandidate({
                    ...classification,
                    content: line,
                    sourceSessionId,
                    sourceMessageIds: [message.id],
                    origin: MEMORY_ORIGINS.automatic,
                    assertedBy: MEMORY_ASSERTED_BY.user
                }));
            });
        });

    const byKey = new Map();
    candidates.forEach(candidate => {
        const key = fingerprintMemory(candidate.type, candidate.content);
        const existing = byKey.get(key);
        if (!existing || candidate.salience > existing.salience) byKey.set(key, candidate);
    });
    return Array.from(byKey.values()).slice(0, 8);
}

module.exports = {
    normalizeExtractorCandidates,
    parseExtractorJson,
    extractModelMessageText,
    isModelExtractionTimeoutError,
    isModelExtractionCircuitOpen,
    markModelExtractionTimeout,
    clearModelExtractionCooldown,
    buildExtractorMessages,
    extractMemoryCandidatesWithModel,
    buildCandidate,
    splitMeaningfulLines,
    classifyLine,
    extractMemoryCandidatesFromMessages
};
