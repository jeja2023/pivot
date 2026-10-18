'use strict';

/* 被上下文预算截断的工具原文只进入受 ACL 保护的 CAS，Working Memory 不复制正文。 */
const { putBuffer } = require('./agent-artifact-cas');
const { assertTenantContext } = require('./agent-tenant-context');

const MAX_WORKING_MEMORY_OUTPUT_BYTES = 16 * 1024 * 1024;

function isWorkingMemoryOutputPartial(value) {
    return value?.__partial === true || value?.structuredContent?.__partial === true;
}

function serializeWorkingMemoryOutput(value) {
    let serialized = '';
    try { serialized = JSON.stringify(value); } catch (_) { serialized = JSON.stringify(String(value ?? '')); }
    return serialized === undefined ? 'null' : serialized;
}

async function persistWorkingMemoryOutput(value, user, options = {}) {
    if (!user?.id || (options.force !== true && !isWorkingMemoryOutputPartial(value))) return null;
    const serialized = serializeWorkingMemoryOutput(value);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (!bytes || bytes > MAX_WORKING_MEMORY_OUTPUT_BYTES) return null;
    let tenantId = Number(options.tenantId || user.tenant_id || user.tenantId || 0);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
        tenantId = Number((await assertTenantContext(user)).tenantId || 0);
    }
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) return null;
    const object = await putBuffer({
        buffer: Buffer.from(serialized, 'utf8'),
        mimeType: 'application/json; charset=utf-8',
        kind: 'workmem_output', tenantId, ownerUserId: user.id,
        retentionDays: Math.min(Math.max(Number(options.retentionDays) || 30, 1), 365),
        maxBytes: MAX_WORKING_MEMORY_OUTPUT_BYTES
    });
    return { ref: object.ref, digest: object.contentDigest, bytes: object.byteSize };
}

function attachWorkingMemoryOutputReference(preview, reference) {
    if (!reference?.ref) return preview;
    const annotation = {
        rawOutputRef: reference.ref,
        rawOutputDigest: reference.digest || '',
        rawOutputBytes: Number(reference.bytes || 0)
    };
    if (preview && typeof preview === 'object' && !Array.isArray(preview)) return { ...preview, ...annotation };
    return { __partial: true, text: String(preview || ''), ...annotation };
}

module.exports = {

    attachWorkingMemoryOutputReference,
    isWorkingMemoryOutputPartial,
    persistWorkingMemoryOutput,
    serializeWorkingMemoryOutput
};
