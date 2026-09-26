'use strict';

/**
 * Product-level Tool Policy Enforcement Point.
 *
 * Agent runs already use `agent-policy` and the orchestrator. This adapter
 * brings manual MCP, OpenAI-compatible and future task entrypoints through
 * the same contract validation, capability governance, connection state and
 * immutable invocation event model without changing individual tool handlers.
 */
const crypto = require('crypto');
const { formatToolList } = require('./agent-tool-catalog');
const { buildToolExecutionPlan } = require('./agent-tool-execution-plan');
const { PolicyError } = require('./agent-policy');
const { normalizeToolContract, validateToolInput } = require('./agent-contracts');
const { schemaHasRules, validateValueAgainstSchema } = require('./agent-dag-contracts');
const { getCapabilityToolGovernance } = require('./capability-market');
const { listCachedMcpTools } = require('./mcp-client');
const { activeRelease, get: getCatalogRelease, releaseItems } = require('./tool-catalog-releases');
const { assertUsable, resolveBoundConnection } = require('./connection-accounts');
const { recordToolInvocationEvent } = require('./tool-invocation-events');
const { acquire: acquireToolExecutionGuard, executeWithRetry } = require('./tool-execution-guard');
const { normalizeRelativeEntryPath } = require('./agent-path-safety');

const SOURCE_NAMES = new Set(['agent', 'chat', 'workflow', 'manual_test', 'mcp_rpc', 'mcp_manual', 'openai', 'desktop', 'data_analysis']);

function sourceName(value) {
    const source = String(value || 'unknown').trim().toLowerCase().slice(0, 64);
    return SOURCE_NAMES.has(source) ? source : (source || 'unknown');
}

function virtualRun(user, options = {}) {
    return {
        id: options.run?.id || options.runId || '',
        user_id: options.run?.user_id || user?.id || null,
        goal: options.run?.goal || '工具库调用',
        tool_policy: options.run?.tool_policy || options.toolPolicy || 'all',
        tool_allowlist: options.run?.tool_allowlist || options.toolAllowlist || null,
        approval_policy: options.run?.approval_policy || options.approvalPolicy || 'safe_mcp_auto',
        network_policy: options.run?.network_policy || options.networkPolicy || {},
        metadata: options.run?.metadata || options.metadata || {}
    };
}

function serverIdForTool(name, tool = {}, input = {}) {
    const direct = Number(tool.serverId ?? tool.server_id);
    if (Number.isSafeInteger(direct) && direct >= 0) return direct;
    const match = /^mcp\.(\d+)\./.exec(String(name || ''));
    if (match) return Number(match[1]);
    if (tool.databaseTool && /^db\./.test(String(name || ''))) {
        const raw = input?.connectionId ?? input?.connection_id ?? input?.databaseConnectionId ?? input?.database_connection_id ?? input?.mcpServerId ?? input?.mcp_server_id;
        const selected = Number(raw);
        return Number.isSafeInteger(selected) && selected > 0 ? selected : null;
    }
    return null;
}

function shortToolName(name) {
    const match = /^mcp\.\d+\.(.+)$/.exec(String(name || ''));
    return match ? match[1] : String(name || '');
}

function findDatabaseCompatTool(fullName, toolList = []) {
    const match = String(fullName || '').match(/^mcp\.(\d+)\.(db\..+)$/);
    if (!match) return null;
    return (toolList || []).find(tool => tool?.databaseTool && tool.name === match[2]
        && (tool.databaseConnections || []).some(connection => String(connection.fullName || '') === String(fullName))) || null;
}

function findCatalogToolByName(name, toolList = []) {
    const safeName = String(name || '').trim();
    return (toolList || []).find(item => item.name === safeName || item.fullName === safeName)
        || findDatabaseCompatTool(safeName, toolList);
}

