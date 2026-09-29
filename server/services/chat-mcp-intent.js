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
        const wantsChart = /图表|画图|绘图|可视化|趋势图|折线图|柱状图|饼图|面积图|chart|visuali[sz]e|plot|graph|数据分布|数据可视化|echarts?/i.test(prompt);
        const wantsReport = /报告|报表|周报|月报|日报|汇总成文档|分析报告|report/i.test(prompt);
        return { wantsChart, wantsReport };
    }

    // 聊天中的“工具”既可能是实际执行意图，也可能只是让模型讲解、写示例或
    // 生成普通文本。只有前者才应该中断本轮回答来请求 MCP 授权；否则用户会被
    // 迫使在“允许并继续/直接回答”间作一次没有意义的选择。
    function isInstructionalOrCodeRequest(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase().trim();
        if (!prompt) return false;
        const capabilityTopic = /(?:\bsql\b|代码|语句|脚本|\bapi\b|接口|webhook|\bmcp\b|工具库|能力库|工具调用|数据库表?|数据表)/i;
        if (!capabilityTopic.test(prompt)) return false;
        const instructional = /(?:什么是|是什么|介绍|说明|帮助|如何|怎么|为什么|区别|原理|教程|示例|样例|演示|语法|模板|优化|调试|学习|设计)/i;
        const asksForCode = /(?:写|编写|生成|提供|给我).{0,36}(?:代码|语句|脚本|demo|javascript|typescript|python|java|\bsql\b)/i;
        // “生成柱状图”“生成报告”也会含“生成”，但它们不一定是代码示例。
        // 将创作类动词限制为明确的代码载体，避免压制真实数据查询和图表请求。
        if (!instructional.test(prompt) && !asksForCode.test(prompt)) return false;
        // “请执行/调用 API 并返回结果”仍是可执行操作；但“如何调用 API”
        // 这类问法只是教学，不能因为含有“调用”二字就弹出授权。
        const explicitExecution = /(?:请|帮我|现在|直接|给我).{0,12}(?:执行|运行|调用|访问|读取|查询|发送|提交).{0,36}(?:数据库|数据表|\bapi\b|接口|webhook|工具|\bmcp\b|网址|网页)/i;
        const requestsExample = /(?:示例|样例|演示|教程|语法|原理|代码片段|code\s*sample)/i.test(prompt);
        return !explicitExecution.test(prompt) || requestsExample;
    }

    function requiresDocumentArtifact(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase();
        return /(?:导出|下载|保存|创建|生成|输出|制作).{0,24}(?:\.docx\b|\.pdf\b|\.xlsx?\b|文件|附件|文档)/i.test(prompt)
            || /(?:使用|套用).{0,24}(?:报告|文档)?模板/i.test(prompt);
    }

    function requiresExternalChartRendering(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase();
        const wantsChart = /图表|画图|绘图|可视化|趋势图|折线图|柱状图|饼图|面积图|chart|visuali[sz]e|plot|graph|echarts?/i.test(prompt);
        if (!wantsChart) return false;
        const requestsArtifact = /(?:交互式|可下载|导出|渲染|嵌入|发布|仪表盘|echarts?)/i.test(prompt);
        const externalSource = /(?:数据库|数据表|查询结果|接口|\bapi\b|本机文件|报表目录|上传文件|实时数据)/i.test(prompt);
        return requestsArtifact || externalSource;
    }

    function requiresExternalOperation(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase();
        // 侧效操作必须具备外部目标，避免把“写一封通知”“创建一个方案”之类
        // 纯文本创作误送进工具授权。
        return /(?:发送|通知|提交|发布|更新|写入|删除|创建|修改|审批).{0,48}(?:给|至|到|系统|平台|接口|webhook|邮箱|邮件|短信|群(?:聊)?|人员|客户|订单|记录|数据库)/i.test(prompt);
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
        // 如果是 Markdown 表格生成、排版、对比、填写或写作请求，直接排除
        if (/对比|优缺点|填写|怎么填|格式|样式|排版|markdown|制作表格|画表|制表|生成表格|以表格形式|表格形式|表格展示|总结.*表格/i.test(prompt)) {
            return false;
        }
        const asksInventory = /查询|查找|列出|读取|扫描|看看|查看|有哪些|所有|全部|清单|列表|list|show/.test(prompt);
        const mentionsLocal = /本机|我的电脑|本地|授权目录|报表目录|当前目录|目录下|文件夹下|磁盘|local/.test(prompt);
        const mentionsFileTypes = /\.xlsx?|\.xls|\.csv|\.json|\.pdf|excel文件|报表文件|表格文件|数据文件/i.test(prompt);
        const mentionsFiles = /文件|目录|文件夹|folder|directory|files?/i.test(prompt);
        return asksInventory && (
            (mentionsLocal && (mentionsFiles || /报表|台账/.test(prompt))) ||
            mentionsFileTypes
        );
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
        if (isInstructionalOrCodeRequest(prompt)) return false;
        // 排除常见写作生成 SQL 语句或教学示例请求
        if (/^(?:请(?:帮我)?)?(?:写|编写|生成|起草|提供|润色|解释|优化).*(?:sql|代码|语句|脚本|demo)[片段示例演示]*$/i.test(prompt.trim())) {
            return false;
        }
        // 排除中文里包含“表”的常见非数据库表词汇（如代表、表现、表达、外表、一览表、课程表、时间表等）
        const nonDbTableExclude = /(?:代表|表现|表达|外表|列表|图表|发表|表格|课程表|时间表|时刻表|作息表|周期表|一览表|对比表)/;
        const hasSqlKeywords = /\b(?:select\s+[\w.*,\s]+\s+from|from\s+[`"']?[a-zA-Z0-9_]{2,}[`"']?|group\s+by|order\s+by|show\s+tables|describe\s+[`"']?\w+[`"']?)\b/i.test(prompt);
        const hasDbTableRef = /(?:数据表|数据库表|系统表|业务表|库表)\s*[`"']?[\w.]*|数据库\s*[`"']?[\w.]*[`"']?\s*(?:中|里|的)?\s*(?:数据|表|查询)|\b[a-zA-Z0-9_]{2,}\s*表\b/i.test(prompt);
        const hasQueryTable = /(?:查询|查找|统计|从)\s*[`"']?([a-zA-Z0-9_]{2,})[`"']?\s*表(?:\s*(?:中|里|数据))?/i.test(prompt);
        const hasTableRef = hasSqlKeywords || hasDbTableRef || (hasQueryTable && !nonDbTableExclude.test(prompt));

        const hasDataOperation = /(?:查询|查找|统计|分组|计数|汇总|列出|读取|获取|筛选|导出|下载|查看|\bquery\b|\bfind\b|\blist\b|\bread\b|\bfetch\b|\bfilter\b|\bexport\b|\bdownload\b)/i.test(prompt);
        const hasAggregation = /(?:统计|分组|数量|计数|汇总|count|group|sum|avg)/i.test(prompt);
        const hasColumn = /(?:表字段|数据字段|字段|column)\s*[:：`"']?[\w]+|按照\s*[`"']?[\w]+[`"']?\s*(?:字段|列)\s*(?:分组|统计)|根据\s*[`"']?[\w]+[`"']?\s*(?:字段|列)\s*(?:分组|统计)/i.test(prompt);
        // 未提及“数据库/表”的自然语言查询也可能是在要实时业务数据；但必须
        // 有足够具体的业务对象，避免把“统计一下有哪些问题”之类的写作请求
        // 误认为数据工具调用。
        const hasConcreteBusinessDataTarget = /(?:订单|客户|用户|销售(?:额|量)?|库存|余额|账单|账款|发票|员工|考勤|工单|交易|日志|记录|明细|指标|数据|\borders?\b|\bcustomers?\b|\bsales\b|\binventory\b|\bbalance\b|\binvoices?\b|\bemployees?\b|\battendance\b|\btickets?\b|\btransactions?\b|\brecords?\b|\bmetrics?\b|\bdata\b)/i.test(prompt);
        // 单纯解释“数据库表是什么”、编写 SQL 示例等不需要真实数据访问；只有
        // 明确要求读、查、列、统计实际数据或结构时才触发授权与工具执行。
        return detectTableInventoryIntent(userPrompt)
            || (hasTableRef && (hasDataOperation || hasAggregation || hasColumn))
            || (hasDataOperation && hasConcreteBusinessDataTarget)
            || (hasAggregation && hasColumn && /数据库|数据表|表\b/i.test(prompt));
    }

    function detectExplicitMcpCapabilityIntent(userPrompt = '') {
        const prompt = String(userPrompt || '').toLowerCase();
        if (isInstructionalOrCodeRequest(prompt)) return false;
        if (/^(?:请(?:帮我)?)?(?:写|编写|生成|起草|提供|润色|解释|优化).*(?:sql|代码|语句|脚本|demo)[片段示例演示]*$/i.test(prompt.trim())) {
            return false;
        }
        if (/^(?:请(?:帮我)?)?(?:写|撰写|起草|润色|修改|翻译|总结|列出|对比)(?:一篇|一份|一个|下|一下)?(?:关于|有关)?[^，。；\n]{0,25}(?:报告|周报|月报|总结|方案|文档|文章|表格|材料|提纲|要点|建议)/i.test(prompt)
            && !/数据库|数据表|sql\b|mcp|工具|本地文件|报表目录|本机|折线图|柱状图|饼图|图表/i.test(prompt)) {
            return false;
        }
        const wantsDataOperation = /查询|查找|统计|计数|列出|读取|筛选|调用|请求|执行|运行|获取|发送|提交|访问|select\s|show\s|describe\s|count\s|\bquery\b|\bfind\b|\blist\b|\bread\b|\bfetch\b|\bcall\b|\bexecute\b|\brun\b|\bvisit\b/i.test(prompt)
            && /数据库|数据表|数据库表|sql\b|集合|collections?|api|接口|webhook/i.test(prompt);
        const explicitToolExecution = /(?:调用|执行|运行|使用).{0,18}(?:工具|工具库|能力库|\bmcp\b)|\b(?:use|call|execute|run)\b.{0,24}\b(?:tool|tools|mcp)\b/i.test(prompt);
        return detectStrongDataQueryIntent(userPrompt)
            || detectReportFileInventoryIntent(userPrompt)
            || requiresExternalChartRendering(userPrompt)
            || requiresDocumentArtifact(userPrompt)
            || requiresExternalOperation(userPrompt)
            || wantsDataOperation
            || detectBrowserVisitIntent(userPrompt)
            || explicitToolExecution;
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
        isInstructionalOrCodeRequest,
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
