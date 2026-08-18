const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { formatToolList } = require('./agent-tool-catalog');
const { getRunnableModelForUserAsync, getUserRunnableModelsAsync } = require('./models');
const { listWorkflowCredentials, hasWorkflowCredentialAccess } = require('./workflow-credentials');

const MANAGED_CREDENTIAL_PREFIX = 'managed:';
const BOUND_CREDENTIAL_PREFIX = 'PIVOT_BOUND_CREDENTIAL_';

function invalid(message, status = 400, details = null) {
    const error = new Error(message);
    error.status = status;
    if (details) error.details = details;
    return error;
}

function cloneJson(value, fallback = {}) {
    try {
        return JSON.parse(JSON.stringify(value ?? fallback));
    } catch (_error) {
        return cloneJson(fallback, {});
    }
}

function parseBindings(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value || '{}');
        } catch (_error) {
            parsed = {};
        }
    }
    const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return {
        models: source.models && typeof source.models === 'object' && !Array.isArray(source.models) ? source.models : {},
        tools: source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools) ? source.tools : {},
        credentials: source.credentials && typeof source.credentials === 'object' && !Array.isArray(source.credentials) ? source.credentials : {}
    };
}

function dependencyTitle(node) {
    return String(node?.title || node?.id || '未命名节点');
}

function isSensitiveCredentialKey(value) {
    return /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|private[-_]?key)/i.test(String(value || ''));
}

function collectSensitiveObjectLiterals(value, path = '') {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, item]) => {
        const nextPath = path ? `${path}.${key}` : key;
        if (isSensitiveCredentialKey(key) && String(item ?? '').trim()) return [nextPath];
        return item && typeof item === 'object' ? collectSensitiveObjectLiterals(item, nextPath) : [];
    });
}

function findSensitiveHttpLiterals(node) {
    if (String(node?.tool || '').trim() !== 'agent.http') return [];
    const input = node?.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input : {};
    const headers = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers : {};
    const headerLiterals = Object.entries(headers)
        .filter(([key, value]) => isSensitiveCredentialKey(key) && String(value ?? '').trim())
        .map(([key]) => `headers.${key}`);
    const bodyLiterals = collectSensitiveObjectLiterals(input.body ?? input.data ?? {}, 'body');
    const url = String(input.url || '').trim();
    const urlLiterals = /[?&](authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|private[-_]?key)=([^&]+)/i.test(url)
        ? ['url']
        : [];
    return [...new Set([...headerLiterals, ...bodyLiterals, ...urlLiterals])].map(key => ({
        key,
        nodeId: String(node?.id || ''),
        title: dependencyTitle(node)
    }));
}

function addManifestItem(map, source, node) {
    if (!source) return;
    if (!map.has(source)) map.set(source, { source, nodes: [] });
    map.get(source).nodes.push({ nodeId: String(node?.id || ''), title: dependencyTitle(node) });
}

function isConfigurableTool(tool) {
    return /^mcp\./i.test(tool) || /^db\./i.test(tool);
}

function dependencyToolSource(node) {
    const tool = String(node?.tool || '').trim();
    const fullDatabaseTool = tool.match(/^mcp\.(\d+)\.(db\..+)$/i);
    if (fullDatabaseTool) return `${fullDatabaseTool[2]}#${fullDatabaseTool[1]}`;
    if (!/^db\./i.test(tool)) return tool;
    const input = node?.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input : {};
    const connectionId = String(
        input.connectionId ?? input.connection_id ?? input.databaseConnectionId ?? input.database_connection_id
        ?? input.mcpServerId ?? input.mcp_server_id ?? ''
    ).trim();
    return connectionId ? `${tool}#${connectionId}` : tool;
}

function buildAgentWorkflowDependencyManifest(dagSpec = {}) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const models = new Map();
    const tools = new Map();
    const credentials = new Map();
    const sensitiveLiterals = [];

    nodes.forEach(node => {
        const tool = String(node?.tool || '').trim();
        if (tool === 'agent.llm' || tool === 'agent.content_review') {
            const model = String(node?.input?.model || node?.input?.modelId || node?.input?.model_id || '').trim();
            addManifestItem(models, model, node);
        }
        if (isConfigurableTool(tool)) addManifestItem(tools, dependencyToolSource(node), node);
        if (tool === 'agent.http') {
            const slug = String(node?.input?.credentialSecret || node?.input?.credential_secret || '').trim().toUpperCase();
            addManifestItem(credentials, slug, node);
            sensitiveLiterals.push(...findSensitiveHttpLiterals(node));
        }
    });

    return {
        models: [...models.values()],
        tools: [...tools.values()],
        credentials: [...credentials.values()],
        sensitiveLiterals,
        summary: {
            modelCount: models.size,
            toolCount: tools.size,
            credentialCount: credentials.size,
            sensitiveLiteralCount: sensitiveLiterals.length,
            totalCount: models.size + tools.size + credentials.size
        }
    };
}

