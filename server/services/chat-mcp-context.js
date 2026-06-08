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

const MCP_CHAT_TOOL_TITLES = {
    'db.list_tables': '列出数据表',
    'db.count_tables': '统计数据表数量',
    'db.describe_table': '查看表结构',
    'db.run_readonly_query': '执行只读 SQL',
    'db.group_count': '分组统计',
    'db.list_collections': '列出集合',
    'db.count_collections': '统计集合数量',
    'db.sample_collection': '读取集合样本',
    'db.aggregate': '执行聚合分析',
    'reports.list_files': '查找报表文件',
    'reports.read_file_summary': '读取报表摘要',
    'reports.query_table': '查询表格数据',
    'reports.compare_files': '对比数据文件',
    'viz.build_chart': '生成图表',
    'viz.build_table': '整理表格',
    'report.compose': '编排报告',
    'report.validate_template': '校验报告模板',
    'doc.extract_outline': '提取文档大纲',
    'doc.extract_key_values': '提取关键信息',
    'doc.chunk_text': '切分文档文本',
    'data.profile_rows': '分析表格字段',
    'data.filter_rows': '筛选表格行',
    'data.group_summary': '分组汇总数据',
    'data.normalize_fields': '标准化字段',
    'format.to_markdown_table': '转换 Markdown 表格',
    'format.to_json': '转换 JSON',
    'format.extract_json': '提取 JSON',
    'format.normalize_text': '规范化文本',
    'im.list_allowed_targets': '查看通知目标',
    'im.send_user_message': '发送用户消息',
    'im.send_group_message': '发送群组消息',
    'im.send_markdown': '发送 Markdown 消息'
};

function compactText(value, maxLength = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...内容已截断...` : text;
}

function normalizeMcpToolShortName(tool) {
    const raw = String(tool?.name || tool?.toolName || tool?.fullName || tool || '').trim();
    const match = raw.match(/^mcp\.\d+\.(.+)$/);
    return match ? match[1] : raw;
}

function getMcpActionName(tool) {
    const shortName = normalizeMcpToolShortName(tool);
    const readableName = shortName.split('.').pop().replace(/[_-]+/g, ' ').trim();
    return MCP_CHAT_TOOL_TITLES[shortName] || cleanCapabilityDisplayName(tool?.title || '') || readableName || '能力动作';
}

function buildMcpTracePayload(tool) {
    const toolName = normalizeMcpToolShortName(tool);
    return {
        tool: tool?.fullName || tool?.name || toolName,
        toolFullName: tool?.fullName || '',
        toolName,
        actionName: getMcpActionName(tool),
        serverName: cleanCapabilityDisplayName(tool?.serverName || '')
    };
}

function buildMcpTraceMessage(actionName, serverName, fallback = '能力服务', prefix = '正在使用能力库') {
    const service = cleanCapabilityDisplayName(serverName || fallback) || fallback;
    return `${prefix}：${service} / ${actionName || '能力动作'}`;
}

function getMcpToolIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    const wantsChart = /图表|画图|绘图|可视化|趋势图|折线图|柱状图|饼图|面积图|chart|visuali[sz]e|plot|graph|统计分析|数据对比|数据汇总|数据概览|分布情况|数据分布|占比|排名|排行|展示.*数据|数据.*展示|呈现.*数据|查询.*统计|洞察/.test(prompt);
    const wantsReport = /报告|报表|周报|月报|日报|汇总成文档|分析报告|report/.test(prompt);
    return { wantsChart, wantsReport };
}

function detectTableInventoryIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    const mentionsTable = /数据表|数据库表|表清单|表列表|所有表|全部表|表数量|表的数量|多少张表|几张表|几(\s*)个表|list\s+tables|show\s+tables|\btables?\b/.test(prompt);
    const mentionsCollection = /集合|collections?/i.test(prompt);
    const asksInventory = /数量|个数|多少|几张|几个|列出|有哪些|所有|全部|清单|列表|list|show/.test(prompt);
    return (mentionsTable || mentionsCollection) && asksInventory;
}

function detectCollectionInventoryIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    return /集合|collections?/i.test(prompt);
}

function detectTableCountIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    return detectTableInventoryIntent(prompt) && /数量|个数|多少|几张|几个|count/.test(prompt);
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
    return detectTableInventoryIntent(userPrompt) || hasTableRef || (hasAggregation && hasColumn);
}

function detectExplicitMcpCapabilityIntent(userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    const intent = getMcpToolIntent(prompt);
    const wantsChartOutput = intent.wantsChart && /生成|画|绘|可视化|展示|呈现|创建|输出|做|build|create|make|plot|visuali[sz]e/.test(prompt);
    const wantsReportOutput = intent.wantsReport && /生成|写|出|汇总|导出|创建|输出|compose|build|create|make/.test(prompt);
    const wantsDataOperation = /查询|查找|统计|计数|列出|读取|筛选|分析|汇总|调用|请求|select\s|show\s|describe\s|count\s/i.test(prompt)
        && /数据库|数据表|数据库表|sql\b|集合|collections?|api|接口|webhook/.test(prompt);
    return detectStrongDataQueryIntent(userPrompt)
        || wantsChartOutput
        || wantsReportOutput
        || wantsDataOperation
        || /能力库|mcp|工具调用|调用工具/.test(prompt);
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

function extractSchemaName(userPrompt = '') {
    const prompt = String(userPrompt || '');
    const match = prompt.match(/(?:schema|模式|架构)\s*[：:]*\s*['`"]?([A-Za-z_][\w]*)/i);
    return match ? match[1] : '';
}

