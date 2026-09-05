function createMcpIntentHelpers(deps = {}) {
    const {
        cleanCapabilityDisplayName,
        detectBrowserVisitIntent,
        getLocalBridgeStatus,
        isDataResultMcpTool,
        isLocalBrowserMcpTool
    } = deps;

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

    function detectReportFileInventoryIntent(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase();
        const asksInventory = /查询|查找|列出|读取|扫描|看看|查看|有哪些|所有|全部|清单|列表|list|show/.test(prompt);
        const mentionsFiles = /文件|目录|文件夹|报表|表格|台账|清单|资料|材料|csv|xlsx?|xls|json|txt|md|folder|directory|files?/.test(prompt);
        const mentionsLocal = /本机|我的电脑|本地|授权目录|报表目录|当前目录|目录下|文件夹下|local/.test(prompt);
        return asksInventory && mentionsFiles && (mentionsLocal || /报表|表格|台账|csv|xlsx?|xls/.test(prompt));
    }

    function detectLocalReportFileInventoryIntent(userPrompt = '') {
        return detectReportFileInventoryIntent(userPrompt)
            && /本机|我的电脑|本地|授权目录|当前目录|local/.test(String(userPrompt || '').toLowerCase());
    }

    function extractReportListQuery(userPrompt = '') {
        const prompt = String(userPrompt || '').trim();
        const patterns = [
            /(?:查询|查找|列出|看看|查看|扫描)\s*(?:本机|本地|我的电脑|授权目录|报表目录)?\s*([^\s，。；、,.!?]+?)\s*(?:目录|文件夹)\s*(?:下|里|中)?/,
            /(?:本机|本地|我的电脑|授权目录|报表目录)?\s*([^\s，。；、,.!?]+?)\s*(?:目录|文件夹)\s*(?:下|里|中)?/,
            /(?:查询|查找|列出|看看|查看|扫描)\s*([^\s，。；、,.!?]+?)\s*(?:文件|报表)/,
            /名称?为\s*[“"']?([^\s，。；、,.!?"'”]+)[”"']?/
        ];
        for (const pattern of patterns) {
            const match = prompt.match(pattern);
            let value = match?.[1] ? String(match[1]).trim() : '';
            value = value.replace(/^(?:查询|查找|列出|看看|查看|扫描)?(?:本机|本地|我的电脑|授权目录|报表目录|授权)?/u, '').trim();
            if (value && !/本机|本地|我的电脑|授权|报表|文件|目录|文件夹|哪些|所有|全部/.test(value)) return value;
        }
        return '';
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
            || detectReportFileInventoryIntent(userPrompt)
            || wantsChartOutput
            || wantsReportOutput
            || wantsDataOperation
            || detectBrowserVisitIntent(userPrompt)
            || /工具库|能力库|mcp|工具调用|调用工具/.test(prompt);
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

    function preferLocalDeviceTool(tools = [], matcher = () => false) {
        const candidates = tools.filter(tool => matcher(String(tool.name || tool.fullName || '')));
        return candidates.find(tool => String(tool.fullName || '').startsWith('mcp.0.')) || candidates[0] || null;
    }

    function normalizeReportQueryToken(value = '') {
        return String(value || '')
            .trim()
            .replace(/[\/]+$/g, '')
            .replace(/^[\/]+/g, '')
            .toLowerCase();
    }

    function localReportGrantLabels(tool = {}) {
        const grant = tool?.localDevice?.grants?.local_report_dir || null;
        if (!grant || grant.authorized !== true) return [];
        const labels = [grant.label, grant.pathHint]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        const baseLabels = labels
            .map(value => value.split(/[\/]+/).filter(Boolean).pop() || '')
            .filter(Boolean);
        return Array.from(new Set([...labels, ...baseLabels].map(normalizeReportQueryToken).filter(Boolean)));
    }

    function shouldListAuthorizedReportRoot(tool, query = '') {
        const normalizedQuery = normalizeReportQueryToken(query);
        if (!normalizedQuery) return false;
        return localReportGrantLabels(tool).includes(normalizedQuery);
    }

    function buildDeterministicReportFallback(userPrompt = '', tools = []) {
        if (!detectReportFileInventoryIntent(userPrompt)) return null;
        const listTool = preferLocalDeviceTool(tools, name => /reports\.list_files/i.test(name));
        if (!listTool) return null;
        const query = extractReportListQuery(userPrompt);
        const listRoot = query && shouldListAuthorizedReportRoot(listTool, query);
        const input = query && !listRoot ? { query, limit: 80 } : { limit: 80 };
        return {
            tool: listTool,
            input,
            reason: query ? `用户要求查询本机目录或报表文件：${query}` : '用户要求查询本机目录或报表文件清单'
        };
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

    function toolNameMatches(tool, pattern) {
        return pattern.test(String(tool?.name || '')) || pattern.test(String(tool?.fullName || ''));
    }

    function filterReportFileInventoryTools(tools = [], userPrompt = '') {
        return tools.filter(tool => {
            if (!toolNameMatches(tool, /(?:^|\.)reports\.list_files$/i)) return false;
            return !detectLocalReportFileInventoryIntent(userPrompt) || String(tool.fullName || '').startsWith('mcp.0.');
        });
    }

    function localBridgeReportMissingReason(tools = [], user = null, userPrompt = '', localMcpBridgeDebug = null) {
        if (!detectLocalReportFileInventoryIntent(userPrompt)) {
            return '当前没有可用于列出报表目录文件的 reports.list_files 工具。';
        }
        const reportNames = tools
            .filter(tool => toolNameMatches(tool, /(?:^|\.)reports\./i))
            .map(tool => tool.fullName || tool.name)
            .filter(Boolean);
        if (reportNames.length) {
            return '本机报表目录工具存在，但 reports.list_files 没有进入本轮候选，请检查工具治理或工具名称。';
        }
        let status = null;
        try {
            status = getLocalBridgeStatus(user);
        } catch (_err) {
            status = null;
        }
        const devices = Array.isArray(status?.devices) ? status.devices : [];
        if (!devices.length) {
            const debug = localMcpBridgeDebug && typeof localMcpBridgeDebug === 'object' ? localMcpBridgeDebug : null;
            const reason = String(debug?.reason || '').trim();
            if (debug?.hasDesktopBridge === false) {
                return reason || '聊天页没有检测到桌面端桥；请确认当前页面是在 Pivot 桌面客户端中打开，而不是普通浏览器。';
            }
            if (debug?.hasStatusBridge === false) {
                return reason || '当前桌面客户端缺少本机授权状态接口；请重新打包或安装包含本机授权中心的新版本。';
            }
            if (debug?.hasExecuteBridge === false) {
                return reason || '当前桌面客户端缺少本机只读执行接口；请重新打包或安装包含本机执行器的新版本。';
            }
            if (debug?.status === 'authorization_unavailable') {
                return reason || '聊天页已检测到桌面端，但没有读到可用的本机授权；请重新授权本机文件目录后再发送。';
            }
            if (debug?.status === 'heartbeat_failed') {
                return `聊天页已检测到桌面端本机执行器，但心跳注册失败：${reason || '请检查登录状态和服务端接口。'}`;
            }
            if (debug?.statusAvailable === true && debug?.grants?.local_report_dir !== true) {
                return '聊天页已读取桌面端本机授权状态，但没有文件目录授权；请在“我的电脑/管理本机资源授权”里授权文件目录。';
            }
            return '没有收到桌面端本机执行器心跳；请确认使用桌面客户端打开、工具库已开启，并重新发送消息。';
        }
        const hasReportGrant = devices.some(device => device?.grants?.local_report_dir?.authorized === true);
        if (!hasReportGrant) {
            return '桌面端本机执行器在线，但本轮没有收到本机文件目录授权；请在“我的电脑/管理本机资源授权”里授权文件目录。';
        }
        return '已收到本机文件目录授权，但 mcp.0.reports.list_files 没有进入治理后的工具列表，请检查该工具是否被禁用。';
    }

    function filterMcpToolsForChatIntent(tools, userPrompt = '') {
        const browserIntent = detectBrowserVisitIntent(userPrompt);
        if (detectReportFileInventoryIntent(userPrompt)) {
            return filterReportFileInventoryTools(tools, userPrompt);
        }
        const intent = getMcpToolIntent(userPrompt);
        return tools.filter(tool => {
            const name = String(tool.name || tool.fullName || '');
            if (isLocalBrowserMcpTool(tool)) return browserIntent;
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

    return {
        buildDeterministicDataFallback,
        buildDeterministicReportFallback,
        buildFallbackDataQueryInput,
        buildFallbackListTablesInput,
        detectCollectionInventoryIntent,
        detectExplicitMcpCapabilityIntent,
        detectLocalReportFileInventoryIntent,
        detectReportFileInventoryIntent,
        detectStrongDataQueryIntent,
        detectTableCountIntent,
        detectTableInventoryIntent,
        extractGroupByField,
        extractReportListQuery,
        extractSchemaName,
        extractTableName,
        filterMcpToolsForChatIntent,
        filterMcpToolsForPlanner,
        filterReportFileInventoryTools,
        getMcpToolIntent,
        localBridgeReportMissingReason,
        preferLocalDeviceTool,
        resolvePlannerTool,
        shouldListAuthorizedReportRoot,
        toolMatchesPromptSource
    };
}

module.exports = { createMcpIntentHelpers };