function setNodeModel(input, target) {
    if (Object.prototype.hasOwnProperty.call(input, 'model')) input.model = target;
    if (Object.prototype.hasOwnProperty.call(input, 'modelId')) input.modelId = target;
    if (Object.prototype.hasOwnProperty.call(input, 'model_id')) input.model_id = target;
}

function setNodeCredential(input, target) {
    if (Object.prototype.hasOwnProperty.call(input, 'credentialSecret')) input.credentialSecret = target;
    if (Object.prototype.hasOwnProperty.call(input, 'credential_secret')) input.credential_secret = target;
}

function applyAgentWorkflowDependencyBindings(dagSpec, bindings, credentialTargets = new Map(), toolTargets = new Map()) {
    const next = cloneJson(dagSpec, { nodes: [] });
    const normalized = parseBindings(bindings);
    const nodes = Array.isArray(next.nodes) ? next.nodes : [];
    nodes.forEach(node => {
        const originalTool = String(node?.tool || '').trim();
        const input = node?.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input : {};
        if (originalTool === 'agent.llm' || originalTool === 'agent.content_review') {
            const source = String(input.model || input.modelId || input.model_id || '').trim();
            const target = String(normalized.models[source] || '').trim();
            if (target) setNodeModel(input, target);
        }
        if (isConfigurableTool(originalTool)) {
            const selected = String(normalized.tools[dependencyToolSource(node)] || '').trim();
            const target = toolTargets.get(selected) || (selected ? { tool: selected, connectionId: '' } : null);
            if (target?.tool) {
                node.tool = target.tool;
                if (target.connectionId) input.connectionId = target.connectionId;
            }
        }
        if (originalTool === 'agent.http') {
            const source = String(input.credentialSecret || input.credential_secret || '').trim().toUpperCase();
            const selected = String(normalized.credentials[source] || '').trim();
            const target = selected.startsWith(MANAGED_CREDENTIAL_PREFIX)
                ? source
                : (credentialTargets.has(selected) ? `${BOUND_CREDENTIAL_PREFIX}${selected}` : '');
            if (target) setNodeCredential(input, target);
        }
        node.input = input;
    });
    return next;
}

async function inspectAgentWorkflowDependencies(dagSpec = {}, user = {}, options = {}) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const toolList = options.toolList || (await formatToolList(user, { toolPolicy: 'all' }));
    const toolsByName = new Map(toolList.map(tool => [String(tool.name || ''), tool]));
    const models = [];
    const tools = [];
    const credentials = [];
    const blockers = [];

    for (const node of nodes) {
        const tool = String(node?.tool || '').trim();
        const title = dependencyTitle(node);
        if (tool === 'agent.llm' || tool === 'agent.content_review') {
            const requestedModel = String(node?.input?.model || node?.input?.modelId || node?.input?.model_id || '').trim();
            if (requestedModel) {
                const available = Boolean(await getRunnableModelForUserAsync(requestedModel, user));
                models.push({ nodeId: node.id, title, requestedModel, available });
                if (!available) blockers.push(`${title} 引用的模型「${requestedModel}」对当前账号不可用。`);
            }
        }
        if (isConfigurableTool(tool)) {
            const available = toolsByName.has(tool);
            tools.push({ nodeId: node.id, title, requestedTool: tool, available });
            if (!available) blockers.push(`${title} 引用的工具「${tool}」对当前账号不可用。`);
        }
        if (tool === 'agent.http') {
            const slug = String(node?.input?.credentialSecret || node?.input?.credential_secret || '').trim().toUpperCase();
            if (slug) {
                const envName = `PIVOT_WORKFLOW_SECRET_${slug}`;
                const available = (await hasWorkflowCredentialAccess(slug, user)) || Boolean(process.env[envName]);
                credentials.push({ nodeId: node.id, title, slug, available });
                if (!available) blockers.push(`${title} 需要凭据「${slug}」，但当前账号没有可用授权。`);
            }
        }
    }

    return {
        status: blockers.length ? 'blocked' : 'ready',
        blockers,
        models,
        tools,
        credentials,
        summary: {
            modelCount: models.length,
            unavailableModelCount: models.filter(item => !item.available).length,
            toolCount: tools.length,
            unavailableToolCount: tools.filter(item => !item.available).length,
            credentialCount: credentials.length,
            unavailableCredentialCount: credentials.filter(item => !item.available).length
        }
    };
}

async function getBindingRow(workflowId, userId) {
    return await queryOne(`
        SELECT * FROM agent_workflow_dependency_bindings
        WHERE workflow_id = ? AND user_id = ?
    `, [workflowId, userId]);
}