async function resolveInvocationTool({ safeName, suppliedTool = null, toolList = [], user = null, listMcpTools } = {}) {
    const directMatch = /^mcp\.(\d+)\.(.+)$/.exec(String(safeName || ''));
    if (directMatch && typeof listMcpTools === 'function') {
        const serverId = Number(directMatch[1]);
        const shortName = directMatch[2];
        const cached = (await listMcpTools(serverId, user)).find(item => String(item.fullName || '') === safeName || String(item.name || '') === shortName);
        if (cached) {
            const managedReadSource = ['database', 'reports', 'imported_dataset', 'imported_report'].includes(String(cached.serverType || ''))
                || Number(serverId) === 0;
            // `formatToolList` intentionally folds database connections into
            // db.* generic tools. A caller that already selected mcp.<id>.*
            // must keep the concrete contract, otherwise the synthetic
            // connectionId requirement leaks into a direct, safely scoped call.
            return {
                ...normalizeToolContract({
                    ...cached,
                    name: safeName,
                    title: cached.displayTitle || cached.title || shortName,
                    description: cached.displayDescription || cached.description || shortName,
                    input_schema: cached.input_schema || cached.inputSchema || { type: 'object' },
                    output_schema: cached.output_schema || cached.outputSchema || { type: 'object' },
                    source: 'mcp',
                    risk: cached.governance?.riskLevel || cached.risk || (managedReadSource ? 'medium' : 'high'),
                    approvalRequired: cached.governance?.approvalRequired || cached.requiresApproval,
                    localBrowserConnector: cached.localBrowserConnector === true,
                    localWorkspaceConnector: cached.localWorkspaceConnector === true,
                    localDesktopControl: cached.localDesktopControl === true,
                    network: cached.network
                }),
                serverId,
                serverName: cached.serverName || '',
                fullName: safeName,
                governance: cached.governance || {}
            };
        }
    }
    return suppliedTool || findCatalogToolByName(safeName, toolList);
}

function traceIdentifiers(traceContext = {}) {
    return {
        traceId: String(traceContext.traceId || traceContext.trace_id || '').slice(0, 128),
        spanId: String(traceContext.spanId || traceContext.span_id || crypto.randomUUID().replace(/-/g, '')).slice(0, 128),
        parentSpanId: String(traceContext.parentSpanId || traceContext.parent_span_id || '').slice(0, 128)
    };
}

function outputForValidation(value) {
    if (value && typeof value === 'object' && value.structuredContent !== undefined) return value.structuredContent;
    return value;
}

function validateToolOutput(tool = {}, catalogItem = null, output) {
    const schema = catalogItem?.outputSchema || catalogItem?.output_schema || tool.output_schema || tool.outputSchema || {};
    if (!schemaHasRules(schema)) return [];
    return validateValueAgainstSchema(outputForValidation(output), schema, {}, '工具输出');
}

async function resolveCatalogReference(name, tool, options = {}, deps = {}) {
    const getActiveRelease = deps.activeRelease || activeRelease;
    const getRelease = deps.getCatalogRelease || getCatalogRelease;
    const getReleaseItems = deps.releaseItems || releaseItems;
    const serverId = serverIdForTool(name, tool, options.input || {});
    if (!Number.isSafeInteger(serverId) || serverId <= 0) return { serverId, release: null, item: null };
    const release = options.releaseId
        ? await getRelease(Number(options.releaseId), serverId)
        : await getActiveRelease(serverId);
    if (!release?.id) {
        if (options.releaseId) {
            const error = new Error('指定的工具目录版本不存在或不属于当前工具服务。');
            error.code = 'TOOL_RELEASE_NOT_FOUND';
            error.status = 404;
            throw error;
        }
        return { serverId, release: null, item: null };
    }
    const items = await getReleaseItems(release.id);
    const item = items.find(candidate => String(candidate.tool_name || candidate.toolName) === shortToolName(name));
    return { serverId, release, item: item || null };
}

async function resolveConnection({ input = {}, item = null, user = null, options = {} } = {}, deps = {}) {
    const connectionAccountId = input.connectionAccountId ?? input.connection_account_id ?? options.connectionAccountId ?? options.connection_account_id;
    const requiredScopes = item?.authScopes || item?.auth_scopes || [];
    const usable = deps.assertUsable || assertUsable;
    if (connectionAccountId) return await usable(connectionAccountId, user, requiredScopes);
    if (item?.id) {
        const resolveBinding = deps.resolveBoundConnection || resolveBoundConnection;
        const bound = await resolveBinding(item.id, user);
        if (bound?.account) return await usable(bound.account.id, user, requiredScopes);
    }
    if (requiredScopes.length) {
        const error = new Error('该工具需要已授权的连接账户，请先连接或选择账户。');
        error.code = 'CONNECTION_ACCOUNT_REAUTH_REQUIRED';
        error.status = 403;
        throw error;
    }
    return null;
}


