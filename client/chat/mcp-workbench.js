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

function mcpFormPrefix(mode = 'create') {
    return mode === 'edit' ? 'mcp-edit' : 'mcp';
}

function mcpFormEl(name, mode = 'create') {
    return document.getElementById(`${mcpFormPrefix(mode)}-${name}`);
}

function setMcpSourceType(type, mode = 'create') {
    const editableBuiltins = mode === 'edit' ? ['reports', 'visualization', 'report', 'documents', 'data', 'format', 'im'] : [];
    const sourceType = ['database', ...editableBuiltins].includes(type) ? type : 'external';
    const select = mcpFormEl('source-type', mode);
    if (select) {
        select.value = sourceType;
        // 系统卡片打开配置时，源类型由系统决定，不需要用户选择。
        const isSystemManaged = sourceType === 'database' || mcpBuiltinServices.some(item => item.type === sourceType);
        select.classList.toggle('hidden', isSystemManaged);
    }
    mcpFormEl('external-fields', mode)?.classList.toggle('hidden', sourceType !== 'external');
    mcpFormEl('db-fields', mode)?.classList.toggle('hidden', sourceType !== 'database');
    mcpFormEl('reports-fields', mode)?.classList.toggle('hidden', sourceType !== 'reports');
    mcpFormEl('im-fields', mode)?.classList.toggle('hidden', sourceType !== 'im');
    mcpFormEl('test-db-btn', mode)?.classList.toggle('hidden', sourceType !== 'database');
    const dbType = mcpFormEl('db-type', mode)?.value || 'postgres';
    const port = mcpFormEl('db-port', mode);
    if (sourceType === 'database' && port && !port.value) port.value = mcpDbDefaultPorts[dbType] || '';
    updateMcpDbTypeFields(mode);
}

function updateMcpDbTypeFields(mode = 'create') {
    const dbType = mcpFormEl('db-type', mode)?.value || 'postgres';
    mcpFormEl('db-host', mode)?.classList.toggle('hidden', dbType === 'sqlite');
    mcpFormEl('db-port', mode)?.classList.toggle('hidden', dbType === 'sqlite');
    mcpFormEl('db-user', mode)?.classList.toggle('hidden', dbType === 'sqlite');
    mcpFormEl('db-password', mode)?.classList.toggle('hidden', dbType === 'sqlite');
}

function setMcpFormDefaults(mode = 'create', type = 'external') {
    [
        'id', 'name', 'url', 'key', 'desc', 'db-host', 'db-port', 'db-name', 'db-user',
        'db-password', 'db-schema', 'db-max-rows', 'reports-roots', 'reports-extensions',
        'reports-max-file-mb', 'reports-max-rows', 'im-endpoint-url', 'im-auth-header',
        'im-token', 'im-allowed-targets', 'im-default-target', 'im-max-message-length'
    ].forEach(field => {
        const el = mcpFormEl(field, mode);
        if (el) el.value = '';
    });
    const dbSsl = mcpFormEl('db-ssl', mode);
    if (dbSsl) dbSsl.checked = false;
    const imAllowAtAll = mcpFormEl('im-allow-at-all', mode);
    if (imAllowAtAll) imAllowAtAll.checked = false;
    const shared = mcpFormEl('shared', mode);
    if (shared) shared.checked = false;
    const dbType = mcpFormEl('db-type', mode);
    if (dbType) dbType.value = 'postgres';
    setMcpSourceType(type, mode);
}

function bindMcpFormControls(mode = 'create') {
    const sourceType = mcpFormEl('source-type', mode);
    if (sourceType && sourceType.dataset.boundMcpSource !== '1') {
        sourceType.dataset.boundMcpSource = '1';
        sourceType.addEventListener('change', () => setMcpSourceType(sourceType.value, mode));
    }
    const dbType = mcpFormEl('db-type', mode);
    if (dbType && dbType.dataset.boundMcpType !== '1') {
        dbType.dataset.boundMcpType = '1';
        dbType.addEventListener('change', () => {
            const port = mcpFormEl('db-port', mode);
            if (port) port.value = mcpDbDefaultPorts[dbType.value] || '';
            updateMcpDbTypeFields(mode);
        });
    }
    const testButton = mcpFormEl('test-db-btn', mode);
    if (testButton && testButton.dataset.boundMcpTest !== '1') {
        testButton.dataset.boundMcpTest = '1';
        testButton.addEventListener('click', () => window.testMcpDatabaseConnection(mode));
    }
    updateMcpDbTypeFields(mode);
}

