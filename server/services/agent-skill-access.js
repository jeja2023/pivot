/**
 * server/services/agent-skill-access.js
 * 技能版本与发布的访问判定
 *
 * 落地方案 v1.2 §2.3-C5、§6.2 与阶段 1.4 / 1.6：
 * 1. 用「角色 + 租户 + 团队成员关系 + resource_permissions」组合判定替换
 *    created_by / published_by 硬绑定，使管理员可以治理他人技能；
 * 2. 「创建者可读写自己的草稿」保留为其中一条规则，而不是唯一规则；
 * 3. skill_release 的受众判定不能只看 ACL 行是否存在，必须同时展开
 *    用户主体、团队成员、组织归属与角色主体。
 */
const {
    getUserEnterpriseContext,
    listResourcePermissionsForResource,
    normalizeResourceAction,
    normalizeSubjectType
} = require('./enterprise-access');
const { query, queryOne, execute } = require('../db/client');
const { normalizeTenantId } = require('./agent-tenant-context');
const { normalizeReleaseScope, parseOwnerKey } = require('./agent-skill-scope');

const SKILL_RELEASE_RESOURCE_TYPE = 'skill_release';
const SKILL_VERSION_RESOURCE_TYPE = 'skill_version';
const SKILL_RELEASE_ACTIONS = Object.freeze(['use', 'publish', 'manage']);

function accessError(message, code = 'SKILL_ACCESS_FORBIDDEN', status = 403) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
}

function normalizeRole(user) {
    return String(user?.role || '').trim().toLowerCase();
}

function isTenantAdmin(user) {
    return ['admin', 'root'].includes(normalizeRole(user));
}

/** 汇总当前用户可用于 ACL 匹配的全部主体。 */
async function resolveAccessSubjects(user) {
    const userId = Number.parseInt(user?.id, 10) || 0;
    const context = await getUserEnterpriseContext(userId);
    const teamIds = (context.teams || []).map(team => Number.parseInt(team.id, 10)).filter(Boolean);
    const directTenantId = normalizeTenantId(user?.tenant_id ?? user?.tenantId);
    const organizationIds = [...new Set([
        ...(context.organizations || []).map(item => Number.parseInt(item.id, 10)).filter(Boolean),
        ...(directTenantId ? [directTenantId] : [])
    ])];
    const teamRoles = new Map((context.teams || []).map(team => [Number.parseInt(team.id, 10), String(team.role || 'member').toLowerCase()]));
    const subjects = [
        { type: 'user', id: userId },
        ...teamIds.map(id => ({ type: 'team', id })),
        ...organizationIds.map(id => ({ type: 'organization', id })),
        { type: 'role', id: normalizeRole(user) || 'user' }
    ];
    return { userId, teamIds, organizationIds, teamRoles, subjects, role: normalizeRole(user) };
}

/** 动作蕴含关系：manage 蕴含 publish 与 use，publish 蕴含 use。 */
function actionSatisfies(granted, required) {
    const order = { use: 1, publish: 2, manage: 3 };
    const grantedRank = order[normalizeResourceAction(granted)] || 0;
    const requiredRank = order[normalizeResourceAction(required)] || 0;
    return grantedRank > 0 && requiredRank > 0 && grantedRank >= requiredRank;
}

/**
 * 判定 ACL 行集合是否放行。deny 优先于 allow（显式拒绝不可被其他主体的 allow 覆盖）。
 */
function decideByAclRows(rows, action) {
    const relevant = (rows || []).filter(row => actionSatisfies(row.action, action));
    if (relevant.some(row => row.effect === 'deny')) return 'deny';
    return relevant.some(row => row.effect === 'allow') ? 'allow' : 'none';
}

/**
 * 判定用户能否对某个 Release 执行指定动作。
 * @param {Object} params.release agent_skill_releases 行（需含 tenant_id / team_id / rollout_scope / owner_key / published_by）
 * @param {string} params.action use | publish | manage
 * @returns {Promise<{allowed:boolean, reason:string, via:string}>}
 */