async function buildDependencyCandidates(user, manifest) {
    const credentials = await listWorkflowCredentials(user);
    const managedCredentials = manifest.credentials
        .filter(item => Boolean(process.env[`PIVOT_WORKFLOW_SECRET_${item.source}`]))
        .map(item => ({
            id: `${MANAGED_CREDENTIAL_PREFIX}${item.source}`,
            slug: item.source,
            name: '平台托管凭据',
            owner_name: '',
            is_owner: false,
            managed: true
        }));
    const toolList = await formatToolList(user, { toolPolicy: 'all' });
    const toolCandidates = toolList.flatMap(tool => {
        if (!tool.databaseTool) {
            return [{
                binding_value: tool.name,
                name: tool.name,
                title: tool.title || tool.name,
                description: tool.description || '',
                source: tool.source || 'builtin',
                server_name: tool.serverName || '',
                connection_id: ''
            }];
        }
        return (tool.databaseConnections || []).map(connection => ({
            binding_value: `${tool.name}#${connection.connectionId || connection.serverId}`,
            name: tool.name,
            title: tool.title || tool.name,
            description: tool.description || '',
            source: tool.source || 'mcp',
            server_name: connection.serverName || tool.serverName || '',
            connection_id: String(connection.connectionId || connection.serverId || '')
        }));
    });
    const runnableModels = await getUserRunnableModelsAsync(user);
    return {
        models: runnableModels.map(model => ({
            id: String(model.id),
            name: model.name || model.model_name || `模型 ${model.id}`,
            model_name: model.model_name || '',
            provider: model.provider || model.provider_type || ''
        })),
        tools: toolCandidates,
        credentials: [
            ...credentials.map(item => ({
                id: String(item.id),
                slug: item.slug,
                name: item.name,
                owner_name: item.owner_name || '',
                is_owner: Boolean(item.is_owner),
                managed: false
            })),
            ...managedCredentials
        ]
    };
}

async function evaluateBinding(resolved, user, { includeCandidates = false } = {}) {
    const manifest = buildAgentWorkflowDependencyManifest(resolved.dagSpec);
    const isOwner = Number(resolved.workflow.user_id) === Number(user.id);
    const candidates = await buildDependencyCandidates(user, manifest);
    const row = isOwner ? null : await getBindingRow(resolved.workflow.id, user.id);
    const bindings = parseBindings(row?.bindings_json);
    const blockers = [];
    const stale = Boolean(row && Number(row.published_version_id) !== Number(resolved.version_id));

    if (!isOwner && manifest.summary.totalCount > 0) {
        if (!row) blockers.push('请先为当前账号配置并确认工作流依赖。');
        else if (stale) blockers.push('工作流已发布新版本，请重新确认依赖映射。');
    }
    if (!isOwner && manifest.sensitiveLiterals.length) {
        blockers.push('该工作流包含未托管的敏感 HTTP 凭据，请所有者改用凭据引用或平台托管执行。');
    }

    if (!isOwner && row && !stale) {
        const modelIds = new Set(candidates.models.map(item => String(item.id)));
        const toolNames = new Set(candidates.tools.map(item => item.binding_value));
        const credentialIds = new Set(candidates.credentials.map(item => String(item.id)));
        manifest.models.forEach(item => {
            const selected = String(bindings.models[item.source] || '');
            if (!selected) blockers.push(`模型「${item.source}」尚未映射。`);
            else if (!modelIds.has(selected)) blockers.push(`模型「${item.source}」的目标模型已不可用，请重新选择。`);
        });
        manifest.tools.forEach(item => {
            const selected = String(bindings.tools[item.source] || '');
            if (!selected) blockers.push(`工具「${item.source}」尚未映射。`);
            else if (!toolNames.has(selected)) blockers.push(`工具「${item.source}」的目标工具已不可用，请重新选择。`);
        });
        manifest.credentials.forEach(item => {
            const selected = String(bindings.credentials[item.source] || '');
            if (!selected) blockers.push(`凭据「${item.source}」尚未映射。`);
            else if (!credentialIds.has(selected)) blockers.push(`凭据「${item.source}」的授权已不可用，请重新选择。`);
        });
    }

    const canApply = isOwner || (row && !stale && blockers.length === 0);
    const credentialTargets = new Map(candidates.credentials.map(item => [String(item.id), item]));
    const toolTargets = new Map(candidates.tools.map(item => [String(item.binding_value), {
        tool: item.name,
        connectionId: item.connection_id || ''
    }]));
    const dagSpec = canApply && !isOwner
        ? applyAgentWorkflowDependencyBindings(resolved.dagSpec, bindings, credentialTargets, toolTargets)
        : cloneJson(resolved.dagSpec, { nodes: [] });
    if (canApply) {
        const report = await inspectAgentWorkflowDependencies(dagSpec, user, { toolList: await formatToolList(user, { toolPolicy: 'all' }) });
        blockers.push(...report.blockers);
    }

    return {
        dagSpec,
        dependencyBinding: {
            required: !isOwner && manifest.summary.totalCount > 0,
            can_configure: !isOwner,
            status: blockers.length ? 'blocked' : 'ready',
            stale,
            version_id: resolved.version_id,
            bound_version_id: row?.published_version_id || null,
            updated_at: row?.updated_at || '',
            blockers,
            manifest,
            bindings,
            ...(includeCandidates ? { candidates } : {})
        }
    };
}

