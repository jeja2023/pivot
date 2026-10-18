'use strict';

/*
 * 高风险执行授权（Execution Grant）。
 *
 * 控制面在策略、审批和输入都固定后签发短期授权；执行面只接受绑定
 * Run、用户、工具、输入摘要、工作区范围和资源上限的令牌。它不是用户
 * 可携带的登录令牌，也绝不能作为权限扩大或跨任务复用的凭据。
 */
const crypto = require('crypto');
const { canonicalJson } = require('./canonical-json');

const GRANT_VERSION = 1;
const GRANT_AUDIENCE = 'pivot-capability-worker';
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;
const MIN_SECRET_BYTES = 32;
const TOKEN_PREFIX = 'peg1';

function grantError(message, code = 'AGENT_EXECUTION_GRANT_INVALID', status = 403) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'policy';
    return error;
}

function base64UrlEncode(value) {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
    try { return Buffer.from(String(value || ''), 'base64url').toString('utf8'); } catch (_) { return ''; }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function executionInputDigest(input = {}) {
    return sha256(canonicalJson(input ?? {}));
}

function normalizePositiveInt(value, fallback, max) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(number, max);
}

function normalizeString(value, field, max = 255) {
    const result = String(value || '').trim();
    if (!result || result.length > max) throw grantError(`执行授权缺少或包含无效的 ${field}。`, 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    return result;
}

function grantSecret(options = {}) {
    const env = options.env || process.env;
    const secret = String(options.secret ?? env.PIVOT_AGENT_EXECUTION_GRANT_SECRET ?? '').trim();
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
        throw grantError(`未配置至少 ${MIN_SECRET_BYTES} 字节的 PIVOT_AGENT_EXECUTION_GRANT_SECRET，不能签发受控执行授权。`, 'AGENT_EXECUTION_GRANT_SECRET_MISSING', 503);
    }
    // 禁止回退复用会话/数据加密密钥；授权密钥泄露或轮转不应扩大影响面。
    if (secret === String(env.JWT_SECRET || '').trim() || secret === String(env.DATA_ENCRYPTION_KEY || '').trim()) {
        throw grantError('PIVOT_AGENT_EXECUTION_GRANT_SECRET 必须与 JWT_SECRET、DATA_ENCRYPTION_KEY 分离。', 'AGENT_EXECUTION_GRANT_SECRET_REUSED', 503);
    }
    return secret;
}

