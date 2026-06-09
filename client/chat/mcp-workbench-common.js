// 工具箱工作台逻辑
const mcpEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));
let mcpServersCache = [];
let mcpCallLogsCache = [];
let mcpToolsCache = [];

const mcpDbDefaultPorts = {
    postgres: 5432,
    mysql: 3306,
    sqlserver: 1433,
    sqlite: '',
    mongodb: 27017
};

const mcpDbToolLabels = {
    postgres: 'PostgreSQL',
    mysql: 'MySQL / MariaDB',
    sqlserver: 'SQL Server',
    sqlite: 'SQLite',
    mongodb: 'MongoDB'
};

const mcpBuiltinToolLabels = {
    reports: '报表文件',
    visualization: '图表生成',
    report: '报告编排',
    documents: '文档解析',
    data: '数据处理',
    format: '格式转换',
    im: 'IM 通知'
};

const mcpSystemServices = [
    {
        type: 'visualization',
        title: '图表生成',
        badge: '系统服务',
        description: '把表格数据转换为可直接渲染的柱状图、折线图、饼图和表格展示。',
        usage: '适合“把这份数据画成图”“统计结果做成表格”。',
        tools: ['viz.build_chart', 'viz.build_table']
    },
    {
        type: 'report',
        title: '报告编排',
        badge: '系统服务',
        description: '把摘要、表格、图表和指标块组装成固定格式的报告内容。',
        usage: '适合“生成日报、周报、分析报告”。',
        tools: ['report.compose', 'report.validate_template']
    },
    {
        type: 'documents',
        title: '文档解析',
        badge: '系统服务',
        description: '从文档文本中提取大纲、键值信息，并按段落切分为可分析片段。',
        usage: '适合“提取合同要点”“把长文拆成段落”。',
        tools: ['doc.extract_outline', 'doc.extract_key_values', 'doc.chunk_text']
    },
    {
        type: 'data',
        title: '数据处理',
        badge: '系统服务',
        description: '对表格行进行字段画像、筛选、聚合统计和字段标准化处理。',
        usage: '适合“按部门汇总”“筛选异常行”。',
        tools: ['data.profile_rows', 'data.filter_rows', 'data.group_summary', 'data.normalize_fields']
    },
    {
        type: 'format',
        title: '格式转换',
        badge: '系统服务',
        description: '在 Markdown 表格、JSON 和规范化文本之间进行轻量转换。',
        usage: '适合“转成 JSON”“整理成 Markdown 表格”。',
        tools: ['format.to_markdown_table', 'format.to_json', 'format.extract_json', 'format.normalize_text']
    }
];

const mcpPersonalBuiltinServices = [
    {
        type: 'reports',
        title: '报表文件',
        badge: '需配置',
        description: '连接报表和数据文件目录后，提供查找文件、摘要读取和表格查询工具。',
        usage: '适合“从共享目录读取 Excel/CSV 报表”。',
        tools: ['reports.list_files', 'reports.read_file_summary', 'reports.query_table', 'reports.compare_files'],
        requiresConfig: true,
        defaultName: '报表文件',
        defaultDescription: '系统集成的报表和数据文件访问能力。'
    },
    {
        type: 'im',
        title: '消息通知',
        badge: '需配置',
        description: '对接局域网聊天工具接收地址，把报告摘要、提醒和任务结果发送给用户或群组。',
        usage: '适合“把结果发给某个群或同事”。',
        tools: ['im.list_allowed_targets', 'im.send_user_message', 'im.send_group_message', 'im.send_markdown'],
        requiresConfig: true,
        defaultName: 'IM 通知',
        defaultDescription: '系统集成的局域网消息通知能力。'
    }
];

const mcpBuiltinServices = [...mcpSystemServices, ...mcpPersonalBuiltinServices];

const mcpServiceCatalog = [
    {
        type: 'database',
        title: '数据库连接',
        badge: '手动连接',
        description: '连接业务数据库后，提供表结构查看、只读查询和集合分析等工具。',
        usage: '适合“查询业务表、统计数量、生成图表”。默认只读，避免误写数据。',
        actionLabel: '配置',
        defaultName: '数据库连接',
        defaultDescription: '手动连接数据库后启用查询工具。'
    }
];