async function evaluateSkillReleaseAccess({ user, release, action = 'use', subjects = null } = {}) {
    const required = normalizeResourceAction(action);
    if (!SKILL_RELEASE_ACTIONS.includes(required)) {
        return { allowed: false, reason: '不支持的技能发布动作。', via: 'invalid_action' };
    }
    if (!release) return { allowed: false, reason: '技能发布不存在。', via: 'missing_release' };
    const context = subjects || await resolveAccessSubjects(user);
    const releaseTenantId = normalizeTenantId(release.tenant_id);
    const scope = normalizeReleaseScope(release.rollout_scope || 'personal');
    const owner = parseOwnerKey(release.owner_key);

    // ACL 显式 deny 具有最高优先级。
    const aclRows = await listResourcePermissionsForResource({
        resourceType: SKILL_RELEASE_RESOURCE_TYPE,
        resourceId: release.id,
        subjects: context.subjects
    });
    const aclDecision = decideByAclRows(aclRows, required);
    if (aclDecision === 'deny') return { allowed: false, reason: '已被显式拒绝访问该技能发布。', via: 'acl_deny' };

    // 个人范围：仅创建者本人，或同租户管理员做治理动作。
    if (scope === 'personal') {
        if (owner.type === 'user' && owner.id === context.userId) return { allowed: true, reason: '', via: 'owner' };
        if (aclDecision === 'allow') return { allowed: true, reason: '', via: 'acl_allow' };
        if (isTenantAdmin(user) && required === 'manage'
            && (!releaseTenantId || context.organizationIds.includes(releaseTenantId))) {
            return { allowed: true, reason: '', via: 'tenant_admin' };
        }
        return { allowed: false, reason: '个人范围技能仅创建者本人可用。', via: 'personal_scope' };
    }

    // 共享范围：租户必须匹配，绝不跨租户放行。
    if (!releaseTenantId) return { allowed: false, reason: '技能发布缺少租户归属。', via: 'tenant_missing' };
    if (!context.organizationIds.includes(releaseTenantId)) {
        return { allowed: false, reason: '技能发布不属于当前用户所在组织。', via: 'tenant_mismatch' };
    }

    if (scope === 'team') {
        const teamId = Number.parseInt(release.team_id, 10) || (owner.type === 'team' ? owner.id : null);
        if (!teamId) return { allowed: false, reason: '团队范围技能缺少团队归属。', via: 'team_missing' };
        const memberRole = context.teamRoles.get(teamId);
        if (!memberRole) {
            if (aclDecision === 'allow') return { allowed: true, reason: '', via: 'acl_allow' };
            if (isTenantAdmin(user)) return { allowed: true, reason: '', via: 'tenant_admin' };
            return { allowed: false, reason: '当前用户不是该团队成员。', via: 'team_member_missing' };
        }
        if (required === 'use') return { allowed: true, reason: '', via: 'team_member' };
        if (['owner', 'admin', 'manager'].includes(memberRole)) return { allowed: true, reason: '', via: 'team_admin' };
        if (aclDecision === 'allow') return { allowed: true, reason: '', via: 'acl_allow' };
        if (isTenantAdmin(user)) return { allowed: true, reason: '', via: 'tenant_admin' };
        return { allowed: false, reason: '团队技能的发布与治理需要团队管理员或被授权发布者。', via: 'team_role' };
    }

    // organization 范围
    if (required === 'use') return { allowed: true, reason: '', via: 'organization_member' };
    if (isTenantAdmin(user)) return { allowed: true, reason: '', via: 'tenant_admin' };
    if (aclDecision === 'allow') return { allowed: true, reason: '', via: 'acl_allow' };
    return { allowed: false, reason: '组织技能的发布与治理需要组织管理员。', via: 'organization_role' };
}

