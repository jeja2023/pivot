/* Agent DAG 工具栏工具元数据辅助函数（拆自 dag-toolbar.js） */

const TOOL_DISPLAY_OVERRIDES = {
        'agent.llm': ['大模型节点', '调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。'],
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
        'data.group_summary': ['分组汇总', '按字段分组并计算数量、求和、均值、最小值或最大值。'],
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
        'im.send_markdown': ['发送格式化消息', '向允许的局域网消息目标发送格式化内容。']
    };

const TOOL_GROUPS = [
        { key: 'llm', label: '大模型', test: name => /^(agent\.(llm|delegate|handoff)|llm\.|model\.generate)/.test(name) },
        { key: 'knowledge', label: '知识与会话', test: name => /^(rag|sessions|knowledge)\./.test(name) },
        { key: 'database', label: '数据库', test: name => /(^|\.)(db)\./.test(name) },
        { key: 'reports', label: '报表与文件', test: name => /^(reports|report)\./.test(name) },
        { key: 'visual', label: '图表与展示', test: name => /^viz\./.test(name) },
        { key: 'data', label: '数据处理', test: name => /^data\./.test(name) },
        { key: 'document', label: '文档处理', test: name => /^doc\./.test(name) },
        { key: 'format', label: '格式转换', test: name => /^format\./.test(name) },
        { key: 'notify', label: '消息通知', test: name => /^im\./.test(name) },
        { key: 'system', label: '系统诊断', test: name => /^(models|system)\./.test(name) },
        { key: 'external', label: '外部能力', test: name => /^mcp\./.test(name) },
        { key: 'other', label: '其他工具', test: () => true }
    ];

function toolShortName(tool) {
        const value = String(toolValue(tool) || '');
        const match = value.match(/^mcp\.\d+\.(.+)$/);
        return match ? match[1] : value;
    }

function friendlyToolTitle(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[0] || tool?.title || shortName || toolValue(tool) || '未命名工具';
    }

function friendlyToolDescription(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[1] || tool?.description || '暂无说明。';
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
                    <div class="pivot-dag-tool-meta-id">
                        <span>工具标识</span>
                        <code>${dagEscapeHtml(toolValue(tool))}</code>
                    </div>
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