function validateScopedReportPaths(toolName, input = {}) {
    const short = shortToolName(toolName);
    const fields = short === 'reports.read_file_summary' || short === 'reports.query_table'
        ? ['path']
        : short === 'reports.compare_files' ? ['leftPath', 'rightPath'] : [];
    for (const field of fields) {
        const raw = String(input?.[field] || '').trim();
        const match = raw.match(/^(\d+):(.*)$/);
        const relative = match ? match[2] : raw;
        if (match && !Number.isSafeInteger(Number.parseInt(match[1], 10))) throw new Error('报表目录索引无效。');
        try { normalizeRelativeEntryPath(relative, { allowSubdirectories: true }); }
        catch (_) {
            const error = new Error('报表文件未找到或超出授权目录');
            error.code = 'REPORT_PATH_DENIED';
            error.status = 404;
            error.category = 'policy';
            throw error;
        }
    }
}

function policyErrorForDecision(decision = {}) {
    const result = {
        decision: decision.decision || 'denied',
        reasons: decision.reasons || ['工具调用被策略拒绝。'],
        reasonCodes: decision.reasonCodes || ['policy_denied'],
        tool: decision.tool || null
    };
    const error = new PolicyError(`工具调用被策略拦截：${result.reasons.join('；')}`, result);
    error.code = result.decision === 'require_approval' ? 'AGENT_APPROVAL_REQUIRED' : 'TOOL_POLICY_DENIED';
    error.status = 403;
    return error;
}