function buildFallbackListTablesInput(userPrompt = '') {
    const schema = extractSchemaName(userPrompt);
    return schema ? { schema } : {};
}

// 当规划器失败时，尝试为数据查询工具构造合理的 SQL
function buildFallbackDataQueryInput(userPrompt = '', tool) {
    const toolName = String(tool?.name || tool?.fullName || '');
    const table = extractTableName(userPrompt);
    if (!table && /list_tables|list_collections|count_tables|count_collections/i.test(toolName) && detectTableInventoryIntent(userPrompt)) {
        return buildFallbackListTablesInput(userPrompt);
    }
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

function toolMatchesPromptSource(tool, userPrompt = '') {
    const prompt = String(userPrompt || '').toLowerCase();
    if (!prompt) return false;
    const labels = [
        tool?.serverName,
        cleanCapabilityDisplayName(tool?.serverName || ''),
        String(tool?.serverName || '').replace(/\s+/g, ''),
        String(tool?.serverName || '').replace(/\s*MCP$/iu, '').replace(/\s+/g, '')
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    return labels.some(label => label.length >= 2 && prompt.includes(label));
}

function chooseToolForPrompt(tools, userPrompt, matcher) {
    const candidates = tools.filter(tool => matcher(String(tool.name || tool.fullName || '')));
    if (candidates.length <= 1) return candidates[0] || null;
    return candidates.find(tool => toolMatchesPromptSource(tool, userPrompt)) || candidates[0];
}

function resolvePlannerTool(toolName, tools, userPrompt = '') {
    const raw = String(toolName || '').trim();
    if (!raw) return null;
    const exact = tools.find(tool => tool.fullName === raw);
    if (exact) return exact;
    const matches = tools.filter(tool => tool.name === raw || String(tool.fullName || '').endsWith(`.${raw}`));
    if (matches.length <= 1) return matches[0] || null;
    return matches.find(tool => toolMatchesPromptSource(tool, userPrompt)) || null;
}

function buildDeterministicDataFallback(userPrompt = '', tools = []) {
    const table = extractTableName(userPrompt);
    if (!table && detectTableInventoryIntent(userPrompt)) {
        const collectionIntent = detectCollectionInventoryIntent(userPrompt);
        const countTool = detectTableCountIntent(userPrompt)
            ? chooseToolForPrompt(tools, userPrompt, name => collectionIntent ? /db\.count_collections/i.test(name) : /db\.count_tables/i.test(name))
            : null;
        const inventoryTool = countTool || chooseToolForPrompt(tools, userPrompt, name => collectionIntent ? /db\.list_collections/i.test(name) : /db\.list_tables/i.test(name));
        if (inventoryTool) {
            return {
                tool: inventoryTool,
                input: buildFallbackListTablesInput(userPrompt),
                reason: collectionIntent
                    ? (countTool ? '用户要求统计数据库集合数量' : '用户要求查询数据库集合清单')
                    : (countTool ? '用户要求统计数据库表数量' : '用户要求查询数据库表清单')
            };
        }
    }

    const groupTool = chooseToolForPrompt(tools, userPrompt, name => /group_count/i.test(name));
    const queryTool = chooseToolForPrompt(tools, userPrompt, name => /run_readonly_query|run_query/i.test(name));
    const dataTool = extractGroupByField(userPrompt) && groupTool ? groupTool : (queryTool || groupTool);
    if (!dataTool) return null;
    const input = buildFallbackDataQueryInput(userPrompt, dataTool);
    return input ? { tool: dataTool, input, reason: '用户明确要求查询数据库数据' } : null;
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
    const chartTrace = buildMcpTracePayload(chartTool);
    writeSse(JSON.stringify({
        type: 'mcp',
        status: 'running',
        ...chartTrace,
        serverName: chartTrace.serverName || '图表生成',
        message: buildMcpTraceMessage(chartTrace.actionName, chartTrace.serverName || '图表生成')
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

function buildMcpMissingToolHint(tools, reason = '') {
    const toolNames = tools.slice(0, 8).map(t => t.name || t.fullName || '').filter(Boolean);
    const availability = toolNames.length
        ? `当前可用工具：${toolNames.join('、')}。`
        : '当前没有可用的能力库工具缓存。';
    const note = reason ? `无法调用的原因：${reason}。` : '无法调用的原因：没有匹配用户请求的能力库工具。';
    return [
        '本轮用户请求需要能力库工具，但当前没有匹配的能力库工具，因此未实际调用。',
        availability,
        note,
        '请直接告诉用户当前缺少对应能力库工具，无法完成该类实时查询、数据库查询或外部能力调用；不要把未调用原因描述成用户请求不需要工具，也不要编造工具结果。'
    ].join('\n');
}

async function maybeBuildMcpChatContext({ modelCfg, history, userPrompt, tools, user, writeSse, log }) {
    const explicitToolIntent = detectExplicitMcpCapabilityIntent(userPrompt);
    if (!tools.length) {
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'empty',
            message: explicitToolIntent ? '没有可用的能力库工具，无法完成本轮能力调用' : '没有可用的能力库工具缓存'
        }));
        return explicitToolIntent ? buildMcpMissingToolHint([], '没有可用的能力库工具缓存') : '';
    }
    const intentTools = filterMcpToolsForChatIntent(tools, userPrompt);
    if (!intentTools.length) {
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'skipped',
            message: explicitToolIntent ? '没有匹配用户请求的能力库工具' : '本轮没有匹配用户意图的能力库工具'
        }));
        if (explicitToolIntent) {
            return buildMcpMissingToolHint(tools, '没有匹配用户请求的能力库工具');
        }
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
            writeSse(JSON.stringify({
                type: 'mcp',
                status: 'skipped',
                message: explicitToolIntent ? '没有适合本轮请求的能力库工具' : '本轮没有适合优先调用的能力库工具'
            }));
            return explicitToolIntent
                ? buildMcpMissingToolHint(intentTools, '工具过滤后没有适合本轮请求的工具')
                : buildMcpToolsHint(intentTools, '工具过滤后无匹配');
        }
        const plannerText = await callChatMcpPlanner(modelCfg, buildChatMcpPlannerMessages(history, userPrompt, plannerTools), user);
        const plan = parsePlannerJson(plannerText);
        const plannedTool = plan?.action === 'tool' ? resolvePlannerTool(plan.tool, plannerTools, userPrompt) : null;
        if (!plan || plan.action !== 'tool' || !plannedTool) {
            // 规划器返回 none 或解析失败——尝试确定性回退：用户明显要查数据时直接执行
            if (detectStrongDataQueryIntent(userPrompt)) {
                const fallback = buildDeterministicDataFallback(userPrompt, plannerTools);
                if (fallback) {
                    const dataTool = fallback.tool;
                    const fallbackInput = fallback.input;
                    const trace = buildMcpTracePayload(dataTool);
                    writeSse(JSON.stringify({
                        type: 'mcp',
                        status: 'running',
                        ...trace,
                        message: buildMcpTraceMessage(trace.actionName, trace.serverName, '能力服务', '已自动选择能力库动作')
                    }));
                    try {
                        const result = await executeMcpTool(dataTool.fullName, fallbackInput, user, { source: 'chat_fallback' });
                        let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
                        const chartText = await maybeBuildChartAfterDataTool({ selected: dataTool, result, intentTools, userPrompt, user, writeSse });
                        if (chartText) {
                            resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
                        }
                        writeSse(JSON.stringify({
                            type: 'mcp',
                            status: 'done',
                            ...trace,
                            message: buildMcpTraceMessage(trace.actionName, trace.serverName, '能力服务', '能力库动作已完成')
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
            if (explicitToolIntent) {
                writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '没有匹配用户请求的能力库工具，无法完成本轮能力调用' }));
                return buildMcpMissingToolHint(plannerTools, plan?.reason || '规划器未选择工具，且没有可确定执行的匹配工具');
            }
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮不需要调用能力库工具' }));
            // 注入可用工具提示，防止主模型自行生成代码
            return buildMcpToolsHint(plannerTools, plan?.reason || '规划器判断不需要调用');
        }

        const selected = plannedTool;
        const trace = buildMcpTracePayload(selected);
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'running',
            ...trace,
            message: buildMcpTraceMessage(trace.actionName, trace.serverName)
        }));
        const result = await executeMcpTool(selected.fullName, plan.input || {}, user, { source: 'chat' });
        let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
        const chartText = await maybeBuildChartAfterDataTool({ selected, result, intentTools, userPrompt, user, writeSse });
        if (chartText) {
            resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
        }
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'done',
            ...trace,
            message: buildMcpTraceMessage(trace.actionName, trace.serverName, '能力服务', '能力库动作已完成')
        }));
        return [
            '以下是本轮普通对话启用能力库后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
            '如果工具结果包含 ```pivot-echart 代码块，且用户需要图表，请在最终回答中原样保留该代码块，前端会自动渲染为可视化图表。',
            `工具: ${selected.fullName}`,
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
