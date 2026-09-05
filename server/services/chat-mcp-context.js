const {
    buildModelHeaders,
    buildResponsesUrl,
    buildChatCompletionsUrl,
    convertChatMessagesToResponsesInput,
    shouldUseResponsesApi
} = require('./model-adapter');
const { executeMcpTool } = require('./mcp-client');
const { getLocalBridgeStatus } = require('./local-device-bridge');
const {
    cleanCapabilityDisplayName,
    extractModelText,
    extractRowsFromMcpResult,
    formatMcpToolsForPlanner,
    isDataResultMcpTool,
    parsePlannerJson
} = require('./chat-route-helpers');
const { forwardChatCompletion } = require('./model-forwarder');
const { buildThinkingControlPayload } = require('./models');
const { buildToolExecutionPlan, summarizeToolExecutionPlan } = require('./agent-tool-execution-plan');
const { createMcpIntentHelpers } = require('./chat-mcp-intent');

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
    'im.send_markdown': '发送 Markdown 消息',
    'browser.open': '打开本机浏览器',
    'browser.inspect': '读取本机网页',
    'browser.click': '点击本机网页元素',
    'browser.screenshot': '截取本机网页'
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
    return MCP_CHAT_TOOL_TITLES[shortName] || cleanCapabilityDisplayName(tool?.title || '') || readableName || '工具';
}

function isLocalBrowserMcpTool(tool = {}) {
    const name = String(tool?.fullName || tool?.name || '');
    return tool?.localBrowserConnector === true || /^mcp\.0\.browser\.(?:open|inspect|click|screenshot)$/.test(name);
}

function detectBrowserVisitIntent(userPrompt = '') {
    const prompt = String(userPrompt || '');
    const hasUrl = /https?:\/\/[^\s，。；！？]+/i.test(prompt);
    const asksBrowser = /(?:打开|访问|进入|浏览)\s*https?:\/\/|(?:打开|访问|进入|浏览|查看|检查|登录|点击|截图).{0,24}(?:网页|网站|浏览器|页面|门户|后台)|(?:网页|网站|浏览器|页面|门户|后台).{0,24}(?:打开|访问|进入|浏览|查看|检查|登录|点击|截图)|\b(?:open|visit|browse|inspect|click|screenshot)\b/i.test(prompt);
    return hasUrl && asksBrowser;
}

/**
 * The generic "realtime web is unavailable" guard runs before normal chat
 * context assembly. An explicitly requested, authorized local-browser visit
 * is a different capability: Pivot does not search the web itself; it queues
 * a page-open task for the user's local, isolated browser. Let that task be
 * evaluated by the MCP connector instead of rejecting it as web search.
 */
function shouldDeferRealtimeCapabilityGuard(capability, { mcpEnabled = false, userPrompt = '' } = {}) {
    return Boolean(
        mcpEnabled
        && capability?.code === 'realtime_web'
        && detectBrowserVisitIntent(userPrompt)
    );
}

function extractBrowserUrl(userPrompt = '') {
    const match = String(userPrompt || '').match(/https?:\/\/[^\s，。；！？)\]}>"']+/i);
    return match ? String(match[0] || '').trim() : '';
}

