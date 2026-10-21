'use strict';

const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const { canonicalJson } = require('./canonical-json');
const { assertTenantContext } = require('./agent-tenant-context');
const {
    manifestDigestForHook,
    normalizeHookRegistration,
    registerAgentLifecycleHook
} = require('./agent-lifecycle-hooks');
const {
    getSigningEnvelopeById,
    registerVerifiedEnvelope,
    verifyEnvelopeSignature
} = require('./agent-skill-signing');

const PACKAGE_KIND = 'pivot.lifecycle-hook-package';
const PACKAGE_STATUSES = new Set(['active', 'disabled', 'revoked']);
const MAX_PACKAGE_HOOKS = 96;

function packageError(message, code = 'AGENT_HOOK_PACKAGE_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.expose = true;
    return error;
}

function text(value, max = 255) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback = {}) { try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '')); } catch (_) { return fallback; } }
function digest(value) { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }

function assertHookPackageAdmin(actor) {
    if (!isSuperAdmin(actor)) throw packageError('只有系统管理员可以导入、停用或吊销受管 Hook 包。', 'AGENT_HOOK_PACKAGE_ADMIN_REQUIRED', 403);
}

function packageHookManifestEntry(value = {}, packageId, packageVersion) {
    const hook = normalizeHookRegistration({
        ...value,
        packageId,
        packageVersion,
        status: String(value.status || 'enabled'),
        signatureVerified: true
    });
    return {
        hookName: hook.hookName,
        eventType: hook.eventType,
        phase: hook.phase,
        priority: hook.priority,
        config: hook.config,
        inputSchema: hook.inputSchema,
        outputSchema: hook.outputSchema,
        requiredScopes: hook.requiredScopes,
        failurePolicy: hook.failurePolicy,
        timeoutMs: hook.timeoutMs,
        status: hook.status
    };
}

function normalizeManagedHookPackageManifest(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const schemaVersion = Number(source.schemaVersion ?? source.schema_version);
    const kind = text(source.kind, 80);
    const packageId = text(source.packageId ?? source.package_id, 160);
    const packageVersion = text(source.packageVersion ?? source.package_version, 80);
    if (schemaVersion !== 1 || kind !== PACKAGE_KIND) {
        throw packageError('受管 Hook 包必须使用 schemaVersion=1 和受支持的 kind。', 'AGENT_HOOK_PACKAGE_SCHEMA_INVALID');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{2,159}$/.test(packageId)) {
        throw packageError('受管 Hook 包 ID 不合法。', 'AGENT_HOOK_PACKAGE_ID_INVALID');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(packageVersion)) {
        throw packageError('受管 Hook 包版本不合法。', 'AGENT_HOOK_PACKAGE_VERSION_INVALID');
    }
    const sourceHooks = Array.isArray(source.hooks) ? source.hooks : [];
    if (!sourceHooks.length || sourceHooks.length > MAX_PACKAGE_HOOKS) {
        throw packageError(`受管 Hook 包必须包含 1 至 ${MAX_PACKAGE_HOOKS} 个 Hook。`, 'AGENT_HOOK_PACKAGE_HOOKS_INVALID');
    }
    const names = new Set();
    const hooks = sourceHooks.map(item => {
        const entry = packageHookManifestEntry(item, packageId, packageVersion);
        if (names.has(entry.hookName)) throw packageError('受管 Hook 包内 Hook 名称不能重复。', 'AGENT_HOOK_PACKAGE_HOOK_DUPLICATE');
        names.add(entry.hookName);
        return entry;
    });
    return { schemaVersion: 1, kind: PACKAGE_KIND, packageId, packageVersion, hooks };
}

function serializeManagedHookPackage(row = {}) {
    return {
        id: String(row.id || ''),
        tenantId: Number(row.tenant_id || 0),
        packageId: String(row.package_id || ''),
        packageVersion: String(row.package_version || ''),
        manifestDigest: String(row.manifest_digest || ''),
        signingEnvelopeId: Number(row.signing_envelope_id || 0) || null,
        signatureKeyId: String(row.signature_key_id || ''),
        status: String(row.status || ''),
        importedByUserId: Number(row.imported_by_user_id || 0) || null,
        importedAt: row.imported_at || null,
        updatedAt: row.updated_at || null
    };
}