function renderMcpServiceCard({
    service,
    server = null,
    enabledEmptyText = '已启用，刷新后可查看工具',
    disabledMetaText = '启用后可查看工具',
    configMetaText = '配置后可查看工具',
    connector = false
}) {
    const enabled = Boolean(server);
    const isPaused = server?.status === 'paused';
    const metaText = enabled
        ? mcpToolPreviewText(server.id, service.tools, enabledEmptyText)
        : (service.requiresConfig ? configMetaText : disabledMetaText);
    const headAction = enabled
        ? `
            <button class="mcp-status-toggle${isPaused ? '' : ' is-on'}" type="button" data-mcp-toggle="${server.id}" data-next-status="${isPaused ? 'active' : 'paused'}" aria-label="${isPaused ? '启用服务' : '停用服务'}" title="${isPaused ? '启用服务' : '停用服务'}">
                <span></span>
            </button>
        `
        : `
            <button class="mcp-status-toggle" type="button" ${service.requiresConfig ? `data-mcp-system-config="${mcpEscape(service.type)}"` : `data-mcp-system-enable="${mcpEscape(service.type)}"`} aria-label="${service.requiresConfig ? '配置服务' : '启用服务'}" title="${service.requiresConfig ? '配置服务' : '启用服务'}">
                <span></span>
            </button>
        `;
    return `
        <div class="mcp-system-card${connector ? ' mcp-connector-card' : ''}${enabled ? ' is-enabled' : ''}${isPaused ? ' is-paused' : ''}">
            <div class="mcp-system-card-head">
                <strong>${mcpEscape(service.title)}</strong>
                ${headAction}
            </div>
            <p>${mcpEscape(service.description)}</p>
            <div class="mcp-card-meta">${mcpEscape(metaText)}</div>
            <div class="mcp-system-actions">
                ${enabled ? `<button class="btn-secondary" type="button" data-mcp-tools="${server.id}">工具</button>` : ''}
                ${service.requiresConfig ? `
                    <button class="btn-secondary" type="button" data-mcp-system-config="${mcpEscape(service.type)}">
                        ${enabled ? '编辑配置' : '配置'}
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

const mcpToolDisplayMap = {
    'db.list_tables': {
        title: '列出数据表',
        description: '列出当前数据库中可查询的表和视图。',
        prompt: '请查看这个数据库里有哪些表，并说明哪些可能和我的问题有关。'
    },
    'db.count_tables': {
        title: '统计数据表数量',
        description: '统计当前数据库中可查询的表和视图数量。',
        prompt: '请统计这个数据库里有多少张可查询的数据表。'
    },
    'db.describe_table': {
        title: '查看表结构',
        description: '查看字段、类型、默认值和可空性，辅助模型生成安全 SQL。',
        prompt: '请查看相关业务表的字段含义，并告诉我可以怎样提问。'
    },
    'db.run_readonly_query': {
        title: '执行只读 SQL',
        description: '执行只读查询，限制返回行数，并阻止写入或管理类语句。',
        prompt: '请用只读查询统计我关心的数据，并给出简短结论。'
    },
    'db.group_count': {
        title: '分组统计分布',
        description: '按指定字段统计数量，适合生成分布表、排行榜和图表前置数据。',
        prompt: '请按关键字段做数量分布统计，并把结果整理成适合生成图表的数据。'
    },
    'db.list_collections': {
        title: '列出集合',
        description: '列出 MongoDB 数据库中的集合。',
        prompt: '请列出这个 MongoDB 数据库里的集合，并说明可能保存了什么数据。'
    },
    'db.count_collections': {
        title: '统计集合数量',
        description: '统计 MongoDB 数据库中的集合数量。',
        prompt: '请统计这个 MongoDB 数据库里有多少个集合。'
    },
    'db.sample_collection': {
        title: '读取集合样本',
        description: '读取少量文档样本，辅助理解字段结构。',
        prompt: '请读取相关集合的少量样本，并解释字段大概含义。'
    },
    'db.aggregate': {
        title: '执行聚合分析',
        description: '执行只读聚合管道，并限制返回文档数量。',
        prompt: '请对相关集合做只读聚合分析，并总结主要发现。'
    }
};

const mcpSqlDatabaseFallbackTools = [
    'db.list_tables',
    'db.count_tables',
    'db.describe_table',
    'db.run_readonly_query',
    'db.group_count'
];

const mcpMongoDatabaseFallbackTools = [
    'db.list_collections',
    'db.count_collections',
    'db.sample_collection',
    'db.aggregate'
];

Object.assign(mcpToolDisplayMap, {
    'reports.list_files': {
        title: '\u62a5\u8868\u6587\u4ef6',
        description: '扫描配置目录内的报表、表格和数据文件。',
        prompt: '请列出可用的报表文件，并告诉我哪些适合分析当前问题。'
    },
    'reports.read_file_summary': {
        title: '\u62a5\u8868\u6587\u4ef6\u6458\u8981',
        description: '读取文件元数据、表头、工作表和少量样本。',
        prompt: '请读取报表摘要，帮我说明这份文件包含哪些字段和数据。'
    },
    'reports.query_table': {
        title: '\u67e5\u8be2\u8868\u683c\u6570\u636e',
        description: '按列筛选 CSV、Excel 表格并返回限定行数。',
        prompt: '请从报表里筛选我关心的数据，并用表格总结。'
    },
    'reports.compare_files': {
        title: '\u5bf9\u6bd4\u6570\u636e\u6587\u4ef6',
        description: '对比两个文件的工作表、字段和样本结构。',
        prompt: '请对比两份报表的字段和数据差异，并列出重点变化。'
    },
    'viz.build_chart': {
        title: '图表生成',
        description: '从上一步传入的表格行生成可直接渲染的图表配置。',
        prompt: '请把这份数据生成一张最合适的图表，并解释图表含义。'
    },
    'viz.build_table': {
        title: '\u8868\u683c\u5c55\u793a',
        description: '从上一步传入的表格行生成 Markdown 表格展示块。',
        prompt: '请把结果整理成清晰的表格，并补充一句结论。'
    },
    'report.compose': {
        title: '\u62a5\u544a\u7f16\u6392',
        description: '把摘要、表格、图表和指标块组装为固定格式报告。',
        prompt: '请把分析结果整理成一份结构清楚的报告。'
    },
    'report.validate_template': {
        title: '\u6821\u9a8c\u62a5\u544a\u6a21\u677f',
        description: '校验报告章节模板是否满足编排要求。',
        prompt: '请检查这份报告模板是否完整，并指出需要补充的章节。'
    },
    'doc.extract_outline': {
        title: '提取文档大纲',
        description: '从 Markdown 或普通文本中识别标题层级和编号式章节。',
        prompt: '请提取这份文档的大纲，并用层级列表展示。'
    },
    'doc.extract_key_values': {
        title: '提取键值信息',
        description: '从文档文本中提取“字段：内容”形式的关键信息。',
        prompt: '请从这份文档里提取关键字段和对应内容。'
    },
    'doc.chunk_text': {
        title: '切分文档文本',
        description: '按段落把长文本切分为适合后续分析的片段。',
        prompt: '请把这段长文按主题分成几个清晰片段。'
    },
    'data.profile_rows': {
        title: '分析表格字段',
        description: '统计字段类型、填充率和样例值，快速了解数据结构。',
        prompt: '请分析这份表格的字段质量、缺失情况和样例值。'
    },
    'data.filter_rows': {
        title: '筛选表格行',
        description: '按字段条件对表格行进行精确或包含匹配筛选。',
        prompt: '请按我的条件筛选表格行，并说明筛选结果。'
    },
    'data.group_summary': {
        title: '分组汇总数据',
        description: '按字段分组后计算数量、求和、平均值、最小值或最大值。',
        prompt: '请按关键字段分组汇总这份数据，并指出最高和最低的组。'
    },
    'data.normalize_fields': {
        title: '标准化字段',
        description: '批量重命名字段，并清理字符串首尾空格。',
        prompt: '请帮我整理字段名称，并清理明显的空格和格式问题。'
    },
    'format.to_markdown_table': {
        title: '转换 Markdown 表格',
        description: '把结构化行数据转换为 Markdown 表格。',
        prompt: '请把这些内容整理成 Markdown 表格。'
    },
    'format.to_json': {
        title: '转换 JSON',
        description: '把任意结构化内容序列化为 JSON 文本。',
        prompt: '请把这些内容转换成结构清晰的 JSON。'
    },
    'format.extract_json': {
        title: '提取 JSON',
        description: '从混合文本中提取并解析第一个 JSON 对象或数组。',
        prompt: '请从下面这段文本中提取 JSON，并解释字段含义。'
    },
    'format.normalize_text': {
        title: '规范化文本',
        description: '整理换行和空白字符，并可转换大小写。',
        prompt: '请整理这段文本的换行、空格和格式。'
    },
    'im.list_allowed_targets': {
        title: '\u67e5\u770b\u901a\u77e5\u76ee\u6807',
        description: '查看局域网即时聊天服务允许发送的用户或群组。',
        prompt: '请查看当前可以发送通知的用户或群组。'
    },
    'im.send_user_message': {
        title: '\u53d1\u9001\u7528\u6237\u6d88\u606f',
        description: '向一个白名单用户发送局域网聊天消息。',
        prompt: '请把这段摘要发送给指定同事，并在发送前说明内容。'
    },
    'im.send_group_message': {
        title: '\u53d1\u9001\u7fa4\u7ec4\u6d88\u606f',
        description: '向一个白名单群组发送局域网聊天消息。',
        prompt: '请把这份结果发送到指定群组，并使用简短标题。'
    },
    'im.send_markdown': {
        title: '\u53d1\u9001 Markdown \u6d88\u606f',
        description: '向白名单目标发送 Markdown 格式通知。',
        prompt: '请把下面内容整理成 Markdown 通知并发送给指定目标。'
    }
});

function mcpCleanToolTitle(title) {
    return String(title || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s+MCP$/u, '')
        .trim();
}

function mcpCleanServiceName(name) {
    return String(name || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function mcpToolTitle(tool) {
    const title = mcpToolDisplayMap[tool?.name]?.title || tool?.title || tool?.name || '工具';
    return mcpCleanToolTitle(title) || '工具';
}

function mcpToolDescription(tool) {
    return mcpToolDisplayMap[tool?.name]?.description || tool?.description || tool?.serverName || '';
}

function mcpToolsForServer(serverId, fallbackToolNames = []) {
    const tools = mcpToolsCache.filter(tool => String(tool.serverId || tool.server_id || '') === String(serverId || ''));
    if (tools.length || !fallbackToolNames.length) return tools;
    return fallbackToolNames.map(name => ({
        name,
        fullName: name,
        description: mcpToolDisplayMap[name]?.description || '',
        serverId
    }));
}

function mcpFallbackToolsForServer(server) {
    const builtinService = mcpBuiltinServices.find(item => item.type === server?.server_type);
    if (builtinService?.tools) return builtinService.tools;
    if (server?.server_type === 'database') {
        return server.database_connection?.database_type === 'mongodb'
            ? mcpMongoDatabaseFallbackTools
            : mcpSqlDatabaseFallbackTools;
    }
    return [];
}

function mcpToolCount(serverId, fallbackToolNames = []) {
    return mcpToolsForServer(serverId, fallbackToolNames).length;
}

function mcpToolPreviewText(serverId, fallbackToolNames = [], emptyText = '启用并刷新后可查看工具') {
    const count = mcpToolCount(serverId, fallbackToolNames);
    return count ? `已接入 ${count} 个工具` : emptyText;
}

