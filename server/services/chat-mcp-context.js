const axios = require('axios');
const {
    buildModelHeaders,
    buildResponsesUrl,
    buildChatCompletionsUrl,
    convertChatMessagesToResponsesInput,
    shouldUseResponsesApi,
    assertSafeModelRuntimeUrl,
    createSafeModelHttpAgents
} = require('./model-adapter');
const { executeMcpTool } = require('./mcp-client');
const {
    cleanCapabilityDisplayName,
    extractModelText,
    extractRowsFromMcpResult,
    formatMcpToolsForPlanner,
    isDataResultMcpTool,
    parsePlannerJson
} = require('./chat-route-helpers');

function compactText(value, maxLength = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...内容已截断...` : text;
}

function getMcpToolIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    const wantsChart = /图表|画图|绘图|可视化|趋势图|折线图|柱状图|饼图|面积图|chart|visuali[sz]e|plot|graph/.test(prompt);
    const wantsReport = /报告|报表|周报|月报|日报|汇总成文档|分析报告|report/.test(prompt);
    return { wantsChart, wantsReport };
}

function filterMcpToolsForChatIntent(tools, userPrompt = '') {
    const intent = getMcpToolIntent(userPrompt);
    return tools.filter(tool => {
        const name = String(tool.name || tool.fullName || '');
        if (name.startsWith('viz.')) return intent.wantsChart || intent.wantsReport;
        if (name.startsWith('report.')) return intent.wantsReport;
        return true;
    });
}

function filterMcpToolsForPlanner(tools, userPrompt = '') {
    const intent = getMcpToolIntent(userPrompt);
    const hasDataResultTool = tools.some(isDataResultMcpTool);
    if (!intent.wantsChart || !hasDataResultTool) return tools;
    return tools.filter(tool => !String(tool.name || tool.fullName || '').startsWith('viz.'));
}

function inferChartInputFromRows(rows, userPrompt = '') {
    const columns = Array.from(rows.reduce((set, row) => {
        Object.keys(row || {}).forEach(key => set.add(key));
        return set;
    }, new Set()));
    if (!columns.length) return null;
    const prompt = String(userPrompt || '').toLowerCase();
    const numericColumns = columns.filter(col => rows.some(row => Number.isFinite(Number(row[col]))));
    const mentioned = columns.find(col => prompt.includes(String(col).toLowerCase()));
    const xAxis = mentioned || columns.find(col => !numericColumns.includes(col)) || columns[0];
    const yAxis = numericColumns.find(col => col !== xAxis && /(count|cnt|数量|人数|总数|total|sum|amount|value|num|avg|平均)/i.test(col))
        || numericColumns.find(col => col !== xAxis)
        || '';
    const chartType = /折线|趋势|line/.test(prompt)
        ? 'line'
        : /饼图|占比|比例|pie/.test(prompt)
            ? 'pie'
            : /面积|area/.test(prompt)
                ? 'area'
                : 'bar';
    const sortBy = /升序|降序|排序|order|sort/.test(prompt) ? 'label' : (chartType === 'line' ? 'label' : 'value');
    const sortOrder = /降序|desc/.test(prompt) ? 'desc' : /升序|asc/.test(prompt) ? 'asc' : (sortBy === 'label' ? 'asc' : 'desc');
    return {
        rows,
        chartType,
        title: xAxis && yAxis ? `${xAxis} 与 ${yAxis} 图表` : '查询结果图表',
        xAxis,
        yAxis,
        aggregation: yAxis ? 'sum' : 'count',
        sortBy,
        sortOrder,
        limit: 80
    };
}

function extractMcpResultText(result) {
    if (result?.structuredContent?.type === 'pivot_chart') {
        return [
            '能力库工具返回了可视化图表配置。回答用户时，如果需要展示图表，请原样输出下面的 fenced code block，语言必须保持为 pivot-echart：',
            '```pivot-echart',
            JSON.stringify(result.structuredContent, null, 2),
            '```'
        ].join('\n');
    }
    if (result?.structuredContent?.type === 'pivot_report' && result.structuredContent.markdown) {
        return result.structuredContent.markdown;
    }
    if (result?.structuredContent?.type === 'pivot_table' && result.structuredContent.markdown) {
        return result.structuredContent.markdown;
    }
    if (Array.isArray(result?.content)) {
        const text = result.content
            .map(item => item?.text || item?.content || '')
            .filter(Boolean)
            .join('\n');
        if (text) return text;
    }
    if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

async function maybeBuildChartAfterDataTool({ selected, result, intentTools, userPrompt, user, writeSse }) {
    const intent = getMcpToolIntent(userPrompt);
    if (!intent.wantsChart || String(selected?.name || '').startsWith('viz.')) return null;
    const rows = extractRowsFromMcpResult(result);
    if (!rows.length) return null;
    const chartTool = intentTools.find(tool => String(tool.name || '').startsWith('viz.build_chart'));
    if (!chartTool) return null;
    const chartInput = inferChartInputFromRows(rows, userPrompt);
    if (!chartInput) return null;
    writeSse(JSON.stringify({
        type: 'mcp',
        status: 'running',
        tool: chartTool.fullName,
        serverName: cleanCapabilityDisplayName(chartTool.serverName || '图表生成'),
        message: '正在根据查询结果生成图表'
    }));
    const chartResult = await executeMcpTool(chartTool.fullName, chartInput, user, { source: 'chat_auto_chart' });
    return compactText(extractMcpResultText(chartResult), 12000);
}

