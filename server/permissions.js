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

const DATA_CLASSIFICATION_LEVELS = Object.freeze(['public', 'internal', 'confidential', 'restricted']);
const POLICY_OBJECT_TYPES = Object.freeze(['model_usage', 'tool_approval', 'data_classification', 'retention', 'audit_export']);
const PERMISSION_CAPABILITY_MATRIX = Object.freeze({
    [ADMIN_TIER]: Object.freeze({
        manageUsers: true,
        manageManagers: true,
        manageGlobalSettings: true,
        manageGlobalModels: true,
        manageGlobalMcp: true,
        approveTools: true,
        exportAudit: true,
        readDeletedAudit: true,
        manageAnnouncements: true,
        resourceScopes: Object.freeze(['own', 'global']),
        plannedResourceScopes: Object.freeze(['organization', 'team']),
        dataClassificationMax: 'restricted'
    }),
    [MANAGER_TIER]: Object.freeze({
        manageUsers: true,
        manageManagers: false,
        manageGlobalSettings: false,
        manageGlobalModels: false,
        manageGlobalMcp: false,
        approveTools: false,
        exportAudit: false,
        readDeletedAudit: false,
        manageAnnouncements: true,
        resourceScopes: Object.freeze(['own']),
        plannedResourceScopes: Object.freeze(['organization', 'team']),
        dataClassificationMax: 'confidential'
    }),
    [USER_TIER]: Object.freeze({
        manageUsers: false,
        manageManagers: false,
        manageGlobalSettings: false,
        manageGlobalModels: false,
        manageGlobalMcp: false,
        approveTools: false,
        exportAudit: false,
        readDeletedAudit: false,
        manageAnnouncements: false,
        resourceScopes: Object.freeze(['own']),
        plannedResourceScopes: Object.freeze(['organization', 'team']),
        dataClassificationMax: 'internal'
    })
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

function getPermissionCapabilities(user) {
    const tier = getPermissionTier(user);
    const base = PERMISSION_CAPABILITY_MATRIX[tier] || PERMISSION_CAPABILITY_MATRIX[USER_TIER];
    return {
        tier,
        ...base,
        resourceScopes: [...base.resourceScopes],
        plannedResourceScopes: [...base.plannedResourceScopes],
        policyObjects: [...POLICY_OBJECT_TYPES],
        dataClassificationLevels: [...DATA_CLASSIFICATION_LEVELS],
        organizationAccessEnabled: false,
        teamAccessEnabled: false,
        auditExportEnabled: base.exportAudit === true,
        breakGlassAdmin: tier === ADMIN_TIER
    };
}

function hasPermissionCapability(user, capability) {
    return getPermissionCapabilities(user)[capability] === true;
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
    const permissionCapabilities = getPermissionCapabilities(normalized);
    return {
        ...normalized,
        permissionTier,
        permissionLabel,
        permission_tier: permissionTier,
        permission_label: permissionLabel,
        permissionCapabilities,
        permission_capabilities: permissionCapabilities,
        isAdmin: admin,
        isSuperAdmin: superAdmin,
        is_admin: admin,
        is_super_admin: superAdmin
    };
}

module.exports = {
    ADMIN_ROLE,
    DATA_CLASSIFICATION_LEVELS,
    USER_ROLE,
    SUPER_ADMIN_USERNAME,
    ADMIN_TIER,
    MANAGER_TIER,
    POLICY_OBJECT_TYPES,
    USER_TIER,
    PERMISSION_CAPABILITY_MATRIX,
    PERMISSION_LABELS,
    getPermissionCapabilities,
    getPermissionTier,
    getPermissionLabel,
    isAdmin,
    hasPermissionCapability,
    isSuperAdmin,
    normalizeRole,
    withPermissionFlags
};
