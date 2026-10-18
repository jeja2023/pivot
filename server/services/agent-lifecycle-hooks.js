'use strict';

/*
 * 声明式 Lifecycle Hook 平台。
 *
 * 外部包不能提交 JavaScript/Shell handler：hook 只允许由配置表达“阻断”或
 * “需要人工审批”。这样 Hook 可用于企业策略接入，但不能绕过核心 PEP、扩大
 * 路径/网络/权限或在服务进程执行任意代码。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { canonicalJson } = require('./canonical-json');
const { assertTenantContext } = require('./agent-tenant-context');
const {
    normalizeJsonSchema,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');

const HOOK_EVENTS = Object.freeze(new Set([
    'run.started', 'run.finished', 'tool.preflight', 'tool.succeeded', 'tool.failed',
    'context.compacted', 'workspace.changed', 'transaction.committed', 'transaction.rolled_back',
    'plan.requested', 'plan.completed', 'plan.failed', 'plan.failover'
]));
const HOOK_PHASES = Object.freeze(new Set(['pre', 'post']));
const FAILURE_POLICIES = Object.freeze(new Set(['fail_open', 'fail_closed']));
const MAX_HOOKS_PER_EVENT = 24;
const MAX_HOOK_TIMEOUT_MS = 5000;
const MIN_HOOK_TIMEOUT_MS = 50;
const DEFAULT_HOOK_TIMEOUT_MS = 1000;
const FAIL_CLOSED_PRE_EVENTS = Object.freeze(new Set(['tool.preflight', 'run.started']));

function hookError(message, code = 'AGENT_HOOK_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'policy';
    return error;
}

function text(value, max = 255) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback = {}) { try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '')); } catch (_) { return fallback; } }

function normalizeStringList(value, max = 32, itemMax = 160) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(item => text(item, itemMax)).filter(Boolean))].slice(0, max);
}

function normalizeTimeoutMs(value) {
    const parsed = Number.parseInt(value, 10);
    const safe = Number.isFinite(parsed) ? parsed : DEFAULT_HOOK_TIMEOUT_MS;
    return Math.min(Math.max(safe, MIN_HOOK_TIMEOUT_MS), MAX_HOOK_TIMEOUT_MS);
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function manifestDigestForHook(hook = {}) {
    return sha256(canonicalJson({
        packageId: text(hook.packageId, 160),
        packageVersion: text(hook.packageVersion, 80),
        hookName: text(hook.hookName, 160),
        eventType: text(hook.eventType, 80),
        phase: text(hook.phase, 16),
        priority: Number(hook.priority || 0),
        handlerKind: 'declarative_policy',
        config: normalizeHookConfig(hook.config),
        inputSchema: normalizeJsonSchema(hook.inputSchema || {}),
        outputSchema: normalizeJsonSchema(hook.outputSchema || {}),
        requiredScopes: normalizeStringList(hook.requiredScopes),
        failurePolicy: text(hook.failurePolicy, 16),
        timeoutMs: normalizeTimeoutMs(hook.timeoutMs)
    }));
}

function validateHookSchema(schema, label) {
    if (!schemaHasRules(schema)) return;
    const issues = validateJsonSchemaDefinition(schema, label, []);
    if (issues.length) throw hookError(issues.join('；'), 'AGENT_HOOK_SCHEMA_INVALID');
}

function normalizeHookSchema(value, label) {
    const schema = normalizeJsonSchema(value || {});
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length && !Object.keys(schema).length) {
        throw hookError(`${label}必须是可序列化对象。`, 'AGENT_HOOK_SCHEMA_INVALID');
    }
    validateHookSchema(schema, label);
    return schema;
}

function normalizeHookConfig(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const blockedTools = normalizeStringList(source.blockedTools || source.blocked_tools, 64);
    const allowedRunModes = normalizeStringList(source.allowedRunModes || source.allowed_run_modes, 16, 40);
    const maxRiskLevel = source.maxRiskLevel == null && source.max_risk_level == null
        ? null
        : Math.max(0, Math.min(5, Number(source.maxRiskLevel ?? source.max_risk_level) || 0));
    const additionalContext = text(source.additionalContext || source.additional_context, 2000);
    const action = ['deny', 'observe'].includes(String(source.action || 'observe'))
        ? String(source.action || 'observe') : 'observe';
    return { blockedTools, allowedRunModes, maxRiskLevel, additionalContext, action };
}

function normalizeHookRegistration(value = {}, defaults = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const eventType = text(source.eventType || source.event_type, 80);
    const phase = text(source.phase || 'pre', 16);
    const hookName = text(source.hookName || source.hook_name, 160);
    if (!HOOK_EVENTS.has(eventType)) throw hookError('Hook 事件类型不受支持。', 'AGENT_HOOK_EVENT_INVALID');
    if (!HOOK_PHASES.has(phase)) throw hookError('Hook 阶段只能为 pre 或 post。', 'AGENT_HOOK_PHASE_INVALID');
    if (!hookName) throw hookError('Hook 必须提供名称。', 'AGENT_HOOK_NAME_REQUIRED');
    const failurePolicy = text(source.failurePolicy || source.failure_policy || 'fail_open', 16);
    if (!FAILURE_POLICIES.has(failurePolicy)) throw hookError('Hook 失败策略无效。', 'AGENT_HOOK_FAILURE_POLICY_INVALID');
    // 所有安全相关 pre Hook 必须 fail-closed，避免服务错误时策略静默放宽。
    const effectiveFailurePolicy = phase === 'pre' && FAIL_CLOSED_PRE_EVENTS.has(eventType) ? 'fail_closed' : failurePolicy;
    const hook = {
        id: text(source.id, 64) || crypto.randomUUID(),
        tenantId: Number(source.tenantId ?? source.tenant_id ?? defaults.tenantId) || 0,
        userId: source.userId ?? source.user_id ?? defaults.userId ?? null,
        packageId: text(source.packageId || source.package_id || 'platform', 160) || 'platform',
        packageVersion: text(source.packageVersion || source.package_version || '1', 80) || '1',
        hookName,
        eventType,
        phase,
        priority: Math.max(-1000, Math.min(1000, Number.parseInt(source.priority, 10) || 100)),
        handlerKind: 'declarative_policy',
        config: normalizeHookConfig(source.config),
        inputSchema: normalizeHookSchema(source.inputSchema || source.input_schema || {}, 'Hook 输入契约'),
        outputSchema: normalizeHookSchema(source.outputSchema || source.output_schema || {}, 'Hook 输出契约'),
        requiredScopes: normalizeStringList(source.requiredScopes || source.required_scopes),
        failurePolicy: effectiveFailurePolicy,
        timeoutMs: normalizeTimeoutMs(source.timeoutMs ?? source.timeout_ms),
        signatureVerified: source.signatureVerified === true || source.signature_verified === true,
        signatureKeyId: text(source.signatureKeyId || source.signature_key_id, 160),
        status: ['enabled', 'disabled'].includes(String(source.status || 'disabled')) ? String(source.status || 'disabled') : 'disabled'
    };
    hook.manifestDigest = manifestDigestForHook(hook);
    return hook;
}

function evaluateDeclarativeHook(hook, payload = {}) {
    const config = normalizeHookConfig(hook.config);
    const toolName = text(payload.tool?.name || payload.toolName, 160);
    const runMode = text(payload.run?.run_mode || payload.run?.runMode, 40);
    const riskLevel = Number(payload.tool?.risk_level ?? payload.tool?.riskLevel ?? 0) || 0;
    const blocked = config.blockedTools.includes(toolName)
        || (config.allowedRunModes.length > 0 && !config.allowedRunModes.includes(runMode))
        || (config.maxRiskLevel !== null && riskLevel > config.maxRiskLevel);
    if (!blocked || config.action === 'observe') {
        return { decision: 'observe', additionalContext: config.additionalContext || '' };
    }
    // Hook 永远不能 allow 或更新输入；只可拒绝或要求更严格的人类审批。
    return {
        decision: config.action,
        reason: config.blockedTools.includes(toolName) ? 'tool_blocked' : config.maxRiskLevel !== null && riskLevel > config.maxRiskLevel ? 'risk_exceeded' : 'run_mode_not_allowed',
        additionalContext: config.additionalContext || ''
    };
}

function scopeSetFromPayload(payload = {}) {
    const source = payload.authorization?.scopes
        || payload.auth?.scopes
        || payload.authorizedScopes
        || payload.authorized_scopes
        || [];
    return new Set(normalizeStringList(source, 128, 160));
}

function missingHookScopes(hook, payload = {}) {
    const granted = scopeSetFromPayload(payload);
    return normalizeStringList(hook.requiredScopes, 64, 160).filter(scope => !granted.has(scope));
}

function withHookTimeout(work, timeoutMs) {
    const boundedMs = normalizeTimeoutMs(timeoutMs);
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(hookError(`Hook 执行超过 ${boundedMs}ms。`, 'AGENT_HOOK_TIMEOUT', 503));
        }, boundedMs);
        timer.unref?.();
    });
    return Promise.race([Promise.resolve().then(work), deadline]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function hookPayloadFingerprint(payload = {}, env = process.env) {
    const secret = String(env.PIVOT_HOOK_AUDIT_FINGERPRINT_SECRET || '').trim();
    if (secret.length < 32) return '';
    return crypto.createHmac('sha256', secret).update(canonicalJson(payload || {})).digest('hex');
}

async function recordHookInvocationAudit({ hook, user, payload, eventType, phase, sequenceNo, decision, outcome, reason = '', durationMs = 0, executeQuery = execute, env = process.env } = {}) {
    if (!hook?.id || typeof executeQuery !== 'function') return;
    await executeQuery(`
        INSERT INTO agent_lifecycle_hook_invocations (
            hook_id, tenant_id, user_id, run_id, event_type, phase, sequence_no,
            decision, outcome, reason, duration_ms, payload_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        String(hook.id), Number(hook.tenantId || user?.tenant_id || user?.tenantId || 0) || 0,
        Number(user?.id || 0) || null, text(payload?.run?.id || payload?.runId, 160), text(eventType, 80), text(phase, 16),
        Math.max(0, Number.parseInt(sequenceNo, 10) || 0), text(decision, 32) || 'error', text(outcome, 32) || 'error',
        text(reason, 320), Math.max(0, Number.parseInt(durationMs, 10) || 0), hookPayloadFingerprint(payload, env), getBeijingTimestamp()
    ]);
}

function assertPayloadMatchesHookSchema(payload, schema, label, code) {
    if (!schemaHasRules(schema)) return;
    const issues = validateValueAgainstSchema(payload, schema, { allowTemplates: false }, label, []);
    if (issues.length) throw hookError(issues.join('；'), code);
}

function serializeHook(row = {}) {
    return {
        id: String(row.id || ''), tenantId: Number(row.tenant_id || 0), userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
        packageId: String(row.package_id || 'platform'), packageVersion: String(row.package_version || '1'), hookName: String(row.hook_name || ''),
        eventType: String(row.event_type || ''), phase: String(row.phase || ''), priority: Number(row.priority || 0),
        handlerKind: String(row.handler_kind || 'declarative_policy'), config: normalizeHookConfig(parseJson(row.config, {})),
        inputSchema: parseJson(row.input_schema, {}), outputSchema: parseJson(row.output_schema, {}),
        requiredScopes: normalizeStringList(parseJson(row.required_scopes, [])), failurePolicy: String(row.failure_policy || 'fail_open'),
        timeoutMs: normalizeTimeoutMs(row.timeout_ms), manifestDigest: String(row.manifest_digest || ''), signatureKeyId: String(row.signature_key_id || ''),
        packageManifestDigest: String(row.package_manifest_digest || ''),
        signingEnvelopeId: row.signing_envelope_id === null || row.signing_envelope_id === undefined ? null : Number(row.signing_envelope_id),
        signatureVerified: Boolean(row.signature_verified), status: String(row.status || 'disabled'), createdAt: row.created_at || null, updatedAt: row.updated_at || null
    };
}

async function listAgentLifecycleHooks(user, options = {}) {
    const eventType = text(options.eventType || options.event_type, 80);
    const tenant = await assertTenantContext(user);
    const params = [tenant.tenantId, Number(user?.id || 0)];
    const eventClause = eventType ? ' AND event_type = ?' : '';
    if (eventType) params.push(eventType);
    const rows = await query(`
        SELECT * FROM agent_lifecycle_hooks
        WHERE tenant_id = ? AND (user_id IS NULL OR user_id = ?)${eventClause}
        ORDER BY event_type ASC, phase ASC, priority ASC, id ASC
    `, params);
    return rows.map(serializeHook);
}

async function listAgentLifecycleHookInvocations(user, options = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 100, 1), 500);
    const hookId = text(options.hookId || options.hook_id, 64);
    const runId = text(options.runId || options.run_id, 160);
    const tenant = await assertTenantContext(user);
    const params = [tenant.tenantId, Number(user?.id || 0)];
    const clauses = [];
    if (hookId) { clauses.push('i.hook_id = ?'); params.push(hookId); }
    if (runId) { clauses.push('i.run_id = ?'); params.push(runId); }
    params.push(safeLimit);
    const rows = await query(`
        SELECT i.hook_id, i.run_id, i.event_type, i.phase, i.sequence_no, i.decision, i.outcome,
            i.reason, i.duration_ms, i.payload_fingerprint, i.created_at
        FROM agent_lifecycle_hook_invocations i
        JOIN agent_lifecycle_hooks h ON h.id = i.hook_id
        WHERE h.tenant_id = ? AND (h.user_id IS NULL OR h.user_id = ?)
            ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ?
    `, params);
    return rows.map(row => ({
        hookId: String(row.hook_id || ''), runId: String(row.run_id || ''), eventType: String(row.event_type || ''),
        phase: String(row.phase || ''), sequenceNo: Number(row.sequence_no || 0), decision: String(row.decision || ''),
        outcome: String(row.outcome || ''), reason: String(row.reason || ''), durationMs: Number(row.duration_ms || 0),
        payloadFingerprint: String(row.payload_fingerprint || ''), createdAt: row.created_at || null
    }));
}

async function registerAgentLifecycleHook(user, input = {}, { verifiedSignature = false, manifestDigest = '', signatureKeyId = '', packageManifestDigest = '', signingEnvelopeId = null, organizationScoped = false, trx = null } = {}) {
    if (!user?.id) throw hookError('Hook 注册需要有效用户。', 'AGENT_HOOK_USER_REQUIRED', 401);
    // 请求载荷不是信任边界：客户端不得通过提交 signatureVerified 绕过
    // 已签名扩展包的验证。只有完成供应链验证的内部调用方才能通过第三个参数
    // 写入这个事实；公开 HTTP 路由永远不会传递该能力。
    const tenant = await assertTenantContext(user);
    const callerTenantId = tenant.tenantId;
    const requestedTenantId = input.tenantId ?? input.tenant_id;
    const requestedUserId = input.userId ?? input.user_id;
    if (requestedTenantId !== undefined && Number(requestedTenantId) !== callerTenantId) {
        throw hookError('Hook 不能写入其他租户。', 'AGENT_HOOK_TENANT_FORBIDDEN', 403);
    }
    if (organizationScoped && (verifiedSignature !== true || !text(packageManifestDigest, 64))) {
        throw hookError('组织级 Hook 只能由已验证的受管扩展包登记。', 'AGENT_HOOK_ORGANIZATION_SCOPE_FORBIDDEN', 403);
    }
    if (requestedUserId !== undefined && (organizationScoped ? requestedUserId !== null : Number(requestedUserId) !== Number(user.id))) {
        throw hookError('Hook 不能写入其他用户。', 'AGENT_HOOK_USER_FORBIDDEN', 403);
    }
    const hookUserId = organizationScoped ? null : user.id;
    const hook = normalizeHookRegistration({
        ...input,
        tenantId: callerTenantId,
        userId: hookUserId,
        signatureVerified: verifiedSignature === true,
        signatureKeyId: verifiedSignature === true ? (text(signatureKeyId, 160) || 'verified-internal') : ''
    }, {
        tenantId: user.tenant_id || user.tenantId || 0,
        userId: hookUserId
    });
    const assertedDigest = text(manifestDigest, 64);
    if (assertedDigest && assertedDigest !== hook.manifestDigest) {
        throw hookError('已验证的 Hook 清单摘要与登记内容不一致。', 'AGENT_HOOK_MANIFEST_MISMATCH', 409);
    }
    if (hook.status === 'enabled' && !hook.signatureVerified) {
        throw hookError('启用 Hook 必须先完成签名清单校验。', 'AGENT_HOOK_SIGNATURE_REQUIRED', 409);
    }
    const packageDigest = text(packageManifestDigest, 64);
    const envelopeId = signingEnvelopeId === null || signingEnvelopeId === undefined ? null : Number.parseInt(signingEnvelopeId, 10);
    if (packageDigest && !/^[a-f0-9]{64}$/i.test(packageDigest)) {
        throw hookError('受管 Hook 包摘要非法。', 'AGENT_HOOK_PACKAGE_DIGEST_INVALID', 409);
    }
    if (packageDigest && (!Number.isSafeInteger(envelopeId) || envelopeId <= 0 || !hook.signatureVerified)) {
        throw hookError('受管 Hook 包必须绑定已验证的签名信封。', 'AGENT_HOOK_PACKAGE_SIGNATURE_REQUIRED', 409);
    }
    const database = trx || { queryOne };
    const ownerClause = hookUserId === null ? 'user_id IS NULL' : 'user_id = ?';
    const existing = await database.queryOne(`
        SELECT manifest_digest, signature_verified, status
        FROM agent_lifecycle_hooks
        WHERE tenant_id = ? AND ${ownerClause} AND package_id = ? AND package_version = ? AND hook_name = ?
    `, hookUserId === null
        ? [hook.tenantId, hook.packageId, hook.packageVersion, hook.hookName]
        : [hook.tenantId, hook.userId, hook.packageId, hook.packageVersion, hook.hookName]);
    if (existing?.manifest_digest && existing.manifest_digest !== hook.manifestDigest) {
        throw hookError('已发布 Hook 清单不可原地修改，请发布新的 packageVersion。', 'AGENT_HOOK_RELEASE_IMMUTABLE', 409);
    }
    const now = getBeijingTimestamp();
    const values = [
        hook.id, hook.tenantId, hook.userId, hook.packageId, hook.packageVersion, hook.hookName, hook.eventType, hook.phase, hook.priority,
        JSON.stringify(hook.config), JSON.stringify(hook.inputSchema), JSON.stringify(hook.outputSchema), JSON.stringify(hook.requiredScopes),
        hook.failurePolicy, hook.timeoutMs, hook.manifestDigest, packageDigest, envelopeId, hook.signatureKeyId, hook.signatureVerified, hook.status, now, now
    ];
    const insertSql = `
        INSERT INTO agent_lifecycle_hooks (
            id, tenant_id, user_id, package_id, package_version, hook_name, event_type, phase, priority,
            handler_kind, config, input_schema, output_schema, required_scopes, failure_policy, timeout_ms,
            manifest_digest, package_manifest_digest, signing_envelope_id, signature_key_id, signature_verified, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'declarative_policy', ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, user_id, package_id, package_version, hook_name) DO UPDATE SET
            event_type = EXCLUDED.event_type, phase = EXCLUDED.phase, priority = EXCLUDED.priority,
            config = EXCLUDED.config, input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema,
            required_scopes = EXCLUDED.required_scopes, failure_policy = EXCLUDED.failure_policy, timeout_ms = EXCLUDED.timeout_ms,
            manifest_digest = EXCLUDED.manifest_digest, package_manifest_digest = EXCLUDED.package_manifest_digest,
            signing_envelope_id = EXCLUDED.signing_envelope_id, signature_key_id = EXCLUDED.signature_key_id,
            signature_verified = EXCLUDED.signature_verified, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
        RETURNING *
    `;
    // PostgreSQL 的普通 UNIQUE 允许多条 NULL，因此组织级包使用迁移提供的
    // partial unique index，并用显式更新避免依赖 ON CONFLICT 的 NULL 语义。
    const row = hookUserId === null && existing
        ? await database.queryOne(`
            UPDATE agent_lifecycle_hooks SET
                event_type = ?, phase = ?, priority = ?, config = ?::jsonb, input_schema = ?::jsonb, output_schema = ?::jsonb,
                required_scopes = ?::jsonb, failure_policy = ?, timeout_ms = ?, manifest_digest = ?, package_manifest_digest = ?,
                signing_envelope_id = ?, signature_key_id = ?, signature_verified = ?, status = ?, updated_at = ?
            WHERE tenant_id = ? AND user_id IS NULL AND package_id = ? AND package_version = ? AND hook_name = ?
            RETURNING *
        `, [
            hook.eventType, hook.phase, hook.priority, JSON.stringify(hook.config), JSON.stringify(hook.inputSchema), JSON.stringify(hook.outputSchema),
            JSON.stringify(hook.requiredScopes), hook.failurePolicy, hook.timeoutMs, hook.manifestDigest, packageDigest,
            envelopeId, hook.signatureKeyId, hook.signatureVerified, hook.status, now,
            hook.tenantId, hook.packageId, hook.packageVersion, hook.hookName
        ])
        : await database.queryOne(insertSql, values);
    return serializeHook(row);
}

async function invokeAgentLifecycleHooks({ eventType, phase = 'pre', user, payload = {} } = {}, dependencies = {}) {
    if (!HOOK_EVENTS.has(String(eventType || '')) || !HOOK_PHASES.has(String(phase || ''))) return { decisions: [], additionalContext: [] };
    const listHooks = dependencies.listHooks || listAgentLifecycleHooks;
    const evaluateHook = dependencies.evaluateHook || evaluateDeclarativeHook;
    const recordAudit = dependencies.recordAudit || recordHookInvocationAudit;
    const hooks = (await listHooks(user, { eventType }))
        .filter(hook => hook.status === 'enabled' && hook.phase === phase)
        .slice(0, MAX_HOOKS_PER_EVENT);
    const decisions = [];
    const additionalContext = [];
    for (const [index, hook] of hooks.entries()) {
        const startedAt = Date.now();
        try {
            if (!hook.signatureVerified || !/^[a-f0-9]{64}$/i.test(String(hook.manifestDigest || ''))) {
                throw hookError('启用 Hook 缺少已验证的不可变签名清单。', 'AGENT_HOOK_MANIFEST_REQUIRED', 503);
            }
            const recomputedDigest = manifestDigestForHook(hook);
            if (recomputedDigest !== hook.manifestDigest) {
                throw hookError('Hook 清单摘要校验失败。', 'AGENT_HOOK_MANIFEST_MISMATCH', 503);
            }
            if (hook.signingEnvelopeId) {
                const { assertManagedHookPackageActive } = require('./agent-lifecycle-hook-packages');
                await (dependencies.assertManagedPackage || assertManagedHookPackageActive)(hook);
            }
            const missingScopes = missingHookScopes(hook, payload);
            if (missingScopes.length) {
                const reason = `missing_scopes:${missingScopes.join(',')}`;
                if (phase === 'pre') throw hookError('Hook 所需权限范围未满足。', 'AGENT_HOOK_SCOPE_REQUIRED', 403);
                const decision = { hookId: hook.id, hookName: hook.hookName, decision: 'skipped_scope', reason };
                decisions.push(decision);
                await recordAudit({ hook, user, payload, eventType, phase, sequenceNo: index + 1, decision: decision.decision, outcome: 'skipped_scope', reason, durationMs: Date.now() - startedAt, env: dependencies.env });
                continue;
            }
            assertPayloadMatchesHookSchema(payload, hook.inputSchema, `Hook「${hook.hookName}」输入`, 'AGENT_HOOK_INPUT_SCHEMA_INVALID');
            const result = await withHookTimeout(() => evaluateHook(hook, payload), hook.timeoutMs);
            assertPayloadMatchesHookSchema(result, hook.outputSchema, `Hook「${hook.hookName}」输出`, 'AGENT_HOOK_OUTPUT_SCHEMA_INVALID');
            if (result.additionalContext) additionalContext.push({ hookId: hook.id, text: result.additionalContext });
            const decision = { hookId: hook.id, hookName: hook.hookName, decision: result.decision, reason: result.reason || '' };
            decisions.push(decision);
            await recordAudit({ hook, user, payload, eventType, phase, sequenceNo: index + 1, decision: decision.decision, outcome: 'succeeded', reason: decision.reason, durationMs: Date.now() - startedAt, env: dependencies.env });
        } catch (error) {
            const reason = String(error.message || '').slice(0, 300);
            try {
                await recordAudit({ hook, user, payload, eventType, phase, sequenceNo: index + 1, decision: 'error', outcome: 'failed', reason, durationMs: Date.now() - startedAt, env: dependencies.env });
            } catch (auditError) {
                if (hook.failurePolicy === 'fail_closed') {
                    throw hookError(`Hook ${hook.hookName} 审计失败：${auditError.message}`, 'AGENT_HOOK_AUDIT_FAILED_CLOSED', 503);
                }
            }
            if (hook.failurePolicy === 'fail_closed') {
                throw hookError(`Hook ${hook.hookName} 执行失败：${error.message}`, 'AGENT_HOOK_FAILED_CLOSED', 503);
            }
            decisions.push({ hookId: hook.id, hookName: hook.hookName, decision: 'error_open', reason });
        }
    }
    return { decisions, additionalContext };
}

module.exports = {

    evaluateDeclarativeHook,
    hookError,
    hookPayloadFingerprint,
    invokeAgentLifecycleHooks,
    listAgentLifecycleHooks,
    listAgentLifecycleHookInvocations,
    manifestDigestForHook,

    normalizeHookRegistration,
    normalizeTimeoutMs,

    registerAgentLifecycleHook,

    withHookTimeout
};
