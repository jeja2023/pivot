/* Agent DAG 工具栏工具元数据辅助函数（拆自 dag-toolbar.js） */
/* global agentToolTitle, agentToolDescription */

const TOOL_DISPLAY_OVERRIDES = {
        'agent.llm': ['大模型节点', '调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。'],
        'agent.content_review': ['富文本内容校对', '清洗数据库富文本记录，按模型上下文逐条分块校对，并生成完整报告。'],
        'agent.delegate': ['委派智能体', '调用一次独立模型运行具名专家，返回分析结果并自动附带交接信息；通常无需另接交接节点。'],
        'agent.handoff': ['智能体交接', '只整理已有结论、证据、风险和待决问题，不调用模型；用于统一交给下游智能体。'],
        'rag.search': ['知识库检索', '检索当前用户知识库，返回相关片段和来源。'],
        'sessions.search': ['会话检索', '按关键词检索当前用户历史会话。'],
        'sessions.recent': ['最近会话', '列出最近未删除会话。'],
        'knowledge.list': ['知识库文档', '查看知识库文档及索引状态。'],
        'models.list': ['可用模型', '列出当前用户可用模型。'],
        'system.health': ['系统健康检查', '查看数据库、存储、内存和磁盘健康状态。'],
        'system.modelRuntime': ['模型运行状态', '查看模型端点队列、熔断器和监控状态。'],
        'db.list_tables': ['列出数据表', '列出当前数据库中可查询的表和视图。'],
        'db.count_tables': ['统计数据表数量', '统计当前数据库中可查询的数据表和视图数量。'],
        'db.describe_table': ['查看表结构', '查看表字段、类型和可空性。'],
        'db.run_readonly_query': ['只读数据查询', '默认用可视化条件生成安全查询，也支持切换到高级查询。'],
        'db.group_count': ['分组统计', '按指定表字段分组并统计数量，用于快速生成分布图。'],
        'db.list_collections': ['列出集合', '列出文档数据库中的集合。'],
        'db.count_collections': ['统计集合数量', '统计文档数据库中的集合数量。'],
        'db.sample_collection': ['读取集合样本', '读取集合小样本，辅助理解字段结构。'],
        'db.aggregate': ['Mongo 聚合查询', '执行只读统计分析聚合管道。'],
        'reports.list_files': ['列出报表文件', '列出可访问的报表或数据文件。'],
        'reports.read_file_summary': ['读取报表摘要', '读取报表文件元数据、工作表和样本行。'],
        'reports.query_table': ['查询报表表格', '按列筛选逗号分隔文件或电子表格中的数据行。'],
        'reports.compare_files': ['对比报表文件', '对比两个报表文件的工作表、表头和样本行。'],
        'report.compose': ['组合报告', '将摘要、表格、图表和格式化片段组合成报告。'],
        'report.validate_template': ['校验报告模板', '在执行编排前验证报告模板结构。'],
        'viz.build_chart': ['生成图表', '基于表格行生成可渲染图表配置。'],
        'viz.build_table': ['生成表格', '基于表格行生成清晰易读的表格。'],
        'data.profile_rows': ['分析表格字段', '分析字段类型、填充率和样本值。'],
        'data.filter_rows': ['筛选表格行', '按精确匹配或包含关系筛选行。'],
        'data.aggregate': ['数据汇总', '对全部数据计算总数、求和、均值、最小值或最大值。'],
        'data.group_summary': ['分组汇总', '按字段分组后计算一个或多个统计指标。'],
        'data.normalize_fields': ['规范字段', '重命名字段并清理字符串值。'],
        'doc.extract_outline': ['提取文档大纲', '从文本或格式化内容中提取轻量大纲。'],
        'doc.extract_key_values': ['提取键值信息', '从文档文本中抽取键值样式信息。'],
        'doc.chunk_text': ['拆分长文本', '按段落拆分长文本供后续分析。'],
        'format.to_markdown_table': ['转为表格', '将行数据转换为清晰易读的表格。'],
        'format.to_json': ['转为结构化数据', '将内容转换为紧凑或易读的结构化数据。'],
        'format.extract_json': ['提取结构化数据', '从文本中提取并解析第一个结构化对象或数组。'],
        'format.normalize_text': ['规范文本', '清理空白并可选转换大小写。'],
        'im.list_allowed_targets': ['列出通知目标', '列出当前允许通知的局域网即时通讯目标。'],
        'im.send_user_message': ['发送用户消息', '向允许的局域网即时通讯用户发送纯文本消息。'],
        'im.send_group_message': ['发送群组消息', '向允许的局域网即时通讯群组发送纯文本消息。'],
        'im.send_markdown': ['发送格式化消息', '向允许的局域网消息目标发送格式化内容。'],
        'browser.open': ['打开本机浏览器页面', '在当前设备已授权的隔离浏览器中打开页面，用户可自行完成登录。'],
        'browser.inspect': ['读取本机网页内容', '在当前设备已授权的隔离浏览器中读取标题和受限正文。'],
        'browser.click': ['点击本机网页元素', '在当前设备已授权的隔离浏览器中点击目标，须经本机确认。'],
        'browser.screenshot': ['截取本机网页', '在当前设备已授权的隔离浏览器中截取页面，须经本机确认。'],
        'browser.navigate': ['浏览器访问页面', '在受控浏览器沙箱中打开目标页面。'],
        'browser.extract_text': ['网页内容提取', '提取当前网页的正文结构与关键文本。'],
        'code.python_execute': ['Python 脚本执行', '在隔离沙箱中执行 Python 数据处理与建模脚本。'],
        'code.duckdb_query': ['DuckDB 高性能查询', '使用 DuckDB 列式引擎对多格式数据进行快速 SQL 分析。'],
        'filesystem.read_workspace': ['读取工作区文件', '读取任务受控工作区内的文件内容。'],
        'filesystem.write_workspace': ['写入工作区文件', '在任务受控工作区内安全保存生成的文件。'],
        'workflow.input': ['工作流输入', '声明并读取运行参数，支持类型转换与默认值。'],
        'workflow.template': ['文本模板', '使用工作流变量拼接确定性文本，不调用模型。'],
        'workflow.notify': ['受控通知', '通过已配置的企业微信、飞书或钉钉渠道绑定排队发送通知。'],
        'workflow.output': ['工作流输出', '声明工作流最终输出，便于按名称读取交付结果。'],
        'workflow.condition': ['条件路由', '比较输入值并返回匹配路由，供下游条件分支引用。'],
        'workflow.approval': ['人工审批', '暂停工作流等待指定人员审批，支持多级审批与超时策略。'],
        'workflow.foreach': ['循环 / 批处理', '在独立受控 Worker 沙箱中并发遍历处理集合项。'],
        'workflow.subworkflow': ['子工作流', '调用另一个已发布工作流并获取其最终输出。'],
        'workflow.delay': ['延时等待', '挂起工作流到指定时间后继续执行。'],
        'workflow.embed_page': ['嵌入页面', '在工作流结果中展示受限页面嵌入。'],
        'workflow.embed_image': ['嵌入图片', '在工作流结果中展示图片资源。'],
        'workflow.embed_video': ['嵌入视频', '在工作流结果中展示带控件的视频资源。'],
        'workflow.embed_audio': ['嵌入音频', '在工作流结果中展示带控件的音频资源。'],
        'workflow.link_card': ['链接卡片', '生成安全的链接卡片并在新窗口打开。'],
        'workflow.embed_code': ['网站嵌入代码', '生成可复制到其它网站页面的 HTML iframe 代码。'],
        'agent.code': ['代码执行', '在独立受控 Worker 沙箱中运行脚本；服务端不直接执行代码。'],
        'agent.http': ['HTTP 请求', '调用外部 REST API 并返回状态码与响应数据。'],
        'agent.browser': ['浏览器自动化', '在受控浏览器沙箱中打开目标页面并提取关键内容。'],
        'agent.merge': ['变量聚合', '把多个上游节点的输出合并为一个结构化对象。'],
        'artifact.render': ['文档渲染', '将受控 Document IR 渲染为正式文档。'],
        'artifact.list_renditions': ['渲染结果列表', '列出某个产物已有的渲染结果。'],
        'knowledge.graph.query': ['知识图谱查询', '查询知识图谱中的实体与关联关系。']
    };

