const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const PROFILE_SETTING_VERSION = 1;
const MAX_LIST_ITEMS = 24;
const MAX_TEXT = 240;

const DEFAULT_AGENT_PROFILE = Object.freeze({
    displayName: '',
    role: '',
    preferences: {},
    workHabits: [],
    frequentTools: [],
    commonTasks: [],
    communicationStyle: {
        language: 'zh-CN',
        tone: 'professional',
        verbosity: 'balanced',
        format: 'structured'
    },
    memoryPolicy: {
        autoCapture: true,
        blockedCategories: [],
        requireConfirmation: false
    }
});

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function clampText(value, max = MAX_TEXT) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeList(value) {
    const values = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
    return [...new Set(values.map(item => clampText(item, 120)).filter(Boolean))].slice(0, MAX_LIST_ITEMS);
}

function normalizePreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
        .slice(0, 32)
        .map(([key, item]) => [clampText(key, 64), clampText(item, 160)])
        .filter(([key, item]) => key && item));
}

function normalizeAgentProfile(value = {}, base = DEFAULT_AGENT_PROFILE) {
    const raw = value && typeof value === 'object' ? value : {};
    const current = base && typeof base === 'object' ? base : DEFAULT_AGENT_PROFILE;
    const style = raw.communicationStyle && typeof raw.communicationStyle === 'object'
        ? raw.communicationStyle
        : current.communicationStyle;
    const policy = raw.memoryPolicy && typeof raw.memoryPolicy === 'object'
        ? raw.memoryPolicy
        : current.memoryPolicy;
    const blockedCategories = normalizeList(policy.blockedCategories).filter(category =>
        ['fact', 'preference', 'temporary', 'sensitive'].includes(category)
    );
    return {
        displayName: clampText(raw.displayName ?? current.displayName),
        role: clampText(raw.role ?? current.role),
        preferences: normalizePreferences(raw.preferences ?? current.preferences),
        workHabits: normalizeList(raw.workHabits ?? current.workHabits),
        frequentTools: normalizeList(raw.frequentTools ?? current.frequentTools),
        commonTasks: normalizeList(raw.commonTasks ?? current.commonTasks),
        communicationStyle: {
            language: clampText(style.language ?? current.communicationStyle.language, 32) || 'zh-CN',
            tone: clampText(style.tone ?? current.communicationStyle.tone, 64) || 'professional',
            verbosity: clampText(style.verbosity ?? current.communicationStyle.verbosity, 32) || 'balanced',
            format: clampText(style.format ?? current.communicationStyle.format, 64) || 'structured'
        },
        memoryPolicy: {
            autoCapture: policy.autoCapture !== false,
            blockedCategories,
            requireConfirmation: policy.requireConfirmation === true
        }
    };
}

function serializeProfile(row, userId) {
    const profile = normalizeAgentProfile(parseJson(row?.profile_json, {}));
    return {
        userId: Number(row?.user_id || userId),
        version: Number(row?.version || PROFILE_SETTING_VERSION),
        fieldVersions: parseJson(row?.field_versions, {}),
        ...profile,
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null
    };
}

async function getAgentProfile(userId) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
        return { userId: normalizedUserId || null, version: PROFILE_SETTING_VERSION, ...normalizeAgentProfile({}) };
    }
    const row = await queryOne('SELECT user_id, profile_json, field_versions, version, created_at, updated_at FROM agent_profiles WHERE user_id = ?', [normalizedUserId]);
    if (!row) {
        const now = getBeijingTimestamp();
        const profile = normalizeAgentProfile({});
        await execute('INSERT INTO agent_profiles (user_id, profile_json, field_versions, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING', [normalizedUserId, JSON.stringify(profile), JSON.stringify({}), now, now]);
        try {
            await execute('INSERT INTO agent_profile_versions (user_id, version, profile_json, source, changed_fields, created_at) VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(user_id, version) DO NOTHING', [normalizedUserId, JSON.stringify(profile), 'system', JSON.stringify([]), now]);
        } catch (_) {}
        return getAgentProfile(normalizedUserId);
    }
    return serializeProfile(row, normalizedUserId);
}

