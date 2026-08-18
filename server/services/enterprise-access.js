const { query } = require('../db/client');
const { logger } = require('../logger');

const RESOURCE_TYPES = new Set(['knowledge_doc', 'knowledge_collection', 'mcp_tool', 'model', 'session', 'agent', 'dataset']);
const SUBJECT_TYPES = new Set(['user', 'team', 'organization', 'role']);

function normalizeResourceType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return RESOURCE_TYPES.has(type) ? type : 'session';
}

function normalizeSubjectType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return SUBJECT_TYPES.has(type) ? type : 'user';
}

function parseJson(value, fallback) {
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
        logger.warn({ err: err.message, userId: safeUserId }, 'Enterprise context lookup failed');
        return { organizations: [], teams: [], permissions: [] };
    }
}

function isEnterpriseAccessEnabled(env = process.env) {
    return String(env.PIVOT_ENTERPRISE_ACCESS || '').trim().toLowerCase() === 'true';
}

module.exports = {
    getUserEnterpriseContext,
    isEnterpriseAccessEnabled,
    listResourcePermissions,
    normalizeResourceType,
    normalizeSubjectType
};
