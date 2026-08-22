const { query, queryOne, execute } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { encryptSecret, decryptSecret } = require('../security');
const { canAccessSharedResource, normalizeShareSettings, parseAllowedUserIds } = require('./unit-visibility');
const { filterExistingShareUserIds } = require('./share-targets');

const MAX_CREDENTIALS_PER_USER = 20;
const SLUG_PATTERN = /^[A-Z0-9_]{2,64}$/;
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

function invalid(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizeSlug(raw) {
    const value = String(raw || '').trim().replace(/[-\s]+/g, '_').toUpperCase();
    if (!SLUG_PATTERN.test(value)) {
        throw invalid('凭据引用名仅支持 2-64 位大写字母、数字和下划线，例如 ERP_API_KEY。');
    }
    return value;
}

function normalizeSecretValue(raw) {
    const value = String(raw ?? '').trim();
    if (!value) throw invalid('请填写凭据内容。');
    if (value.length > 8192) throw invalid('凭据内容长度不能超过 8KB。');
    return value;
}

async function normalizeCredentialPayload(body = {}, user = {}, current = null) {
    const name = String(body.name || current?.name || '').trim();
    if (!name) throw invalid('请填写凭据名称。');
    if (name.length > 80) throw invalid('凭据名称不能超过 80 个字符。');

    const slug = normalizeSlug(body.slug || current?.slug);
    const description = String(body.description ?? current?.description ?? '').trim().slice(0, 500);

    const share = normalizeShareSettings(body, user, current || {});
    share.allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });

    return {
        name,
        slug,
        description,
        scope: share.scope,
        allowedUnits: share.allowedUnits,
        allowedUserIds: share.allowedUserIds
    };
}

