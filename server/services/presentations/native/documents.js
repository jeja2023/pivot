'use strict';

const repository = require('../../../repositories/presentation-native');
const { assertTenantContext } = require('../../agent-tenant-context');
const cas = require('../../agent-artifact-cas');
const contract = require('./contract');
const { error } = require('../master/runtime');

async function get(user, id, version = null) {
    const tenant = await assertTenantContext(user);
    const row = await repository.read(user, tenant.tenantId, contract.id(id), version === null ? null : contract.version(version));
    if (!row) throw error('原稿文稿不存在或无权访问。', 'PRESENTATION_NATIVE_NOT_FOUND', 404);
    return row;
}
function publicDocument(row) {
    const manifest = JSON.parse(JSON.stringify(row.manifest_json));
    for (const slide of manifest.slides) { delete slide.previewRef; slide.previewUrl = `/api/apps/presentations/native/documents/${row.id}/versions/${row.version}/preview/${slide.index}`; }
    return { id: row.id, title: row.title, version: Number(row.version), currentVersion: Number(row.current_version), createdAt: row.created_at, updatedAt: row.updated_at, manifest };
}
async function list(user) { const tenant = await assertTenantContext(user); return repository.list(user, tenant.tenantId); }
async function versions(user, id) { const row = await get(user, id); return repository.versions(user, row.tenant_id, row.id); }
async function preview(user, id, version, slideIndex) {
    const row = await get(user, id, version);
    if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= row.manifest_json.slides.length) throw error('原稿预览页码不存在。');
    const slide = row.manifest_json.slides[slideIndex];
    return (await cas.readBuffer({ ref: slide.previewRef, tenantId: row.tenant_id, userId: user.id, tenantScoped: true })).buffer;
}
async function download(user, id, version = null) {
    const row = await get(user, id, version);
    const loaded = await cas.readBuffer({ ref: row.package_ref, tenantId: row.tenant_id, userId: user.id, tenantScoped: true });
    if (require('node:crypto').createHash('sha256').update(loaded.buffer).digest('hex') !== row.package_digest) throw error('原稿版本摘要不一致，已停止下载。');
    return { title: row.title, buffer: loaded.buffer };
}
async function remove(user, id) { const row = await get(user, id); return repository.remove(user, row.tenant_id, row.id); }

module.exports = { get, publicDocument, list, versions, preview, download, remove };
