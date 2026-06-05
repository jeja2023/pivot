// 能力库工作台逻辑
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
        tools: ['viz.build_chart', 'viz.build_table']
    },
    {
        type: 'report',
        title: '报告编排',
        badge: '系统服务',
        description: '把摘要、表格、图表和指标块组装成固定格式的报告内容。',
        tools: ['report.compose', 'report.validate_template']
    },
    {
        type: 'documents',
        title: '文档解析',
        badge: '系统服务',
        description: '从文档文本中提取大纲、键值信息，并按段落切分为可分析片段。',
        tools: ['doc.extract_outline', 'doc.extract_key_values', 'doc.chunk_text']
    },
    {
        type: 'data',
        title: '数据处理',
        badge: '系统服务',
        description: '对表格行进行字段画像、筛选、聚合统计和字段标准化处理。',
        tools: ['data.profile_rows', 'data.filter_rows', 'data.group_summary', 'data.normalize_fields']
    },
    {
        type: 'format',
        title: '格式转换',
        badge: '系统服务',
        description: '在 Markdown 表格、JSON 和规范化文本之间进行轻量转换。',
        tools: ['format.to_markdown_table', 'format.to_json', 'format.extract_json', 'format.normalize_text']
    }
];

const mcpPersonalBuiltinServices = [
    {
        type: 'reports',
        title: '报表文件',
        badge: '需配置',
        description: '连接报表和数据文件目录后，提供文件检索、摘要读取和表格查询能力。',
        tools: ['reports.list_files', 'reports.read_file_summary', 'reports.query_table', 'reports.compare_files'],
        requiresConfig: true,
        defaultName: '报表文件',
        defaultDescription: '系统集成的报表和数据文件访问能力。'
    },
    {
        type: 'im',
        title: '消息通知',
        badge: '需配置',
        description: '对接局域网 Webhook 或消息 API，把报告摘要、提醒和任务结果发送给用户或群组。',
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
        description: '连接业务数据库后，提供表结构查看、只读查询和集合分析等能力。',
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
        description: '列出当前数据库中可查询的表和视图。'
    },
    'db.count_tables': {
        title: '统计数据表数量',
        description: '统计当前数据库中可查询的表和视图数量。'
    },
    'db.describe_table': {
        title: '查看表结构',
        description: '查看字段、类型、默认值和可空性，辅助模型生成安全 SQL。'
    },
    'db.run_readonly_query': {
        title: '执行只读 SQL',
        description: '执行只读查询，限制返回行数，并阻止写入或管理类语句。'
    },
    'db.list_collections': {
        title: '列出集合',
        description: '列出 MongoDB 数据库中的集合。'
    },
    'db.count_collections': {
        title: '统计集合数量',
        description: '统计 MongoDB 数据库中的集合数量。'
    },
    'db.sample_collection': {
        title: '读取集合样本',
        description: '读取少量文档样本，辅助理解字段结构。'
    },
    'db.aggregate': {
        title: '执行聚合分析',
        description: '执行只读聚合管道，并限制返回文档数量。'
    }
};

const mcpSqlDatabaseFallbackTools = [
    'db.list_tables',
    'db.count_tables',
    'db.describe_table',
    'db.run_readonly_query'
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
        description: '扫描配置目录内的报表、表格和数据文件。'
    },
    'reports.read_file_summary': {
        title: '\u62a5\u8868\u6587\u4ef6\u6458\u8981',
        description: '读取文件元数据、表头、工作表和少量样本。'
    },
    'reports.query_table': {
        title: '\u67e5\u8be2\u8868\u683c\u6570\u636e',
        description: '按列筛选 CSV、Excel 表格并返回限定行数。'
    },
    'reports.compare_files': {
        title: '\u5bf9\u6bd4\u6570\u636e\u6587\u4ef6',
        description: '对比两个文件的工作表、字段和样本结构。'
    },
    'viz.build_chart': {
        title: '图表生成',
        description: '从上一步传入的表格行生成可直接渲染的图表配置。'
    },
    'viz.build_table': {
        title: '\u8868\u683c\u5c55\u793a',
        description: '从上一步传入的表格行生成 Markdown 表格展示块。'
    },
    'report.compose': {
        title: '\u62a5\u544a\u7f16\u6392',
        description: '把摘要、表格、图表和指标块组装为固定格式报告。'
    },
    'report.validate_template': {
        title: '\u6821\u9a8c\u62a5\u544a\u6a21\u677f',
        description: '校验报告章节模板是否满足编排要求。'
    },
    'doc.extract_outline': {
        title: '提取文档大纲',
        description: '从 Markdown 或普通文本中识别标题层级和编号式章节。'
    },
    'doc.extract_key_values': {
        title: '提取键值信息',
        description: '从文档文本中提取“字段：内容”形式的关键信息。'
    },
    'doc.chunk_text': {
        title: '切分文档文本',
        description: '按段落把长文本切分为适合后续分析的片段。'
    },
    'data.profile_rows': {
        title: '分析表格字段',
        description: '统计字段类型、填充率和样例值，快速了解数据结构。'
    },
    'data.filter_rows': {
        title: '筛选表格行',
        description: '按字段条件对表格行进行精确或包含匹配筛选。'
    },
    'data.group_summary': {
        title: '分组汇总数据',
        description: '按字段分组后计算数量、求和、平均值、最小值或最大值。'
    },
    'data.normalize_fields': {
        title: '标准化字段',
        description: '批量重命名字段，并清理字符串首尾空格。'
    },
    'format.to_markdown_table': {
        title: '转换 Markdown 表格',
        description: '把结构化行数据转换为 Markdown 表格。'
    },
    'format.to_json': {
        title: '转换 JSON',
        description: '把任意结构化内容序列化为 JSON 文本。'
    },
    'format.extract_json': {
        title: '提取 JSON',
        description: '从混合文本中提取并解析第一个 JSON 对象或数组。'
    },
    'format.normalize_text': {
        title: '规范化文本',
        description: '整理换行和空白字符，并可转换大小写。'
    },
    'im.list_allowed_targets': {
        title: '\u67e5\u770b\u901a\u77e5\u76ee\u6807',
        description: '查看局域网即时聊天服务允许发送的用户或群组。'
    },
    'im.send_user_message': {
        title: '\u53d1\u9001\u7528\u6237\u6d88\u606f',
        description: '向一个白名单用户发送局域网聊天消息。'
    },
    'im.send_group_message': {
        title: '\u53d1\u9001\u7fa4\u7ec4\u6d88\u606f',
        description: '向一个白名单群组发送局域网聊天消息。'
    },
    'im.send_markdown': {
        title: '\u53d1\u9001 Markdown \u6d88\u606f',
        description: '向白名单目标发送 Markdown 格式通知。'
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