async function resolveAgentWorkflowDependencyBindings(resolved, user, { enforce = true } = {}) {
    const evaluation = await evaluateBinding(resolved, user);
    if (enforce && evaluation.dependencyBinding.blockers.length) {
        throw invalid(`当前账号无法运行该工作流：${evaluation.dependencyBinding.blockers[0]}`, 409, {
            dependencies: evaluation.dependencyBinding
        });
    }
    return {
        ...resolved,
        dagSpec: evaluation.dagSpec,
        dependency_binding: evaluation.dependencyBinding
    };
}

async function getAgentWorkflowDependencyConfiguration(resolved, user) {
    const evaluation = await evaluateBinding(resolved, user, { includeCandidates: true });
    return {
        workflow: {
            id: resolved.workflow.id,
            name: resolved.workflow.name,
            version: resolved.version,
            version_id: resolved.version_id,
            is_owner: Number(resolved.workflow.user_id) === Number(user.id)
        },
        ...evaluation.dependencyBinding
    };
}

async function saveAgentWorkflowDependencyConfiguration(resolved, user, payload = {}) {
    if (Number(resolved.workflow.user_id) === Number(user.id)) {
        throw invalid('工作流所有者使用原始依赖，无需配置接收者映射。', 403);
    }
    const manifest = buildAgentWorkflowDependencyManifest(resolved.dagSpec);
    const candidates = await buildDependencyCandidates(user, manifest);
    const requested = parseBindings(payload.bindings || payload);
    const modelIds = new Set(candidates.models.map(item => String(item.id)));
    const toolNames = new Set(candidates.tools.map(item => item.binding_value));
    const credentialIds = new Set(candidates.credentials.map(item => String(item.id)));
    const bindings = { models: {}, tools: {}, credentials: {} };

    manifest.models.forEach(item => {
        const target = String(requested.models[item.source] || '').trim();
        if (!target || !modelIds.has(target)) throw invalid(`请为模型「${item.source}」选择当前账号可用的等价模型。`);
        bindings.models[item.source] = target;
    });
    manifest.tools.forEach(item => {
        const target = String(requested.tools[item.source] || '').trim();
        if (!target || !toolNames.has(target)) throw invalid(`请为工具「${item.source}」选择当前账号可用的等价工具。`);
        bindings.tools[item.source] = target;
    });
    manifest.credentials.forEach(item => {
        const target = String(requested.credentials[item.source] || '').trim();
        if (!target || !credentialIds.has(target)) throw invalid(`请为凭据「${item.source}」选择受控授权或平台托管执行。`);
        bindings.credentials[item.source] = target;
    });

    const now = getBeijingTimestamp();
    await execute(`
        INSERT INTO agent_workflow_dependency_bindings (
            workflow_id, user_id, published_version_id, bindings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_id, user_id) DO UPDATE SET
            published_version_id = excluded.published_version_id,
            bindings_json = excluded.bindings_json,
            updated_at = excluded.updated_at
    `, [resolved.workflow.id, user.id, resolved.version_id, JSON.stringify(bindings), now, now]);
    return await getAgentWorkflowDependencyConfiguration(resolved, user);
}

async function assertAgentWorkflowDependencies(dagSpec, user, options = {}) {
    const report = await inspectAgentWorkflowDependencies(dagSpec, user, options);
    if (!report.blockers.length) return report;
    throw invalid(`当前账号无法运行该工作流：${report.blockers[0]}`, 400, { dependencies: report });
}

module.exports = {
    MANAGED_CREDENTIAL_PREFIX,
    BOUND_CREDENTIAL_PREFIX,
    applyAgentWorkflowDependencyBindings,
    assertAgentWorkflowDependencies,
    buildAgentWorkflowDependencyManifest,
    getAgentWorkflowDependencyConfiguration,
    inspectAgentWorkflowDependencies,
    resolveAgentWorkflowDependencyBindings,
    saveAgentWorkflowDependencyConfiguration
};