function buildChatMcpPlannerMessages(history, userPrompt, tools) {
    const recentMessages = history
        .filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
        .slice(-8)
        .map(message => ({ role: message.role, content: compactText(message.content, 1200) }));
    return [
        {
            role: 'system',
            content: [
                '你是 Pivot 普通对话里的能力库工具调度器。',
                '你只能返回严格 JSON，不要返回 Markdown、解释或多余文本。',
                'Schema: {"action":"none|tool","tool":"mcp.server.tool","input":{},"reason":"简短中文原因"}',
                '只有当用户问题明确需要访问已保存能力服务中的外部数据、数据库结构或数据库查询结果时，才选择 action=tool。',
                '不要主动扩展用户意图：用户只要求查询、列出、筛选或统计数据时，只能选择数据查询类工具，不要选择可视化、图表或报告工具。',
                '只有用户明确要求图表、画图、可视化、趋势图、柱状图、折线图、饼图等展示时，才可以选择 viz.* 工具。',
                '当用户同时要求查询数据库/报表并生成图表时，优先选择数据查询工具；系统会在查询结果返回后自动调用图表生成能力。',
                '只有用户明确要求生成报告、报表、周报、月报或固定格式文档时，才可以选择 report.* 工具。',
                '一轮最多选择一个工具。数据库查询必须保持只读，只生成 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等读取类输入。',
                '如果用户只是闲聊、写作、总结当前上下文或知识库足够回答，返回 {"action":"none","reason":"不需要能力库"}。',
                '可用能力库工具:',
                compactText(formatMcpToolsForPlanner(tools), 18000)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                '最近对话:',
                compactText(recentMessages, 6000),
                '',
                '用户本轮问题:',
                userPrompt
            ].join('\n')
        }
    ];
}

async function callChatMcpPlanner(modelCfg, messages, user = null) {
    const modelName = modelCfg.model_name || modelCfg.name || 'default';
    const headers = buildModelHeaders(modelCfg, { acceptJson: true });
    if (shouldUseResponsesApi(modelName)) {
        try {
            const targetUrl = buildResponsesUrl(modelCfg.url, { appendV1ForLocal: false });
            await assertSafeModelRuntimeUrl(modelCfg, targetUrl, user);
            const agents = createSafeModelHttpAgents(modelCfg, user);
            const response = await axios({
                method: 'post',
                url: targetUrl,
                headers,
                data: {
                    model: modelName,
                    input: convertChatMessagesToResponsesInput(messages),
                    stream: false,
                    temperature: 0,
                    max_output_tokens: 600
                },
                responseType: 'json',
                timeout: 120000,
                proxy: false,
                ...agents
            });
            return extractModelText(response.data);
        } catch (e) {
            if (![404, 405, 502, 503].includes(e.response?.status)) throw e;
        }
    }
    const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
    await assertSafeModelRuntimeUrl(modelCfg, targetUrl, user);
    const agents = createSafeModelHttpAgents(modelCfg, user);
    const response = await axios({
        method: 'post',
        url: targetUrl,
        headers,
        data: {
            model: modelName,
            messages,
            stream: false,
            temperature: 0,
            max_tokens: 600
        },
        responseType: 'json',
        timeout: 120000,
        proxy: false,
        ...agents
    });
    return extractModelText(response.data);
}

async function maybeBuildMcpChatContext({ modelCfg, history, userPrompt, tools, user, writeSse, log }) {
    if (!tools.length) {
        writeSse(JSON.stringify({ type: 'mcp', status: 'empty', message: '没有可用的能力库工具缓存' }));
        return '';
    }
    const intentTools = filterMcpToolsForChatIntent(tools, userPrompt);
    if (!intentTools.length) {
        writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮没有匹配用户意图的能力库工具' }));
        return '';
    }
    try {
        writeSse(JSON.stringify({ type: 'mcp', status: 'planning', message: '正在判断是否需要调用能力库工具' }));
        const plannerTools = filterMcpToolsForPlanner(intentTools, userPrompt);
        if (!plannerTools.length) {
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮没有适合优先调用的能力库工具' }));
            return '';
        }
        const plannerText = await callChatMcpPlanner(modelCfg, buildChatMcpPlannerMessages(history, userPrompt, plannerTools), user);
        const plan = parsePlannerJson(plannerText);
        const toolNames = new Set(plannerTools.map(tool => tool.fullName));
        if (!plan || plan.action !== 'tool' || !toolNames.has(plan.tool)) {
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮不需要调用能力库工具' }));
            return '';
        }

        const selected = plannerTools.find(tool => tool.fullName === plan.tool);
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'running',
            tool: plan.tool,
            serverName: cleanCapabilityDisplayName(selected?.serverName || ''),
            message: `正在调用能力库工具：${cleanCapabilityDisplayName(selected?.serverName || '能力服务')} / ${selected?.name || plan.tool}`
        }));
        const result = await executeMcpTool(plan.tool, plan.input || {}, user);
        let resultText = compactText(extractMcpResultText(result), 18000);
        const chartText = await maybeBuildChartAfterDataTool({ selected, result, intentTools, userPrompt, user, writeSse });
        if (chartText) {
            resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
        }
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'done',
            tool: plan.tool,
            message: '能力库工具调用完成，正在生成回答'
        }));
        return [
            '以下是本轮普通对话启用能力库后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
            '如果工具结果包含 ```pivot-echart 代码块，且用户需要图表，请在最终回答中原样保留该代码块，前端会自动渲染为可视化图表。',
            `工具: ${plan.tool}`,
            `调用原因: ${plan.reason || ''}`,
            '结果:',
            resultText
        ].join('\n');
    } catch (e) {
        log?.warn?.({ err: e.message }, '普通对话能力库调用失败');
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'error',
            message: `能力库工具调用失败：${e.message}`
        }));
        return `本轮尝试调用能力库工具失败：${e.message}`;
    }
}

module.exports = {
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    maybeBuildMcpChatContext
};
