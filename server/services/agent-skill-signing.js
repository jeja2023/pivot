/**
 * server/services/agent-skill-signing.js
 * 技能签名信封（signing envelope）
 *
 * 落地方案 v1.2 B1、阶段 0.4 与 §6.3 第 1 条：
 * 1. 导入期与验证期必须使用同一份签名记录，否则「带 SKILL.sig 而 manifest 无 signature 字段」
 *    的分离签名包在验证期必然失败，即分离签名包无法发布；
 * 2. 签名校验一律在服务端执行，关闭 createSkillVersion 的 signatureVerified 入参旁路；
 * 3. 信封记录 digest、keyId、算法、签名形态、签发与过期时间及吊销状态，支持密钥轮换。
 */
const crypto = require('crypto');
const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { canonicalJson } = require('./agent-skills');
const { withControlPlaneFallback } = require('./agent-control-plane-state');
const {
    getOrganizationSigningKey,
    getOrganizationSigningPublicKey,
    normalizePem: normalizeConfiguredPem
} = require('./agent-skill-signing-configuration');

const SIGNATURE_FORMS = Object.freeze(['detached', 'embedded']);
const DEFAULT_ALGORITHM = 'RSA-SHA256';

function signingError(message, code = 'SKILL_SIGNATURE_INVALID', status = 422) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function normalizeSignatureForm(value) {
    const form = String(value || '').trim().toLowerCase();
    return SIGNATURE_FORMS.includes(form) ? form : 'embedded';
}

function normalizeDigest(value) {
    return String(value || '').replace(/^sha256:/i, '').trim().toLowerCase();
}

function resolveTrustedPublicKey(options = {}, env = process.env, keyId = '') {
    const explicit = normalizePem(options.publicKey);
    if (explicit) return explicit;
    // 组织签名按信封 keyId 从密钥环精确选择公钥，轮换后仍可复验历史版本。
    const organizationPublicKey = getOrganizationSigningPublicKey(keyId, env);
    return organizationPublicKey || normalizePem(env.AGENT_SKILL_PUBLIC_KEY);
}

/** 将环境变量中的 PEM 规范化；支持安全注入时常见的字面 \n 形式。 */
function normalizePem(value) {
    return normalizeConfiguredPem(value);
}

/** 组织签名私钥仅由服务端管理员审批流程读取，绝不返回到网页或 Skill 文件。 */
function resolveOrganizationSigningPrivateKey(_options = {}, env = process.env) {
    return getOrganizationSigningKey(env)?.privateKey || '';
}

function resolveOrganizationSigningKeyId(_options = {}, env = process.env) {
    return getOrganizationSigningKey(env)?.keyId || String(env.AGENT_SKILL_ORGANIZATION_KEY_ID || 'organization-default').trim().slice(0, 128) || 'organization-default';
}

function isSignatureRequired(options = {}, env = process.env) {
    if (options.requireSignature === false) return false;
    if (options.requireSignature === true) return true;
    return String(env.AGENT_SKILL_REQUIRE_SIGNATURE || 'true').trim().toLowerCase() !== 'false';
}

/**
 * 构造被签名的载荷。
 * 两种签名形态共用同一入口，避免导入期与验证期各写一套（B1 的根因）：
 * - embedded：签名对象是规范化后的 manifest（剥离 signature 与 digest 字段）；
 * - detached：签名对象是内容摘要字符串本身（SKILL.sig 的既有约定）。
 */
function buildSignaturePayload(form, { manifest = null, contentDigest = '' } = {}) {
    if (normalizeSignatureForm(form) === 'embedded') {
        if (!manifest || typeof manifest !== 'object') return null;
        const unsigned = { ...manifest };
        delete unsigned.signature;
        delete unsigned.digest;
        return canonicalJson(unsigned);
    }
    return normalizeDigest(contentDigest);
}

/**
 * 校验一份签名信封。分离签名与内嵌签名统一走这一条实现，杜绝两套校验语义。
 * embedded 形态必须传入 manifest，否则无法重建被签名载荷，判定为无法验证。
 */