function createToolPolicyEngine(deps = {}) {
    const listTools = deps.formatToolList || formatToolList;
    const buildPlan = deps.buildToolExecutionPlan || buildToolExecutionPlan;
    const resolveGovernance = deps.getCapabilityToolGovernance || getCapabilityToolGovernance;
    const listMcpTools = deps.listCachedMcpTools || listCachedMcpTools;
    const recordEvent = deps.recordToolInvocationEvent || recordToolInvocationEvent;
    const acquireGuard = deps.acquireToolExecutionGuard || acquireToolExecutionGuard;
    const executeRetry = deps.executeWithRetry || executeWithRetry;

    async function evaluateToolInvocation({ actor, tenant = null, run = null, tool: suppliedTool = null, toolName = '', input = {}, connection = null, credential = null, source = 'unknown', traceContext = {}, options = {} } = {}) {
        const user = actor || options.user;
        if (!user?.id) {
            const error = new Error('工具调用必须关联已登录用户。');
            error.status = 401;
            error.code = 'TOOL_ACTOR_REQUIRED';
            throw error;
        }
        const safeName = String(toolName || suppliedTool?.name || suppliedTool?.fullName || '').trim();
        // Account selection is control-plane metadata, not an argument of the
        // provider tool. Strip it before JSON Schema validation and before the
        // payload crosses an MCP boundary so account IDs never become a hidden
        // API parameter or model-visible credential substitute.
        const sanitizedInput = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
        const embeddedConnectionAccountId = sanitizedInput.connectionAccountId ?? sanitizedInput.connection_account_id;
        delete sanitizedInput.connectionAccountId;
        delete sanitizedInput.connection_account_id;
        const effectiveOptions = embeddedConnectionAccountId === undefined
            ? options
            : { ...options, connectionAccountId: options.connectionAccountId ?? options.connection_account_id ?? embeddedConnectionAccountId };
        const toolList = options.toolList || await listTools(user, { toolPolicy: options.toolPolicy, toolAllowlist: options.toolAllowlist });
        const tool = await resolveInvocationTool({ safeName, suppliedTool, toolList, user, listMcpTools });
        if (!tool) {
            const error = new Error(`工具不可用或无权访问：${safeName || '-'}`);
            error.status = 403;
            error.code = 'TOOL_NOT_AVAILABLE';
            throw error;
        }
        const effectiveRun = virtualRun(user, { ...effectiveOptions, run });
        const catalog = await resolveCatalogReference(safeName || tool.name, tool, { ...effectiveOptions, input: sanitizedInput }, deps);
        validateScopedReportPaths(safeName, sanitizedInput);
        const issues = validateToolInput(tool, sanitizedInput);
        if (issues.length) {
            const error = policyErrorForDecision({ decision: 'denied', tool, reasons: [`工具输入契约校验失败：${issues[0]}`], reasonCodes: ['tool_input_invalid'] });
            await recordEvent({ actorId: user.id, tenantId: tenant?.id || tenant, serverId: catalog.serverId, releaseId: catalog.release?.id, toolItemId: catalog.item?.id, toolName: safeName || tool.name, definitionDigest: catalog.item?.definitionDigest || catalog.item?.definition_digest || '', policyDecision: 'denied', reasonCodes: ['tool_input_invalid'], source: sourceName(source), input: sanitizedInput, error, status: 'denied', ...traceIdentifiers(traceContext) });
            throw error;
        }
        if (catalog.release?.status && catalog.release.status !== 'active' && !effectiveOptions.allowHistoricalRelease) {
            const error = policyErrorForDecision({ decision: 'denied', tool, reasons: ['工具目录版本未处于可执行状态。'], reasonCodes: ['stale_release'] });
            await recordEvent({ actorId: user.id, tenantId: tenant?.id || tenant, serverId: catalog.serverId, releaseId: catalog.release.id, toolItemId: catalog.item?.id, toolName: safeName || tool.name, policyDecision: 'denied', reasonCodes: ['stale_release'], source: sourceName(source), input: sanitizedInput, error, status: 'denied', ...traceIdentifiers(traceContext) });
            throw error;
        }
        if (catalog.release && !catalog.item) {
            const error = policyErrorForDecision({ decision: 'denied', tool, reasons: ['工具不在指定的目录版本中，无法安全执行。'], reasonCodes: ['tool_contract_release_missing'] });
            await recordEvent({ actorId: user.id, tenantId: tenant?.id || tenant, serverId: catalog.serverId, releaseId: catalog.release.id, toolName: safeName || tool.name, policyDecision: 'denied', reasonCodes: ['tool_contract_release_missing'], source: sourceName(source), input: sanitizedInput, error, status: 'denied', ...traceIdentifiers(traceContext) });
            throw error;
        }
        if (safeName.startsWith('mcp.') || (tool.databaseTool && catalog.serverId)) {
            const cached = (await listMcpTools(catalog.serverId, user)).find(item => item.fullName === safeName || item.name === shortToolName(safeName));
            const type = tool.databaseTool || cached?.serverType === 'database' ? 'database_connection' : 'mcp_server';
            const governance = await resolveGovernance(type, String(catalog.serverId ?? ''), shortToolName(safeName), user);
            if (governance.enabled === false) {
                const error = policyErrorForDecision({ decision: 'denied', tool, reasons: ['该工具已在工具治理中停用。'], reasonCodes: ['capability_denied'] });
                await recordEvent({ actorId: user.id, serverId: catalog.serverId, releaseId: catalog.release?.id, toolItemId: catalog.item?.id, toolName: safeName, policyDecision: 'denied', reasonCodes: ['capability_denied'], source: sourceName(source), input: sanitizedInput, error, status: 'denied', ...traceIdentifiers(traceContext) });
                throw error;
            }
        }
        const resolvedConnection = connection || credential || await resolveConnection({ input: sanitizedInput, item: catalog.item, user, options: effectiveOptions }, deps);
        const executionPlan = await buildPlan({
            run: effectiveRun,
            tool,
            input: sanitizedInput,
            user,
            context: {
                ...effectiveOptions,
                allowApproval: effectiveOptions.allowApproval === true || effectiveOptions.approvalGranted === true,
                consumeBudget: effectiveOptions.consumeBudget === true
            }
        });
        if (executionPlan.policy.decision === 'denied' || executionPlan.policy.decision === 'require_approval') {
            const error = policyErrorForDecision({ ...executionPlan.policy, tool });
            await recordEvent({
                actorId: user.id, tenantId: tenant?.id || tenant, serverId: catalog.serverId, releaseId: catalog.release?.id, toolItemId: catalog.item?.id,
                connectionAccountId: resolvedConnection?.id, toolName: safeName || tool.name, definitionDigest: catalog.item?.definitionDigest || catalog.item?.definition_digest || '',
                policyDecision: executionPlan.policy.decision, reasonCodes: executionPlan.policy.reasonCodes || [], source: sourceName(source), input: sanitizedInput, error,
                status: executionPlan.policy.decision === 'require_approval' ? 'pending_approval' : 'denied', ...traceIdentifiers(traceContext)
            });
            throw error;
        }
        return {
            decision: 'allow', tool, toolList, run: effectiveRun, input: executionPlan.input,
            executionPlan, release: catalog.release, toolItem: catalog.item, serverId: catalog.serverId,
            connection: resolvedConnection, source: sourceName(source), trace: traceIdentifiers(traceContext)
        };
    }

    async function invokeDetailed(request = {}, executor) {
        if (typeof executor !== 'function') throw new TypeError('Tool Policy Engine 缺少工具执行器。');
        const startedAt = Date.now();
        let evaluation;
        let guardLease = null;
        let attempts = 1;
        try {
            evaluation = await evaluateToolInvocation(request);
            guardLease = acquireGuard({
                toolName: request.toolName || evaluation.tool.name,
                connectionAccountId: evaluation.connection?.id || null,
                serverId: evaluation.serverId,
                env: request.options?.env || process.env
            });
            const output = await executeRetry(async attempt => {
                attempts = attempt;
                return await executor(evaluation, attempt);
            }, {
                retryable: Boolean(evaluation.executionPlan?.retry?.retryable),
                maxAttempts: request.options?.maxAttempts ?? request.options?.max_attempts ?? 3,
                signal: request.options?.signal || null
            });
            const outputIssues = validateToolOutput(evaluation.tool, evaluation.toolItem, output);
            if (outputIssues.length) {
                const error = new Error(`工具输出契约校验失败：${outputIssues[0]}`);
                error.code = 'TOOL_OUTPUT_INVALID';
                error.status = 502;
                error.category = 'validation';
                throw error;
            }
            const invocationEventId = await recordEvent({
                actorId: request.actor?.id || request.user?.id, tenantId: request.tenant?.id || request.tenant, runId: evaluation.run.id || null,
                stepId: request.options?.stepId || '', serverId: evaluation.serverId, releaseId: evaluation.release?.id, toolItemId: evaluation.toolItem?.id,
                connectionAccountId: evaluation.connection?.id, toolName: request.toolName || evaluation.tool.name,
                definitionDigest: evaluation.toolItem?.definitionDigest || evaluation.toolItem?.definition_digest || '', policyDecision: 'allow', source: evaluation.source,
                input: evaluation.input, output, attempt: attempts, status: 'success', startedAt, executionMs: Date.now() - startedAt, totalMs: Date.now() - startedAt, ...evaluation.trace
            });
            guardLease?.release();
            return { output, evaluation, invocationEventId };
        } catch (error) {
            guardLease?.release({ error });
            if (evaluation) {
                await recordEvent({
                    actorId: request.actor?.id || request.user?.id, tenantId: request.tenant?.id || request.tenant, runId: evaluation.run.id || null,
                    stepId: request.options?.stepId || '', serverId: evaluation.serverId, releaseId: evaluation.release?.id, toolItemId: evaluation.toolItem?.id,
                    connectionAccountId: evaluation.connection?.id, toolName: request.toolName || evaluation.tool.name,
                    definitionDigest: evaluation.toolItem?.definitionDigest || evaluation.toolItem?.definition_digest || '', policyDecision: error.code === 'AGENT_APPROVAL_REQUIRED' ? 'require_approval' : 'allow',
                    source: evaluation.source, input: evaluation.input, error, attempt: attempts, status: error.code === 'AGENT_APPROVAL_REQUIRED' ? 'pending_approval' : 'error', startedAt, executionMs: Date.now() - startedAt, totalMs: Date.now() - startedAt, retryable: Boolean(evaluation.executionPlan?.retry?.retryable), ...evaluation.trace
                });
            }
            throw error;
        }
    }

    async function invoke(request = {}, executor) {
        return (await invokeDetailed(request, executor)).output;
    }

    return { evaluateToolInvocation, invoke, invokeDetailed };
}

const defaultEngine = createToolPolicyEngine();

module.exports = {
    defaultToolPolicyEngine: defaultEngine,
    createToolPolicyEngine,
    resolveCatalogReference,
    shortToolName,
    validateToolOutput,
    ...defaultEngine
};