function bindMcpToolsModalControls() {
    const modal = document.getElementById('mcp-tools-modal');
    if (!modal || modal.dataset.boundMcpToolsModal === '1') return;
    modal.dataset.boundMcpToolsModal = '1';
    document.getElementById('mcp-tools-close-btn')?.addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('mcp-tools-refresh-btn')?.addEventListener('click', async event => {
        const id = event.currentTarget?.dataset?.mcpServerId;
        if (id) await window.refreshMcpTools(id, { keepToolsModalOpen: true });
    });
    modal.addEventListener('click', event => {
        if (event.target === modal) modal.classList.add('hidden');
    });
}

window.openMcpWorkbench = async function() {
    window.showMainWorkspace?.('mcp');
    const panel = document.getElementById('mcp-workbench-modal');
    if (!panel) return;
    bindMcpToolsModalControls();
    panel.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    panel.querySelectorAll('.super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    await window.loadMcpWorkbench?.();
};

window.closeMcpWorkbench = function() {
    window.showMainWorkspace?.('chat');
};

window.closeMcpEditModal = function() {
    document.getElementById('mcp-edit-modal')?.classList.add('hidden');
};

window.closeMcpToolsModal = function() {
    document.getElementById('mcp-tools-modal')?.classList.add('hidden');
};

function setMcpEditTitle(title = '编辑能力') {
    const heading = document.querySelector('#mcp-edit-modal .mcp-edit-header h3');
    if (heading) heading.textContent = title;
}

window.resetMcpForm = function() {
    setMcpFormDefaults('create', 'external');
};

window.openMcpCreateModal = function(type = 'external') {
    const service = mcpServiceCatalog.find(item => item.type === type) || mcpPersonalBuiltinServices.find(item => item.type === type);
    const modal = document.getElementById('mcp-edit-modal');
    if (!modal || !service) return;
    bindMcpFormControls('edit');
    setMcpEditTitle(service.title);
    setMcpFormDefaults('edit', type);
    const name = mcpFormEl('name', 'edit');
    if (name) name.value = service.defaultName || service.title;
    const desc = mcpFormEl('desc', 'edit');
    if (desc) desc.value = service.defaultDescription || service.description || '';
    const shared = mcpFormEl('shared', 'edit');
    if (shared) shared.checked = false;
    const dbType = mcpFormEl('db-type', 'edit');
    if (dbType && type === 'database') dbType.value = 'postgres';
    if (type === 'external') {
        mcpFormEl('url', 'edit').focus?.();
    }
    document.querySelectorAll('#mcp-edit-modal .admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    document.querySelectorAll('#mcp-edit-modal .super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    modal.classList.remove('hidden');
};

function fillMcpForm(server, mode = 'create') {
    const database = server.database_connection || {};
    const serverType = ['database', 'reports', 'visualization', 'report', 'im'].includes(server.server_type) ? server.server_type : 'external';
    setMcpSourceType(serverType, mode);
    mcpFormEl('id', mode).value = server.id || '';
    mcpFormEl('name', mode).value = server.name || '';
    mcpFormEl('url', mode).value = server.base_url || '';
    mcpFormEl('key', mode).value = server.has_api_key ? '********' : '';
    mcpFormEl('desc', mode).value = server.description || '';
    if (server.server_type === 'database') {
        mcpFormEl('db-type', mode).value = database.database_type || 'postgres';
        mcpFormEl('db-host', mode).value = database.host || '';
        mcpFormEl('db-port', mode).value = database.port || mcpDbDefaultPorts[database.database_type] || '';
        mcpFormEl('db-name', mode).value = database.database_name || '';
        mcpFormEl('db-user', mode).value = database.username || '';
        mcpFormEl('db-password', mode).value = database.has_password ? '********' : '';
        mcpFormEl('db-schema', mode).value = database.schema || '';
        mcpFormEl('db-max-rows', mode).value = database.max_rows || '';
        mcpFormEl('db-ssl', mode).checked = Boolean(database.ssl);
        updateMcpDbTypeFields(mode);
    }
    if (server.server_type === 'reports') {
        const config = server.builtin_config?.config || {};
        mcpFormEl('reports-roots', mode).value = (config.roots || []).join('\n');
        mcpFormEl('reports-extensions', mode).value = (config.extensions || []).join(',');
        mcpFormEl('reports-max-file-mb', mode).value = config.maxFileMb || '';
        mcpFormEl('reports-max-rows', mode).value = config.maxRows || '';
    }
    if (server.server_type === 'im') {
        const config = server.builtin_config?.config || {};
        mcpFormEl('im-endpoint-url', mode).value = config.endpointUrl || '';
        mcpFormEl('im-auth-header', mode).value = config.authHeader || 'Authorization';
        mcpFormEl('im-token', mode).value = server.builtin_config?.has_secret ? '********' : '';
        mcpFormEl('im-allowed-targets', mode).value = (config.allowedTargets || []).join('\n');
        mcpFormEl('im-default-target', mode).value = config.defaultTarget || '';
        mcpFormEl('im-max-message-length', mode).value = config.maxMessageLength || '';
        mcpFormEl('im-allow-at-all', mode).checked = Boolean(config.allowAtAll);
    }
    const shared = mcpFormEl('shared', mode);
    if (shared) shared.checked = !server.user_id;
}

window.openMcpEditModal = function(serverId) {
    const server = mcpServersCache.find(item => String(item.id) === String(serverId));
    if (!server) return showToast('未找到能力服务', 'error');
    const modal = document.getElementById('mcp-edit-modal');
    if (!modal) return;
    setMcpEditTitle('编辑能力');
    bindMcpFormControls('edit');
    fillMcpForm(server, 'edit');
    document.querySelectorAll('#mcp-edit-modal .admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    document.querySelectorAll('#mcp-edit-modal .super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    modal.classList.remove('hidden');
};

async function loadMcpServers() {
    const list = document.getElementById('mcp-server-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/mcp/servers`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '能力服务加载失败');
    mcpServersCache = data.data || [];
    const systemTypes = new Set(mcpSystemServices.map(item => item.type));
    const personalBuiltinTypes = new Set(mcpPersonalBuiltinServices.map(item => item.type));
    const userManagedServers = mcpServersCache.filter(server => !systemTypes.has(server.server_type));
    const personalConnectionServers = userManagedServers.filter(server => !personalBuiltinTypes.has(server.server_type));
    const logsByServer = new Map();
    mcpCallLogsCache.forEach(log => {
        const key = String(log.server_id || '');
        if (!key) return;
        if (!logsByServer.has(key)) logsByServer.set(key, []);
        logsByServer.get(key).push(log);
    });
    renderMcpSystemServices();
    const personalByType = new Map(mcpServersCache
        .filter(server => mcpPersonalBuiltinServices.some(item => item.type === server.server_type))
        .map(server => [server.server_type, server]));
    const databaseCount = userManagedServers.filter(server => server.server_type === 'database').length;
    list.innerHTML = `
        <div class="mcp-system-head">
            <div>
                <strong>个人能力</strong>
                <span>需要个人连接或个人配置的能力，保存后供当前用户调用。</span>
            </div>
        </div>
        <div class="mcp-system-grid">
            ${mcpServiceCatalog.map(service => `
                <div class="mcp-system-card mcp-connector-card">
                    <div class="mcp-system-card-head">
                        <strong>${mcpEscape(service.title)}</strong>
                        <em>${mcpEscape(databaseCount ? `${databaseCount} 个` : service.badge)}</em>
                    </div>
                    <p>${mcpEscape(service.description)}</p>
                    <div class="mcp-card-meta">${mcpEscape(databaseCount ? '可继续添加连接' : '配置后可查看工具')}</div>
                    <div class="mcp-system-actions">
                        <button class="btn-secondary" type="button" data-mcp-create="${mcpEscape(service.type)}">${mcpEscape(service.actionLabel)}</button>
                    </div>
                </div>
            `).join('')}
            ${mcpPersonalBuiltinServices.map(service => {
                const server = personalByType.get(service.type);
                return renderMcpServiceCard({
                    service,
                    server,
                    connector: true,
                    enabledEmptyText: '已配置，刷新后可查看工具',
                    configMetaText: '配置后可查看工具'
                });
            }).join('')}
            ${personalConnectionServers.map(server => {
        const database = server.database_connection || {};
        const typeLabel = server.server_type === 'database'
            ? (mcpDbToolLabels[database.database_type] || '数据库')
            : (mcpBuiltinToolLabels[server.server_type] || '外部服务');
        const serverTools = mcpToolsForServer(server.id, mcpFallbackToolsForServer(server));
        const isPaused = server.status === 'paused';
        const toolCount = serverTools.length;
        return `
        <div class="mcp-system-card mcp-connector-card mcp-instance-card${isPaused ? ' is-paused' : ''}">
            <div class="mcp-system-card-head mcp-instance-head">
                <div class="mcp-instance-title">
                    <strong>${mcpEscape(mcpCleanServiceName(server.name))}</strong>
                    <em>${mcpEscape(typeLabel)}</em>
                </div>
                <button class="mcp-status-toggle${isPaused ? '' : ' is-on'}" type="button" data-mcp-toggle="${server.id}" data-next-status="${isPaused ? 'active' : 'paused'}" aria-label="${isPaused ? '启用服务' : '停用服务'}" title="${isPaused ? '启用服务' : '停用服务'}">
                    <span></span>
                </button>
            </div>
            <div class="mcp-card-meta${server.last_error ? ' error-text' : ''}">
                ${mcpEscape(server.last_error || mcpToolPreviewText(server.id, mcpFallbackToolsForServer(server), toolCount ? `已接入 ${toolCount} 个工具` : '刷新后显示该服务工具'))}
            </div>
            <div class="mcp-system-actions mcp-instance-actions">
                <button class="btn-secondary" data-mcp-edit="${server.id}">编辑</button>
                <button class="btn-secondary" data-mcp-tools="${server.id}">工具</button>
                <button class="btn-danger-outline" data-mcp-delete="${server.id}">删除</button>
            </div>
        </div>
    `;
    }).join('')}
        </div>
        ${personalConnectionServers.length ? '' : `
            <div class="mcp-empty-panel">
                <strong>还没有个人能力</strong>
                <span>可以先配置一个数据库连接。</span>
            </div>
        `}
    `;
    list.querySelectorAll('[data-mcp-create]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpCreateModal(btn.dataset.mcpCreate));
    });
    list.querySelectorAll('[data-mcp-system-config]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpSystemConfig(btn.dataset.mcpSystemConfig));
    });
    list.querySelectorAll('[data-mcp-edit]').forEach(btn => btn.addEventListener('click', () => {
        window.openMcpEditModal(btn.dataset.mcpEdit);
    }));
    list.querySelectorAll('[data-mcp-tools]').forEach(btn => btn.addEventListener('click', () => window.openMcpToolsModal(btn.dataset.mcpTools)));
    list.querySelectorAll('[data-mcp-toggle]').forEach(btn => btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus)));
    list.querySelectorAll('[data-mcp-delete]').forEach(btn => btn.addEventListener('click', () => window.deleteMcpServer(btn.dataset.mcpDelete)));
}

