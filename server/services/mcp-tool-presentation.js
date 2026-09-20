const MAX_DISPLAY_TITLE_LENGTH = 80;
const MAX_DISPLAY_DESCRIPTION_LENGTH = 360;

const MCP_TOOL_PRESENTATIONS = Object.freeze({
    'db.list_tables': { title: '列出数据表', description: '列出当前数据库中可查询的数据表和视图。' },
    'db.count_tables': { title: '统计数据表数量', description: '统计当前数据库中可查询的数据表和视图数量。' },
    'db.describe_table': { title: '查看表结构', description: '查看表字段、类型和可空性。' },
    'db.run_readonly_query': { title: '执行只读 SQL', description: '执行受限的只读 SQL 查询。' },
    'db.group_count': { title: '数据库分组计数', description: '直接查询数据库表，按指定字段分组并统计每组数量。' },
    'db.list_collections': { title: '列出集合', description: '列出 MongoDB 数据库中的集合。' },
    'db.count_collections': { title: '统计集合数量', description: '统计 MongoDB 数据库中的集合数量。' },
    'db.sample_collection': { title: '读取集合样本', description: '读取集合的小样本以了解字段结构。' },
    'db.aggregate': { title: '执行聚合分析', description: '执行只读的 MongoDB 聚合分析。' },
    'reports.list_files': { title: '查找报表文件', description: '列出授权目录中可访问的报表和数据文件。' },
    'reports.read_file_summary': { title: '读取报表摘要', description: '读取报表文件的元数据、工作表和样本行。' },
    'reports.query_table': { title: '查询表格数据', description: '按列筛选并查询 CSV 或电子表格数据。' },
    'reports.compare_files': { title: '对比数据文件', description: '对比两份数据文件的工作表、表头和样本行。' },
    'viz.build_chart': { title: '生成图表', description: '根据表格数据生成可视化图表。' },
    'viz.build_table': { title: '整理表格', description: '将数据整理为清晰易读的表格。' },
    'report.compose': { title: '编排报告', description: '将摘要、表格和章节组合成结构化报告。' },
    'report.validate_template': { title: '校验报告模板', description: '校验报告模板和章节定义。' },
    'doc.extract_outline': { title: '提取文档大纲', description: '从文档文本中提取标题层级和大纲。' },
    'doc.extract_key_values': { title: '提取关键信息', description: '从文本中提取键值对形式的关键信息。' },
    'doc.chunk_text': { title: '切分文档文本', description: '按段落将长文本切分为适合分析的内容块。' },
    'data.profile_rows': { title: '分析表格字段', description: '分析表格字段、类型和数据分布。' },
    'data.filter_rows': { title: '筛选表格行', description: '按规则筛选表格数据行。' },
    'data.aggregate': { title: '数据汇总', description: '对全部数据计算一个或多个统计指标。' },
    'data.group_summary': { title: '表格分组汇总', description: '对上游表格行按字段分组后计算一个或多个统计指标。' },
    'data.normalize_fields': { title: '规范化字段', description: '规范字段名称和表格内容。' },
    'format.to_markdown_table': { title: '转换 Markdown 表格', description: '将数据行转换为 Markdown 表格。' },
    'format.to_json': { title: '转换 JSON', description: '将输入内容转换为 JSON。' },
    'format.extract_json': { title: '提取 JSON', description: '从文本中提取可解析的 JSON 内容。' },
    'format.normalize_text': { title: '规范化文本', description: '整理文本中的空白和格式。' },
    'im.list_allowed_targets': { title: '查看通知目标', description: '列出当前允许发送消息的用户和群组。' },
    'im.send_user_message': { title: '发送用户消息', description: '向允许的用户发送即时通讯消息。' },
    'im.send_group_message': { title: '发送群组消息', description: '向允许的群组发送即时通讯消息。' },
    'im.send_markdown': { title: '发送富文本消息', description: '向允许的目标发送 Markdown 格式消息。' },
    'browser.open': { title: '打开本机浏览器', description: '在当前设备已授权的隔离浏览器中打开网页。' },
    'browser.inspect': { title: '读取本机网页', description: '读取当前设备已授权网页的标题和受限正文。' },
    'browser.click': { title: '点击本机网页元素', description: '点击当前设备已授权网页中的目标元素。' },
    'browser.screenshot': { title: '截取本机网页', description: '截取当前设备已授权浏览器中的网页。' },
    'browser.navigate': { title: '浏览器访问页面', description: '在受控浏览器中访问目标页面。' },
    'browser.extract_text': { title: '提取网页内容', description: '提取网页正文和关键文本。' },
    'code.python_execute': { title: '执行 Python 脚本', description: '在隔离沙箱中执行 Python 数据处理脚本。' },
    'code.duckdb_query': { title: '执行 DuckDB 查询', description: '使用 DuckDB 对多格式数据执行快速查询。' },
    'filesystem.read_workspace': { title: '读取工作区文件', description: '读取受控工作区中的文件内容。' },
    'filesystem.write_workspace': { title: '写入工作区文件', description: '在受控工作区中保存生成的文件。' }
});

