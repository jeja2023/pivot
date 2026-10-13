const crypto = require('crypto');

const { query, queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { decryptSecret, encryptSecret } = require('../../security');

const SECRET_TTL_MS = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_PROCESSING_SECRET_TTL_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000, 5 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);

function secretContext(jobId, purpose = 'source_password') {
    return `document_job_secrets:${Number(jobId)}:${String(purpose || 'source_password')}`;
}

function toExpiryTimestamp() {
    return getBeijingTimestamp(new Date(Date.now() + SECRET_TTL_MS));
}

async function storeJobSecret({ userId, jobId, purpose = 'source_password', value }) {
    const plain = String(value || '');
    if (!plain) return false;
    const secretPurpose = String(purpose || 'source_password').slice(0, 80);
    const id = crypto.randomUUID();
    await execute(`
        UPDATE document_job_secrets
        SET deleted_at = ?
        WHERE user_id = ? AND job_id = ? AND secret_purpose = ? AND deleted_at IS NULL
    `, [getBeijingTimestamp(), userId, jobId, secretPurpose]);
    await execute(`
        INSERT INTO document_job_secrets (id, user_id, job_id, secret_purpose, encrypted_value, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, userId, jobId, secretPurpose, encryptSecret(plain, secretContext(jobId, secretPurpose)), toExpiryTimestamp(), getBeijingTimestamp()]);
    return true;
}

async function getJobSecret({ userId, jobId, purpose = 'source_password' }) {
    const secretPurpose = String(purpose || 'source_password').slice(0, 80);
    const row = await queryOne(`
        SELECT encrypted_value
        FROM document_job_secrets
        WHERE user_id = ? AND job_id = ? AND secret_purpose = ? AND deleted_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
    `, [userId, jobId, secretPurpose, getBeijingTimestamp()]);
    return row?.encrypted_value ? decryptSecret(row.encrypted_value, secretContext(jobId, secretPurpose)) : '';
}

async function storeJobPassword({ userId, jobId, password }) {
    return storeJobSecret({ userId, jobId, purpose: 'source_password', value: password });
}

async function getJobPassword({ userId, jobId }) {
    return getJobSecret({ userId, jobId, purpose: 'source_password' });
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
    getJobSecret,
    getJobPassword,
    removeJobSecrets,
    storeJobSecret,
    storeJobPassword
};
