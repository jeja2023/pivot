'use strict';

const { approvalInputHash, findApprovalGrant } = require('./agent-approval-grants');

async function captureToolApprovalBinding(run, tool, input, user, deps = {}) {
    const serverId = Number(/^mcp\.(\d+)\./.exec(tool.name)?.[1] || input.connectionId || tool.serverId) || null;
    let release = null, item = null, server = null, connection = null;
    if (serverId) {
        server = await (deps.readServer || require('../repositories/tool-approval-binding').readApprovalServer)(serverId);
        release = await (deps.activeRelease || require('./tool-catalog-releases').activeRelease)(serverId);
        const items = release ? await (deps.releaseItems || require('./tool-catalog-releases').releaseItems)(release.id) : [];
        item = items.find(candidate => (candidate.tool_name || candidate.toolName) === tool.name.replace(/^mcp\.\d+\./, ''));
        const accountId = input.connectionAccountId ?? input.connection_account_id;
        if (accountId) connection = await (deps.assertUsable || require('./connection-accounts').assertUsable)(accountId, user, item?.auth_scopes || []);
        else if (item?.id) connection = (await (deps.resolveBoundConnection || require('./connection-accounts').resolveBoundConnection)(item.id, user))?.account;
    }
    return { version: 1, actorId: Number(user.id), runId: String(run.id), tool: tool.name,
        inputHash: approvalInputHash(input), contractDigest: approvalInputHash({ version: tool.version || '', input: tool.input_schema || {}, output: tool.output_schema || {},
            sideEffect: Boolean(tool.side_effect), risk: tool.risk_level || tool.risk || '', approval: tool.approval_required }),
        releaseId: release?.id || null, definitionDigest: item?.definition_digest || item?.definitionDigest || tool.definitionDigest || '',
        endpointDigest: server ? approvalInputHash({ url: server.base_url, config: server.config, status: server.status, auth: server.api_key }) : '',
        connectionId: connection?.id || null, connectionDigest: connection ? approvalInputHash({ id: connection.id, state: connection.auth_state,
            scopes: connection.scopes, expiry: connection.expires_at, updated: connection.updated_at }) : '' };
}

async function assertToolApprovalCurrent({ run, tool, input, user, key = '' }, deps = {}) {
    const grant = findApprovalGrant(run, tool.name, key, input);
    if (!grant) return;
    if (!grant.binding) throw Object.assign(new Error('旧操作授权缺少版本与连接绑定，请重新确认本次操作。'), { code: 'AGENT_APPROVAL_STALE', status: 409, category: 'policy' });
    const current = await captureToolApprovalBinding(run, tool, input, user, deps);
    if (approvalInputHash(current) !== approvalInputHash(grant.binding)) throw Object.assign(new Error('工具版本、目标连接或授权范围已变化，请重新确认本次操作。'),
        { code: 'AGENT_APPROVAL_STALE', status: 409, category: 'policy' });
}

module.exports = { assertToolApprovalCurrent, captureToolApprovalBinding };