async function importManagedHookPackage(actor, input = {}, dependencies = {}) {
    assertHookPackageAdmin(actor);
    const tenant = await assertTenantContext(actor);
    const tenantActor = { ...actor, tenant_id: tenant.tenantId };
    const manifest = normalizeManagedHookPackageManifest(input.manifest || input);
    const manifestDigest = digest(manifest);
    const signature = input.signature && typeof input.signature === 'object' ? input.signature : {};
    const registerEnvelope = dependencies.registerVerifiedEnvelope || registerVerifiedEnvelope;
    const verified = await registerEnvelope({
        contentDigest: manifestDigest,
        keyId: text(signature.keyId ?? signature.key_id, 128) || 'organization-default',
        algorithm: text(signature.algorithm, 64) || 'RSA-SHA256',
        signature: text(signature.value ?? signature.signature, 8192),
        signatureForm: 'embedded',
        expiresAt: signature.expiresAt ?? signature.expires_at ?? null
    }, { manifest, requireSignature: true });
    if (!verified?.verified || !verified.envelope?.id) {
        throw packageError('受管 Hook 包签名未通过验证。', 'AGENT_HOOK_PACKAGE_SIGNATURE_INVALID', 422);
    }
    const tenantId = tenant.tenantId;
    const now = getBeijingTimestamp();
    return await transaction(async trx => {
        const existing = await trx.queryOne(`
            SELECT * FROM agent_lifecycle_hook_packages
            WHERE tenant_id = ? AND package_id = ? AND package_version = ? FOR UPDATE
        `, [tenantId, manifest.packageId, manifest.packageVersion]);
        if (existing && String(existing.manifest_digest || '') !== manifestDigest) {
            throw packageError('同一包 ID 与版本已存在不同清单；请发布新版本。', 'AGENT_HOOK_PACKAGE_IMMUTABLE', 409);
        }
        const packageRow = existing || await trx.queryOne(`
            INSERT INTO agent_lifecycle_hook_packages (
                id, tenant_id, package_id, package_version, manifest, manifest_digest,
                signing_envelope_id, signature_key_id, status, imported_by_user_id, imported_at, updated_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, 'active', ?, ?, ?)
            RETURNING *
        `, [crypto.randomUUID(), tenantId, manifest.packageId, manifest.packageVersion, JSON.stringify(manifest), manifestDigest,
            verified.envelope.id, String(verified.envelope.key_id || ''), tenantActor.id, now, now]);
        if (!packageRow) throw packageError('受管 Hook 包登记失败。', 'AGENT_HOOK_PACKAGE_REGISTER_FAILED', 500);
        const hooks = [];
        for (const entry of manifest.hooks) {
            const raw = { ...entry, packageId: manifest.packageId, packageVersion: manifest.packageVersion };
            const hookManifestDigest = manifestDigestForHook(normalizeHookRegistration({ ...raw, signatureVerified: true }));
            hooks.push(await registerAgentLifecycleHook(tenantActor, raw, {
                verifiedSignature: true,
                manifestDigest: hookManifestDigest,
                signatureKeyId: String(packageRow.signature_key_id || ''),
                packageManifestDigest: manifestDigest,
                signingEnvelopeId: packageRow.signing_envelope_id,
                organizationScoped: true,
                trx
            }));
        }
        return { package: serializeManagedHookPackage(packageRow), hooks, reused: Boolean(existing) };
    });
}

async function listManagedHookPackages(actor, options = {}) {
    assertHookPackageAdmin(actor);
    const tenantId = (await assertTenantContext(actor)).tenantId;
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const rows = await query(`
        SELECT * FROM agent_lifecycle_hook_packages
        WHERE tenant_id = ? ORDER BY imported_at DESC, id DESC LIMIT ?
    `, [tenantId, limit]);
    return rows.map(serializeManagedHookPackage);
}

async function setManagedHookPackageStatus(actor, packageId, packageVersion, status) {
    assertHookPackageAdmin(actor);
    const safeStatus = String(status || '').trim();
    if (!PACKAGE_STATUSES.has(safeStatus)) throw packageError('受管 Hook 包状态不受支持。', 'AGENT_HOOK_PACKAGE_STATUS_INVALID');
    const tenantId = (await assertTenantContext(actor)).tenantId;
    const row = await queryOne(`
        UPDATE agent_lifecycle_hook_packages SET status = ?, updated_at = ?
        WHERE tenant_id = ? AND package_id = ? AND package_version = ?
        RETURNING *
    `, [safeStatus, getBeijingTimestamp(), tenantId, text(packageId, 160), text(packageVersion, 80)]);
    if (!row) throw packageError('受管 Hook 包不存在。', 'AGENT_HOOK_PACKAGE_NOT_FOUND', 404);
    return serializeManagedHookPackage(row);
}

async function assertManagedHookPackageActive(hook = {}) {
    const envelopeId = Number(hook.signingEnvelopeId || hook.signing_envelope_id || 0);
    if (!envelopeId) return { legacy: true };
    const tenantId = Number(hook.tenantId || hook.tenant_id || 0) || 0;
    const packageRow = await queryOne(`
        SELECT * FROM agent_lifecycle_hook_packages
        WHERE tenant_id = ? AND package_id = ? AND package_version = ?
          AND manifest_digest = ? AND signing_envelope_id = ?
    `, [tenantId, text(hook.packageId || hook.package_id, 160), text(hook.packageVersion || hook.package_version, 80),
        text(hook.packageManifestDigest || hook.package_manifest_digest, 64), envelopeId]);
    if (!packageRow || String(packageRow.status || '') !== 'active') {
        throw packageError('受管 Hook 包不存在、已停用或已吊销。', 'AGENT_HOOK_PACKAGE_INACTIVE', 503);
    }
    const envelope = await getSigningEnvelopeById(envelopeId);
    const manifest = parseJson(packageRow.manifest, {});
    const verified = envelope && verifyEnvelopeSignature(envelope, { manifest });
    if (!verified?.verified) {
        throw packageError('受管 Hook 包签名无效、已过期或已吊销。', 'AGENT_HOOK_PACKAGE_SIGNATURE_INVALID', 503);
    }
    const entry = (Array.isArray(manifest.hooks) ? manifest.hooks : [])
        .find(item => String(item?.hookName || '') === String(hook.hookName || hook.hook_name || ''));
    const expectedHookDigest = entry
        ? manifestDigestForHook(normalizeHookRegistration({ ...entry, packageId: packageRow.package_id, packageVersion: packageRow.package_version, signatureVerified: true }))
        : '';
    if (!expectedHookDigest || expectedHookDigest !== String(hook.manifestDigest || hook.manifest_digest || '')) {
        throw packageError('Hook 与已签名受管包清单不匹配。', 'AGENT_HOOK_PACKAGE_MEMBER_MISMATCH', 503);
    }
    return { package: serializeManagedHookPackage(packageRow), envelope };
}

module.exports = {
    assertManagedHookPackageActive,
    importManagedHookPackage,
    listManagedHookPackages,
    normalizeManagedHookPackageManifest,
    setManagedHookPackageStatus
};