function renderMcpSystemServices() {
    const box = document.getElementById('mcp-system-services');
    if (!box) return;
    const byType = new Map(mcpServersCache
        .filter(server => mcpSystemServices.some(item => item.type === server.server_type))
        .map(server => [server.server_type, server]));
    box.innerHTML = `
        <div class="mcp-system-head">
            <div>
                <strong>系统能力</strong>
                <span>系统能力由系统集成，可直接启用或在卡片里完成必要配置。</span>
            </div>
        </div>
        <div class="mcp-system-grid">
            ${mcpSystemServices.map(service => {
                const server = byType.get(service.type);
                return renderMcpServiceCard({ service, server });
            }).join('')}
        </div>
    `;
    box.querySelectorAll('[data-mcp-system-enable]').forEach(btn => {
        btn.addEventListener('click', () => window.ensureMcpSystemService(btn.dataset.mcpSystemEnable, btn));
    });
    box.querySelectorAll('[data-mcp-system-config]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpSystemConfig(btn.dataset.mcpSystemConfig));
    });
    box.querySelectorAll('[data-mcp-tools]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpToolsModal(btn.dataset.mcpTools));
    });
    box.querySelectorAll('[data-mcp-toggle]').forEach(btn => {
        btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus));
    });
}

window.openMcpSystemConfig = function(type) {
    const service = mcpBuiltinServices.find(item => item.type === type);
    if (!service?.requiresConfig) return showToast('该系统能力不需要额外配置', 'error');
    const existing = mcpServersCache.find(server => server.server_type === type);
    if (existing) return window.openMcpEditModal(existing.id);

    const modal = document.getElementById('mcp-edit-modal');
    if (!modal) return;
    bindMcpFormControls('edit');
    setMcpEditTitle(`配置${service.title}`);
    [
        'mcp-edit-id', 'mcp-edit-url', 'mcp-edit-key', 'mcp-edit-desc',
        'mcp-edit-im-endpoint-url', 'mcp-edit-im-auth-header', 'mcp-edit-im-token',
        'mcp-edit-im-allowed-targets', 'mcp-edit-im-default-target',
        'mcp-edit-im-max-message-length'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    setMcpSourceType(type, 'edit');
    mcpFormEl('name', 'edit').value = service.defaultName || service.title;
    mcpFormEl('desc', 'edit').value = service.defaultDescription || service.description || '';
    mcpFormEl('im-auth-header', 'edit').value = 'Authorization';
    const imAllowAtAll = mcpFormEl('im-allow-at-all', 'edit');
    if (imAllowAtAll) imAllowAtAll.checked = false;
    const shared = mcpFormEl('shared', 'edit');
    if (shared) shared.checked = false;
    document.querySelectorAll('#mcp-edit-modal .admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    document.querySelectorAll('#mcp-edit-modal .super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    modal.classList.remove('hidden');
};

window.openMcpToolsModal = function(serverId) {
    const server = mcpServersCache.find(item => String(item.id) === String(serverId));
    if (!server) return showToast('未找到能力服务', 'error');
    const modal = document.getElementById('mcp-tools-modal');
    const title = document.getElementById('mcp-tools-title');
    const list = document.getElementById('mcp-tools-list');
    if (!modal || !title || !list) return;
    const fallbackTools = mcpFallbackToolsForServer(server);
    const tools = mcpToolsForServer(server.id, fallbackTools);
    title.textContent = `${mcpCleanServiceName(server.name || '能力服务')} 的工具`;
    const refreshButton = document.getElementById('mcp-tools-refresh-btn');
    if (refreshButton) {
        refreshButton.dataset.mcpServerId = server.id;
        refreshButton.disabled = server.status === 'paused';
        refreshButton.textContent = server.status === 'paused' ? '已停用' : '刷新工具';
    }
    list.innerHTML = tools.length ? `
        <div class="mcp-tools-grid">
            ${tools.map(tool => `
                <div class="mcp-tool-card">
                    <div class="mcp-tool-card-head">
                        <strong>${mcpEscape(mcpToolTitle(tool))}</strong>
                    </div>
                    <p>${mcpEscape(mcpToolDescription(tool) || '暂无说明')}</p>
                    <div class="mcp-tool-meta">
                        <span>${mcpEscape(tool.name || tool.fullName || '')}</span>
                    </div>
                </div>
            `).join('')}
        </div>
    ` : '<div class="mcp-empty-panel compact"><strong>暂无工具</strong><span>请先刷新该能力服务，或确认它已启用并完成连接。</span></div>';
    modal.classList.remove('hidden');
};

window.ensureMcpSystemService = async function(type, button) {
    const service = mcpBuiltinServices.find(item => item.type === type);
    if (!service) return showToast('不支持的系统能力', 'error');
    const originalText = button?.textContent || '启用';
    if (button) {
        button.disabled = true;
        button.textContent = '处理中...';
    }
    try {
        const res = await apiFetch(`${API_BASE}/mcp/system-services/${encodeURIComponent(type)}/ensure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '系统能力启用失败', 'error');
        showToast(`${service.title} 已可用，刷新到 ${Number(data.tools?.length || 0)} 个工具`, 'success');
        await window.loadMcpWorkbench();
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

async function loadMcpTools() {
    const box = document.getElementById('mcp-tool-cache');
    const res = await apiFetch(`${API_BASE}/mcp/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具加载失败');
    mcpToolsCache = data.tools || [];
    if (box) box.innerHTML = '';
}

async function loadMcpGovernance() {
    const panel = document.getElementById('mcp-governance-panel');
    if (!panel) return;
    const [govRes, logsRes] = await Promise.all([
        apiFetch(`${API_BASE}/mcp/governance`),
        apiFetch(`${API_BASE}/mcp/call-logs?limit=60`)
    ]);
    const gov = await govRes.json().catch(() => ({}));
    const logs = await logsRes.json().catch(() => ({}));
    if (!govRes.ok || !logsRes.ok) {
        panel.innerHTML = '';
        return;
    }
    panel.className = 'workspace-governance-panel mcp-governance-panel';
    const s = gov.summary || {};
    mcpCallLogsCache = logs.data || [];
    panel.innerHTML = `
        <div class="mcp-governance-title">
            <div>
                <strong>能力治理</strong>
                <span>7 日 ${Number(s.calls7d || 0)} 调用 · ${Number(s.callErrors7d || 0)} 错误 · 平均 ${Number(s.avgDurationMs || 0)}ms</span>
            </div>
            <button id="mcp-refresh-btn" class="btn-secondary" type="button">刷新</button>
        </div>
        <div class="governance-metrics">
            <span><b>${Number(s.active || 0)}</b>活跃</span>
            <span><b>${Number(s.error || 0)}</b>异常</span>
            <span><b>${Number(s.unchecked || 0)}</b>未检查</span>
            <span><b>${Number(s.databaseServers || 0)}</b>数据库</span>
        </div>
    `;
    panel.querySelector('#mcp-refresh-btn')?.addEventListener('click', () => window.loadMcpWorkbench?.());
}

function collectMcpDatabasePayload(mode = 'create') {
    return {
        id: mcpFormEl('id', mode)?.value || undefined,
        name: mcpFormEl('name', mode)?.value.trim(),
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false,
        database_type: mcpFormEl('db-type', mode)?.value || 'postgres',
        host: mcpFormEl('db-host', mode)?.value.trim(),
        port: mcpFormEl('db-port', mode)?.value,
        database_name: mcpFormEl('db-name', mode)?.value.trim(),
        username: mcpFormEl('db-user', mode)?.value.trim(),
        password: mcpFormEl('db-password', mode)?.value,
        schema: mcpFormEl('db-schema', mode)?.value.trim(),
        max_rows: mcpFormEl('db-max-rows', mode)?.value,
        ssl: mcpFormEl('db-ssl', mode)?.checked || false
    };
}

function validateMcpDatabasePayload(payload, { requireName = true } = {}) {
    if (requireName && !payload.name) return '请填写连接名称';
    if (!payload.database_name) return '请填写数据库名；SQLite 请填写文件路径';
    if (payload.database_type !== 'sqlite' && !payload.host) return '请填写数据库主机地址';
    return '';
}

function collectMcpBuiltinPayload(type, mode = 'create') {
    const base = {
        id: mcpFormEl('id', mode)?.value || undefined,
        name: mcpFormEl('name', mode)?.value.trim(),
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false,
        service_type: type
    };
    if (type === 'reports') {
        return {
            ...base,
            roots: mcpFormEl('reports-roots', mode)?.value || '',
            extensions: mcpFormEl('reports-extensions', mode)?.value || '',
            maxFileMb: mcpFormEl('reports-max-file-mb', mode)?.value,
            maxRows: mcpFormEl('reports-max-rows', mode)?.value
        };
    }
    if (type !== 'im') return base;
    return {
        ...base,
        endpointUrl: mcpFormEl('im-endpoint-url', mode)?.value.trim(),
        authHeader: mcpFormEl('im-auth-header', mode)?.value.trim(),
        secret: mcpFormEl('im-token', mode)?.value,
        allowedTargets: mcpFormEl('im-allowed-targets', mode)?.value || '',
        defaultTarget: mcpFormEl('im-default-target', mode)?.value.trim(),
        maxMessageLength: mcpFormEl('im-max-message-length', mode)?.value,
        allowAtAll: mcpFormEl('im-allow-at-all', mode)?.checked || false
    };
}

function validateMcpBuiltinPayload(type, payload) {
    if (!payload.name) return '请填写服务名称';
    if (type === 'reports' && !String(payload.roots || '').trim()) return '请至少填写一个报表/数据文件目录';
    if (type === 'im' && !payload.endpointUrl) return '请填写局域网聊天工具 Webhook/API URL';
    return '';
}

function formatMcpDatabaseError(data, fallback = '数据库连接失败') {
    const parts = [data?.error || fallback];
    if (data?.hint) parts.push(data.hint);
    if (data?.diagnostics?.host) {
        parts.push(`目标：${data.diagnostics.host}${data.diagnostics.port ? `:${data.diagnostics.port}` : ''}`);
    }
    return parts.filter(Boolean).join('\n');
}

window.testMcpDatabaseConnection = async function(mode = 'create') {
    if ((mcpFormEl('source-type', mode)?.value || 'external') !== 'database') {
        return showToast('请先选择数据库连接', 'error');
    }
    const payload = collectMcpDatabasePayload(mode);
    const error = validateMcpDatabasePayload(payload, { requireName: false });
    if (error) return showToast(error, 'error');

    const button = mcpFormEl('test-db-btn', mode);
    const originalText = button?.textContent || '测试连接';
    if (button) {
        button.disabled = true;
        button.textContent = '测试中...';
    }
    try {
        const res = await apiFetch(`${API_BASE}/mcp/database-connections/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) return showToast(formatMcpDatabaseError(data, '连接测试失败'), 'error');
        return showToast('数据库连接测试通过', 'success');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

window.saveMcpServer = async function(mode = 'create') {
    const id = mcpFormEl('id', mode)?.value;
    const sourceType = mcpFormEl('source-type', mode)?.value || 'external';
    let payload = {
        name: mcpFormEl('name', mode)?.value.trim(),
        base_url: mcpFormEl('url', mode)?.value.trim(),
        api_key: mcpFormEl('key', mode)?.value,
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false
    };
    let endpoint = `${API_BASE}/mcp/servers${id ? `/${encodeURIComponent(id)}` : ''}`;
    if (sourceType === 'database') {
        payload = collectMcpDatabasePayload(mode);
        endpoint = `${API_BASE}/mcp/database-connections${id ? `/${encodeURIComponent(id)}` : ''}`;
        const error = validateMcpDatabasePayload(payload);
        if (error) return showToast(error, 'error');
    } else if (['reports', 'visualization', 'report', 'documents', 'data', 'format', 'im'].includes(sourceType)) {
        payload = collectMcpBuiltinPayload(sourceType, mode);
        endpoint = `${API_BASE}/mcp/builtin-services${id ? `/${encodeURIComponent(id)}` : ''}`;
        const error = validateMcpBuiltinPayload(sourceType, payload);
        if (error) return showToast(error, 'error');
    } else if (!payload.name || !payload.base_url) {
        return showToast('请填写服务名称和 URL', 'error');
    }
    const res = await apiFetch(endpoint, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(formatMcpDatabaseError(data, '保存失败'), 'error');
    showToast('能力服务已保存', 'success');
    if (mode === 'edit') {
        window.closeMcpEditModal();
    } else {
        window.resetMcpForm();
    }
    await window.loadMcpWorkbench();
};

window.refreshMcpTools = async function(id, options = {}) {
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '刷新失败', 'error');
    showToast(`已刷新 ${data.tools.length} 个工具`, 'success');
    await window.loadMcpWorkbench();
    if (options.keepToolsModalOpen) window.openMcpToolsModal(id);
};

window.toggleMcpServerStatus = async function(id, nextStatus = 'paused') {
    const server = mcpServersCache.find(item => String(item.id) === String(id));
    if (!server) return showToast('未找到能力服务', 'error');
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus === 'paused' ? 'paused' : 'active' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(formatMcpDatabaseError(data, '状态更新失败'), 'error');
    showToast(nextStatus === 'paused' ? '能力服务已停用' : '能力服务已启用', 'success');
    await window.loadMcpWorkbench();
};

window.deleteMcpServer = function(id) {
    showConfirm('删除能力服务', '确定删除这个能力服务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除失败', 'error');
        showToast('能力服务已删除', 'success');
        await window.loadMcpWorkbench();
    });
};

window.loadMcpWorkbench = async function() {
    try {
        await loadMcpGovernance();
        await loadMcpTools();
        await loadMcpServers();
    } catch (e) {
        showToast(e.message, 'error');
    }
};



