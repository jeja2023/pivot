'use strict';

/** Publish-time tool release snapshots for workflow reproducibility. */
const { query, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { activeRelease, releaseItems } = require('./tool-catalog-releases');

function parseJson(value, fallback = []) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; }
}

function mcpReferenceForNode(node = {}) {
    const direct = String(node.tool || '').trim();
    const full = /^mcp\.(\d+)\.(.+)$/.exec(direct);
    if (full) return { serverId: Number(full[1]), toolName: full[2], fullName: direct };
    if (!/^db\./.test(direct)) return null;
    const input = node.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input : {};
    const connectionId = input.connectionId ?? input.connection_id ?? input.databaseConnectionId ?? input.database_connection_id ?? input.mcpServerId ?? input.mcp_server_id;
    const serverId = Number(connectionId);
    return Number.isSafeInteger(serverId) && serverId > 0
        ? { serverId, toolName: direct, fullName: `mcp.${serverId}.${direct}` }
        : null;
}

async function buildWorkflowToolReleaseBindings(dagSpec = {}, deps = {}) {
    const getActiveRelease = deps.activeRelease || activeRelease;
    const getReleaseItems = deps.releaseItems || releaseItems;
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const bindings = [];
    for (const node of nodes) {
        const reference = mcpReferenceForNode(node);
        if (!reference) continue;
        const release = await getActiveRelease(reference.serverId);
        const items = release?.id ? await getReleaseItems(release.id) : [];
        const item = items.find(candidate => String(candidate.tool_name || candidate.toolName) === reference.toolName);
        bindings.push({
            nodeId: String(node.id || '').slice(0, 160),
            toolName: reference.fullName,
            serverId: reference.serverId,
            releaseId: release?.id || null,
            definitionDigest: item?.definitionDigest || item?.definition_digest || '',
            capturedAt: getBeijingTimestamp()
        });
    }
    return bindings;
}

async function persistWorkflowToolReleaseBindings(releaseId, dagSpec, deps = {}) {
    const write = deps.execute || execute;
    const bindings = await buildWorkflowToolReleaseBindings(dagSpec, deps);
    await write(`
        UPDATE agent_workflow_releases
        SET tool_release_bindings = ?::jsonb, tool_dependency_stale = FALSE,
            tool_dependency_stale_at = NULL, tool_dependency_stale_reason = ''
        WHERE id = ?
    `, [JSON.stringify(bindings), releaseId]);
    return bindings;
}

async function markWorkflowToolDependenciesStale(serverId, activeReleaseId, deps = {}) {
    const read = deps.query || query;
    const write = deps.execute || execute;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;
    const rows = await read(`
        SELECT id, tool_release_bindings
        FROM agent_workflow_releases
        WHERE status = 'published' AND tool_dependency_stale = FALSE
    `);
    const staleIds = rows.filter(row => parseJson(row.tool_release_bindings, []).some(binding =>
        Number(binding?.serverId) === Number(serverId)
        && Number(binding?.releaseId || 0) > 0
        && Number(binding?.releaseId) !== Number(activeReleaseId)
    )).map(row => row.id);
    if (!staleIds.length) return [];
    await write(`
        UPDATE agent_workflow_releases
        SET tool_dependency_stale = TRUE, tool_dependency_stale_at = ?,
            tool_dependency_stale_reason = ?
        WHERE id = ANY(?)
    `, [now(), `工具目录服务 ${serverId} 已激活新版本 ${activeReleaseId}，请重新确认并发布工作流。`, staleIds]);
    return staleIds;
}

module.exports = {
    buildWorkflowToolReleaseBindings,
    markWorkflowToolDependenciesStale,
    mcpReferenceForNode,
    persistWorkflowToolReleaseBindings
};
