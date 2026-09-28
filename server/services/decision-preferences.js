'use strict';

const crypto = require('crypto');
const { execute, query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeActionId } = require('./decision-provider');

const CACHE_TTL_MS = 15_000;
const cache = new Map();
const FIND_PREFERENCE_SQL = 
    'SELECT id, scope, subject_key, user_id, tenant_id, scenario, action_id, enabled, updated_at ' +
    'FROM decision_preferences WHERE scenario = ? AND enabled = TRUE AND subject_key IN (?, ?) ' +
    "ORDER BY CASE WHEN scope = 'user' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1";
const LIST_PREFERENCES_SQL = 'SELECT id, scope, subject_key, user_id, tenant_id, scenario, action_id, enabled, created_at, updated_at FROM decision_preferences WHERE subject_key = ? ORDER BY scenario ASC';
const UPSERT_PREFERENCE_SQL = 
    'INSERT INTO decision_preferences (id, scope, subject_key, user_id, tenant_id, scenario, action_id, enabled, created_by, updated_by, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT (subject_key, scenario) DO UPDATE SET action_id = EXCLUDED.action_id, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at';

function normalizeScope(value) {
    const scope = String(value || '').toLowerCase();
    return ['user', 'tenant'].includes(scope) ? scope : '';
}

function normalizePositiveId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function subjectKey(scope, userId, tenantId) {
    if (scope === 'user' && userId) return 'user:' + userId;
    if (scope === 'tenant' && tenantId) return 'tenant:' + tenantId;
    return '';
}

function clearDecisionPreferenceCache() {
    cache.clear();
}

function preferenceCacheKey({ userId, tenantId, scenario }) {
    return [userId || '', tenantId || '', String(scenario || '')].join('|');
}

async function getDecisionPreference({ userId = null, tenantId = null, scenario = '' } = {}, deps = {}) {
    const safeUserId = normalizePositiveId(userId);
    const safeTenantId = normalizePositiveId(tenantId);
    const safeScenario = String(scenario || '').trim().slice(0, 80);
    if (!safeScenario || (!safeUserId && !safeTenantId)) return null;
    const key = preferenceCacheKey({ userId: safeUserId, tenantId: safeTenantId, scenario: safeScenario });
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const userKey = subjectKey('user', safeUserId, null) || '__none__';
    const tenantKey = subjectKey('tenant', null, safeTenantId) || '__none__';
    const row = await (deps.queryOne || queryOne)(FIND_PREFERENCE_SQL, [safeScenario, userKey, tenantKey]);
    const value = row ? { id: row.id, scope: row.scope, actionId: normalizeActionId(row.action_id), scenario: row.scenario, updatedAt: row.updated_at } : null;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value?.actionId ? value : null;
}

async function listDecisionPreferences({ scope = 'user', userId = null, tenantId = null } = {}, deps = {}) {
    const safeScope = normalizeScope(scope);
    const key = subjectKey(safeScope, normalizePositiveId(userId), normalizePositiveId(tenantId));
    if (!key) return [];
    return await (deps.query || query)(LIST_PREFERENCES_SQL, [key]);
}

async function saveDecisionPreference({ scope = 'user', userId = null, tenantId = null, scenario = '', actionId = '', enabled = true, actorId = null } = {}, deps = {}) {
    const safeScope = normalizeScope(scope);
    const safeUserId = normalizePositiveId(userId);
    const safeTenantId = normalizePositiveId(tenantId);
    const safeActorId = normalizePositiveId(actorId);
    const key = subjectKey(safeScope, safeUserId, safeTenantId);
    const safeScenario = String(scenario || '').trim().slice(0, 80);
    const safeActionId = normalizeActionId(actionId);
    if (!key || !safeScenario || !safeActionId || !safeActorId) throw new Error('invalid_decision_preference');
    const now = getBeijingTimestamp();
    const id = 'preference_' + crypto.randomUUID();
    await (deps.execute || execute)(UPSERT_PREFERENCE_SQL, [id, safeScope, key, safeScope === 'user' ? safeUserId : null, safeScope === 'tenant' ? safeTenantId : null, safeScenario, safeActionId, enabled !== false, safeActorId, safeActorId, now, now]);
    clearDecisionPreferenceCache();
    return { id, scope: safeScope, subjectKey: key, userId: safeScope === 'user' ? safeUserId : null, tenantId: safeScope === 'tenant' ? safeTenantId : null, scenario: safeScenario, actionId: safeActionId, enabled: enabled !== false, updatedAt: now };
}

module.exports = {
    getDecisionPreference,
    listDecisionPreferences,
    saveDecisionPreference
};
