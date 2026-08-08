/* 工作流凭据库：加密落库、按部门授权、支持免重启轮换。
   凭据明文只在运行时解密注入，不写入工作流定义、运行参数和日志。 */
const { db } = require('../db');
const { sql } = require('../db/statements');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { encryptSecret, decryptSecret } = require('../security');
const {
    canAccessSharedResource,
    normalizeShareSettings,
    parseAllowedUnits
} = require('./unit-visibility');

const MAX_CREDENTIALS_PER_USER = 100;
const MAX_SECRET_LENGTH = 4000;
// 轮换后旧值的保留时长，给正在运行的任务留出过渡窗口
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

function invalid(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// 凭据引用名只允许字母、数字和下划线，便于在节点里以 {{secrets.NAME}} 形式引用
function normalizeSlug(value) {
    const slug = String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
    if (!/^[A-Z0-9_]{2,60}$/.test(slug)) {
        throw invalid('凭据引用名只能包含字母、数字和下划线，长度 2 到 60 位。');
    }
    return slug;
}

function normalizeCredentialPayload(body = {}, user = {}, fallback = {}) {
    const name = String(body.name || '').trim().slice(0, 100);
    if (!name) throw invalid('请填写凭据名称。');
    const slug = normalizeSlug(body.slug ?? body.reference ?? fallback.slug ?? name);
    const share = normalizeShareSettings(body, user, fallback);
    return {
        name,
        slug,
        description: String(body.description || '').trim().slice(0, 300),
        scope: share.scope,
        allowedUnits: share.allowedUnits
    };
}

function normalizeSecretValue(value) {
    const secret = String(value ?? '');
    if (!secret.trim()) throw invalid('请填写凭据内容。');
    if (secret.length > MAX_SECRET_LENGTH) throw invalid(`凭据内容不能超过 ${MAX_SECRET_LENGTH} 个字符。`);
    return secret;
}

/** 对外只返回元数据，明文凭据永远不进入接口响应 */
function formatCredential(row, user = null) {
    if (!row) return null;
    const isOwner = user ? Number(row.user_id) === Number(user.id) : true;
    return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        slug: row.slug,
        description: row.description || '',
        scope: row.scope || 'personal',
        allowed_units: parseAllowedUnits(row.allowed_units),
        version: Number(row.version || 1),
        is_owner: isOwner,
        can_edit: isOwner,
        owner_name: row.owner_name || '',
        has_previous_value: Boolean(row.previous_value),
        previous_expires_at: row.previous_expires_at || '',
        last_used_at: row.last_used_at || '',
        use_count: Number(row.use_count || 0),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function listWorkflowCredentials(user) {
    return db.prepare(`
        SELECT c.*, COALESCE(NULLIF(u.nickname, ''), NULLIF(u.deleted_username, ''), u.username) AS owner_name
        FROM workflow_credentials c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE (c.user_id = ? OR c.scope = 'shared') AND c.deleted_at IS NULL
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT 200
    `).all(user.id)
        .filter(row => canAccessSharedResource(row, user, false))
        .map(row => formatCredential(row, user));
}

function findOwnedCredential(credentialId, user) {
    const row = db.prepare('SELECT * FROM workflow_credentials WHERE id = ? AND deleted_at IS NULL').get(credentialId);
    return row && canAccessSharedResource(row, user, true) ? row : null;
}

function createWorkflowCredential(user, body = {}) {
    const data = normalizeCredentialPayload(body, user);
    const secret = normalizeSecretValue(body.secretValue ?? body.secret_value ?? body.value);
    const count = db.prepare('SELECT COUNT(*) AS count FROM workflow_credentials WHERE user_id = ? AND deleted_at IS NULL').get(user.id)?.count || 0;
    if (count >= MAX_CREDENTIALS_PER_USER) throw invalid(`每个账号最多创建 ${MAX_CREDENTIALS_PER_USER} 个凭据。`, 409);
    const duplicated = db.prepare('SELECT id FROM workflow_credentials WHERE user_id = ? AND slug = ? AND deleted_at IS NULL').get(user.id, data.slug);
    if (duplicated) throw invalid('该凭据引用名已存在，请换一个名称。', 409);

    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO workflow_credentials (
            user_id, name, slug, description, secret_value, scope, allowed_units,
            version, use_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(
        user.id, data.name, data.slug, data.description,
        encryptSecret(secret), data.scope, data.allowedUnits, now, now
    );
    logger.info({ userId: user.id, slug: data.slug }, '工作流凭据已创建');
    return formatCredential(db.prepare('SELECT * FROM workflow_credentials WHERE id = ?').get(info.lastInsertRowid), user);
}

/** 更新元数据和共享范围；不传 secretValue 时保留原凭据内容 */
function updateWorkflowCredential(credentialId, user, body = {}) {
    const current = findOwnedCredential(credentialId, user);
    if (!current) return null;
    const data = normalizeCredentialPayload(body, user, current);
    if (data.slug !== current.slug) {
        const duplicated = db.prepare('SELECT id FROM workflow_credentials WHERE user_id = ? AND slug = ? AND id != ? AND deleted_at IS NULL')
            .get(user.id, data.slug, current.id);
        if (duplicated) throw invalid('该凭据引用名已存在，请换一个名称。', 409);
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE workflow_credentials
        SET name = ?, slug = ?, description = ?, scope = ?, allowed_units = ?, updated_at = ?
        WHERE id = ?
    `).run(data.name, data.slug, data.description, data.scope, data.allowedUnits, now, current.id);
    return formatCredential(db.prepare('SELECT * FROM workflow_credentials WHERE id = ?').get(current.id), user);
}

/**
 * 轮换凭据内容：新值立即生效，旧值保留一段过渡期。
 * 过渡期内新旧值都能解析，避免轮换瞬间打断正在运行的任务，且无需重启服务。
 */
function rotateWorkflowCredential(credentialId, user, body = {}) {
    const current = findOwnedCredential(credentialId, user);
    if (!current) return null;
    const secret = normalizeSecretValue(body.secretValue ?? body.secret_value ?? body.value);
    const now = getBeijingTimestamp();
    const graceUntil = getBeijingTimestamp(new Date(Date.now() + ROTATION_GRACE_MS));
    db.prepare(`
        UPDATE workflow_credentials
        SET secret_value = ?, previous_value = ?, previous_expires_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
    `).run(encryptSecret(secret), current.secret_value, graceUntil, now, current.id);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据已轮换');
    return formatCredential(db.prepare('SELECT * FROM workflow_credentials WHERE id = ?').get(current.id), user);
}

/**
 * 撤销上一次轮换：在过渡期内把旧值恢复为当前值。
 * 用于轮换后发现新凭据填错或外部系统尚未同步的情况，避免只能靠重新录入补救。
 */
function revertWorkflowCredentialRotation(credentialId, user) {
    const current = findOwnedCredential(credentialId, user);
    if (!current) return null;
    if (!current.previous_value) throw invalid('该凭据没有可恢复的历史值。');
    if (current.previous_expires_at && current.previous_expires_at <= getBeijingTimestamp()) {
        throw invalid('历史凭据已超过可恢复期限，请重新录入。');
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE workflow_credentials
        SET secret_value = previous_value, previous_value = NULL, previous_expires_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ?
    `).run(now, current.id);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据轮换已撤销');
    return formatCredential(db.prepare('SELECT * FROM workflow_credentials WHERE id = ?').get(current.id), user);
}

function deleteWorkflowCredential(credentialId, user) {
    const current = findOwnedCredential(credentialId, user);
    if (!current) return null;
    const now = getBeijingTimestamp();
    // 软删除同时清空密文，避免删除后仍在库里留存可解密内容
    db.prepare(`
        UPDATE workflow_credentials
        SET deleted_at = ?, secret_value = '', previous_value = NULL, updated_at = ?
        WHERE id = ?
    `).run(now, now, current.id);
    logger.info({ userId: user.id, slug: current.slug }, '工作流凭据已删除');
    return formatCredential(current, user);
}

/**
 * 运行时按引用名解析凭据明文。
 * 解析范围包含本人凭据和共享给本人所属部门的凭据，命中后记录使用痕迹。
 */
function findAccessibleCredentialRow(slug, user) {
    const boundMatch = String(slug || '').trim().match(/^PIVOT_BOUND_CREDENTIAL_(\d+)$/i);
    if (boundMatch) {
        const row = sql('SELECT * FROM workflow_credentials WHERE id = ? AND deleted_at IS NULL').get(boundMatch[1]);
        return row && canAccessSharedResource(row, user, false) ? row : null;
    }
    let normalizedSlug = '';
    try {
        normalizedSlug = normalizeSlug(slug);
    } catch (_err) {
        return null;
    }
    const rows = db.prepare(`
        SELECT * FROM workflow_credentials
        WHERE slug = ? AND deleted_at IS NULL AND (user_id = ? OR scope = 'shared')
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, updated_at DESC
    `).all(normalizedSlug, user.id, user.id);
    // 本人凭据优先，其次才是部门共享凭据，避免同名共享凭据覆盖个人配置
    return rows.find(item => canAccessSharedResource(item, user, false)) || null;
}

function hasWorkflowCredentialAccess(slug, user) {
    return Boolean(findAccessibleCredentialRow(slug, user));
}

function resolveCredentialSecret(slug, user) {
    const row = findAccessibleCredentialRow(slug, user);
    if (!row) return null;

    const now = getBeijingTimestamp();
    db.prepare('UPDATE workflow_credentials SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
        .run(now, row.id);
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