function buildDeterministicBrowserFallback(userPrompt = '', tools = []) {
    if (!detectBrowserVisitIntent(userPrompt)) return null;
    const url = extractBrowserUrl(userPrompt);
    if (!url) return null;
    const prompt = String(userPrompt || '').toLowerCase();
    const action = /截图|screenshot/i.test(prompt) ? 'browser.screenshot' : /读取|检查|查看.*内容|inspect/i.test(prompt) ? 'browser.inspect' : 'browser.open';
    const tool = tools.find(item => normalizeMcpToolShortName(item) === action);
    return tool ? { tool, input: { url }, reason: '用户明确要求在已授权本机浏览器访问其提供的网址' } : null;
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

function buildMcpTraceMessage(actionName, serverName, fallback = '工具服务', prefix = '正在使用工具库') {
    const service = cleanCapabilityDisplayName(serverName || fallback) || fallback;
    return `${prefix}：${service} / ${actionName || '工具'}`;
}

async function executeChatMcpTool(tool, input, user, options = {}) {
    const executableTool = isLocalBrowserMcpTool(tool) ? { ...tool, source: 'mcp' } : tool;
    const allowLocalBrowser = options.allowLocalBrowser === true && isLocalBrowserMcpTool(executableTool);
    const plan = await buildToolExecutionPlan({
        run: {
            id: `chat:${user?.id || 'anonymous'}`,
            user_id: user?.id || null,
            goal: '聊天工具调用',
            tool_policy: 'all',
            approval_policy: 'safe_mcp_auto',
            network_policy: options.networkPolicy || {}
        },
        tool: executableTool,
        input,
        user,
        // 用户明确请求访问允许站点后，桌面端仍对打开/点击/截图执行本机确认；
        // 这里仅免除普通会话没有交互容器的服务端审批死锁。
        context: { autonomous: false, sandboxAvailable: options.sandboxAvailable !== false, allowApproval: allowLocalBrowser }
    });
    if (plan.policy.decision === 'denied') {
        const error = new Error(plan.policy.reasons.join('；') || '聊天工具调用被策略拒绝。');
        error.code = 'AGENT_POLICY_DENIED';
        error.plan = summarizeToolExecutionPlan(plan);
        throw error;
    }
    if (plan.approval.required) {
        const error = new Error('聊天工具调用需要人工审批。');
        error.code = 'AGENT_APPROVAL_REQUIRED';
        error.plan = summarizeToolExecutionPlan(plan);
        throw error;
    }
    if (plan.network.preflight === 'denied') {
        const error = new Error(plan.network.error?.message || '聊天工具网络预检被拒绝。');
        error.code = plan.network.error?.code || 'AGENT_NETWORK_POLICY_DENIED';
        error.plan = summarizeToolExecutionPlan(plan);
        throw error;
    }
    const result = await executeMcpTool(executableTool.fullName || executableTool.name, plan.input, user, {
        ...(options || {}),
        executionPlan: plan,
        source: options.source || 'chat'
    });
    return { result, plan };
}

const intentHelpers = createMcpIntentHelpers({
    cleanCapabilityDisplayName,
    detectBrowserVisitIntent,
    getLocalBridgeStatus,
    isDataResultMcpTool,
    isLocalBrowserMcpTool
});
const {
    buildDeterministicDataFallback,
    buildDeterministicReportFallback,
    buildFallbackDataQueryInput,
    detectExplicitMcpCapabilityIntent,
    detectReportFileInventoryIntent,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    getMcpToolIntent,
    localBridgeReportMissingReason,
    resolvePlannerTool
} = intentHelpers;

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
    const chartExecution = await executeChatMcpTool(chartTool, chartInput, user, { source: 'chat_auto_chart' });
    const chartResult = chartExecution.result;
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
                '你是 Pivot 普通对话里的工具库工具调度器。',
                '你只能返回严格 JSON，不要返回 Markdown、解释或多余文本。',
                'Schema: {"action":"none|tool","tool":"mcp.server.tool","input":{},"reason":"简短中文原因"}',
                '核心原则：只要用户的请求可以通过可用工具列表中的能力来完成，就必须选择 action=tool，不要返回 action=none。主模型无法自行查询数据库、访问外部数据或生成真正的交互式图表，你返回 none 会导致主模型编造数据或生成无效代码。',
                '数据查询类工具的使用门槛很低——用户只要提到了查数据、统计、分组、汇总、列出、筛选、分析数据库/表格内容，且存在 db.* 或 reports.query_* 等合适的工具，就应当选择。你不知道表结构或数据内容不是拒绝的理由——先用 SELECT * LIMIT 1 或 describe_table 探索，或根据用户描述的表名/字段名编写合理的 SQL 尝试执行。',
                '不要主动扩展用户意图：用户只要求查询、列出、筛选或统计数据时，只能选择数据查询类工具，不要选择可视化、图表或报告工具。',
                '只有用户明确要求图表、画图、可视化、趋势图、柱状图、折线图、饼图等展示时，才可以选择 viz.* 工具。',
                '当用户同时要求查询数据库/报表并生成图表时，优先选择数据查询工具；系统会在查询结果返回后自动调用图表生成能力。',
                '只有用户明确要求生成报告、报表、周报、月报或固定格式文档时，才可以选择 report.* 工具。',
                'mcp.0.browser.* 仅可在用户明确要求打开或访问其消息中给出的 http/https 网站时选择。必须使用 Schema 提供的 deviceId、browserId；不得猜测、扩展或替换 URL。',
                '一轮最多选择一个工具。数据库查询必须保持只读，只生成 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等读取类输入。',
                '仅当用户问题与任何可用工具都完全无关时（如闲聊、写作建议、纯知识问答），才返回 {"action":"none","reason":"不需要工具库"}。',
                '可用工具库工具:',
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

async function callChatMcpPlanner(modelCfg, messages, user = null, options = {}) {
    const modelName = modelCfg.model_name || modelCfg.name || 'default';
    const headers = buildModelHeaders(modelCfg, { acceptJson: true });
    if (shouldUseResponsesApi(modelName)) {
        try {
            const targetUrl = buildResponsesUrl(modelCfg.url, { appendV1ForLocal: false });
            const response = await forwardChatCompletion({
                modelCfg,
                user,
                url: targetUrl,
                headers,
                data: {
                    model: modelName,
                    input: convertChatMessagesToResponsesInput(messages),
                    stream: false,
                    temperature: 0,
                    max_output_tokens: 600,
                    ...buildThinkingControlPayload(modelCfg)
                },
                timeout: 120000,
                signal: options.signal || null
            });
            return extractModelText(response.data);
        } catch (e) {
            if (![404, 405, 502, 503].includes(e.response?.status)) throw e;
        }
    }
    const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
    const response = await forwardChatCompletion({
        modelCfg,
        user,
        url: targetUrl,
        headers,
        data: {
            model: modelName,
            messages,
            stream: false,
            temperature: 0,
            max_tokens: 600,
            // 工具调用决策要的是结构化判断，600 tokens 预算容不下思维链。
            ...buildThinkingControlPayload(modelCfg)
        },
        timeout: 120000,
        signal: options.signal || null
    });
    return extractModelText(response.data);
}

function buildMcpToolsHint(tools, reason = '') {
    const toolNames = tools.slice(0, 6).map(t => t.name || t.fullName || '').filter(Boolean);
    if (!toolNames.length) return '';
    const list = toolNames.join('、');
    const note = reason ? `未调用的原因：${reason}。` : '本轮未调用。';
    return [
        '以下是本轮可用的工具库工具（仅供了解，本轮未实际调用）：',
        `可用工具：${list}。`,
        note,
        '如果用户的问题涉及数据查询、统计分析或图表展示，请不要自行生成 Python/JavaScript 图表代码。你可以建议用户重新提问以触发工具调用，或在回答中说明需要开启哪些工具库服务。'
    ].join('\n');
}

function buildMcpMissingToolHint(tools, reason = '') {
    const toolNames = tools.slice(0, 8).map(t => t.name || t.fullName || '').filter(Boolean);
    const availability = toolNames.length
        ? `当前可用工具：${toolNames.join('、')}。`
        : '当前没有可用的工具库工具缓存。';
    const note = reason ? `无法调用的原因：${reason}。` : '无法调用的原因：没有匹配用户请求的工具库工具。';
    return [
        '本轮用户请求需要工具库工具，但当前没有匹配的工具库工具，因此未实际调用。',
        availability,
        note,
        '请直接告诉用户当前缺少对应工具库工具，无法完成该类实时查询、数据库查询或外部工具调用；不要把未调用原因描述成用户请求不需要工具，也不要编造工具结果。'
    ].join('\n');
}

function getAxiosStatusCode(error) {
    return Number(error?.response?.status || error?.statusCode || error?.status || 0) || 0;
}

function buildMcpFailureMessage(error, stage = 'planning') {
    const statusCode = getAxiosStatusCode(error);
    if (stage === 'planning') {
        if (statusCode === 429) return '工具规划模型暂时被限流，已跳过本轮工具调用，请稍后重试。';
        if (statusCode === 401 || statusCode === 403) return '工具规划模型鉴权失败，已跳过本轮工具调用，请检查当前聊天模型配置。';
        return '工具规划暂时失败，已跳过本轮工具调用。';
    }
    if (statusCode === 429) return '工具服务请求过多，本轮工具调用暂未完成，请稍后重试。';
    if (statusCode === 401 || statusCode === 403) return '工具服务鉴权失败，请检查工具库连接配置。';
    return '工具库工具调用失败，请稍后重试或检查工具库配置。';
}

function buildMcpToolResultContext(lines = []) {
    const body = Array.isArray(lines) ? lines : [String(lines || '')];
    return [
        'PIVOT_MCP_TOOL_RESULT_BEGIN',
        '【工具库结果：本轮最新事实】',
        '本轮已经通过 Pivot 工具库完成了授权工具调用。下面的“结果”是刚刚实时返回的内容，不是长期记忆、历史猜测或模型常识。',
        '回答用户时必须优先使用下面的工具结果；不得与工具结果相反地声称无法访问本机目录、数据库或工具资源。若结果不足，只说明结果不足。',
        ...body,
        'PIVOT_MCP_TOOL_RESULT_END'
    ].join('\n');
}
async function executeDeterministicMcpFallback({ fallback, intentTools, userPrompt, user, writeSse, log, logLabel = '回退工具调用失败', requireResult = false }) {
    if (!fallback?.tool) return null;
    const selectedTool = fallback.tool;
    const fallbackInput = fallback.input || {};
    const trace = buildMcpTracePayload(selectedTool);
    writeSse(JSON.stringify({
        type: 'mcp',
        status: 'running',
        ...trace,
        message: buildMcpTraceMessage(trace.actionName, trace.serverName, '工具服务', '已自动选择工具库工具')
    }));
    try {
        const execution = await executeChatMcpTool(selectedTool, fallbackInput, user, { source: 'chat_fallback', allowLocalBrowser: isLocalBrowserMcpTool(selectedTool) && detectBrowserVisitIntent(userPrompt) });
        const result = execution.result;
        let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
        const chartText = await maybeBuildChartAfterDataTool({ selected: selectedTool, result, intentTools, userPrompt, user, writeSse });
        if (chartText) {
            resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
        }
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'done',
            ...trace,
            message: buildMcpTraceMessage(trace.actionName, trace.serverName, '工具服务', '工具库工具已完成')
        }));
        return buildMcpToolResultContext([
            '以下是本轮普通对话启用工具库后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
            `工具: ${selectedTool.fullName}`,
            `调用原因: ${fallback.reason || ''}`,
            `输入: ${JSON.stringify(fallbackInput)}`,
            '结果:',
            resultText
        ]);
    } catch (fallbackErr) {
        log?.warn?.({ err: fallbackErr.message }, logLabel);
        if (requireResult) throw fallbackErr;
        return null;
    }
}
function buildMcpFailureHint(error, stage = 'planning') {
    const statusCode = getAxiosStatusCode(error);
    const statusText = statusCode ? `HTTP ${statusCode}` : '未知状态';
    if (stage === 'planning') {
        return [
            '本轮已开启工具库，但用于判断是否需要调用工具的模型请求失败，因此没有实际调用工具。',
            `失败原因：${statusText}。`,
            '请向用户说明工具规划暂时不可用，不要编造工具调用结果。'
        ].join('\n');
    }
    return [
        '本轮已开启工具库，但工具执行阶段失败，因此没有可用的工具结果。',
        `失败原因：${statusText}。`,
        '请向用户说明工具调用暂时不可用，不要编造工具调用结果。'
    ].join('\n');
}

