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
    const wantsChart = /图表|画图|绘图|可视化|趋势图|折线图|柱状图|饼图|面积图|chart|visuali[sz]e|plot|graph|统计分析|数据对比|数据汇总|数据概览|分布情况|数据分布|占比|排名|排行|展示.*数据|数据.*展示|呈现.*数据|查询.*统计|洞察/.test(prompt);
    const wantsReport = /报告|报表|周报|月报|日报|汇总成文档|分析报告|report/.test(prompt);
    return { wantsChart, wantsReport };
}

// 检测用户是否明确要求查询数据库（即使规划器返回 none 也应强行走数据工具）
function detectStrongDataQueryIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    // 明确提到了表名/数据库+表 或 SQL 关键词
    const hasTableRef = /[\w.]+\s*表|表\s*[\w.]+|table[_\s.]*[\w.]+|数据库\s*[\w.]+|查询.*表|从.*表|select\s|from\s+[\w.]+|group\s+by|order\s+by/i.test(prompt);
    // 明确要求统计/分组/数量
    const hasAggregation = /统计|分组|数量|计数|汇总|count|group|sum|avg/i.test(prompt);
    // 指定了具体的列/字段
    const hasColumn = /字段|列|column|按照|根据.*分组|根据.*统计/i.test(prompt);
    return hasTableRef || (hasAggregation && hasColumn);
}