const TOOL_GROUPS = [
        { key: 'llm', label: '大模型', test: name => /^(agent\.(llm|content_review|delegate|handoff)|llm\.|model\.generate)/.test(name) },
        { key: 'knowledge', label: '知识与会话', test: name => /^(rag|sessions|knowledge)\./.test(name) },
        { key: 'database', label: '数据库', test: name => /(^|\.)(db)\./.test(name) },
        { key: 'reports', label: '报表与文件', test: name => /^(reports|report)\./.test(name) },
        { key: 'visual', label: '图表与展示', test: name => /^viz\./.test(name) },
        { key: 'data', label: '数据处理', test: name => /^data\./.test(name) },
        { key: 'document', label: '文档处理', test: name => /^doc\./.test(name) },
        { key: 'format', label: '格式转换', test: name => /^format\./.test(name) },
        { key: 'notify', label: '消息通知', test: name => /^(im\.|workflow\.notify$)/.test(name) },
        { key: 'system', label: '系统诊断', test: name => /^(models|system)\./.test(name) },
        { key: 'external', label: '外部能力', test: name => /^mcp\./.test(name) },
        { key: 'other', label: '其他工具', test: () => true }
    ];

function toolShortName(tool) {
        const value = String(toolValue(tool) || '');
        const match = value.match(/^(?:mcp\.[^.]+\.)?(.+)$/);
        return match ? match[1] : value;
    }