/** 判定失败即抛出 403，供路由与服务层直接使用。 */
async function assertSkillReleaseAccess(params = {}) {
    const decision = await evaluateSkillReleaseAccess(params);
    if (!decision.allowed) throw accessError(decision.reason || '无权访问该技能发布。');
    return decision;
}

/**
 * 判定用户能否对某个技能版本执行动作（read / write / manage）。
 * 替换 agent-releases.js 中 `WHERE id = ? AND created_by = ?` 的硬绑定。
 */
async function evaluateSkillVersionAccess({ user, version, action = 'read', subjects = null } = {}) {
    if (!version) return { allowed: false, reason: '技能版本不存在。', via: 'missing_version' };
    const context = subjects || await resolveAccessSubjects(user);
    const required = normalizeResourceAction(action === 'read' ? 'read' : action);
    const createdBy = Number.parseInt(version.created_by, 10) || 0;
    const versionTenantId = normalizeTenantId(version.tenant_id);

    const aclRows = await listResourcePermissionsForResource({
        resourceType: SKILL_VERSION_RESOURCE_TYPE,
        resourceId: version.id,
        subjects: context.subjects
    });
    if (aclRows.some(row => row.effect === 'deny')) {
        return { allowed: false, reason: '已被显式拒绝访问该技能版本。', via: 'acl_deny' };
    }
    // 规则一：创建者可读写自己的草稿与版本。
    if (createdBy && createdBy === context.userId) return { allowed: true, reason: '', via: 'creator' };
    // 规则二：同租户管理员可治理他人版本（留审计）。
    if (isTenantAdmin(user) && (!versionTenantId || context.organizationIds.includes(versionTenantId))) {
        return { allowed: true, reason: '', via: 'tenant_admin' };
    }
    // 规则三：显式 ACL 授权。
    if (aclRows.some(row => row.effect === 'allow'
        && (row.action === 'manage' || row.action === required || (required === 'read' && row.action === 'write')))) {
        return { allowed: true, reason: '', via: 'acl_allow' };
    }
    return { allowed: false, reason: '无权访问该技能版本。', via: 'denied' };
}

async function assertSkillVersionAccess(params = {}) {
    const decision = await evaluateSkillVersionAccess(params);
    if (!decision.allowed) throw accessError(decision.reason || '无权访问该技能版本。');
    return decision;
}

function normalizePermissionInput(input = {}) {
    const subjectType = String(input.subjectType || input.subject_type || '').trim().toLowerCase();
    const subjectId = String(input.subjectId || input.subject_id || '').trim();
    const action = String(input.action || '').trim().toLowerCase();
    const effect = String(input.effect || 'allow').trim().toLowerCase();
    if (!['user', 'team', 'organization', 'role'].includes(subjectType) || normalizeSubjectType(subjectType) !== subjectType) {
        throw accessError('授权主体只能是 user、team、organization 或 role。', 'SKILL_PERMISSION_SUBJECT_INVALID', 400);
    }
    if (!subjectId || subjectId.length > 120) throw accessError('授权主体标识非法。', 'SKILL_PERMISSION_SUBJECT_INVALID', 400);
    if (!SKILL_RELEASE_ACTIONS.includes(action)) throw accessError('技能发布授权动作只能是 use、publish 或 manage。', 'SKILL_PERMISSION_ACTION_INVALID', 400);
    if (!['allow', 'deny'].includes(effect)) throw accessError('授权效果只能是 allow 或 deny。', 'SKILL_PERMISSION_EFFECT_INVALID', 400);
    return { subjectType, subjectId, action, effect };
}

