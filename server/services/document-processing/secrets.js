const crypto = require('crypto');

const { query, queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { decryptSecret, encryptSecret } = require('../../security');

const SECRET_TTL_MS = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_PROCESSING_SECRET_TTL_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000, 5 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);

function passwordContext(jobId) {
    return `document_job_secrets:${Number(jobId)}:source_password`;
}

function toExpiryTimestamp() {
    return getBeijingTimestamp(new Date(Date.now() + SECRET_TTL_MS));
}

async function storeJobPassword({ userId, jobId, password }) {
    const plain = String(password || '');
    if (!plain) return false;
    const id = crypto.randomUUID();
    await execute(`
        UPDATE document_job_secrets
        SET deleted_at = ?
        WHERE user_id = ? AND job_id = ? AND secret_purpose = ? AND deleted_at IS NULL
    `, [getBeijingTimestamp(), userId, jobId, 'source_password']);
    await execute(`
        INSERT INTO document_job_secrets (id, user_id, job_id, secret_purpose, encrypted_value, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, userId, jobId, 'source_password', encryptSecret(plain, passwordContext(jobId)), toExpiryTimestamp(), getBeijingTimestamp()]);
    return true;
}

async function getJobPassword({ userId, jobId }) {
    const row = await queryOne(`
        SELECT encrypted_value
        FROM document_job_secrets
        WHERE user_id = ? AND job_id = ? AND secret_purpose = ? AND deleted_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
    `, [userId, jobId, 'source_password', getBeijingTimestamp()]);
    return row?.encrypted_value ? decryptSecret(row.encrypted_value, passwordContext(jobId)) : '';
}

async function removeJobSecrets({ userId, jobId }) {
    return execute(`
        UPDATE document_job_secrets
        SET deleted_at = COALESCE(deleted_at, ?)
        WHERE user_id = ? AND job_id = ? AND deleted_at IS NULL
    `, [getBeijingTimestamp(), userId, jobId]);
}

async function cleanupExpiredJobSecrets() {
    const now = getBeijingTimestamp();
    const expired = await query(`
        SELECT id FROM document_job_secrets
        WHERE deleted_at IS NULL AND expires_at <= ?
        LIMIT 500
    `, [now]);
    if (expired.length) {
        await execute('UPDATE document_job_secrets SET deleted_at = ? WHERE id = ANY(?)', [now, expired.map(row => row.id)]);
    }
    return expired.length;
}

module.exports = {
    cleanupExpiredJobSecrets,
    getJobPassword,
    removeJobSecrets,
    storeJobPassword
};
