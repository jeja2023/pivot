function mcpFormPrefix(mode = 'create') {
    return mode === 'edit' ? 'mcp-edit' : 'mcp';
}

function mcpFormEl(name, mode = 'create') {
    return document.getElementById(`${mcpFormPrefix(mode)}-${name}`);
}

const MCP_CONFIG_HELPERS = {
    external: {
        title: '外部能力服务',
        steps: ['填写服务名称', '粘贴技术同事提供的服务地址', '需要鉴权时填写访问密钥'],
        note: '普通用户通常先使用系统能力；外部能力服务需要由技术同事提供地址和密钥。'
    },
    database: {
        title: '数据库连接',
        steps: ['选择数据库类型', '填写主机和数据库名', '先点“测试连接”，通过后再保存'],
        note: '默认只读查询并限制返回行数，不会执行写入 SQL。'
    },
    reports: {
        title: '报表文件',
        steps: ['填写报表目录', '确认允许的文件格式', '保存后查看可用动作'],
        note: '适合把共享目录里的 Excel、CSV、JSON、Markdown 文件交给模型读取。'
    },
    im: {
        title: '消息通知',
        steps: ['填写聊天工具接收地址', '按需填写访问密钥', '白名单里每行写一个可发送目标'],
        note: '建议先配置一个测试群或测试用户，确认能收到消息后再扩大白名单。'
    },
    visualization: {
        title: '图表生成',
        steps: ['保存默认名称', '回到能力库查看动作', '聊天中打开能力库后让模型生成图表'],
        note: '系统内置能力无需额外连接，适合先验证能力库是否可用。'
    },
    report: {
        title: '报告编排',
        steps: ['保存默认名称', '回到能力库查看动作', '把摘要、表格、图表组合成报告'],
        note: '适合日报、周报和固定格式分析报告。'
    },
    documents: {
        title: '文档解析',
        steps: ['保存默认名称', '回到能力库查看动作', '让模型提取大纲、键值或分段'],
        note: '适合合同、制度、说明书等长文档的结构化处理。'
    },
    data: {
        title: '数据处理',
        steps: ['保存默认名称', '回到能力库查看动作', '让模型做筛选、汇总和字段标准化'],
        note: '适合表格行数据的清洗、分组统计和字段画像。'
    },
    format: {
        title: '格式转换',
        steps: ['保存默认名称', '回到能力库查看动作', '让模型在 JSON、Markdown 表格和文本之间转换'],
        note: '适合整理模型输出或把杂乱文本转成结构化格式。'
    }
};

const MCP_DATABASE_TYPE_TIPS = {
    postgres: 'PostgreSQL 常用端口 5432；数据分组/Schema 不确定时可以先留空。',
    mysql: 'MySQL/MariaDB 常用端口 3306；数据库名通常是业务库名称。',
    sqlserver: 'SQL Server 常用端口 1433；数据分组/Schema 常见为 dbo，不确定可留空。',
    sqlite: 'SQLite 只需要填写数据库文件路径，主机、端口、用户名和密码会自动隐藏。',
    mongodb: 'MongoDB 常用端口 27017；数据库名填写要查询的 database。'
};

const MCP_DATABASE_PLACEHOLDERS = {
    postgres: {
        host: '主机地址，例如 10.0.0.8',
        port: '端口，默认 5432',
        name: '数据库名，例如 analytics',
        user: '只读账号用户名',
        password: '只读账号密码',
        schema: '数据分组/Schema，可选，例如 public；不确定留空'
    },
    mysql: {
        host: '主机地址，例如 10.0.0.8',
        port: '端口，默认 3306',
        name: '数据库名，例如 biz',
        user: '只读账号用户名',
        password: '只读账号密码',
        schema: '可留空'
    },
    sqlserver: {
        host: '主机地址，例如 10.0.0.8',
        port: '端口，默认 1433',
        name: '数据库名，例如 BI',
        user: '只读账号用户名',
        password: '只读账号密码',
        schema: '数据分组/Schema，可选，例如 dbo；不确定留空'
    },
    sqlite: {
        host: 'SQLite 不需要主机',
        port: 'SQLite 不需要端口',
        name: 'SQLite 文件路径，例如 D:\\data\\report.db',
        user: 'SQLite 不需要用户名',
        password: 'SQLite 不需要密码',
        schema: '可留空'
    },
    mongodb: {
        host: '主机地址，例如 10.0.0.8',
        port: '端口，默认 27017',
        name: '数据库名，例如 admin 或 reporting',
        user: '只读账号用户名，可选',
        password: '只读账号密码，可选',
        schema: '集合前缀或命名空间，可选；不确定留空'
    }
};

