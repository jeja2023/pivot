'use strict';

const crypto = require('node:crypto');
const { assertTenantContext } = require('../../agent-tenant-context');
const cas = require('../../agent-artifact-cas');
const { getRenditionForUser } = require('../../agent-artifact-renditions');
const { createStandaloneArtifact } = require('../../agent-artifacts');
const { recordDeliveryEvent } = require('../../agent-artifact-delivery');
const renditionRepository = require('../../../repositories/presentation-master-renditions');
const repository = require('../../../repositories/presentation-native');
const service = require('../presentation-service');
const runtime = require('../master/runtime');

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function access(user, request) {
    const tenant = await assertTenantContext(user);
    if (request.kind !== 'import' && !await repository.header(user, tenant.tenantId, request.documentId, request.baseVersion)) throw runtime.error('原稿文稿已不存在或无权访问。', 'PRESENTATION_NATIVE_NOT_FOUND', 404);
    if (request.sourceAssetId && !await service.getPresentationAsset(user, request.sourceAssetId, { metadataOnly: true })) throw runtime.error('原稿素材已不存在或无权访问。', 'PRESENTATION_NATIVE_SOURCE_FORBIDDEN', 403);
    if (request.sourceRenditionId && !await getRenditionForUser(request.sourceRenditionId, user)) throw runtime.error('原稿交付文件已不存在或无权访问。', 'PRESENTATION_NATIVE_SOURCE_FORBIDDEN', 403);
    if (request.presentationId && !await service.getPresentation(user, request.presentationId)) throw runtime.error('原稿文稿已不存在或无权访问。', 'PRESENTATION_NATIVE_SOURCE_FORBIDDEN', 403);
    for (const item of request.video?.narration || []) if (!await service.getPresentationAsset(user, item.assetId, { metadataOnly: true })) throw runtime.error('旁白素材已不存在或无权访问。', 'PRESENTATION_NATIVE_SOURCE_FORBIDDEN', 403);
    return tenant;
}
async function source(user, request) {
    const tenant = await access(user, request);
    if (request.kind !== 'import') {
        const version = await repository.header(user, tenant.tenantId, request.documentId, request.kind === 'restore' ? request.sourceVersion : request.baseVersion);
        if (!version) throw runtime.error('要恢复的原稿版本已不存在。', 'PRESENTATION_NATIVE_NOT_FOUND', 404);
        const loaded = await cas.readBuffer({ ref: version.package_ref, tenantId: tenant.tenantId, userId: user.id, tenantScoped: true });
        if (digest(loaded.buffer) !== version.package_digest) throw runtime.error('原稿包摘要与版本记录不一致。');
        return loaded.buffer;
    }
    if (request.sourceAssetId) {
        const loaded = await service.getPresentationAsset(user, request.sourceAssetId);
        if (loaded.asset.mimeType !== PPTX) throw runtime.error('原稿编辑需要上传PPTX文件。');
        return loaded.buffer;
    }
    const rendition = request.sourceRenditionId ? await getRenditionForUser(request.sourceRenditionId, user)
        : (await service.createPresentationExport(user, request.presentationId, 'pptx', { showSourceRefs: false })).rendition;
    if (rendition.mime_type !== PPTX || rendition.format !== 'pptx') throw runtime.error('只能从原生PPTX交付文件打开原稿。');
    const loaded = await cas.readBuffer({ ref: rendition.storage_ref, tenantId: rendition.tenant_id, userId: user.id, tenantScoped: true });
    if (digest(loaded.buffer) !== rendition.content_digest) throw runtime.error('原稿交付文件摘要无效。');
    return loaded.buffer;
}
async function snapshot(user, taskId, request) {
    const buffer = await source(user, request);
    const sourcePath = await runtime.inputFile(user, taskId, 'source.pptx', buffer);
    const narration = [];
    for (const item of request.video?.narration || []) {
        const loaded = await service.getPresentationAsset(user, item.assetId);
        const extension = { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg' }[loaded.asset.mimeType];
        if (!extension) throw runtime.error('页面旁白仅支持WAV、MP3或OGG音频。');
        narration.push({ slideIndex: item.slideIndex, path: await runtime.inputFile(user, taskId, 'narration-' + item.slideIndex + extension, loaded.buffer) });
    }
    return { source: sourcePath, sourceDigest: digest(buffer), narration };
}
async function storeVersion(user, taskId, receipt) {
    const tenant = await assertTenantContext(user), buffer = await runtime.readOutput(user, taskId, 'presentation.pptx');
    if (digest(buffer) !== receipt.sha256) throw runtime.error('原稿写回文件摘要无效。');
    const manifest = JSON.parse((await runtime.readOutput(user, taskId, 'manifest.json', 6 * 1024 * 1024)).toString('utf8'));
    if (manifest.packageDigest !== receipt.sha256 || manifest.slides?.length !== receipt.slideCount) throw runtime.error('原稿对象清单与最终文件不一致。');
    const stored = await cas.putBuffer({ buffer, mimeType: PPTX, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_native_package' });
    const objectIds = [stored.objectId];
    for (const slide of manifest.slides) {
        const png = await runtime.readOutput(user, taskId, 'preview-' + (slide.index + 1) + '.png', 8 * 1024 * 1024);
        const preview = await cas.putBuffer({ buffer: png, mimeType: 'image/png', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_native_preview' });
        slide.previewRef = cas.buildCasRef(preview.objectId); objectIds.push(preview.objectId);
    }
    return { packageRef: cas.buildCasRef(stored.objectId), packageDigest: stored.contentDigest, manifest, objectIds };
}
async function deliver(user, taskId, request, file, report, options = {}) {
    const tenant = await assertTenantContext(user), format = file === 'video.mp4' ? 'mp4' : 'pptx';
    const mimeType = format === 'mp4' ? 'video/mp4' : PPTX;
    const buffer = await runtime.readOutput(user, taskId, file, 120 * 1024 * 1024);
    if (buffer.length > cas.maxObjectBytes()) throw runtime.error('视频超过当前产物存储大小上限，请降低清晰度或分批导出。', 'PRESENTATION_NATIVE_OUTPUT_TOO_LARGE', 413);
    if (digest(buffer) !== (report.outputDigest || report.sha256)) throw runtime.error('原稿或视频交付文件摘要无效。');
    const metadata = { documentId: request.documentId, version: request.baseVersion, mode: request.kind, report };
    const artifact = await createStandaloneArtifact(user, { type: 'presentation_native', title: request.title, content: JSON.stringify(metadata), note: '原稿离线编辑与视频交付' }, options);
    const ir = await cas.putBuffer({ buffer: Buffer.from(JSON.stringify(metadata)), mimeType: 'application/json', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_native_report' });
    const output = await cas.putBuffer({ buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_native_' + format });
    const rendition = await renditionRepository.insert(user, tenant.tenantId, artifact.id, { runId: `standalone-artifact:${artifact.id}`, toolCallId: taskId, irRef: cas.buildCasRef(ir.objectId), irDigest: ir.contentDigest, format,
        rendererVersion: 'ppt-native-offline-1', contentDigest: output.contentDigest, mimeType, byteSize: output.byteSize, storageRef: cas.buildCasRef(output.objectId) }, options.executor);
    await cas.incrementRefCount(ir.objectId, 1, options); await cas.incrementRefCount(output.objectId, 1, options);
    await recordDeliveryEvent({ tenantId: tenant.tenantId, renditionId: Number(rendition.id), runId: `standalone-artifact:${artifact.id}`, toolCallId: taskId, actorType: 'user', actorId: String(user.id), eventType: 'presentation_render', contentDigest: output.contentDigest, pathHint: request.title + '.' + format }, options);
    return { renditionId: Number(rendition.id), format, filename: request.title + '.' + format, byteSize: output.byteSize, contentDigest: output.contentDigest };
}

module.exports = { access, snapshot, storeVersion, deliver };
