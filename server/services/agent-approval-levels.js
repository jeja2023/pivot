const { query } = require('../db/client');
const { isSuperAdmin } = require('../permissions');

const MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_ACTION = 'reject';

function invalid(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (_err) {
        return fallback;
    }
}

function splitList(value) {
    if (Array.isArray(value)) return value.flatMap(item => splitList(item));
    return String(value || '')
        .split(/[\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function uniqueNumbers(values = []) {
    return [...new Set(values
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isInteger(value) && value > 0))];
}

function uniqueStrings(values = []) {
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeTimeoutMs(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(parsed, MAX_WAIT_MS);
}

function normalizeTimeoutAction(value) {
    const action = String(value || DEFAULT_TIMEOUT_ACTION).trim().toLowerCase();
    return ['reject', 'approve', 'cancel'].includes(action) ? action : DEFAULT_TIMEOUT_ACTION;
}

function resolveApprovalTimeoutMs(input = {}) {
    const directMs = normalizeTimeoutMs(input.timeoutMs ?? input.timeout_ms);
    if (directMs) return directMs;
    const rawHours = input.timeoutHours ?? input.timeout_hours;
    const hours = Number.parseFloat(String(rawHours ?? '').trim());
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return normalizeTimeoutMs(hours * 60 * 60 * 1000);
}

async function resolveUserReferences(values = []) {
    const refs = Array.isArray(values) ? values : splitList(values);
    const ids = [];
    const usernames = [];
    refs.forEach(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            ids.push(item.userId ?? item.user_id ?? item.id);
            if (item.username) usernames.push(item.username);
            return;
        }
        const text = String(item || '').trim();
        if (!text) return;
        if (/^\d+$/.test(text)) ids.push(text);
        else usernames.push(text);
    });
    const resolvedIds = uniqueNumbers(ids);
    const names = uniqueStrings(usernames);
    if (names.length) {
        const placeholders = names.map(() => '?').join(', ');
        const rows = await query(`
            SELECT id FROM users
            WHERE username IN (${placeholders})
               OR nickname IN (${placeholders})
        `, [...names, ...names]);
        rows.forEach(row => resolvedIds.push(row.id));
    }
    return uniqueNumbers(resolvedIds);
}

function collectLevelUserRefs(source = {}) {
    return [
        ...(Array.isArray(source.approvers) ? source.approvers : splitList(source.approvers)),
        ...(Array.isArray(source.approverUserIds) ? source.approverUserIds : splitList(source.approverUserIds)),
        ...(Array.isArray(source.approver_user_ids) ? source.approver_user_ids : splitList(source.approver_user_ids)),
        ...(Array.isArray(source.userIds) ? source.userIds : splitList(source.userIds)),
        ...(Array.isArray(source.user_ids) ? source.user_ids : splitList(source.user_ids)),
        ...(Array.isArray(source.users) ? source.users : splitList(source.users))
    ];
}

async function normalizeLevel(source = {}, ownerUser = {}, fallbackMode = 'any') {
    const approverUserIds = await resolveUserReferences(collectLevelUserRefs(source));
    const approverUnits = uniqueStrings([
        ...splitList(source.approverUnits),
        ...splitList(source.approver_units),
        ...splitList(source.units),
        ...splitList(source.unit)
    ]);
    const mode = String(source.mode || source.approvalMode || source.approval_mode || fallbackMode || 'any').trim().toLowerCase() === 'all'
        ? 'all'
        : 'any';
    if (!approverUserIds.length && !approverUnits.length && ownerUser?.id) {
        approverUserIds.push(Number(ownerUser.id));
    }
    return {
        title: String(source.title || '').trim().slice(0, 120),
        mode,
        approverUserIds: uniqueNumbers(approverUserIds),
        approverUnits
    };
}

async function normalizeApprovalLevels(input = {}, ownerUser = {}) {
    const fallbackMode = String(input.mode || input.approvalMode || input.approval_mode || 'any').trim().toLowerCase() === 'all'
        ? 'all'
        : 'any';
    const rawLevels = Array.isArray(input.approvalLevels || input.approval_levels || input.levels)
        ? (input.approvalLevels || input.approval_levels || input.levels)
        : [];
    const levels = [];
    if (rawLevels.length) {
        for (const level of rawLevels) {
            levels.push(await normalizeLevel(level, ownerUser, fallbackMode));
        }
    } else {
        levels.push(await normalizeLevel(input, ownerUser, fallbackMode));
    }
    return levels
        .filter(level => level.approverUserIds.length || level.approverUnits.length)
        .slice(0, 10);
}

function currentLevel(row) {
    const levels = parseJson(row.levels_json, []);
    const index = Math.max(Number(row.current_level || 1) - 1, 0);
    return levels[index] || levels[0] || { approverUserIds: [], approverUnits: [] };
}

function levelRequirementKeys(level = {}) {
    return [
        ...uniqueNumbers(level.approverUserIds || level.approver_user_ids || []).map(id => `user:${id}`),
        ...uniqueStrings(level.approverUnits || level.approver_units || []).map(unit => `unit:${unit}`)
    ];
}

function actorRequirementKeys(actor = {}, level = {}) {
    if (isSuperAdmin(actor)) return levelRequirementKeys(level);
    const keys = [];
    if (actor?.id) keys.push(`user:${Number(actor.id)}`);
    const unit = String(actor?.unit || '').trim();
    if (unit) keys.push(`unit:${unit}`);
    return uniqueStrings(keys);
}

function decisionSatisfiedKeys(decision = {}, level = {}) {
    if (Array.isArray(decision.satisfiedKeys) && decision.satisfiedKeys.length) {
        return uniqueStrings(decision.satisfiedKeys);
    }
    const keys = [];
    const userId = Number(decision.userId || 0);
    if (userId && uniqueNumbers(level.approverUserIds || []).includes(userId)) {
        keys.push(`user:${userId}`);
    }
    const unit = String(decision.unit || decision.userUnit || '').trim();
    if (unit && uniqueStrings(level.approverUnits || []).includes(unit)) {
        keys.push(`unit:${unit}`);
    }
    if ((decision.system || String(decision.username || '').trim() === 'timeout') && !keys.length) {
        return levelRequirementKeys(level);
    }
    return uniqueStrings(keys);
}

function collectSatisfiedKeys(row, level = {}, levelNumber = 1) {
    const satisfied = new Set();
    const decisions = parseJson(row.decisions_json, []);
    decisions
        .filter(decision => Number(decision.level || 1) === Number(levelNumber) && String(decision.decision || '').toLowerCase() === 'approved')
        .forEach(decision => {
            decisionSatisfiedKeys(decision, level).forEach(key => satisfied.add(key));
        });
    return satisfied;
}

function canUserDecide(row, user) {
    if (!row || row.status !== 'pending') return false;
    if (isSuperAdmin(user)) return true;
    const level = currentLevel(row);
    const requirements = levelRequirementKeys(level);
    if (!requirements.length) return false;
    const actorKeys = actorRequirementKeys(user, level);
    if (!actorKeys.length) return false;
    const satisfied = collectSatisfiedKeys(row, level, Number(row.current_level || 1));
    return actorKeys.some(key => requirements.includes(key) && !satisfied.has(key));
}

function approvalCompletionKind(row, level = {}, decisions = []) {
    const requirementKeys = levelRequirementKeys(level);
    if (!requirementKeys.length) return 'pending';
    const satisfied = new Set();
    decisions
        .filter(decision => Number(decision.level || 1) === Number(row.current_level || 1) && String(decision.decision || '').toLowerCase() === 'approved')
        .forEach(decision => {
            decisionSatisfiedKeys(decision, level).forEach(key => satisfied.add(key));
        });
    const mode = String(level.mode || 'any').trim().toLowerCase() === 'all' ? 'all' : 'any';
    const done = mode === 'all'
        ? requirementKeys.every(key => satisfied.has(key))
        : requirementKeys.some(key => satisfied.has(key));
    return done ? 'completed' : 'pending';
}

function formatRequest(row, user = null) {
    if (!row) return null;
    const levels = parseJson(row.levels_json, []);
    const decisions = parseJson(row.decisions_json, []);
    return {
        id: row.id,
        run_id: row.run_id,
        user_id: row.user_id,
        request_type: row.request_type || 'approval',
        node_key: row.node_key || '',
        approval_key: row.approval_key || '',
        title: row.title || '',
        summary: row.summary || '',
        instructions: row.instructions || '',
        status: row.status || 'pending',
        current_level: Number(row.current_level || 1),
        required_levels: Number(row.required_levels || levels.length || 1),
        levels,
        decisions,
        expires_at: row.expires_at || '',
        decided_at: row.decided_at || '',
        decided_by: row.decided_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        can_decide: user ? canUserDecide(row, user) : false
    };
}

module.exports = {
    actorRequirementKeys,
    approvalCompletionKind,
    canUserDecide,
    currentLevel,
    formatRequest,
    invalid,
    levelRequirementKeys,
    normalizeApprovalLevels,
    normalizeTimeoutAction,
    normalizeTimeoutMs,
    parseJson,
    resolveApprovalTimeoutMs,
    uniqueNumbers,
    uniqueStrings
};
