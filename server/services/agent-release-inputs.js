'use strict';

const { normalizeReleaseScope } = require('./agent-skill-scope');
const { normalizeBreakerThresholds } = require('./agent-skill-rollout');

function invalidInput(message, status = 400, code = 'AGENT_RELEASE_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}


function allowedSkillPermissionsFromEnv(env = process.env) {
    const permissions = String(env.AGENT_SKILL_ALLOWED_PERMISSIONS || '').split(',').map(item => item.trim()).filter(Boolean);
    return permissions.length ? permissions : undefined;
}

function normalizeSkillSourceId(value) {
    const id = String(value || '').trim().slice(0, 64);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw invalidInput('技能来源 ID 格式无效。', 400, 'MEMORY_SKILL_SOURCE_INVALID');
    return id;
}

function skillMemorySourceContent(version = {}) {
    return `${version.content_digest || version.digest || ''}:${version.manifest_json || version.manifest_yaml || ''}:${version.instructions_md || ''}`;
}


function normalizeScope(value) {
    try {
        return normalizeReleaseScope(value, 'personal');
    } catch (_) {
        throw invalidInput('发布范围只能是 personal、team 或 organization。');
    }
}

function normalizeWorkflowReleaseNote(value, label = '发布说明') {
    const note = String(value || '').trim();
    if (note.length > 2000) throw invalidInput(`${label}最多 2000 个字符。`);
    return note;
}

function normalizeIdList(value, limit) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))].slice(0, limit);
}

/**
 * 规范化灰度输入。
 * 落地方案 v1.2 §6.3：target_units 由「匹配 user.unit 字符串」迁移为 team_id 引用，
 * 并在运行时经 team_members 实时校验；熔断阈值在发布时冻结。
 */
function normalizeRollout(input = {}) {
    return {
        rolloutScope: normalizeScope(input.rolloutScope || input.rollout_scope || input.scope),
        rolloutPercent: Math.max(1, Math.min(Number.parseInt(input.rolloutPercent ?? input.rollout_percent, 10) || 100, 100)),
        targetUserIds: normalizeIdList(input.targetUserIds || input.target_user_ids, 500),
        targetUnits: normalizeIdList(input.targetTeamIds || input.target_team_ids || input.targetUnits || input.target_units, 100),
        teamId: Number.parseInt(input.teamId ?? input.team_id, 10) || null,
        breakerThresholds: normalizeBreakerThresholds(input.breakerThresholds || input.breaker_thresholds)
    };
}



module.exports = {
    parseJson,
    allowedSkillPermissionsFromEnv,
    normalizeSkillSourceId,
    skillMemorySourceContent,
    normalizeScope,
    normalizeWorkflowReleaseNote,
    normalizeIdList,
    normalizeRollout
};