function normalizeWorkspace(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const scopeId = normalizeString(source.scopeId || source.scope_id || source.id, 'workspace.scopeId', 160);
    const mode = String(source.mode || 'rw').toLowerCase();
    if (!['ro', 'rw'].includes(mode)) throw grantError('执行授权 workspace.mode 只能为 ro 或 rw。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    const target = String(source.target || '/workspace').trim();
    if (!/^\/[A-Za-z0-9._/-]{1,240}$/.test(target) || target.includes('..')) {
        throw grantError('执行授权工作区目标路径无效。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    }
    return { scopeId, mode, target };
}

function normalizeNetwork(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const mode = String(source.mode || 'deny').toLowerCase();
    if (!['deny', 'allowlist'].includes(mode)) throw grantError('执行授权网络模式无效。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    const allowOrigins = Array.isArray(source.allowOrigins || source.allow_origins) ? (source.allowOrigins || source.allow_origins) : [];
    const normalized = [...new Set(allowOrigins.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 32);
    if (mode === 'deny' && normalized.length) throw grantError('断网执行授权不能携带网络白名单。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    if (normalized.some(item => !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/i.test(item))) {
        throw grantError('执行授权网络白名单必须是 HTTPS Origin。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    }
    return { mode, allowOrigins: normalized };
}

function normalizeResources(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        timeoutMs: normalizePositiveInt(source.timeoutMs ?? source.timeout_ms, 30_000, 120_000),
        memoryBytes: normalizePositiveInt(source.memoryBytes ?? source.memory_bytes, 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
        pids: normalizePositiveInt(source.pids, 64, 256)
    };
}

function signPayload(payload, secret) {
    const body = base64UrlEncode(canonicalJson(payload));
    const signingInput = `${TOKEN_PREFIX}.${body}`;
    const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
    return `${signingInput}.${signature}`;
}

function decodeToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
        throw grantError('执行授权令牌格式无效。', 'AGENT_EXECUTION_GRANT_FORMAT_INVALID');
    }
    let payload;
    try { payload = JSON.parse(base64UrlDecode(parts[1])); } catch (_) { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw grantError('执行授权令牌载荷无效。', 'AGENT_EXECUTION_GRANT_FORMAT_INVALID');
    }
    return { parts, payload };
}

function safeTimingEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function summarizeExecutionGrant(payload = {}) {
    return {
        grantId: String(payload.grantId || ''),
        runId: String(payload.runId || ''),
        tool: String(payload.tool || ''),
        capability: String(payload.capability || ''),
        expiresAt: payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : null,
        workspace: payload.workspace ? { ...payload.workspace } : null,
        network: payload.network ? { mode: payload.network.mode, allowOriginCount: Array.isArray(payload.network.allowOrigins) ? payload.network.allowOrigins.length : 0 } : null,
        resources: payload.resources ? { ...payload.resources } : null,
        inputDigest: String(payload.inputDigest || '')
    };
}

function issueExecutionGrant(claims = {}, options = {}) {
    const secret = grantSecret(options);
    const nowMs = Number(options.nowMs ?? Date.now());
    const ttlMs = Math.min(Math.max(Number(claims.ttlMs ?? claims.ttl_ms) || DEFAULT_TTL_MS, 1_000), MAX_TTL_MS);
    const runId = normalizeString(claims.runId || claims.run_id, 'runId', 160);
    const userId = Number.parseInt(claims.userId ?? claims.user_id, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw grantError('执行授权缺少有效用户。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    const tool = normalizeString(claims.tool, 'tool', 160);
    const capability = normalizeString(claims.capability || 'workspace.execute', 'capability', 120);
    const inputDigest = /^[a-f0-9]{64}$/.test(String(claims.inputDigest || claims.input_digest || ''))
        ? String(claims.inputDigest || claims.input_digest)
        : executionInputDigest(claims.input || {});
    const policySnapshot = /^[a-f0-9]{64}$/.test(String(claims.policySnapshot || claims.policy_snapshot || ''))
        ? String(claims.policySnapshot || claims.policy_snapshot)
        : sha256(canonicalJson(claims.policy || {}));
    const issuedAt = Math.floor(nowMs / 1000);
    const payload = {
        version: GRANT_VERSION,
        audience: GRANT_AUDIENCE,
        grantId: crypto.randomUUID(),
        runId,
        userId,
        tenantId: Number.parseInt(claims.tenantId ?? claims.tenant_id, 10) || 0,
        tool,
        capability,
        inputDigest,
        policySnapshot,
        workspace: normalizeWorkspace(claims.workspace),
        network: normalizeNetwork(claims.network),
        resources: normalizeResources(claims.resources),
        approvalKey: String(claims.approvalKey || claims.approval_key || '').slice(0, 255),
        iat: issuedAt,
        nbf: issuedAt - 1,
        exp: issuedAt + Math.floor(ttlMs / 1000)
    };
    return { token: signPayload(payload, secret), payload, summary: summarizeExecutionGrant(payload) };
}

function assertExpected(payload, expected = {}) {
    const comparisons = [
        ['runId', expected.runId ?? expected.run_id],
        ['userId', expected.userId ?? expected.user_id],
        ['tool', expected.tool],
        ['capability', expected.capability],
        ['inputDigest', expected.inputDigest ?? (expected.input !== undefined ? executionInputDigest(expected.input) : undefined)],
        ['policySnapshot', expected.policySnapshot]
    ];
    for (const [field, expectedValue] of comparisons) {
        if (expectedValue === undefined || expectedValue === null || expectedValue === '') continue;
        if (String(payload[field]) !== String(expectedValue)) {
            throw grantError(`执行授权与当前 ${field} 不匹配。`, 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH');
        }
    }
    if (expected.workspaceScopeId && String(payload.workspace?.scopeId || '') !== String(expected.workspaceScopeId)) {
        throw grantError('执行授权与当前工作区不匹配。', 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH');
    }
}

function verifyExecutionGrant(token, expected = {}, options = {}) {
    const secret = grantSecret(options);
    const { parts, payload } = decodeToken(token);
    const actual = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!safeTimingEqual(parts[2], actual)) throw grantError('执行授权签名无效。', 'AGENT_EXECUTION_GRANT_SIGNATURE_INVALID');
    if (Number(payload.version) !== GRANT_VERSION || payload.audience !== GRANT_AUDIENCE) {
        throw grantError('执行授权版本或受众无效。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID');
    }
    const nowSeconds = Math.floor(Number(options.nowMs ?? Date.now()) / 1000);
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= payload.iat || payload.exp - payload.iat > Math.ceil(MAX_TTL_MS / 1000)) {
        throw grantError('执行授权有效期无效。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID');
    }
    if (payload.nbf && nowSeconds < Number(payload.nbf)) throw grantError('执行授权尚未生效。', 'AGENT_EXECUTION_GRANT_NOT_ACTIVE');
    if (nowSeconds >= payload.exp) throw grantError('执行授权已过期。', 'AGENT_EXECUTION_GRANT_EXPIRED');
    normalizeWorkspace(payload.workspace);
    normalizeNetwork(payload.network);
    normalizeResources(payload.resources);
    assertExpected(payload, expected);
    return { payload, summary: summarizeExecutionGrant(payload) };
}

function issueToolExecutionGrant({ run = {}, user = {}, tool = {}, input = {}, executionPlan = {}, context = {} } = {}, options = {}) {
    if (executionPlan?.sandbox?.required !== true) return null;
    const toolName = normalizeString(tool.name || executionPlan.tool, 'tool', 160);
    const runId = normalizeString(run.id || context.runId || context.run?.id, 'runId', 160);
    const userId = user.id ?? run.user_id ?? context.userId;
    const workspaceScopeId = String(context.executionWorkspaceScopeId || `run:${runId}`).slice(0, 160);
    return issueExecutionGrant({
        runId,
        userId,
        tenantId: run.tenant_id ?? user.tenant_id ?? user.tenantId ?? 0,
        tool: toolName,
        capability: Array.isArray(tool.capabilities) && tool.capabilities.length ? String(tool.capabilities[0]) : 'workspace.execute',
        input,
        policy: {
            decision: executionPlan?.policy?.decision || '',
            reasons: executionPlan?.policy?.reasonCodes || [],
            approvalRequired: Boolean(executionPlan?.approval?.required),
            approvalGranted: context.approvalGranted === true
        },
        workspace: { scopeId: workspaceScopeId, mode: 'rw', target: '/workspace' },
        network: { mode: 'deny', allowOrigins: [] },
        resources: { timeoutMs: context.timeoutMs || input.timeoutMs || input.timeout_ms || 30_000 },
        approvalKey: context.approvalKey || context.operationKey || ''
    }, options);
}

module.exports = {
    DEFAULT_TTL_MS,

    executionInputDigest,
    grantError,
    issueExecutionGrant,
    issueToolExecutionGrant,

    verifyExecutionGrant
};