// 从用户自然语言中尝试提取表名
function extractTableName(userPrompt = '') {
    const prompt = String(userPrompt || '');
    // 匹配 "xxx表" 或 "table_xxx" 或 "FROM xxx" 等模式
    const tableMatch = prompt.match(/数据表\s*[：:]*\s*['`"]?([A-Za-z_][\w.]*)/i) ||
                      prompt.match(/(?:table|from)\s*[：:]*\s*['`"]?([A-Za-z_][\w.]*)/i) ||
                      prompt.match(/['`"]?([A-Za-z_][\w.]*)['`"]?\s*(?:表|table)/i) ||
                      prompt.match(/(?:表)\s*[：:]*\s*['`"]?([A-Za-z_][\w.]*)/i);
    return tableMatch ? tableMatch[1] : null;
}

// 从用户自然语言中提取分组字段
function extractGroupByField(userPrompt = '') {
    const prompt = String(userPrompt || '');
    const groupMatch = prompt.match(/(?:按|根据|按照|分组|group\s+by)\s*[：:]*\s*['`"]?(\w+)/i) ||
        prompt.match(/([A-Za-z_][\w]*)\s*(?:的)?(?:名称|对应|数量|分布|占比)/i) ||
        prompt.match(/['`"]?(\w+)['`"]?\s*(?:分布|分组|统计)/i);
    return groupMatch ? groupMatch[1] : null;
}

// 当规划器失败时，尝试为数据查询工具构造合理的 SQL
function buildFallbackDataQueryInput(userPrompt = '', tool) {
    const toolName = String(tool?.name || tool?.fullName || '');
    const table = extractTableName(userPrompt);
    if (!table) return null;
    const groupBy = extractGroupByField(userPrompt);
    if (toolName.includes('group_count')) {
        if (!groupBy) return null;
        return {
            table,
            groupBy,
            groupAlias: groupBy,
            countAlias: 'count',
            limit: 80,
            sortOrder: 'desc'
        };
    }
    if (!toolName.includes('run_readonly_query') && !toolName.includes('run_query')) return null;
    if (groupBy) {
        return {
            sql: `SELECT ${groupBy}, COUNT(*) AS count FROM ${table} GROUP BY ${groupBy} ORDER BY count DESC`,
            limit: 80
        };
    }
    return {
        sql: `SELECT * FROM ${table}`,
        limit: 50
    };
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

function emitChartSse(writeSse, chartData) {
    if (!writeSse || !chartData) return;
    try {
        writeSse(JSON.stringify({ type: 'chart', data: chartData }));
    } catch (_) {
        // SSE 发射失败不影响主流程
    }
}

function extractMcpResultText(result, writeSse) {
    if (result?.structuredContent?.type === 'pivot_chart') {
        // 结构化图表数据直接通过 SSE 发给前端渲染，完全绕过模型文本生成
        emitChartSse(writeSse, result.structuredContent);
        // 只留简短文字引用给模型，避免模型自行生成代码替代图表
        const title = result.structuredContent.title || '查询结果图表';
        return `[已生成图表：${title}，前端已直接渲染，无需在回答中重复输出图表代码块。]`;
    }
    if (result?.structuredContent?.type === 'pivot_table') {
        // 表格走文本通道——markdown 表格模型能正确保留
        return result.structuredContent.markdown || JSON.stringify(result.structuredContent, null, 2);
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
    return compactText(extractMcpResultText(chartResult, writeSse), 12000);
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
                '核心原则：只要用户的请求可以通过可用工具列表中的能力来完成，就必须选择 action=tool，不要返回 action=none。主模型无法自行查询数据库、访问外部数据或生成真正的交互式图表，你返回 none 会导致主模型编造数据或生成无效代码。',
                '数据查询类工具的使用门槛很低——用户只要提到了查数据、统计、分组、汇总、列出、筛选、分析数据库/表格内容，且存在 db.* 或 reports.query_* 等合适的工具，就应当选择。你不知道表结构或数据内容不是拒绝的理由——先用 SELECT * LIMIT 1 或 describe_table 探索，或根据用户描述的表名/字段名编写合理的 SQL 尝试执行。',
                '不要主动扩展用户意图：用户只要求查询、列出、筛选或统计数据时，只能选择数据查询类工具，不要选择可视化、图表或报告工具。',
                '只有用户明确要求图表、画图、可视化、趋势图、柱状图、折线图、饼图等展示时，才可以选择 viz.* 工具。',
                '当用户同时要求查询数据库/报表并生成图表时，优先选择数据查询工具；系统会在查询结果返回后自动调用图表生成能力。',
                '只有用户明确要求生成报告、报表、周报、月报或固定格式文档时，才可以选择 report.* 工具。',
                '一轮最多选择一个工具。数据库查询必须保持只读，只生成 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等读取类输入。',
                '仅当用户问题与任何可用工具的能力都完全无关时（如闲聊、写作建议、纯知识问答），才返回 {"action":"none","reason":"不需要能力库"}。',
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

function buildMcpToolsHint(tools, reason = '') {
    const toolNames = tools.slice(0, 6).map(t => t.name || t.fullName || '').filter(Boolean);
    if (!toolNames.length) return '';
    const list = toolNames.join('、');
    const note = reason ? `未调用的原因：${reason}。` : '本轮未调用。';
    return [
        '以下是本轮可用的能力库工具（仅供了解，本轮未实际调用）：',
        `可用工具：${list}。`,
        note,
        '如果用户的问题涉及数据查询、统计分析或图表展示，请不要自行生成 Python/JavaScript 图表代码。你可以建议用户重新提问以触发工具调用，或在回答中说明需要开启哪些能力库服务。'
    ].join('\n');
}

async function maybeBuildMcpChatContext({ modelCfg, history, userPrompt, tools, user, writeSse, log }) {
    if (!tools.length) {
        writeSse(JSON.stringify({ type: 'mcp', status: 'empty', message: '没有可用的能力库工具缓存' }));
        return '';
    }
    const intentTools = filterMcpToolsForChatIntent(tools, userPrompt);
    if (!intentTools.length) {
        writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮没有匹配用户意图的能力库工具' }));
        // 注入可用工具提示，防止主模型自行生成代码
        const dataTools = tools.filter(isDataResultMcpTool);
        if (dataTools.length) {
            return buildMcpToolsHint(dataTools, '用户未明确要求图表或报告');
        }
        return '';
    }
    try {
        writeSse(JSON.stringify({ type: 'mcp', status: 'planning', message: '正在判断是否需要调用能力库工具' }));
        const plannerTools = filterMcpToolsForPlanner(intentTools, userPrompt);
        if (!plannerTools.length) {
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮没有适合优先调用的能力库工具' }));
            return buildMcpToolsHint(intentTools, '工具过滤后无匹配');
        }
        const plannerText = await callChatMcpPlanner(modelCfg, buildChatMcpPlannerMessages(history, userPrompt, plannerTools), user);
        const plan = parsePlannerJson(plannerText);
        const toolNames = new Set(plannerTools.map(tool => tool.fullName));
        if (!plan || plan.action !== 'tool' || !toolNames.has(plan.tool)) {
            // 规划器返回 none 或解析失败——尝试确定性回退：用户明显要查数据时直接执行
            if (detectStrongDataQueryIntent(userPrompt)) {
                const groupTool = plannerTools.find(t => /group_count/i.test(String(t.name || t.fullName || '')));
                const queryTool = plannerTools.find(t => /run_readonly_query|run_query/i.test(String(t.name || t.fullName || '')));
                const dataTool = extractGroupByField(userPrompt) && groupTool ? groupTool : (queryTool || groupTool);
                if (dataTool) {
                    const fallbackInput = buildFallbackDataQueryInput(userPrompt, dataTool);
                    if (fallbackInput) {
                        writeSse(JSON.stringify({
                            type: 'mcp',
                            status: 'running',
                            tool: dataTool.fullName,
                            serverName: cleanCapabilityDisplayName(dataTool.serverName || ''),
                            message: `规划器未选择工具，根据意图自动调用：${cleanCapabilityDisplayName(dataTool.serverName || '能力服务')} / ${dataTool.name || dataTool.fullName}`
                        }));
                        try {
                            const result = await executeMcpTool(dataTool.fullName, fallbackInput, user);
                            let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
                            const chartText = await maybeBuildChartAfterDataTool({ selected: dataTool, result, intentTools, userPrompt, user, writeSse });
                            if (chartText) {
                                resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
                            }
                            writeSse(JSON.stringify({
                                type: 'mcp',
                                status: 'done',
                                tool: dataTool.fullName,
                                message: '能力库工具调用完成，正在生成回答'
                            }));
                            return [
                                '以下是本轮普通对话启用能力库后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
                                `工具: ${dataTool.fullName}`,
                                `输入: ${JSON.stringify(fallbackInput)}`,
                                '结果:',
                                resultText
                            ].join('\n');
                        } catch (fallbackErr) {
                            // 回退执行也失败，降级到提示
                            log?.warn?.({ err: fallbackErr.message }, '回退数据查询也失败');
                        }
                    }
                }
            }
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮不需要调用能力库工具' }));
            // 注入可用工具提示，防止主模型自行生成代码
            return buildMcpToolsHint(plannerTools, plan?.reason || '规划器判断不需要调用');
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
        let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
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
    buildFallbackDataQueryInput,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    maybeBuildMcpChatContext
};
