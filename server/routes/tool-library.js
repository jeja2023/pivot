'use strict';

const express = require('express');
const { asyncHandler } = require('../http');
const { callMcpJsonRpc, getAccessibleMcpServer, executeMcpTool } = require('../services/mcp-client');
const { executeBuiltInTool } = require('../services/agent-tools');
const { formatToolList } = require('../services/agent-tool-catalog');
const { invalidate: invalidateMcpToolCatalog } = require('../services/mcp-tool-catalog-index');
const { defaultToolPolicyEngine } = require('../services/tool-policy-engine');
const { list: listReleases, activate, releaseItems, compareCatalogReleases } = require('../services/tool-catalog-releases');
const { assertUsable, listForUser, getForUser, transition, createAccount, bindToolConnection } = require('../services/connection-accounts');
const { publicConnectorDefinition, startAuthorization, completeAuthorization, refreshAccount, revokeAccount, saveConnectorDefinition } = require('../services/connection-oauth');
const { query: selectMany, queryOne: selectOne } = require('../db/client');
const {
    createToolkitRelease,
    listToolkitReleases,
    registerToolkitSigningKey,
    reviewToolkitRelease,
    validateToolkitRelease
} = require('../services/toolkit-supply-chain');
const { listToolInvocationEventsForUser, getToolInvocationEventForUser } = require('../services/tool-invocation-events');
const toolTasks = require('../services/tool-tasks');
const {
    createToolEvalSuite,
    getToolEvalRun,
    listToolEvalCases,
    listToolEvalSuites,
    runToolEvaluation,
    saveToolEvalCase
} = require('../services/tool-evaluations');
const { isSuperAdmin } = require('../permissions');

function safeLimit(value, fallback = 60, maximum = 300) {
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), maximum);
}

function compactCatalogItem(item = {}) {
    return {
        toolRef: {
            serverId: item.server_id,
            releaseId: item.release_id,
            toolName: item.tool_name,
            definitionDigest: item.definitionDigest || item.definition_digest || ''
        },
        name: item.full_name || `mcp.${item.server_id}.${item.tool_name}`,
        title: item.title || item.tool_name,
        description: item.description || '',
        riskLevel: item.risk_level || 'medium',
        capabilities: item.capabilities || [],
        tags: item.tags || [],
        requiresConnection: Array.isArray(item.authScopes || item.auth_scopes) && (item.authScopes || item.auth_scopes).length > 0,
        approvalRequired: item.risk_level === 'high' || item.risk_level === 'critical' || Boolean(item.side_effect)
    };
}

function createToolLibraryRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    router.get('/tools/catalog', authMiddleware, asyncHandler(async (req, res) => {
        const queryText = String(req.query.query || '').trim().toLowerCase();
        const tools = await formatToolList(req.user);
        const items = tools.filter(tool => {
            if (!queryText) return true;
            return [tool.name, tool.title, tool.description, ...(tool.capabilities || [])].join(' ').toLowerCase().includes(queryText);
        }).slice(0, safeLimit(req.query.limit, 100, 500)).map(tool => ({
            toolRef: { toolName: tool.name, definitionDigest: tool.definition_digest || '' },
            name: tool.name, title: tool.title, description: tool.description,
            riskLevel: tool.risk_level || tool.risk || 'low', capabilities: tool.capabilities || [],
            source: tool.source || 'builtin', requiresConnection: false,
            approvalRequired: Boolean(tool.approval_required || tool.requiresApproval)
        }));
        res.json({ data: items });
    }));

    router.get('/tools/servers/:id/releases', authMiddleware, asyncHandler(async (req, res) => {
        const server = await getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: '工具服务不存在。' });
        res.json({ data: await listReleases(server.id, { limit: safeLimit(req.query.limit, 30, 200) }) });
    }));

    router.get('/tools/servers/:id/releases/:releaseId', authMiddleware, asyncHandler(async (req, res) => {
        const server = await getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: '工具服务不存在。' });
        const items = await releaseItems(Number(req.params.releaseId));
        if (!items.length || items.some(item => Number(item.server_id) !== Number(server.id))) return res.status(404).json({ error: '工具目录版本不存在。' });
        res.json({ data: items.map(compactCatalogItem) });
    }));

    router.get('/tools/servers/:id/releases/:releaseId/diff', authMiddleware, asyncHandler(async (req, res) => {
        const server = await getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: '工具服务不存在。' });
        const targetItems = await releaseItems(Number(req.params.releaseId));
        if (!targetItems.length || targetItems.some(item => Number(item.server_id) !== Number(server.id))) return res.status(404).json({ error: '工具目录版本不存在。' });
        const prior = (await listReleases(server.id, { limit: 200 })).find(item => Number(item.id) !== Number(req.params.releaseId));
        const previousItems = prior ? await releaseItems(prior.id) : [];
        res.json({ data: { fromRelease: prior || null, toReleaseId: Number(req.params.releaseId), comparison: compareCatalogReleases(previousItems, targetItems) } });
    }));

    router.post('/tools/servers/:id/releases/:releaseId/activate', authMiddleware, asyncHandler(async (req, res) => {
        const server = await getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: '工具服务不存在。' });
        if (Number(server.user_id) !== Number(req.user.id) && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权激活该工具目录版本。' });
        const release = await activate(server.id, Number(req.params.releaseId), req.user);
        invalidateMcpToolCatalog();
        logAction(req, '激活工具目录版本', `${server.name}: ${release.release_version}`);
        res.json({ success: true, data: release });
    }));

    router.get('/connection-accounts', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listForUser(req.user, { includeInactive: req.query.includeInactive === 'true' }) });
    }));

    router.get('/connectors', authMiddleware, asyncHandler(async (_req, res) => {
        const rows = await selectMany("SELECT * FROM connector_definitions WHERE status = 'active' ORDER BY category ASC, display_name ASC");
        res.json({ data: rows.map(publicConnectorDefinition) });
    }));

    router.post('/connectors', authMiddleware, asyncHandler(async (req, res) => {
        const connector = await saveConnectorDefinition(req.user, req.body || {});
        logAction(req, '维护连接器定义', connector.slug);
        res.status(201).json({ success: true, data: connector });
    }));

    router.get('/toolkits', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listToolkitReleases(req.user, { includeAll: req.query.includeAll === 'true' }) });
    }));

    router.post('/toolkits', authMiddleware, asyncHandler(async (req, res) => {
        const release = await createToolkitRelease(req.user, req.body || {});
        logAction(req, '创建工具包版本草稿', `${release.slug}@${release.version}`);
        res.status(201).json({ success: true, data: release });
    }));

    router.post('/toolkits/signing-keys', authMiddleware, asyncHandler(async (req, res) => {
        const key = await registerToolkitSigningKey(req.user, req.body || {});
        logAction(req, '登记工具包签名密钥', key.key_id);
        res.status(201).json({ success: true, data: { keyId: key.key_id, publisher: key.publisher, status: key.status, expiresAt: key.expires_at || null } });
    }));

    router.post('/toolkits/:id/validate', authMiddleware, asyncHandler(async (req, res) => {
        const release = await validateToolkitRelease(req.params.id, req.user, req.body || {});
        if (!release) return res.status(404).json({ error: '工具包版本不存在或无权访问。' });
        logAction(req, '校验工具包版本', `${release.slug}@${release.version}`);
        res.json({ success: true, data: release });
    }));

    router.post('/toolkits/:id/review', authMiddleware, asyncHandler(async (req, res) => {
        const release = await reviewToolkitRelease(req.params.id, req.user, req.body || {});
        if (!release) return res.status(404).json({ error: '工具包版本不存在。' });
        logAction(req, release.status === 'published' ? '发布工具包版本' : '阻断工具包版本', `${release.slug}@${release.version}`);
        res.json({ success: true, data: release });
    }));

    router.post('/connection-accounts', authMiddleware, asyncHandler(async (req, res) => {
        const account = await createAccount(req.user, req.body || {});
        logAction(req, '创建连接账户', account.display_name);
        res.status(201).json({ success: true, data: account });
    }));

    router.post('/connection-accounts/:id/bindings', authMiddleware, asyncHandler(async (req, res) => {
        const binding = await bindToolConnection(req.user, { ...(req.body || {}), connectionAccountId: req.params.id });
        logAction(req, '绑定工具连接账户', `连接账户: ${req.params.id}，工具目录项: ${binding.tool_item_id}`);
        res.status(201).json({ success: true, data: binding });
    }));

    router.get('/connection-accounts/:id', authMiddleware, asyncHandler(async (req, res) => {
        const account = await getForUser(req.params.id, req.user);
        if (!account) return res.status(404).json({ error: '连接账户不存在。' });
        res.json({ data: account });
    }));

    router.post('/connection-accounts/:id/authorize', authMiddleware, asyncHandler(async (req, res) => {
        const authorization = await startAuthorization(req.params.id, req.user, req.body || {});
        logAction(req, '发起 OAuth 连接授权', `连接账户: ${req.params.id}`);
        res.json({ success: true, data: authorization });
    }));

    // Connection verification never invokes a business tool.  It validates the
    // account's current authorization and, for MCP-backed accounts, performs a
    // safe tools/list handshake using the selected account's bearer token.
    router.post('/connection-accounts/:id/test', authMiddleware, asyncHandler(async (req, res) => {
        const account = await assertUsable(req.params.id, req.user);
        let toolCount = null;
        if (account.server_id) {
            const server = await getAccessibleMcpServer(account.server_id, req.user);
            if (!server || server.status !== 'active') {
                return res.status(409).json({ error: '关联的工具服务当前不可用，请先恢复服务后再测试连接。' });
            }
            const result = await callMcpJsonRpc(server, 'tools/list', {}, req.user, { connectionAccountId: account.id });
            toolCount = Array.isArray(result?.tools) ? result.tools.length : 0;
        }
        logAction(req, '测试连接账户', account.display_name);
        res.json({ success: true, data: { accountId: account.id, authState: account.auth_state, scopes: account.scopes || [], toolCount } });
    }));

    router.get('/connection-accounts/oauth/callback', authMiddleware, asyncHandler(async (req, res) => {
        const account = await completeAuthorization({
            state: req.query?.state, code: req.query?.code, error: req.query?.error,
            errorDescription: req.query?.error_description, user: req.user
        });
        logAction(req, '完成 OAuth 连接授权', `连接账户: ${account.id}`);
        res.json({ success: true, data: account });
    }));

    router.post('/connection-accounts/:id/:action', authMiddleware, asyncHandler(async (req, res) => {
        const action = req.params.action;
        if (!['refresh', 'revoke', 'disable'].includes(action)) {
            return res.status(404).json({ error: '不支持的操作。' });
        }
        let account;
        if (action === 'refresh') {
            const existing = await getForUser(req.params.id, req.user);
            account = existing?.auth_type === 'oauth2'
                ? await refreshAccount(req.params.id, req.user)
                : existing?.encrypted_secret_ref === 'configured'
                    ? await transition(req.params.id, req.user, { authState: 'active', lastError: '' })
                    : (() => { const error = new Error('该连接账户尚未配置凭据，请先完成授权。'); error.status = 409; error.code = 'CONNECTION_ACCOUNT_REAUTH_REQUIRED'; throw error; })();
        } else if (action === 'revoke') {
            const existing = await getForUser(req.params.id, req.user);
            account = existing?.auth_type === 'oauth2'
                ? (await revokeAccount(req.params.id, req.user)).account
                : await transition(req.params.id, req.user, { authState: 'revoked' });
        } else {
            account = await transition(req.params.id, req.user, { authState: 'disabled' });
        }
        if (!account) return res.status(404).json({ error: '连接账户不存在。' });
        logAction(req, `${action === 'refresh' ? '刷新' : action === 'revoke' ? '撤销' : '停用'}连接账户`, account.display_name);
        res.json({ success: true, data: account });
    }));

    router.post('/tools/search', authMiddleware, asyncHandler(async (req, res) => {
        const queryText = String(req.body?.query || '').trim().toLowerCase();
        if (!queryText) return res.status(400).json({ error: '请提供工具搜索关键词。' });
        const tools = await formatToolList(req.user);
        const tokens = queryText.split(/\s+/).filter(Boolean);
        const scored = tools.map(tool => {
            const text = [tool.name, tool.title, tool.description, ...(tool.capabilities || [])].join(' ').toLowerCase();
            const score = tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
            return { tool, score };
        }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || String(a.tool.name).localeCompare(String(b.tool.name))).slice(0, safeLimit(req.body?.limit, 5, 20));
        res.json({ data: scored.map(item => ({
            ...compactCatalogItem({ ...item.tool, tool_name: item.tool.name, full_name: item.tool.name, risk_level: item.tool.risk_level || item.tool.risk, authScopes: [] }),
            score: item.score,
            reason: '名称、描述或能力标签与查询匹配。'
        })) });
    }));

    router.post('/tools/describe', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.toolRef?.toolName || req.body?.tool || req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: '请指定工具。' });
        const requestedReleaseId = Number(req.body?.toolRef?.releaseId || 0);
        if (requestedReleaseId) {
            const frozenItems = await releaseItems(requestedReleaseId);
            const bareName = String(name).replace(/^mcp\.\d+\./, '');
            const item = frozenItems.find(candidate => String(candidate.tool_name || candidate.toolName) === bareName);
            if (!item) return res.status(404).json({ error: '工具不在指定的目录版本中。' });
            const server = await getAccessibleMcpServer(item.server_id, req.user);
            if (!server) return res.status(404).json({ error: '工具服务不存在或无权访问。' });
            const requestedDigest = String(req.body?.toolRef?.definitionDigest || '').trim();
            const digest = item.definitionDigest || item.definition_digest || '';
            if (requestedDigest && requestedDigest !== digest) return res.status(409).json({ error: '工具定义摘要不匹配，请重新选择当前目录版本。', code: 'TOOL_REFERENCE_STALE' });
            return res.json({ data: {
                toolRef: { toolName: `mcp.${item.server_id}.${item.tool_name || item.toolName}`, releaseId: requestedReleaseId, definitionDigest: digest },
                name: `mcp.${item.server_id}.${item.tool_name || item.toolName}`, title: item.title, description: item.description,
                inputSchema: item.inputSchema || item.input_schema || {}, outputSchema: item.outputSchema || item.output_schema || {},
                capabilities: item.capabilities || [], riskLevel: item.risk_level || 'medium', idempotent: Boolean(item.idempotent),
                sideEffect: Boolean(item.side_effect), cacheable: Boolean(item.cacheable), cancellable: Boolean(item.cancellable),
                concurrency: item.concurrency || 'read', timeout: item.timeout || {}, requiresApproval: item.risk_level === 'high' || item.risk_level === 'critical' || Boolean(item.side_effect),
                serverName: server.name || '', connectionRequirements: item.authScopes || item.auth_scopes || []
            } });
        }
        const tools = await formatToolList(req.user, { toolPolicy: 'all' });
        const tool = tools.find(item => item.name === name || item.fullName === name);
        if (!tool) return res.status(404).json({ error: '工具不存在或无权访问。' });
        res.json({ data: {
            toolRef: { toolName: tool.name, releaseId: req.body?.toolRef?.releaseId || null, definitionDigest: req.body?.toolRef?.definitionDigest || '' },
            name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.input_schema || {}, outputSchema: tool.output_schema || {},
            capabilities: tool.capabilities || [], riskLevel: tool.risk_level || tool.risk || 'low', approvalRequired: Boolean(tool.approval_required || tool.requiresApproval),
            idempotent: Boolean(tool.idempotent), sideEffect: Boolean(tool.side_effect), network: Boolean(tool.network), timeout: tool.timeout || {}, serverName: tool.serverName || ''
        } });
    }));

    router.post('/tools/invoke', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.toolRef?.toolName || req.body?.tool || req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: '请指定工具。' });
        const policyRequest = {
            actor: req.user,
            toolName: name,
            input: req.body?.input || {},
            source: 'mcp_manual',
            options: { releaseId: req.body?.toolRef?.releaseId, connectionAccountId: req.body?.connectionAccountId, entrypoint: 'tool_library' }
        };
        if (req.body?.background === true) {
            // 后台任务只自动执行明确声明为只读且幂等的工具。写工具和未声明
            // 幂等性的工具必须继续经由完整 Agent/工作流审批运行，避免取消或重试
            // 时制造重复副作用。
            const evaluation = await defaultToolPolicyEngine.evaluateToolInvocation(policyRequest);
            if (evaluation.tool.side_effect || !evaluation.tool.idempotent) {
                return res.status(400).json({ error: '后台执行仅支持只读且幂等的工具；有副作用的工具请使用工作流审批运行。', code: 'TOOL_TASK_IDEMPOTENCY_REQUIRED' });
            }
            const task = await toolTasks.create({
                user: req.user,
                releaseId: evaluation.release?.id || null,
                toolName: name,
                inputRequest: { toolRef: req.body?.toolRef || { toolName: name }, input: policyRequest.input }
            });
            setImmediate(async () => {
                const controller = toolTasks.beginExecution(task.id);
                try {
                    const current = await toolTasks.getForUser(task.id, req.user);
                    if (!current || current.status !== 'working') return;
                    const asyncPolicyRequest = { ...policyRequest, options: { ...policyRequest.options, signal: controller.signal } };
                    const detailed = await defaultToolPolicyEngine.invokeDetailed(asyncPolicyRequest, async effective => (name.startsWith('mcp.')
                        ? await executeMcpTool(name, effective.input, req.user, { source: 'mcp_manual', signal: controller.signal, connectionAccountId: effective.connection?.id || null })
                        : await executeBuiltInTool(name, effective.input, req.user, { entrypoint: 'tool_library_task', signal: controller.signal })));
                    await toolTasks.complete(task.id, req.user, detailed.output, { invocationEventId: detailed.invocationEventId });
                } catch (error) {
                    await toolTasks.complete(task.id, req.user, {}, { failed: true, errorCode: error.code || 'TOOL_TASK_FAILED', errorMessage: error.message });
                } finally {
                    toolTasks.endExecution(task.id, controller);
                }
            });
            logAction(req, '创建工具后台任务', name);
            return res.status(202).json({ resultType: 'task', task });
        }
        const output = await defaultToolPolicyEngine.invoke(policyRequest, async evaluation => (name.startsWith('mcp.')
            ? await executeMcpTool(name, evaluation.input, req.user, { source: 'mcp_manual', connectionAccountId: evaluation.connection?.id || null })
            : await executeBuiltInTool(name, evaluation.input, req.user, { entrypoint: 'tool_library' })));
        logAction(req, '工具库调用工具', name);
        res.json({ success: true, result: output });
    }));

    router.get('/tools/operations', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listToolInvocationEventsForUser(req.user, { limit: safeLimit(req.query.limit, 60, 500) }) });
    }));

    router.get('/tools/operations/summary', authMiddleware, asyncHandler(async (req, res) => {
        const summary = await selectOne(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN status IN ('error', 'failed', 'denied') THEN 1 ELSE 0 END) AS failure_count,
                   SUM(CASE WHEN policy_decision = 'require_approval' THEN 1 ELSE 0 END) AS approval_count,
                   COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms), 0) AS p50_ms,
                   COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms), 0) AS p95_ms,
                   COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms), 0) AS p99_ms
            FROM tool_invocation_events WHERE actor_id = ?
        `, [req.user.id]) || {};
        const total = Number(summary.total || 0);
        res.json({ data: { ...summary, total, successRate: total ? Number(summary.success_count || 0) / total : 0 } });
    }));

    router.get('/tools/operations/:id', authMiddleware, asyncHandler(async (req, res) => {
        const event = await getToolInvocationEventForUser(req.params.id, req.user);
        if (!event) return res.status(404).json({ error: '工具调用记录不存在。' });
        res.json({ data: event });
    }));

    router.get('/tools/evaluations', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listToolEvalSuites(req.user) });
    }));

    router.post('/tools/evaluations', authMiddleware, asyncHandler(async (req, res) => {
        const suite = await createToolEvalSuite(req.user, req.body || {});
        res.status(201).json({ success: true, data: suite });
    }));

    router.get('/tools/evaluations/:id/cases', authMiddleware, asyncHandler(async (req, res) => {
        const cases = await listToolEvalCases(req.params.id, req.user);
        if (!cases) return res.status(404).json({ error: '工具评测集不存在。' });
        res.json({ data: cases });
    }));

    router.post('/tools/evaluations/:id/cases', authMiddleware, asyncHandler(async (req, res) => {
        const item = await saveToolEvalCase(req.params.id, req.user, req.body || {});
        if (!item) return res.status(404).json({ error: '工具评测集不存在。' });
        res.status(201).json({ success: true, data: item });
    }));

    router.post('/tools/evaluations/:id/run', authMiddleware, asyncHandler(async (req, res) => {
        const result = await runToolEvaluation(req.params.id, req.user, req.body || {});
        if (!result) return res.status(404).json({ error: '工具评测集不存在。' });
        res.json({ success: true, data: result });
    }));

    router.get('/tools/evaluations/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const result = await getToolEvalRun(req.params.id, req.user);
        if (!result) return res.status(404).json({ error: '工具评测运行不存在。' });
        res.json({ data: result });
    }));

    router.get('/tools/tasks/:id', authMiddleware, asyncHandler(async (req, res) => {
        const task = await toolTasks.getForUser(req.params.id, req.user);
        if (!task) return res.status(404).json({ error: '工具任务不存在。' });
        res.json({ data: task });
    }));

    router.post('/tools/tasks/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const task = await toolTasks.requestCancel(req.params.id, req.user);
        if (!task) return res.status(404).json({ error: '工具任务不存在。' });
        res.json({ success: true, data: task });
    }));

    router.post('/tools/tasks/:id/input', authMiddleware, asyncHandler(async (req, res) => {
        const task = await toolTasks.submitInput(req.params.id, req.user, req.body?.input || {});
        if (!task) return res.status(404).json({ error: '工具任务不存在。' });
        res.json({ success: true, data: task });
    }));

    return router;
}

module.exports = { createToolLibraryRouter };