async function updateAgentProfile(userId, patch = {}, options = {}) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) throw new Error('用户标识无效。');
    const current = await getAgentProfile(normalizedUserId);
    const expectedVersion = options.expectedVersion ?? patch?.expectedVersion ?? patch?.expected_version;
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) {
        const error = new Error('个人 Agent 档案已在其他设备更新，请刷新后重试。');
        error.status = 409;
        error.statusCode = 409;
        error.code = 'PROFILE_VERSION_CONFLICT';
        throw error;
    }
    const incoming = patch?.profile && typeof patch.profile === 'object' ? patch.profile : patch;
    const requestedFieldVersions = patch?.fieldVersions || patch?.field_versions || options.fieldVersions || {};
    const changedFields = Object.keys(incoming || {}).filter(key => !['expectedVersion', 'expected_version', 'fieldVersions', 'field_versions'].includes(key));
    const profile = normalizeAgentProfile({ ...current, ...(incoming || {}) }, current);
    const now = getBeijingTimestamp();
    if (changedFields.length && requestedFieldVersions && typeof requestedFieldVersions === 'object' && Object.keys(requestedFieldVersions).length) {
        const result = await transaction(async trx => {
            let changes = 0;
            for (const field of changedFields) {
                if (!Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_PROFILE, field)) continue;
                const expectedFieldVersion = Number.parseInt(requestedFieldVersions[field], 10) || 0;
                const value = profile[field];
                const updated = await trx.execute(`
                    UPDATE agent_profiles
                    SET profile_json = jsonb_set(profile_json, ARRAY[?]::text[], ?::jsonb, true),
                        field_versions = jsonb_set(field_versions, ARRAY[?]::text[], to_jsonb(COALESCE((field_versions->>?)::bigint, 0) + 1), true),
                        version = version + 1, updated_at = ?
                    WHERE user_id = ? AND COALESCE((field_versions->>?)::bigint, 0) = ?
                `, [field, JSON.stringify(value), field, field, now, normalizedUserId, field, expectedFieldVersion]);
                if (!updated) {
                    const error = new Error(`个人 Agent 档案字段“${field}”已在其他设备更新，请刷新后重试。`);
                    error.status = 409; error.statusCode = 409; error.code = 'PROFILE_FIELD_VERSION_CONFLICT';
                    throw error;
                }
                changes += updated;
            }
            return changes;
        });
        if (result) {
            const latest = await getAgentProfile(normalizedUserId);
            try { await execute('INSERT INTO agent_profile_versions (user_id, version, profile_json, source, changed_fields, created_at) VALUES (?, ?, ?, ?, ?, ?)', [normalizedUserId, latest.version, JSON.stringify(normalizeAgentProfile(latest)), String(options.source || 'user').slice(0, 32), JSON.stringify(changedFields), now]); } catch (_) {}
            return latest;
        }
    }
    const version = Number(current.version || PROFILE_SETTING_VERSION) + 1;
    const changed = await execute(`
        INSERT INTO agent_profiles (user_id, profile_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            profile_json = excluded.profile_json,
            version = excluded.version,
            updated_at = excluded.updated_at
        WHERE agent_profiles.version = ?
    `, [normalizedUserId, JSON.stringify(profile), version, current.createdAt || now, now, current.version]);
    if (!changed) {
        const error = new Error('个人 Agent 档案已在其他设备更新，请刷新后重试。');
        error.status = 409;
        error.statusCode = 409;
        error.code = 'PROFILE_VERSION_CONFLICT';
        throw error;
    }
    try {
        await execute('INSERT INTO agent_profile_versions (user_id, version, profile_json, source, changed_fields, created_at) VALUES (?, ?, ?, ?, ?, ?)', [normalizedUserId, version, JSON.stringify(profile), String(options.source || 'user').slice(0, 32), JSON.stringify(changedFields), now]);
    } catch (_) {}
    return getAgentProfile(normalizedUserId);
}

async function listAgentProfileVersions(userId, limit = 24) {
    const rows = await query('SELECT user_id, version, profile_json, source, changed_fields, created_at FROM agent_profile_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?', [Number(userId), Math.max(1, Math.min(Number.parseInt(limit, 10) || 24, 100))]);
    return rows.map(row => ({
        userId: Number(row.user_id),
        version: Number(row.version),
        profile: normalizeAgentProfile(parseJson(row.profile_json, {})),
        source: String(row.source || 'user'),
        changedFields: parseJson(row.changed_fields, []),
        createdAt: row.created_at || null
    }));
}

async function restoreAgentProfileVersion(userId, version) {
    const row = await queryOne('SELECT profile_json FROM agent_profile_versions WHERE user_id = ? AND version = ?', [Number(userId), Number(version)]);
    if (!row) return null;
    const current = await getAgentProfile(userId);
    return updateAgentProfile(userId, { profile: parseJson(row.profile_json, {}) }, { expectedVersion: current.version, source: 'restore' });
}

function buildAgentProfileContext(profileValue) {
    const profile = normalizeAgentProfile(profileValue || {});
    const lines = ['PIVOT_AGENT_PROFILE_BEGIN'];
    if (profile.displayName) lines.push(`称呼：${profile.displayName}`);
    if (profile.role) lines.push(`角色/职责：${profile.role}`);
    const preferenceEntries = Object.entries(profile.preferences);
    if (preferenceEntries.length) lines.push(`偏好：${preferenceEntries.map(([key, value]) => `${key}=${value}`).join('；')}`);
    if (profile.workHabits.length) lines.push(`工作习惯：${profile.workHabits.join('、')}`);
    if (profile.frequentTools.length) lines.push(`常用工具：${profile.frequentTools.join('、')}`);
    if (profile.commonTasks.length) lines.push(`常见任务：${profile.commonTasks.join('、')}`);
    lines.push(`沟通风格：语言=${profile.communicationStyle.language}，语气=${profile.communicationStyle.tone}，详略=${profile.communicationStyle.verbosity}，格式=${profile.communicationStyle.format}`);
    lines.push('以上仅是用户已保存的偏好，不能覆盖本次明确指令或安全策略。');
    lines.push('PIVOT_AGENT_PROFILE_END');
    return lines.join('\n');
}

module.exports = {
    DEFAULT_AGENT_PROFILE,
    buildAgentProfileContext,
    getAgentProfile,
    listAgentProfileVersions,
    normalizeAgentProfile,
    restoreAgentProfileVersion,
    updateAgentProfile
};