const IDENTIFIER_TOKENS = Object.freeze({
    list: '列出', read: '读取', get: '获取', fetch: '获取', find: '查找', search: '检索',
    query: '查询', create: '创建', update: '更新', delete: '删除', remove: '移除',
    open: '打开', close: '关闭', inspect: '查看详情', click: '点击', screenshot: '截屏',
    compare: '对比', summary: '摘要', summarize: '摘要', file: '文件', files: '文件',
    table: '表格', tables: '数据表', report: '报表', reports: '报表', data: '数据',
    document: '文档', documents: '文档', text: '文本', image: '图片', images: '图片',
    user: '用户', users: '用户', group: '群组', groups: '群组', message: '消息',
    messages: '消息', notification: '通知', notifications: '通知', send: '发送',
    export: '导出', import: '导入', upload: '上传', download: '下载', run: '执行',
    execute: '执行', validate: '校验', config: '配置', settings: '设置', status: '状态',
    info: '信息', detail: '详情', details: '详情', chart: '图表', browser: '浏览器',
    workspace: '工作区', format: '格式化', markdown: 'Markdown', json: 'JSON',
    sql: 'SQL', database: '数据库', collection: '集合', collections: '集合',
    count: '统计数量', aggregate: '聚合分析', filter: '筛选', normalize: '规范化',
    extract: '提取', outline: '大纲', key: '关键', values: '信息', value: '信息',
    allowed: '允许', target: '目标', targets: '目标', template: '模板', compose: '编排',
    share: '共享', archive: '归档', refresh: '刷新', profile: '分析', rows: '数据行',
    field: '字段', fields: '字段'
});

function cleanDisplayText(value, maxLength) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function hasChinese(value) {
    return /[\u3400-\u9fff]/u.test(String(value || ''));
}

function normalizeMcpToolShortName(tool = {}) {
    const raw = String(tool?.name || tool?.toolName || tool?.fullName || tool || '').trim();
    const match = raw.match(/^mcp\.\d+\.(.+)$/);
    return match ? match[1] : raw;
}

function tokenizeIdentifier(value = '') {
    return String(value || '')
        .replace(/^mcp\.\d+\./, '')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .split(/[.\s_/-]+/)
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
}

function buildFallbackChineseTitle(tool = {}) {
    const translated = tokenizeIdentifier(normalizeMcpToolShortName(tool))
        .map(token => IDENTIFIER_TOKENS[token] || '')
        .filter(Boolean);
    return translated.length ? [...new Set(translated)].join('') : '自定义工具';
}

function normalizeCustomPresentation(input = {}) {
    return {
        displayName: cleanDisplayText(input.displayName ?? input.display_name, MAX_DISPLAY_TITLE_LENGTH),
        displayDescription: cleanDisplayText(input.displayDescription ?? input.display_description, MAX_DISPLAY_DESCRIPTION_LENGTH)
    };
}

function extractCustomPresentationFromTool(tool = {}) {
    if (tool.displayName || tool.displayDescription || tool.customDisplayName || tool.customDisplayDescription) {
        return normalizeCustomPresentation({
            displayName: tool.displayName ?? tool.customDisplayName,
            displayDescription: tool.displayDescription ?? tool.customDisplayDescription
        });
    }
    const rawConfig = tool.serverConfig || tool.server_config;
    if (rawConfig) {
        try {
            const config = typeof rawConfig === 'string' ? JSON.parse(rawConfig || '{}') : rawConfig;
            const presentations = config?.toolPresentations;
            if (presentations && typeof presentations === 'object') {
                const item = presentations[String(tool.name || '')];
                if (item) return normalizeCustomPresentation(item);
            }
        } catch (_) {}
    }
    return normalizeCustomPresentation({});
}

function getMcpToolPresentation(tool = {}) {
    const shortName = normalizeMcpToolShortName(tool);
    const known = MCP_TOOL_PRESENTATIONS[shortName];
    const custom = extractCustomPresentationFromTool(tool);
    const providerTitle = cleanDisplayText(tool.providerTitle ?? tool.provider_title ?? tool.title, MAX_DISPLAY_TITLE_LENGTH);
    const providerDescription = cleanDisplayText(tool.providerDescription ?? tool.provider_description ?? tool.description, MAX_DISPLAY_DESCRIPTION_LENGTH);
    const displayTitle = custom.displayName
        || known?.title
        || (hasChinese(providerTitle) ? providerTitle : buildFallbackChineseTitle(tool));
    const displayDescription = custom.displayDescription
        || known?.description
        || (hasChinese(providerDescription) ? providerDescription : '由已配置的外部工具服务提供。');
    const searchAliases = [...new Set([
        displayTitle,
        displayDescription,
        shortName,
        String(tool.fullName || ''),
        providerTitle,
        providerDescription
    ].map(value => cleanDisplayText(value, 500)).filter(Boolean))];
    return {
        shortName,
        displayTitle,
        displayDescription,
        providerTitle,
        providerDescription,
        customDisplayName: custom.displayName,
        customDisplayDescription: custom.displayDescription,
        hasCustomPresentation: Boolean(custom.displayName || custom.displayDescription),
        requiresCustomPresentation: !known && !custom.displayName && !hasChinese(providerTitle),
        searchAliases
    };
}

function presentMcpTool(tool = {}) {
    return {
        ...tool,
        // Contract/release fields are deliberately retained in the read model:
        // the display formatter must never strip the immutable execution
        // identity that agents, workflows and diagnostics need to surface.
        ...(tool.output_schema || tool.outputSchema ? { output_schema: tool.output_schema || tool.outputSchema } : {}),
        ...(tool.catalogReleaseId ? { catalogReleaseId: tool.catalogReleaseId, catalogReleaseVersion: tool.catalogReleaseVersion || '' } : {}),
        ...(tool.catalogItemId ? { catalogItemId: tool.catalogItemId } : {}),
        ...(tool.definitionDigest ? { definitionDigest: tool.definitionDigest } : {}),
        ...getMcpToolPresentation(tool)
    };
}

module.exports = {
    getMcpToolPresentation,
    normalizeCustomPresentation,
    presentMcpTool
};