async function maybeBuildMcpChatContext({ modelCfg, history, userPrompt, tools, user, writeSse, log, localMcpBridgeDebug = null, signal = null }) {
    const explicitToolIntent = detectExplicitMcpCapabilityIntent(userPrompt);
    if (!tools.length) {
        const reason = explicitToolIntent && detectReportFileInventoryIntent(userPrompt)
            ? localBridgeReportMissingReason(tools, user, userPrompt, localMcpBridgeDebug)
            : '';
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'empty',
            message: explicitToolIntent ? (reason || '没有可用的工具库工具，无法完成本轮工具调用') : '没有可用的工具库工具缓存',
            reason
        }));
        return explicitToolIntent ? buildMcpMissingToolHint([], reason || '没有可用的工具库工具缓存') : '';
    }
    const intentTools = filterMcpToolsForChatIntent(tools, userPrompt);
    if (!intentTools.length) {
        const reason = explicitToolIntent && detectReportFileInventoryIntent(userPrompt)
            ? localBridgeReportMissingReason(tools, user, userPrompt, localMcpBridgeDebug)
            : '';
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'skipped',
            message: explicitToolIntent
                ? (reason || '没有匹配用户请求的工具库工具')
                : '本轮没有匹配用户意图的工具库工具',
            reason
        }));
        if (explicitToolIntent) {
            return buildMcpMissingToolHint(tools, reason || '没有匹配用户请求的工具库工具');
        }
        // 注入可用工具提示，防止主模型自行生成代码
        const dataTools = tools.filter(isDataResultMcpTool);
        if (dataTools.length) {
            return buildMcpToolsHint(dataTools, '用户未明确要求图表或报告');
        }
        return '';
    }
    let mcpStage = 'planning';
    try {
        writeSse(JSON.stringify({ type: 'mcp', status: 'planning', message: '正在判断是否需要调用工具库工具' }));
        const plannerTools = filterMcpToolsForPlanner(intentTools, userPrompt);
        if (!plannerTools.length) {
            const reason = explicitToolIntent && detectReportFileInventoryIntent(userPrompt)
                ? localBridgeReportMissingReason(tools, user, userPrompt, localMcpBridgeDebug)
                : '';
            writeSse(JSON.stringify({
                type: 'mcp',
                status: 'skipped',
                message: explicitToolIntent
                    ? (reason || '没有适合本轮请求的工具库工具')
                    : '本轮没有适合优先调用的工具库工具',
                reason
            }));
            return explicitToolIntent
                ? buildMcpMissingToolHint(intentTools, reason || '工具过滤后没有适合本轮请求的工具')
                : buildMcpToolsHint(intentTools, '工具过滤后无匹配');
        }
        mcpStage = 'planning';
        const earlyBrowserFallback = buildDeterministicBrowserFallback(userPrompt, plannerTools);
        if (earlyBrowserFallback) {
            mcpStage = 'execution';
            const context = await executeDeterministicMcpFallback({
                fallback: earlyBrowserFallback,
                intentTools,
                userPrompt,
                user,
                writeSse,
                log,
                logLabel: '本机浏览器访问失败',
                requireResult: true
            });
            if (context) return context;
            mcpStage = 'planning';
        }
        const earlyReportFallback = buildDeterministicReportFallback(userPrompt, plannerTools);
        if (earlyReportFallback) {
            mcpStage = 'execution';
            const context = await executeDeterministicMcpFallback({
                fallback: earlyReportFallback,
                intentTools,
                userPrompt,
                user,
                writeSse,
                log,
                logLabel: '回退报表目录查询失败',
                requireResult: true
            });
            if (context) return context;
            mcpStage = 'planning';
        }
        const plannerText = await callChatMcpPlanner(modelCfg, buildChatMcpPlannerMessages(history, userPrompt, plannerTools), user, { signal });
        const plan = parsePlannerJson(plannerText);
        const plannedTool = plan?.action === 'tool' ? resolvePlannerTool(plan.tool, plannerTools, userPrompt) : null;
        if (!plan || plan.action !== 'tool' || !plannedTool) {
            // 规划器返回 none 或解析失败时，先尝试确定性回退，避免模型把可查询数据误判成普通问答。
            const reportFallback = buildDeterministicReportFallback(userPrompt, plannerTools);
            if (reportFallback) {
                mcpStage = 'execution';
                const context = await executeDeterministicMcpFallback({
                    fallback: reportFallback,
                    intentTools,
                    userPrompt,
                    user,
                    writeSse,
                    log,
                    logLabel: '回退报表目录查询失败'
                });
                if (context) return context;
            }
            if (detectStrongDataQueryIntent(userPrompt)) {
                const dataFallback = buildDeterministicDataFallback(userPrompt, plannerTools);
                if (dataFallback) {
                    mcpStage = 'execution';
                    const context = await executeDeterministicMcpFallback({
                        fallback: dataFallback,
                        intentTools,
                        userPrompt,
                        user,
                        writeSse,
                        log,
                        logLabel: '回退数据查询也失败'
                    });
                    if (context) return context;
                }
            }
            if (explicitToolIntent) {
                writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '没有匹配用户请求的工具库工具，无法完成本轮工具调用' }));
                return buildMcpMissingToolHint(plannerTools, plan?.reason || '规划器未选择工具，且没有可确定执行的匹配工具');
            }
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮不需要调用工具库工具' }));
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
        mcpStage = 'execution';
        const execution = await executeChatMcpTool(selected, plan.input || {}, user, { source: 'chat', allowLocalBrowser: isLocalBrowserMcpTool(selected) && detectBrowserVisitIntent(userPrompt) });
        const result = execution.result;
        let resultText = compactText(extractMcpResultText(result, writeSse), 18000);
        const chartText = await maybeBuildChartAfterDataTool({ selected, result, intentTools, userPrompt, user, writeSse });
        if (chartText) {
            resultText = `${resultText}\n\n附加图表结果：\n${chartText}`;
        }
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'done',
            ...trace,
            message: buildMcpTraceMessage(trace.actionName, trace.serverName, '工具服务', '工具库工具已完成')
        }));
        return buildMcpToolResultContext([
            '以下是本轮普通对话启用工具库后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
            '如果工具结果包含 ```pivot-echart 代码块，且用户需要图表，请在最终回答中原样保留该代码块，前端会自动渲染为可视化图表。',
            `工具: ${selected.fullName}`,
            `调用原因: ${plan.reason || ''}`,
            '结果:',
            resultText
        ]);
    } catch (e) {
        log?.warn?.({ err: e.message, statusCode: getAxiosStatusCode(e), stage: mcpStage }, '普通对话工具库调用失败');
        const message = buildMcpFailureMessage(e, mcpStage);
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'error',
            message
        }));
        return buildMcpFailureHint(e, mcpStage);
    }
}

module.exports = {
    MCP_CHAT_TOOL_TITLES,
    buildFallbackDataQueryInput,
    buildDeterministicBrowserFallback,
    detectBrowserVisitIntent,
    detectReportFileInventoryIntent,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    isLocalBrowserMcpTool,
    localBridgeReportMissingReason,
    filterMcpToolsForPlanner,
    shouldDeferRealtimeCapabilityGuard,
    maybeBuildMcpChatContext
};