function updateMcpConfigHelper(mode = 'create') {
    const helper = mcpFormEl('helper', mode);
    if (!helper) return;
    const sourceType = mcpFormEl('source-type', mode)?.value || 'external';
    const config = MCP_CONFIG_HELPERS[sourceType] || MCP_CONFIG_HELPERS.external;
    const dbType = mcpFormEl('db-type', mode)?.value || 'postgres';
    const note = sourceType === 'database'
        ? `${config.note} ${MCP_DATABASE_TYPE_TIPS[dbType] || ''}`.trim()
        : config.note;
    helper.innerHTML = `
        <strong>${mcpEscape(config.title)}配置助手</strong>
        <div>${config.steps.map(step => `<span>${mcpEscape(step)}</span>`).join('')}</div>
        <small>${mcpEscape(note)}</small>
    `;
}

function setMcpPlaceholder(id, value, mode = 'create') {
    const el = mcpFormEl(id, mode);
    if (el) el.placeholder = value;
}

function updateMcpDatabaseGuidance(mode = 'create') {
    const dbType = mcpFormEl('db-type', mode)?.value || 'postgres';
    const placeholders = MCP_DATABASE_PLACEHOLDERS[dbType] || MCP_DATABASE_PLACEHOLDERS.postgres;
    setMcpPlaceholder('db-host', placeholders.host, mode);
    setMcpPlaceholder('db-port', placeholders.port, mode);
    setMcpPlaceholder('db-name', placeholders.name, mode);
    setMcpPlaceholder('db-user', placeholders.user, mode);
    setMcpPlaceholder('db-password', placeholders.password, mode);
    setMcpPlaceholder('db-schema', placeholders.schema, mode);
}

function setValueIfEmpty(id, value, mode = 'create') {
    const el = mcpFormEl(id, mode);
    if (el && !String(el.value || '').trim()) el.value = value;
}

function applyMcpRecommendedDefaults(type, mode = 'create') {
    if (type === 'database') {
        setValueIfEmpty('db-max-rows', '200', mode);
    }
    if (type === 'reports') {
        setValueIfEmpty('reports-extensions', 'csv,xlsx,xls,json,txt,md', mode);
        setValueIfEmpty('reports-max-file-mb', '20', mode);
        setValueIfEmpty('reports-max-rows', '500', mode);
    }
    if (type === 'im') {
        setValueIfEmpty('im-auth-header', 'Authorization', mode);
        setValueIfEmpty('im-max-message-length', '2000', mode);
    }
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
    updateMcpDatabaseGuidance(mode);
    applyMcpRecommendedDefaults(sourceType, mode);
    updateMcpConfigHelper(mode);
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
            updateMcpDatabaseGuidance(mode);
            updateMcpDbTypeFields(mode);
            updateMcpConfigHelper(mode);
        });
    }
    const testButton = mcpFormEl('test-db-btn', mode);
    if (testButton && testButton.dataset.boundMcpTest !== '1') {
        testButton.dataset.boundMcpTest = '1';
        testButton.addEventListener('click', () => window.testMcpDatabaseConnection(mode));
    }
    updateMcpDbTypeFields(mode);
    updateMcpDatabaseGuidance(mode);
    updateMcpConfigHelper(mode);
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
    const editableTypes = ['database', ...mcpBuiltinServices.map(item => item.type)];
    const serverType = editableTypes.includes(server.server_type) ? server.server_type : 'external';
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
        updateMcpDatabaseGuidance(mode);
        updateMcpConfigHelper(mode);
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