function verifyEnvelopeSignature(envelope = {}, options = {}) {
    const digest = normalizeDigest(envelope.contentDigest ?? envelope.content_digest);
    const signature = String(envelope.signature || '').trim();
    const form = normalizeSignatureForm(envelope.signatureForm ?? envelope.signature_form);
    const keyId = String(envelope.keyId ?? envelope.key_id ?? '').trim();
    let publicKey;
    try {
        publicKey = resolveTrustedPublicKey(options, process.env, keyId);
    } catch (_) {
        return { verified: false, reason: 'organization_keyring_unavailable', signatureForm: form };
    }
    if (!digest) return { verified: false, reason: 'missing_digest' };
    if (!signature) return { verified: false, reason: 'unsigned' };
    if (!publicKey) return { verified: false, reason: 'no_trusted_key' };
    const revokedAt = String(envelope.revokedAt ?? envelope.revoked_at ?? '').trim();
    if (revokedAt) return { verified: false, reason: 'revoked' };
    const expiresAt = String(envelope.expiresAt ?? envelope.expires_at ?? '').trim();
    if (expiresAt && expiresAt <= getBeijingTimestamp()) return { verified: false, reason: 'expired' };
    const payload = buildSignaturePayload(form, { manifest: options.manifest, contentDigest: digest });
    if (payload === null) return { verified: false, reason: 'payload_unavailable' };
    try {
        const verifier = crypto.createVerify(String(envelope.algorithm || options.algorithm || DEFAULT_ALGORITHM));
        verifier.update(payload);
        verifier.end();
        const verified = verifier.verify(publicKey, Buffer.from(signature, 'base64'));
        return { verified, reason: verified ? '' : 'mismatch', signatureForm: form };
    } catch (error) {
        return { verified: false, reason: String(error.message || 'verify_failed'), signatureForm: form };
    }
}

/**
 * 管理员批准共享版本时调用：对规范化 Manifest 产生 embedded 签名并写入不可变信封。
 * 私钥不落库、不写入 manifest，也不会传给浏览器；受信公钥未配置或与私钥不匹配时 fail-closed。
 */
async function signOrganizationEnvelope({ manifest, contentDigest, expiresAt = null } = {}, options = {}) {
    const privateKey = resolveOrganizationSigningPrivateKey(options);
    if (!privateKey) {
        throw signingError('组织共享发布尚未配置签名私钥，请联系系统管理员。', 'SKILL_ORGANIZATION_SIGNING_NOT_CONFIGURED', 409);
    }
    const keyId = resolveOrganizationSigningKeyId(options);
    const trustedPublicKey = resolveTrustedPublicKey(options, process.env, keyId);
    if (!trustedPublicKey) {
        throw signingError('组织共享发布尚未配置受信公钥，不能验证组织签名。', 'SKILL_ORGANIZATION_PUBLIC_KEY_NOT_CONFIGURED', 409);
    }
    const payload = buildSignaturePayload('embedded', { manifest, contentDigest });
    if (!payload) throw signingError('组织签名缺少规范化 Skill Manifest。', 'SKILL_ORGANIZATION_SIGNING_PAYLOAD_INVALID');
    let signature;
    try {
        const signer = crypto.createSign(DEFAULT_ALGORITHM);
        signer.update(payload);
        signer.end();
        signature = signer.sign(privateKey).toString('base64');
    } catch (_) {
        throw signingError('组织签名私钥无效或算法不受支持。', 'SKILL_ORGANIZATION_PRIVATE_KEY_INVALID', 409);
    }
    const envelope = {
        contentDigest: normalizeDigest(contentDigest),
        keyId,
        algorithm: DEFAULT_ALGORITHM,
        signature,
        signatureForm: 'embedded',
        expiresAt
    };
    const verified = verifyEnvelopeSignature(envelope, { ...options, publicKey: trustedPublicKey, manifest });
    if (!verified.verified) {
        throw signingError('组织签名与受信公钥不匹配，请检查密钥配置。', 'SKILL_ORGANIZATION_SIGNING_KEY_MISMATCH', 409);
    }
    return await recordSigningEnvelope(envelope);
}

