'use strict';

const crypto = require('node:crypto');
const { assertTenantContext } = require('../../agent-tenant-context');
const { createStandaloneArtifact } = require('../../agent-artifacts');
const { putBuffer, buildCasRef, incrementRefCount, maxObjectBytes } = require('../../agent-artifact-cas');
const repository = require('../../../repositories/presentation-master-renditions');
const { recordDeliveryEvent } = require('../../agent-artifact-delivery');
const runtime = require('./runtime');
const sourceBundleLimit = () => Math.min(120 * 1024 * 1024, maxObjectBytes());
const bundleWarning = 'PPTX 已通过核验。完整项目源包超过当前交付上限，无法随本次结果下载。';

async function prepareDelivery(user, taskId, request, receipt, context = {}) {
    context.signal?.throwIfAborted();
    const tenant = await assertTenantContext(user);
    const primary = receipt.templateOnly ? await runtime.readOutput(user, taskId, 'project.zip', sourceBundleLimit())
        : await runtime.readOutput(user, taskId, 'presentation.pptx');
    const actualDigest = crypto.createHash('sha256').update(primary).digest('hex');
    if (!receipt.templateOnly && actualDigest !== receipt.packageCheck?.currentExportSha256) {
        throw runtime.error('交付文件缺少本次导出的版本回执，请使用更新的执行镜像重新导出。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
    }
    if (actualDigest !== receipt.sha256 || receipt.packageCheck?.status !== 'passed') throw runtime.error('最终文件摘要或内容核验无效。', 'PPT_MASTER_DELIVERY_INVALID', 422);
    const metadata = { engine: 'ppt-master', revision: context.engine?.revision || runtime.lock.revision, runtimeId: context.engine?.runtimeId || '', taskId, title: request.title, operation: request.operation,
        sourceDigest: request.sourceDigest, inputDigests: request.inputDigests, outputDigest: actualDigest, checks: receipt.packageCheck, productionProfile: request.productionProfile,
        editing: '原生PPTX与上游项目源包保留；复杂对象尚未转换为Pivot画布元素。' };
    const meta = await putBuffer({ buffer: Buffer.from(JSON.stringify(metadata)), mimeType: 'application/json', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_project' });
    const files = [];
    let sourcePackageWarning = receipt.sourcePackageUnavailable === true && !receipt.templateOnly ? bundleWarning : '';
    const formats = receipt.templateOnly ? [['zip', 'project.zip', 'application/zip']]
        : [['pptx', 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
            ...(sourcePackageWarning ? [] : [['zip', 'project.zip', 'application/zip']])];
    for (const [format, name, mimeType] of formats) {
        context.signal?.throwIfAborted();
        let buffer = primary;
        if (format === 'zip' && !receipt.templateOnly) {
            try { buffer = await runtime.readOutput(user, taskId, name, sourceBundleLimit()); }
            catch (failure) {
                if (!['PPT_SERVICE_RESPONSE_TOO_LARGE', 'PPT_MASTER_OUTPUT_TOO_LARGE'].includes(failure.code)) throw failure;
                sourcePackageWarning = bundleWarning;
                continue;
            }
        }
        if (format === 'zip' && receipt.projectSha256 && crypto.createHash('sha256').update(buffer).digest('hex') !== receipt.projectSha256) {
            throw runtime.error('项目源包摘要不一致，请核对制作服务输出。', 'PPT_MASTER_DELIVERY_INVALID', 422);
        }
        const stored = await putBuffer({ buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_' + format });
        files.push({ format, mimeType, stored });
    }
    return { tenantId: tenant.tenantId, metadata, meta, files, sourcePackageWarning };
}

async function commitDelivery(user, taskId, request, prepared, executor) {
    const { tenantId, metadata, meta, files, sourcePackageWarning } = prepared, toolCallId = 'ppt-master:' + taskId;
    // 文件登记的渲染器版本列为 32 字符，完整运行标识保留在产物元数据。
    const rendererVersion = 'ppt-master-' + (metadata.runtimeId
        ? crypto.createHash('sha256').update(metadata.runtimeId).digest('hex').slice(0, 20) : runtime.lock.skillVersion);
    const existing = [];
    for (const file of files) existing.push(await repository.findTaskRendition(executor, user, tenantId, toolCallId, file.format, meta.contentDigest));
    const previous = existing.find(Boolean);
    const artifact = previous ? { id: previous.artifact_id } : await createStandaloneArtifact(user, {
        type: 'ppt_master', title: request.title, content: JSON.stringify(metadata), note: 'PPT Master 完整制作引擎产物'
    }, { executor });
    if (request.runId) await repository.linkToRun(executor, user, artifact.id, request.runId);
    const runId = request.runId || `standalone-artifact:${artifact.id}`, results = [];
    for (const [index, { format, mimeType, stored }] of files.entries()) {
        const prior = existing[index];
        if (prior && (Number(prior.artifact_id) !== Number(artifact.id) || prior.content_digest !== stored.contentDigest)) {
            throw runtime.error('已登记的交付文件与任务回执不一致，请核对原有产物。', 'PPT_MASTER_DELIVERY_INVALID', 409);
        }
        const record = prior || await repository.insert(user, tenantId, artifact.id, { runId, toolCallId,
            irRef: buildCasRef(meta.objectId), irDigest: meta.contentDigest, format, rendererVersion, contentDigest: stored.contentDigest, mimeType,
            byteSize: stored.byteSize, storageRef: buildCasRef(stored.objectId) }, executor);
        if (!prior) {
            await incrementRefCount(stored.objectId, 1, { executor }); await incrementRefCount(meta.objectId, 1, { executor });
            await recordDeliveryEvent({ tenantId, renditionId: Number(record.id), runId, toolCallId, actorType: 'user', actorId: String(user.id),
                eventType: 'presentation_render', pathHint: request.title + '.' + format, contentDigest: stored.contentDigest }, { executor });
        }
        results.push({ renditionId: Number(record.id), artifactId: Number(artifact.id), format, byteSize: stored.byteSize, contentDigest: stored.contentDigest, filename: request.title + (format === 'zip' ? '-项目源包.zip' : '.pptx') });
    }
    return { files: results, artifactId: Number(artifact.id), outputDigest: metadata.outputDigest, slideCount: metadata.checks.slideCount,
        checks: metadata.checks, editing: metadata.editing, ...(sourcePackageWarning ? { sourcePackageWarning } : {}) };
}
module.exports = { prepareDelivery, commitDelivery, sourceBundleLimit };
