const { estimateTokens, stripThoughtContent, stripVisibleReasoningScaffold } = require('../../llm');
const { shouldDisableChatThinking } = require('../../services/models');

const CHAT_LANGUAGE_SYSTEM_PROMPT = [
    '【重要语言规则】你必须全程使用中文，包括：',
    '1. 最终回答必须使用中文。',
    '2. 所有可见的思考、推理、reasoning_content、<think> 或 <thought> 内容也必须使用中文，禁止使用英文提纲或英文推理。',
    '3. 即使用户问题中包含英文，思考和回答仍然默认使用中文。',
    '4. 仅当用户明确要求使用其他语言时，才可在该次回复中切换语言。',
    '',
    '【重要工具规则】',
    '1. 如果用户要求查询数据、统计分析或生成图表，不要生成 Python（matplotlib/pandas/plotly）、JavaScript（echarts/Chart.js）或其他编程语言的代码来画图。',
    '2. 如果你可以访问工具箱工具（数据库查询、图表生成等），请引导用户开启并使用这些内置工具来获取数据和生成真正的交互式图表。',
    '3. 如果你收到了 ```pivot-echart 代码块，请在最终回答中原样保留该代码块——前端会自动将其渲染为交互式可视化图表，不要将其转换为纯文本或其他格式。',
    '4. 如果你收到了 ```pivot-table 代码块，请在最终回答中原样保留。'
].join('\n');
function serializeChartSpec(chartSpec) {
    try {
        const serialized = JSON.stringify(chartSpec);
        return serialized && serialized !== 'null' ? serialized : '';
    } catch (_err) {
        return '';
    }
}

function chartSpecToMarkdown(chartSpec) {
    const serialized = serializeChartSpec(chartSpec);
    if (!serialized) return '';
    return [
        '```pivot-echart',
        JSON.stringify(chartSpec, null, 2),
        '```'
    ].join('\n');
}

function contentIncludesRenderableChart(content = '') {
    return /```(?:pivot-echart|pivot-chart)\b/i.test(String(content || ''));
}

function appendStreamedChartsToAssistantContent(content = '', chartSpecs = []) {
    const baseContent = String(content || '').trimEnd();
    if (!Array.isArray(chartSpecs) || chartSpecs.length === 0 || contentIncludesRenderableChart(baseContent)) {
        return String(content || '');
    }

    const seen = new Set();
    const blocks = [];
    chartSpecs.forEach(chartSpec => {
        const key = serializeChartSpec(chartSpec);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const block = chartSpecToMarkdown(chartSpec);
        if (block) blocks.push(block);
    });
    if (!blocks.length) return String(content || '');
    return [baseContent, ...blocks].filter(Boolean).join('\n\n');
}

function estimateVisibleAnswerTokensForSpeed(content = '') {
    return estimateTokens(stripVisibleReasoningScaffold(stripThoughtContent(String(content || ''))));
}

function buildAssistantSpeedStats({
    assistantContent = '',
    streamedChartSpecs = [],
    apiUsage = null,
    requestStartedAt = Date.now(),
    endedAt = Date.now()
} = {}) {
    const finalContent = appendStreamedChartsToAssistantContent(assistantContent, streamedChartSpecs);
    const estimatedAssistantTokens = estimateTokens(finalContent);
    const apiCompletionTokens = Number(apiUsage?.completion_tokens || 0);
    const assistantTokens = apiCompletionTokens > 0
        ? Math.max(apiCompletionTokens, estimatedAssistantTokens)
        : estimatedAssistantTokens;
    const costTime = Math.max((endedAt - requestStartedAt) / 1000, 0.001);
    const answerTokens = estimateVisibleAnswerTokensForSpeed(finalContent);
    // t/s 使用完整输出 token 与完整请求耗时，避免把思考 token 或思考耗时排除后造成速率虚高。
    const tokensPerSec = assistantTokens > 0 ? assistantTokens / costTime : 0;
    return {
        assistantContent: finalContent,
        assistantTokens,
        answerTokens,
        costTime,
        tokensPerSec
    };
}

function createChartSseCapture(writeRaw) {
    const streamedChartSpecs = [];
    const streamedChartSpecKeys = new Set();

    const writeSse = (payload) => {
        let data = null;
        try {
            data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        } catch (_err) {
            data = null;
        }

        if (data && data.type === 'chart') {
            const key = serializeChartSpec(data.data);
            if (key && !streamedChartSpecKeys.has(key)) {
                streamedChartSpecKeys.add(key);
                streamedChartSpecs.push(data.data);
            }
            return false;
        }

        if (typeof writeRaw === 'function') writeRaw(payload);
        return true;
    };

    return { streamedChartSpecs, writeSse };
}

function applyChatLanguageInstruction(history = []) {
    const messages = Array.isArray(history) ? history.slice() : [];
    const first = messages[0];
    if (first?.role === 'system' && typeof first.content === 'string') {
        if (first.content.includes('【重要语言规则】') || first.content.includes('reasoning_content')) return messages;
        return [
            { ...first, content: `${first.content.trim()}\n\n${CHAT_LANGUAGE_SYSTEM_PROMPT}`.trim() },
            ...messages.slice(1)
        ];
    }
    return [
        { role: 'system', content: CHAT_LANGUAGE_SYSTEM_PROMPT },
        ...messages
    ];
}

const NO_THINK_DIRECTIVE = '/no_think';

function appendNoThinkDirective(text) {
    const source = String(text ?? '');
    if (/\/no_think\s*$/i.test(source.trimEnd())) return source;
    const trimmed = source.trimEnd();
    return trimmed ? `${trimmed}\n${NO_THINK_DIRECTIVE}` : NO_THINK_DIRECTIVE;
}

function appendNoThinkToContent(content) {
    if (typeof content === 'string') return appendNoThinkDirective(content);
    if (!Array.isArray(content)) return content;

    let applied = false;
    const nextContent = content.map(part => {
        if (applied) return part;
        if (typeof part === 'string') {
            applied = true;
            return appendNoThinkDirective(part);
        }
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
            applied = true;
            return { ...part, text: appendNoThinkDirective(part.text) };
        }
        return part;
    });

    if (!applied) nextContent.push({ type: 'text', text: NO_THINK_DIRECTIVE });
    return nextContent;
}

function applyChatNoThinkSoftSwitch(history = [], modelCfg = {}) {
    const messages = Array.isArray(history) ? history : [];
    if (!shouldDisableChatThinking(modelCfg)) return messages;

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') {
            lastUserIndex = i;
            break;
        }
    }
    if (lastUserIndex < 0) return messages;

    return messages.map((message, index) => {
        if (index !== lastUserIndex) return message;
        return { ...message, content: appendNoThinkToContent(message.content) };
    });
}

function hasRagScopeFilter(scope = {}) {
    if (!scope || typeof scope !== 'object') return false;
    const hasCollection = Array.isArray(scope.collectionIds)
        ? scope.collectionIds.some(Boolean)
        : Boolean(scope.collectionId);
    const hasTag = Array.isArray(scope.tagNames)
        ? scope.tagNames.some(Boolean)
        : Boolean(scope.tagName || scope.tag);
    return hasCollection || hasTag;
}


module.exports = {
    serializeChartSpec,
    chartSpecToMarkdown,
    contentIncludesRenderableChart,
    appendStreamedChartsToAssistantContent,
    estimateVisibleAnswerTokensForSpeed,
    buildAssistantSpeedStats,
    createChartSseCapture,
    applyChatLanguageInstruction,
    appendNoThinkDirective,
    appendNoThinkToContent,
    applyChatNoThinkSoftSwitch,
    hasRagScopeFilter
};