function friendlyToolTitle(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        if (override?.[0]) return override[0];
        if (typeof agentToolTitle === 'function') {
                const title = agentToolTitle(tool);
                if (title && title !== shortName && title !== toolValue(tool) && title !== '工具') return title;
        }
        if (typeof tool === 'object' && tool?.title && tool.title !== shortName && tool.title !== toolValue(tool) && !/^[a-z_]+(?:\.[a-z0-9_-]+)+$/i.test(tool.title)) {
                return tool.title;
        }
        return tool?.title || shortName || toolValue(tool) || '未命名工具';
    }

function friendlyToolDescription(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        if (override?.[1]) return override[1];
        if (typeof agentToolDescription === 'function') {
                const desc = agentToolDescription(tool);
                if (desc) return desc;
        }
        return tool?.description || '暂无说明。';
    }

function toolSourceLabel(tool) {
        if (tool?.source === 'builtin') return '系统内置';
        return String(tool?.serverName || '').trim();
    }

function friendlyToolOptionTitle(tool, duplicateShortNames = new Set()) {
        const title = friendlyToolTitle(tool);
        const source = toolSourceLabel(tool);
        return duplicateShortNames.has(toolShortName(tool)) && source ? `${title} · ${source}` : title;
    }

function toolGroupLabel(tool) {
        const shortName = toolShortName(tool);
        const group = TOOL_GROUPS.find(item => item.test(shortName) || item.test(String(toolValue(tool) || '')));
        return group?.label || '其他工具';
    }

function renderToolOptions(tools, selectedValue) {
        const buckets = new Map();
        TOOL_GROUPS.forEach(group => buckets.set(group.label, []));
        const list = Array.isArray(tools) ? tools : [];
        const resolvedSelectedValue = toolValue(resolveToolForNode(list, selectedValue)) || selectedValue;
        const shortNameCounts = list.reduce((counts, tool) => {
            const value = toolValue(tool);
            const shortName = toolShortName(tool);
            if (value && shortName) counts.set(shortName, (counts.get(shortName) || 0) + 1);
            return counts;
        }, new Map());
        const duplicateShortNames = new Set([...shortNameCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([shortName]) => shortName));
        list.forEach(tool => {
            const value = toolValue(tool);
            if (!value) return;
            const label = toolGroupLabel(tool);
            if (!buckets.has(label)) buckets.set(label, []);
            buckets.get(label).push(tool);
        });
        const groups = [...buckets.entries()]
            .map(([label, items]) => [label, items.sort((a, b) => friendlyToolOptionTitle(a, duplicateShortNames).localeCompare(friendlyToolOptionTitle(b, duplicateShortNames), 'zh-Hans-CN'))])
            .filter(([, items]) => items.length);
        const optionGroups = groups.map(([label, items]) => `
            <optgroup label="${dagEscapeAttr(label)}">
                ${items.map(tool => {
        const value = toolValue(tool);
        const title = friendlyToolOptionTitle(tool, duplicateShortNames);
        const optionTitle = [friendlyToolDescription(tool), toolSourceLabel(tool), value].filter(Boolean).join(' · ');
        return `<option value="${dagEscapeAttr(value)}" ${resolvedSelectedValue === value ? 'selected' : ''} title="${dagEscapeAttr(optionTitle)}">${dagEscapeHtml(title)}</option>`;
    }).join('')}
            </optgroup>
        `).join('');
        return ['<option value="">— 选择工具 —</option>', optionGroups].join('');
    }

