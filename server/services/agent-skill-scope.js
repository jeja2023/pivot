/**
 * server/services/agent-skill-scope.js
 * 技能发布作用域的单一枚举与 ownerKey 服务端推导
 *
 * 落地方案 v1.2 §6.1、阶段 0.4 与 1.1：
 * 1. 业务语义只保留 personal / team / organization 三个值；
 *    user / shared / global 仅作为历史投影值存在，通过本模块双向映射，读写路径不得直接使用；
 * 2. ownerKey 一律由「发布作用域 + 发布者身份 + 租户」在服务端推导，
 *    禁止取自请求入参或 manifest.scope（A2 越权链的根因）。
 *
 * 本模块是叶子节点，不访问数据库。
 */

const RELEASE_SCOPES = Object.freeze(['personal', 'team', 'organization']);

/** 历史投影值 → 新枚举。仅用于读取旧数据与写 agent_skills 只读投影。 */
const LEGACY_SCOPE_TO_RELEASE = Object.freeze({
    user: 'personal',
    personal: 'personal',
    shared: 'team',
    team: 'team',
    global: 'organization',
    organization: 'organization'
});

/** 新枚举 → 历史投影值。agent_skills.scope 作为 read model 仍写旧值以兼容既有前端。 */
const RELEASE_SCOPE_TO_LEGACY = Object.freeze({
    personal: 'user',
    team: 'shared',
    organization: 'global'
});

function scopeError(message, code = 'SKILL_SCOPE_INVALID', status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
}

function normalizeReleaseScope(value, fallback = 'personal') {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    const mapped = LEGACY_SCOPE_TO_RELEASE[raw];
    if (!mapped) throw scopeError('发布范围只能是 personal、team 或 organization。');
    return mapped;
}

function toLegacyScope(value) {
    return RELEASE_SCOPE_TO_LEGACY[normalizeReleaseScope(value)] || 'user';
}

/**
 * 服务端推导 ownerKey。任何调用方都不得传入 ownerKey。
 * personal → user:<userId>；team → team:<teamId>；organization → org:<tenantId>。
 * team / organization 必须已解析出租户，否则拒绝（对应 §6.1 第 3 条）。
 */
function deriveOwnerKey({ scope, userId, tenantId = null, teamId = null } = {}) {
    const releaseScope = normalizeReleaseScope(scope);
    const safeUserId = Number.parseInt(userId, 10);
    if (releaseScope === 'personal') {
        if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
            throw scopeError('个人技能必须绑定有效的创建者。');
        }
        return `user:${safeUserId}`;
    }
    const safeTenantId = Number.parseInt(tenantId, 10);
    if (!Number.isSafeInteger(safeTenantId) || safeTenantId <= 0) {
        throw scopeError('共享范围的技能必须能解析出租户。', 'SKILL_TENANT_UNRESOLVED', 409);
    }
    if (releaseScope === 'team') {
        const safeTeamId = Number.parseInt(teamId, 10);
        if (!Number.isSafeInteger(safeTeamId) || safeTeamId <= 0) {
            throw scopeError('团队范围的技能必须指定团队。', 'SKILL_TENANT_UNRESOLVED', 409);
        }
        return `team:${safeTeamId}`;
    }
    return `org:${safeTenantId}`;
}

/** 解析 ownerKey，兼容历史 scope:shared / scope:global 值。 */
function parseOwnerKey(value) {
    const text = String(value ?? '').trim();
    if (!text) return { type: 'unknown', id: null, scope: 'personal', legacy: false };
    const [prefix, ...rest] = text.split(':');
    const suffix = rest.join(':');
    if (prefix === 'user') return { type: 'user', id: Number.parseInt(suffix, 10) || null, scope: 'personal', legacy: false };
    if (prefix === 'team') return { type: 'team', id: Number.parseInt(suffix, 10) || null, scope: 'team', legacy: false };
    if (prefix === 'org') return { type: 'organization', id: Number.parseInt(suffix, 10) || null, scope: 'organization', legacy: false };
    if (prefix === 'scope') {
        // 历史 owner_key。scope:global 不带租户，是 A2 越权链的载体，读取时统一按组织范围处理，
        // 但必须叠加租户过滤，且迁移会改写为 org:<tenantId>。
        return { type: 'organization', id: null, scope: LEGACY_SCOPE_TO_RELEASE[suffix] || 'organization', legacy: true };
    }
    return { type: 'unknown', id: null, scope: 'personal', legacy: true };
}

/** 判定 ownerKey 是否属于共享范围（团队或组织）。 */
function isSharedOwnerKey(value) {
    return parseOwnerKey(value).scope !== 'personal';
}

module.exports = {
    LEGACY_SCOPE_TO_RELEASE,
    RELEASE_SCOPES,
    RELEASE_SCOPE_TO_LEGACY,
    deriveOwnerKey,
    isSharedOwnerKey,
    normalizeReleaseScope,
    parseOwnerKey,
    toLegacyScope
};