function formatCredential(row, user) {
    if (!row) return null;
    const isOwner = Number(row.user_id) === Number(user?.id);
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description || '',
        scope: row.scope || 'private',
        allowed_units: row.allowed_units ? String(row.allowed_units).split(',').filter(Boolean) : [],
        allowed_user_ids: parseAllowedUserIds(row.allowed_user_ids),
        version: Number(row.version || 1),
        is_owner: isOwner,
        owner_name: row.owner_name || '',
        has_previous_value: Boolean(row.previous_value),
        previous_expires_at: row.previous_expires_at || '',
        last_used_at: row.last_used_at || '',
        use_count: Number(row.use_count || 0),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function listWorkflowCredentials(user) {
    const rows = await query(`
        SELECT c.*, COALESCE(NULLIF(u.nickname, ''), NULLIF(u.deleted_username, ''), u.username) AS owner_name
        FROM workflow_credentials c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE (c.user_id = ? OR c.scope = 'shared') AND c.deleted_at IS NULL
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT 200
    `, [user.id]);
    return rows
        .filter(row => canAccessSharedResource(row, user, false))
        .map(row => formatCredential(row, user));
}

async function findOwnedCredential(credentialId, user) {
    const row = await queryOne('SELECT * FROM workflow_credentials WHERE id = ? AND deleted_at IS NULL', [credentialId]);
    return row && canAccessSharedResource(row, user, true) ? row : null;
}

async function createWorkflowCredential(user, body = {}) {
    const data = await normalizeCredentialPayload(body, user);
    const secret = normalizeSecretValue(body.secretValue ?? body.secret_value ?? body.value);
    const countRow = await queryOne('SELECT COUNT(*) AS count FROM workflow_credentials WHERE user_id = ? AND deleted_at IS NULL', [user.id]);
    const count = Number(countRow?.count || 0);
    if (count >= MAX_CREDENTIALS_PER_USER) throw invalid(`每个账号最多创建 ${MAX_CREDENTIALS_PER_USER} 个凭据。`, 409);
    const duplicated = await queryOne('SELECT id FROM workflow_credentials WHERE user_id = ? AND slug = ? AND deleted_at IS NULL', [user.id, data.slug]);
    if (duplicated) throw invalid('该凭据引用名已存在，请换一个名称。', 409);

    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO workflow_credentials (
            user_id, name, slug, description, secret_value, scope, allowed_units,
            allowed_user_ids, version, use_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        RETURNING id
    `, [
        user.id, data.name, data.slug, data.description,
        encryptSecret(secret), data.scope, data.allowedUnits, data.allowedUserIds, now, now
    ]);
    logger.info({ userId: user.id, slug: data.slug }, '工作流凭据已创建');
    const created = await queryOne('SELECT * FROM workflow_credentials WHERE id = ?', [row?.id]);
    return formatCredential(created, user);
}

/** 更新元数据和共享范围；不传 secretValue 时保留原凭据内容 */
async function updateWorkflowCredential(credentialId, user, body = {}) {
    const current = await findOwnedCredential(credentialId, user);
    if (!current) return null;
    const data = await normalizeCredentialPayload(body, user, current);
    if (data.slug !== current.slug) {
        const duplicated = await queryOne('SELECT id FROM workflow_credentials WHERE user_id = ? AND slug = ? AND id != ? AND deleted_at IS NULL', [
            user.id, data.slug, current.id
        ]);
        if (duplicated) throw invalid('该凭据引用名已存在，请换一个名称。', 409);
    }
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE workflow_credentials
        SET name = ?, slug = ?, description = ?, scope = ?, allowed_units = ?, allowed_user_ids = ?, updated_at = ?
        WHERE id = ?
    `, [data.name, data.slug, data.description, data.scope, data.allowedUnits, data.allowedUserIds, now, current.id]);
    const updated = await queryOne('SELECT * FROM workflow_credentials WHERE id = ?', [current.id]);
    return formatCredential(updated, user);
}

/**
 * 轮换凭据内容：新值立即生效，旧值保留一段过渡期。
 * 过渡期内新旧值都能解析，避免轮换瞬间打断正在运行的任务，且无需重启服务。
 */
async function rotateWorkflowCredential(credentialId, user, body = {}) {
    const current = await findOwnedCredential(credentialId, user);
    if (!current) return null;
    const secret = normalizeSecretValue(body.secretValue ?? body.secret_value ?? body.value);
    const now = getBeijingTimestamp();
    const graceUntil = getBeijingTimestamp(new Date(Date.now() + ROTATION_GRACE_MS));
    await execute(`
        UPDATE workflow_credentials
        SET secret_value = ?, previous_value = ?, previous_expires_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
    `, [encryptSecret(secret), current.secret_value, graceUntil, now, current.id]);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据已轮换');
    const updated = await queryOne('SELECT * FROM workflow_credentials WHERE id = ?', [current.id]);
    return formatCredential(updated, user);
}

/**
 * 撤销上一次轮换：在过渡期内把旧值恢复为当前值。
 * 用于轮换后发现新凭据填错或外部系统尚未同步的情况，避免只能靠重新录入补救。
 */
async function revertWorkflowCredentialRotation(credentialId, user) {
    const current = await findOwnedCredential(credentialId, user);
    if (!current) return null;
    if (!current.previous_value) throw invalid('该凭据没有可恢复的历史值。');
    if (current.previous_expires_at && current.previous_expires_at <= getBeijingTimestamp()) {
        throw invalid('历史凭据已超过可恢复期限，请重新录入。');
    }
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE workflow_credentials
        SET secret_value = previous_value, previous_value = NULL, previous_expires_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ?
    `, [now, current.id]);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据轮换已撤销');
    const updated = await queryOne('SELECT * FROM workflow_credentials WHERE id = ?', [current.id]);
    return formatCredential(updated, user);
}

async function deleteWorkflowCredential(credentialId, user) {
    const current = await findOwnedCredential(credentialId, user);
    if (!current) return null;
    const now = getBeijingTimestamp();
    // 软删除同时清空密文，避免删除后仍在库里留存可解密内容
    await execute(`
        UPDATE workflow_credentials
        SET deleted_at = ?, secret_value = '', previous_value = NULL, updated_at = ?
        WHERE id = ?
    `, [now, now, current.id]);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据已删除');
    return formatCredential(current, user);
}

/**
 * 运行时按引用名解析凭据明文。
 * 解析范围包含本人凭据和共享给本人所属部门的凭据，命中后记录使用痕迹。
 */
async function findAccessibleCredentialRow(slug, user) {
    const boundMatch = String(slug || '').trim().match(/^PIVOT_BOUND_CREDENTIAL_(\d+)$/i);
    if (boundMatch) {
        const row = await queryOne('SELECT * FROM workflow_credentials WHERE id = ? AND deleted_at IS NULL', [boundMatch[1]]);
        return row && canAccessSharedResource(row, user, false) ? row : null;
    }
    let normalizedSlug = '';
    try {
        normalizedSlug = normalizeSlug(slug);
    } catch (_err) {
        return null;
    }
    const rows = await query(`
        SELECT * FROM workflow_credentials
        WHERE slug = ? AND deleted_at IS NULL AND (user_id = ? OR scope = 'shared')
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, updated_at DESC
    `, [normalizedSlug, user.id, user.id]);
    // 本人凭据优先，其次才是部门共享凭据，避免同名共享凭据覆盖个人配置
    return rows.find(item => canAccessSharedResource(item, user, false)) || null;
}

async function hasWorkflowCredentialAccess(slug, user) {
    const row = await findAccessibleCredentialRow(slug, user);
    return Boolean(row);
}

async function resolveCredentialSecret(slug, user) {
    const row = await findAccessibleCredentialRow(slug, user);
    if (!row) return null;

    const now = getBeijingTimestamp();
    await execute('UPDATE workflow_credentials SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?', [
        now, row.id
    ]);
    return {
        id: row.id,
        slug: row.slug,
        value: decryptSecret(row.secret_value),
        version: Number(row.version || 1)
    };
}

module.exports = {
    MAX_CREDENTIALS_PER_USER,
    ROTATION_GRACE_MS,
    createWorkflowCredential,
    deleteWorkflowCredential,
    hasWorkflowCredentialAccess,
    formatCredential,
    listWorkflowCredentials,
    normalizeSlug,
    resolveCredentialSecret,
    revertWorkflowCredentialRotation,
    rotateWorkflowCredential,
    updateWorkflowCredential
};
