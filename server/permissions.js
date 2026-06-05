const ADMIN_ROLE = 'admin';
const USER_ROLE = 'user';
const SUPER_ADMIN_USERNAME = 'admin';
const ADMIN_TIER = 'admin';
const MANAGER_TIER = 'manager';
const USER_TIER = 'user';
const PERMISSION_LABELS = Object.freeze({
    [ADMIN_TIER]: '系统管理员',
    [MANAGER_TIER]: '管理员',
    [USER_TIER]: '用户'
});

function normalizeRole(role) {
    return role === ADMIN_ROLE ? ADMIN_ROLE : USER_ROLE;
}

function isAdmin(user) {
    return normalizeRole(user?.role) === ADMIN_ROLE;
}

function isSuperAdmin(user) {
    return isAdmin(user) && String(user?.username || '').trim() === SUPER_ADMIN_USERNAME;
}

function getPermissionTier(user) {
    if (isSuperAdmin(user)) return ADMIN_TIER;
    if (isAdmin(user)) return MANAGER_TIER;
    return USER_TIER;
}

function getPermissionLabel(user) {
    return PERMISSION_LABELS[getPermissionTier(user)];
}

function withPermissionFlags(user) {
    if (!user) return user;
    const normalized = {
        ...user,
        role: normalizeRole(user.role)
    };
    const admin = isAdmin(normalized);
    const superAdmin = isSuperAdmin(normalized);
    const permissionTier = getPermissionTier(normalized);
    const permissionLabel = PERMISSION_LABELS[permissionTier];
    return {
        ...normalized,
        permissionTier,
        permissionLabel,
        permission_tier: permissionTier,
        permission_label: permissionLabel,
        isAdmin: admin,
        isSuperAdmin: superAdmin,
        is_admin: admin,
        is_super_admin: superAdmin
    };
}

module.exports = {
    ADMIN_ROLE,
    USER_ROLE,
    SUPER_ADMIN_USERNAME,
    ADMIN_TIER,
    MANAGER_TIER,
    USER_TIER,
    PERMISSION_LABELS,
    getPermissionTier,
    getPermissionLabel,
    isAdmin,
    isSuperAdmin,
    normalizeRole,
    withPermissionFlags
};
