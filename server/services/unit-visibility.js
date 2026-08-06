/* 部门可见性共享判定：模型、任务模板和工作流复用同一套 scope + allowed_units 语义。 */
const { isAdmin } = require('../permissions');

// 单位列表入库上限，与 agent_templates.allowed_units 现有口径保持一致
const MAX_ALLOWED_UNITS_LENGTH = 500;
// 单个单位名称长度上限，避免异常输入撑爆字段
const MAX_UNIT_NAME_LENGTH = 60;
// 单次最多允许配置的单位数量
const MAX_ALLOWED_UNITS_COUNT = 30;

const SHARE_SCOPE_PERSONAL = 'personal';
const SHARE_SCOPE_SHARED = 'shared';
const SHARE_SCOPES = new Set([SHARE_SCOPE_PERSONAL, SHARE_SCOPE_SHARED]);

// 把逗号分隔的单位串解析为去重后的单位数组；空值表示不限定单位
function parseAllowedUnits(value) {
    if (Array.isArray(value)) {
        return dedupeUnits(value.map(item => String(item || '').trim()));
    }
    return dedupeUnits(String(value || '').split(',').map(item => item.trim()));
}

function dedupeUnits(list) {
    const seen = new Set();
    const units = [];
    list.forEach(item => {
        const unit = String(item || '').trim().slice(0, MAX_UNIT_NAME_LENGTH);
        if (!unit || seen.has(unit)) return;
        seen.add(unit);
        if (units.length < MAX_ALLOWED_UNITS_COUNT) units.push(unit);
    });
    return units;
}

// 归一化为可入库的逗号分隔字符串
function serializeAllowedUnits(value) {
    return parseAllowedUnits(value).join(',').slice(0, MAX_ALLOWED_UNITS_LENGTH);
}

// 判断用户所属单位是否命中共享范围；范围为空表示全单位可见
function matchesAllowedUnits(value, user) {
    const units = parseAllowedUnits(value);
    if (!units.length) return true;
    const userUnit = String(user?.unit || '').trim();
    return Boolean(userUnit && units.includes(userUnit));
}

function normalizeShareScope(value) {
    const scope = String(value || SHARE_SCOPE_PERSONAL).trim().toLowerCase();
    return SHARE_SCOPES.has(scope) ? scope : SHARE_SCOPE_PERSONAL;
}

// 判断共享范围是否只覆盖用户本人所属单位；本部门共享无需管理员权限
function isOwnUnitOnly(value, user) {
    const units = parseAllowedUnits(value);
    const userUnit = String(user?.unit || '').trim();
    return Boolean(userUnit) && units.length === 1 && units[0] === userUnit;
}

/**
 * 归一化共享设置并执行权限门禁。
 * 规则：本人可把资源共享给自己所属单位；跨部门或全单位共享需要管理员权限。
 */
function normalizeShareSettings(body = {}, user = {}, fallback = {}) {
    const rawScope = body.scope ?? body.share_scope ?? fallback.scope;
    const scope = normalizeShareScope(rawScope);
    if (scope !== SHARE_SCOPE_SHARED) {
        return { scope: SHARE_SCOPE_PERSONAL, allowedUnits: '' };
    }

    const rawUnits = body.allowedUnits ?? body.allowed_units ?? fallback.allowed_units ?? '';
    const allowedUnits = serializeAllowedUnits(rawUnits);
    if (isAdmin(user)) return { scope: SHARE_SCOPE_SHARED, allowedUnits };

    const userUnit = String(user?.unit || '').trim();
    if (!userUnit) {
        const err = new Error('当前账号未设置所属部门，暂时不能共享；请联系管理员补充部门信息。');
        err.status = 403;
        throw err;
    }
    if (!allowedUnits) {
        const err = new Error('共享给全单位需要管理员操作；你可以先共享给本部门。');
        err.status = 403;
        throw err;
    }
    if (!isOwnUnitOnly(allowedUnits, user)) {
        const err = new Error('跨部门共享需要管理员操作；你可以先共享给本部门。');
        err.status = 403;
        throw err;
    }
    return { scope: SHARE_SCOPE_SHARED, allowedUnits };
}

/**
 * 通用可见性判定：所有者始终可读写，共享资源按单位范围只读。
 * write 为 true 时只承认所有者，保证共享出去的是"可看可用"而不是"可改"。
 */
function canAccessSharedResource(resource, user, write = false) {
    if (!resource || resource.deleted_at) return false;
    if (resource.user_id === null || resource.user_id === undefined || resource.user_id === '') return !write;
    if (Number(resource.user_id) === Number(user?.id)) return true;
    if (write) return false;
    if (normalizeShareScope(resource.scope) !== SHARE_SCOPE_SHARED) return false;
    return matchesAllowedUnits(resource.allowed_units, user);
}

module.exports = {
    MAX_ALLOWED_UNITS_COUNT,
    MAX_ALLOWED_UNITS_LENGTH,
    SHARE_SCOPE_PERSONAL,
    SHARE_SCOPE_SHARED,
    canAccessSharedResource,
    isOwnUnitOnly,
    matchesAllowedUnits,
    normalizeShareScope,
    normalizeShareSettings,
    parseAllowedUnits,
    serializeAllowedUnits
};
