const { query } = require('../db/client');
const { logger } = require('../logger');

const RESOURCE_TYPES = new Set([
    'knowledge_doc', 'knowledge_collection', 'mcp_tool', 'model', 'session', 'agent', 'dataset',
    // 落地方案 v1.2 §6.2：技能版本与发布受众复用 resource_permissions，不新建平行受众表。
    'skill_version', 'skill_release'
]);
const SUBJECT_TYPES = new Set(['user', 'team', 'organization', 'role']);
/** 资源动作枚举。skill_release 使用 use/publish/manage 三级。 */
const RESOURCE_ACTIONS = new Set(['read', 'write', 'use', 'publish', 'manage', 'admin']);

function normalizeResourceType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return RESOURCE_TYPES.has(type) ? type : 'session';
}

function normalizeSubjectType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return SUBJECT_TYPES.has(type) ? type : 'user';
}

function normalizeResourceAction(value) {
    const action = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return RESOURCE_ACTIONS.has(action) ? action : 'read';
}

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '');
    } catch (_err) {
        return fallback;
    }
}

async function listResourcePermissions(options = {}) {
    const subjectType = normalizeSubjectType(options.subjectType || options.subject_type);
    const subjectId = String(options.subjectId || options.subject_id || '').trim();
    if (!subjectId) return [];
    try {
        const rows = await query(`
            SELECT *
            FROM resource_permissions
            WHERE subject_type = ?
              AND subject_id = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT 200
        `, [subjectType, subjectId]);
        return (rows || []).map(row => ({
            id: row.id,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            resourceType: normalizeResourceType(row.resource_type),
            resourceId: row.resource_id,
            action: row.action,
            effect: row.effect,
            conditions: parseJson(row.conditions_json, {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    } catch (err) {
        return [];
    }
}

async function getUserEnterpriseContext(userId) {
    const safeUserId = Number(userId || 0);
    if (!safeUserId) return { organizations: [], teams: [], permissions: [] };
    try {
        const teams = await query(`
            SELECT
                tm.team_id,
                tm.role,
                t.name AS team_name,
                t.slug AS team_slug,
                o.id AS organization_id,
                o.name AS organization_name,
                o.slug AS organization_slug
            FROM team_members tm
            JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
            JOIN organizations o ON o.id = t.organization_id AND o.status = 'active'
            WHERE tm.user_id = ? AND tm.status = 'active'
            ORDER BY o.name, t.name
        `, [safeUserId]);
        const organizations = Array.from(new Map((teams || []).map(team => [team.organization_id, {
            id: team.organization_id,
            name: team.organization_name,
            slug: team.organization_slug
        }])).values());
        return {
            organizations,
            teams: (teams || []).map(team => ({
                id: team.team_id,
                name: team.team_name,
                slug: team.team_slug,
                role: team.role,
                organizationId: team.organization_id
            })),
            permissions: await listResourcePermissions({ subjectType: 'user', subjectId: safeUserId })
        };
    } catch (err) {
        logger.warn({ err: err.message, userId: safeUserId }, '查询企业多租户上下文失败');
        return { organizations: [], teams: [], permissions: [] };
    }
}

async function getPrimaryTenantId(userId) {
    const safeUserId = Number(userId || 0);
    if (!safeUserId) return null;
    try {
        const row = await query(`SELECT o.id FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.status = 'active' JOIN organizations o ON o.id = t.organization_id AND o.status = 'active' WHERE tm.user_id = ? AND tm.status = 'active' ORDER BY o.id LIMIT 1`, [safeUserId]);
        return row?.[0]?.id ? Number(row[0].id) : null;
    } catch (_) { return null; }
}

function isEnterpriseAccessEnabled(env = process.env) {
    return String(env.PIVOT_ENTERPRISE_ACCESS || '').trim().toLowerCase() === 'true';
}

/**
 * 按「资源 + 多个主体」批量查询 ACL 行。
 * 主体形如 [{ type: 'user', id: 3 }, { type: 'team', id: 9 }, { type: 'role', id: 'admin' }]。
 * 用于 assertSkillReleaseAccess 一次性汇总用户、团队、组织与角色四类主体，避免 N 次查询。
 */
async function listResourcePermissionsForResource({ resourceType, resourceId, subjects = [] } = {}) {
    const type = normalizeResourceType(resourceType);
    const id = String(resourceId ?? '').trim();
    const normalizedSubjects = (Array.isArray(subjects) ? subjects : [])
        .map(item => ({ type: normalizeSubjectType(item?.type), id: String(item?.id ?? '').trim() }))
        .filter(item => item.id);
    if (!id || !normalizedSubjects.length) return [];
    const conditions = normalizedSubjects.map(() => '(subject_type = ? AND subject_id = ?)').join(' OR ');
    const params = [type, id, ...normalizedSubjects.flatMap(item => [item.type, item.id])];
    try {
        const rows = await query(`
            SELECT subject_type, subject_id, resource_type, resource_id, action, effect, conditions_json
            FROM resource_permissions
            WHERE resource_type = ?
              AND resource_id = ?
              AND (${conditions})
            LIMIT 500
        `, params);
        return (rows || []).map(row => ({
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            resourceType: normalizeResourceType(row.resource_type),
            resourceId: row.resource_id,
            action: normalizeResourceAction(row.action),
            effect: String(row.effect || 'allow').toLowerCase(),
            conditions: parseJson(row.conditions_json, {})
        }));
    } catch (err) {
        logger.warn({ err: err.message, resourceType: type, resourceId: id }, '查询资源授权行失败');
        return [];
    }
}

module.exports = {
    RESOURCE_ACTIONS,
    getUserEnterpriseContext,
    getPrimaryTenantId,
    isEnterpriseAccessEnabled,
    listResourcePermissions,
    listResourcePermissionsForResource,
    normalizeResourceAction,
    normalizeResourceType,
    normalizeSubjectType
};
