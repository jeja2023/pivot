/**
 * server/services/agent-control-plane-state.js
 * 技能控制面可用性判定
 *
 * 落地方案 v1.2 §4.2（部署矩阵决策 A）：控制面表只存在于 PostgreSQL 部署。
 * 当 agent_skill_versions / agent_skill_releases 等表缺失时，
 * resolvePublishedSkill 与技能目录查询必须返回「该部署未启用技能控制面」的确定性降级结果，
 * 而不是把数据库错误直接抛给调用方。
 */

/** PostgreSQL undefined_table。SQLite 侧表现为 no such table 文案。 */
const UNDEFINED_TABLE_CODE = '42P01';

const CONTROL_PLANE_DISABLED_CODE = 'AGENT_SKILL_CONTROL_PLANE_DISABLED';

function isMissingRelationError(error) {
    if (!error) return false;
    if (String(error.code || '') === UNDEFINED_TABLE_CODE) return true;
    return /no such table|does not exist|undefined table/i.test(String(error.message || ''));
}

function controlPlaneDisabledError(message = '当前部署未启用技能控制面，技能版本与发布能力不可用。') {
    const error = new Error(message);
    error.status = 501;
    error.statusCode = 501;
    error.code = CONTROL_PLANE_DISABLED_CODE;
    error.expose = true;
    return error;
}

/**
 * 以确定性降级包裹控制面查询。
 * 表缺失时返回 fallback（不抛错）；其余错误原样抛出，避免掩盖真实故障。
 */
async function withControlPlaneFallback(operation, fallback) {
    try {
        return await operation();
    } catch (error) {
        if (isMissingRelationError(error)) return typeof fallback === 'function' ? fallback() : fallback;
        throw error;
    }
}

module.exports = {
    CONTROL_PLANE_DISABLED_CODE,
    controlPlaneDisabledError,
    isMissingRelationError,
    withControlPlaneFallback
};