/** 避免把 ACL 写给其他租户的用户、团队或组织主体。 */
async function assertPermissionSubjectTenant(release, permission) {
    const tenantId = normalizeTenantId(release?.tenant_id);
    if (!tenantId) throw accessError('技能发布缺少租户归属。', 'SKILL_TENANT_UNRESOLVED', 409);
    if (permission.subjectType === 'organization') {
        if (Number.parseInt(permission.subjectId, 10) !== tenantId) {
            throw accessError('组织授权主体必须属于当前技能租户。', 'SKILL_PERMISSION_TENANT_MISMATCH', 409);
        }
        return;
    }
    if (permission.subjectType === 'team') {
        const team = await queryOne('SELECT organization_id FROM teams WHERE id = ? AND status = ?', [permission.subjectId, 'active']);
        if (!team || Number(team.organization_id) !== tenantId) {
            throw accessError('团队授权主体必须属于当前技能租户。', 'SKILL_PERMISSION_TENANT_MISMATCH', 409);
        }
        return;
    }
    if (permission.subjectType === 'user') {
        const context = await getUserEnterpriseContext(permission.subjectId);
        if (!(context.organizations || []).some(item => Number(item.id) === tenantId)) {
            throw accessError('用户授权主体必须属于当前技能租户。', 'SKILL_PERMISSION_TENANT_MISMATCH', 409);
        }
        return;
    }
    if (!['user', 'manager', 'admin', 'root'].includes(permission.subjectId)) {
        throw accessError('角色授权主体不受支持。', 'SKILL_PERMISSION_SUBJECT_INVALID', 400);
    }
}

async function getManageableSkillRelease(releaseId, user) {
    const release = await queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [releaseId]);
    if (!release) return null;
    await assertSkillReleaseAccess({ user, release, action: 'manage' });
    return release;
}

async function listSkillReleasePermissions(releaseId, user) {
    const release = await getManageableSkillRelease(releaseId, user);
    if (!release) return null;
    const permissions = await query(`
        SELECT id, subject_type, subject_id, action, effect, conditions_json, created_at, updated_at
        FROM resource_permissions
        WHERE resource_type = ? AND resource_id = ?
        ORDER BY subject_type, subject_id, action, id
    `, [SKILL_RELEASE_RESOURCE_TYPE, String(release.id)]);
    return { release, permissions };
}

/** 新建或更新一条 release ACL；相同主体/动作先清理旧行，避免 allow/deny 重复语义不明。 */
async function upsertSkillReleasePermission(releaseId, user, input = {}) {
    const release = await getManageableSkillRelease(releaseId, user);
    if (!release) return null;
    const permission = normalizePermissionInput(input);
    await assertPermissionSubjectTenant(release, permission);
    await execute(`
        DELETE FROM resource_permissions
        WHERE resource_type = ? AND resource_id = ? AND subject_type = ? AND subject_id = ? AND action = ?
    `, [SKILL_RELEASE_RESOURCE_TYPE, String(release.id), permission.subjectType, permission.subjectId, permission.action]);
    const inserted = await queryOne(`
        INSERT INTO resource_permissions (subject_type, subject_id, resource_type, resource_id, action, effect, conditions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id, subject_type, subject_id, resource_type, resource_id, action, effect, conditions_json, created_at, updated_at
    `, [permission.subjectType, permission.subjectId, SKILL_RELEASE_RESOURCE_TYPE, String(release.id), permission.action, permission.effect, '{}']);
    return inserted;
}

async function deleteSkillReleasePermission(releaseId, permissionId, user) {
    const release = await getManageableSkillRelease(releaseId, user);
    if (!release) return null;
    const rows = await query(`
        DELETE FROM resource_permissions
        WHERE id = ? AND resource_type = ? AND resource_id = ?
        RETURNING id
    `, [permissionId, SKILL_RELEASE_RESOURCE_TYPE, String(release.id)]);
    return rows[0] || null;
}

module.exports = {
    SKILL_RELEASE_ACTIONS,
    SKILL_RELEASE_RESOURCE_TYPE,
    SKILL_VERSION_RESOURCE_TYPE,
    actionSatisfies,
    assertSkillReleaseAccess,
    assertSkillVersionAccess,
    deleteSkillReleasePermission,
    evaluateSkillReleaseAccess,
    evaluateSkillVersionAccess,
    isTenantAdmin,
    listSkillReleasePermissions,
    normalizePermissionInput,
    resolveAccessSubjects,
    upsertSkillReleasePermission
};
