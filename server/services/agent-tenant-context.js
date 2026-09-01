/**
 * server/services/agent-tenant-context.js
 * 租户解析语义（fail-closed）
 *
 * 落地方案 v1.2 §6.1、C3、R11：
 * 1. 解析顺序为 user.tenant_id → getPrimaryTenantId(user.id)；
 * 2. 企业访问开启（PIVOT_ENTERPRISE_ACCESS=true）且解析结果为空时，判定为「不可解析」，
 *    必须拒绝共享查询、发布与交付令牌签发，绝不回落到默认租户或其他组织；
 * 3. 只有企业访问关闭的单租户部署才使用默认租户（organizations.id=1），
 *    该默认租户代表整个单租户部署，不能用于企业访问已开启的「无团队用户」。
 */
const { getPrimaryTenantId, isEnterpriseAccessEnabled } = require('./enterprise-access');

/** 单租户部署的默认租户。由控制面迁移幂等创建。 */
const DEFAULT_TENANT_ID = 1;

const TENANT_UNRESOLVED_CODE = 'SKILL_TENANT_UNRESOLVED';

function tenantError(message = '当前用户未归属任何组织，已拒绝共享范围操作。') {
    const error = new Error(message);
    error.status = 409;
    error.statusCode = 409;
    error.code = TENANT_UNRESOLVED_CODE;
    return error;
}

function normalizeTenantId(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 解析用户的租户上下文。
 * 返回 { tenantId, resolvable, enterpriseAccess, usedDefault }。
 * resolvable=false 时，调用方必须拒绝共享范围的读写，而不是落 null。
 */
async function resolveTenantContext(user, options = {}) {
    const enterpriseAccess = options.enterpriseAccess ?? isEnterpriseAccessEnabled();
    const direct = normalizeTenantId(user?.tenant_id ?? user?.tenantId);
    const resolved = direct || normalizeTenantId(await getPrimaryTenantId(user?.id));
    if (resolved) {
        return { tenantId: resolved, resolvable: true, enterpriseAccess, usedDefault: false };
    }
    if (enterpriseAccess) {
        return { tenantId: null, resolvable: false, enterpriseAccess, usedDefault: false };
    }
    return { tenantId: DEFAULT_TENANT_ID, resolvable: true, enterpriseAccess, usedDefault: true };
}

/** 解析租户并在不可解析时抛出确定性错误，供发布、交付与下载令牌路径使用。 */
async function assertTenantContext(user, options = {}) {
    const context = await resolveTenantContext(user, options);
    if (!context.resolvable) throw tenantError();
    return context;
}

module.exports = {
    DEFAULT_TENANT_ID,
    TENANT_UNRESOLVED_CODE,
    assertTenantContext,
    normalizeTenantId,
    resolveTenantContext,
    tenantError
};