/** 落库并返回签名信封 id。同一 (digest, keyId, form) 幂等。 */
async function recordSigningEnvelope(envelope = {}) {
    const digest = normalizeDigest(envelope.contentDigest ?? envelope.content_digest);
    if (!digest) throw signingError('签名信封缺少内容摘要。');
    const keyId = String(envelope.keyId || envelope.key_id || 'default').slice(0, 128);
    const form = normalizeSignatureForm(envelope.signatureForm ?? envelope.signature_form);
    const algorithm = String(envelope.algorithm || DEFAULT_ALGORITHM).slice(0, 64);
    const signature = String(envelope.signature || '');
    const now = getBeijingTimestamp();
    let row = await queryOne(`
        INSERT INTO agent_skill_signing_envelopes (content_digest, key_id, algorithm, signature, signature_form, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_digest, key_id, signature_form) DO NOTHING
        RETURNING *
    `, [digest, keyId, algorithm, signature, form, String(envelope.issuedAt || envelope.issued_at || now), envelope.expiresAt || envelope.expires_at || null]);
    // 签名信封是不可变制品；同一 digest/key/form 已存在时复用原记录，绝不能把
    // 已验证版本引用的 signature / expiry 原地替换。
    if (!row) {
        row = await queryOne(`
            SELECT * FROM agent_skill_signing_envelopes
            WHERE content_digest = ? AND key_id = ? AND signature_form = ?
        `, [digest, keyId, form]);
    }
    return row;
}

async function getSigningEnvelopeById(id) {
    if (!id) return null;
    return await withControlPlaneFallback(
        () => queryOne('SELECT * FROM agent_skill_signing_envelopes WHERE id = ?', [id]),
        null
    );
}

/** 吊销某个签名信封，使依赖它的版本在下一次验证时失败。 */
async function revokeSigningEnvelope(id) {
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_skill_signing_envelopes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, id]);
    return await getSigningEnvelopeById(id);
}

/**
 * 导入期入口：校验并落库签名信封。
 * @param {Object} params.contentDigest 被签名的摘要（包摘要或规范化 manifest 摘要）
 * @param {Object} params.signature base64 签名
 * @param {string} params.signatureForm detached | embedded
 */
async function registerVerifiedEnvelope(params = {}, options = {}) {
    const envelope = {
        contentDigest: params.contentDigest,
        keyId: params.keyId || options.keyId || 'default',
        algorithm: params.algorithm || options.algorithm || DEFAULT_ALGORITHM,
        signature: params.signature,
        signatureForm: params.signatureForm,
        issuedAt: params.issuedAt,
        expiresAt: params.expiresAt
    };
    const result = verifyEnvelopeSignature(envelope, options);
    if (!result.verified) {
        if (isSignatureRequired(options)) {
            throw signingError(`Skill 签名校验失败（${result.reason || '未签名'}），无法创建版本。`);
        }
        return { envelope: null, verified: false, reason: result.reason };
    }
    const row = await recordSigningEnvelope(envelope);
    return { envelope: row, verified: true, reason: '' };
}

/** 验证期入口：按版本记录的信封 id 重新验签，不接受任何外部「已验证」标记。 */
async function verifyEnvelopeForVersion(version = {}, options = {}) {
    const envelopeId = version.signing_envelope_id || version.signingEnvelopeId || null;
    if (!envelopeId) {
        return { verified: false, reason: 'unsigned', envelope: null, required: isSignatureRequired(options) };
    }
    const envelope = await getSigningEnvelopeById(envelopeId);
    if (!envelope) return { verified: false, reason: 'envelope_missing', envelope: null, required: isSignatureRequired(options) };
    // 信封摘要必须与版本记录的摘要之一对齐：embedded 对应规范化 manifest 摘要，
    // detached 对应包内容摘要。两者都不匹配即视为信封被替换。
    const acceptable = [normalizeDigest(version.content_digest), normalizeDigest(version.digest)].filter(Boolean);
    if (acceptable.length && !acceptable.includes(normalizeDigest(envelope.content_digest))) {
        return { verified: false, reason: 'digest_mismatch', envelope, required: isSignatureRequired(options) };
    }
    const result = verifyEnvelopeSignature(envelope, options);
    return { ...result, envelope, required: isSignatureRequired(options) };
}

module.exports = {
    DEFAULT_ALGORITHM,
    SIGNATURE_FORMS,
    buildSignaturePayload,
    getSigningEnvelopeById,
    isSignatureRequired,
    normalizePem,
    normalizeSignatureForm,
    recordSigningEnvelope,
    registerVerifiedEnvelope,
    revokeSigningEnvelope,
    resolveOrganizationSigningKeyId,
    resolveOrganizationSigningPrivateKey,
    signOrganizationEnvelope,
    signingError,
    verifyEnvelopeForVersion,
    verifyEnvelopeSignature
};
