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

