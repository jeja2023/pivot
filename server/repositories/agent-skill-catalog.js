'use strict';

const { query } = require('../db/client');

async function readSkillReleasePage({ ownerKey, tenantId, cursor, name = '', publishedOnly = false }) {
    const where = [tenantId == null
        ? "r.owner_key = ? AND r.rollout_scope = 'personal'"
        : "((r.owner_key = ? AND r.rollout_scope = 'personal') OR (r.tenant_id = ? AND r.rollout_scope <> 'personal'))"];
    const params = tenantId == null ? [ownerKey] : [ownerKey, tenantId];
    if (publishedOnly) where.push("r.status = 'published'");
    if (name) { where.push('r.name = ?'); params.push(name); }
    if (cursor) {
        where.push('(r.published_at, r.id) < (?::timestamptz, ?)');
        params.push(cursor.publishedAt, cursor.id);
    }
    return query(`SELECT r.*, r.published_at::text AS catalog_cursor,
        v.version, v.manifest_yaml, v.manifest_json, v.instructions_md, v.digest, v.content_digest
        FROM agent_skill_releases r JOIN agent_skill_versions v ON v.id = r.skill_version_id
        WHERE ${where.map(clause => `(${clause})`).join(' AND ')}
        ORDER BY r.published_at DESC, r.id DESC LIMIT 200`, params);
}

module.exports = { readSkillReleasePage };