function renderSelectedToolMeta(tool) {
        if (!tool) {
            return '<div class="pivot-dag-tool-meta is-empty">选择工具后显示用途、来源和内部标识。</div>';
        }
        const source = tool.source === 'builtin'
            ? '系统内置'
            : tool.serverName
                ? `工具库 · ${tool.serverName}`
                : '工具库';
        const badges = [
            toolGroupLabel(tool),
            source,
            tool.requiresApproval ? '需审批' : '',
            tool.admin ? '管理员' : ''
        ].filter(Boolean);
        return `
            <div class="pivot-dag-tool-meta">
                <div class="pivot-dag-tool-meta-head">
                    <strong>${dagEscapeHtml(friendlyToolTitle(tool))}</strong>
                    <span class="pivot-dag-tool-meta-badges">${badges.map(item => `<em>${dagEscapeHtml(item)}</em>`).join('')}</span>
                </div>
                <div class="pivot-dag-tool-meta-body">
                    <p>${dagEscapeHtml(friendlyToolDescription(tool))}</p>
                    <details class="pivot-dag-tool-meta-technical">
                        <summary>技术信息</summary>
                        <div class="pivot-dag-tool-meta-id">
                            <span>内部标识</span>
                            <code>${dagEscapeHtml(toolValue(tool))}</code>
                        </div>
                    </details>
                </div>
            </div>
        `;
    }

function findPreferredTool(tools, patterns) {
        const list = Array.isArray(tools) ? tools : [];
        return list.find(tool => {
            const value = String(toolValue(tool)).toLowerCase();
            const title = String(tool?.title || '').toLowerCase();
            return patterns.some(pattern => value.includes(pattern) || title.includes(pattern));
        }) || null;
    }

function findGenericDatabaseToolForFullName(tools, value) {
        const match = String(value || '').match(/^mcp\.(\d+)\.(db\..+)$/);
        if (!match) return null;
        const serverId = match[1];
        const shortName = match[2];
        return (Array.isArray(tools) ? tools : []).find(tool => (
            tool?.databaseTool
            && toolShortName(tool) === shortName
            && databaseConnectionsFromTool(tool).some(connection => (
                String(connection.connectionId ?? connection.serverId ?? '') === serverId
                || String(connection.serverId ?? '') === serverId
            ))
        )) || null;
    }

function databaseConnectionIdFromToolValue(value) {
        const match = String(value || '').match(/^mcp\.(\d+)\.(db\..+)$/);
        return match ? match[1] : '';
    }

function isKnownToolValue(tools, value) {
        const list = Array.isArray(tools) ? tools : [];
        return list.some(tool => toolValue(tool) === value) || Boolean(findGenericDatabaseToolForFullName(list, value));
    }

function resolveToolForNode(tools, value) {
        const list = Array.isArray(tools) ? tools : [];
        const found = list.find(tool => toolValue(tool) === value) || findGenericDatabaseToolForFullName(list, value);
        if (found) return found;
        return value ? { name: value, title: '' } : null;
    }

function buildNodeToolDisplay(tools, value) {
        const tool = resolveToolForNode(tools, value);
        if (!tool) {
            return {
                title: '未选择工具',
                shortId: '',
                fullId: '',
                tooltip: '未选择工具'
            };
        }
        const fullId = toolValue(tool) || value;
        const shortId = toolShortName(tool) || fullId;
        const title = friendlyToolTitle(tool);
        return {
            title,
            shortId,
            fullId,
            tooltip: `${title} · ${fullId}`
        };
    }
