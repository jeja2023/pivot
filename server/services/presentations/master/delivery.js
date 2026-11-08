'use strict';

const crypto = require('node:crypto');
const { assertTenantContext } = require('../../agent-tenant-context');
const { createStandaloneArtifact, createOrUpdateRunArtifact } = require('../../agent-artifacts');
const { putBuffer, buildCasRef, incrementRefCount } = require('../../agent-artifact-cas');
const repository = require('../../../repositories/presentation-master-renditions');
const { recordDeliveryEvent } = require('../../agent-artifact-delivery');
const runtime = require('./runtime');

async function deliver(user, taskId, request, receipt, context = {}) {
    context.signal?.throwIfAborted();
    const tenant = await assertTenantContext(user);
    const primary = await runtime.readOutput(user, taskId, receipt.templateOnly ? 'project.zip' : 'presentation.pptx');
    const actualDigest = crypto.createHash('sha256').update(primary).digest('hex');
    if (actualDigest !== receipt.sha256 || receipt.packageCheck?.status !== 'passed') throw runtime.error('最终文件摘要或内容核验无效。', 'PPT_MASTER_DELIVERY_INVALID', 422);
    const metadata = { engine: 'ppt-master', revision: runtime.lock.revision, taskId, title: request.title, operation: request.operation,
        sourceDigest: request.sourceDigest, inputDigests: request.inputDigests, outputDigest: actualDigest, checks: receipt.packageCheck, productionProfile: request.productionProfile,
        editing: '原生PPTX与上游项目源包保留；复杂对象尚未转换为Pivot画布元素。' };
    const artifact = request.runId ? await createOrUpdateRunArtifact({ runId: request.runId, user, type: 'ppt_master', title: request.title, content: JSON.stringify(metadata), note: 'PPT Master 完整制作引擎产物' })
        : await createStandaloneArtifact(user, { type: 'ppt_master', title: request.title, content: JSON.stringify(metadata), note: 'PPT Master 完整制作引擎产物' });
    const meta = await putBuffer({ buffer: Buffer.from(JSON.stringify(metadata)), mimeType: 'application/json', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_project' });
    const results = [];
    const formats = receipt.templateOnly ? [['zip', 'project.zip', 'application/zip']] : [['pptx', 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], ['zip', 'project.zip', 'application/zip']];
    for (const [format, name, mimeType] of formats) {
        context.signal?.throwIfAborted();
        const buffer = format === 'pptx' || receipt.templateOnly ? primary : await runtime.readOutput(user, taskId, name);
        const stored = await putBuffer({ buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_' + format });
        const record = await repository.insert(user, tenant.tenantId, artifact.id, { runId: request.runId || `standalone-artifact:${artifact.id}`, toolCallId: 'ppt-master:' + taskId,
            irRef: buildCasRef(meta.objectId), irDigest: meta.contentDigest, format, rendererVersion: 'ppt-master-6.8.0', contentDigest: stored.contentDigest, mimeType,
            byteSize: stored.byteSize, storageRef: buildCasRef(stored.objectId) });
        await incrementRefCount(stored.objectId, 1); await incrementRefCount(meta.objectId, 1);
        await recordDeliveryEvent({ tenantId: tenant.tenantId, renditionId: Number(record.id), runId: request.runId || `standalone-artifact:${artifact.id}`,
            toolCallId: 'ppt-master:' + taskId, actorType: 'user', actorId: String(user.id), eventType: 'presentation_render', pathHint: request.title + '.' + format, contentDigest: stored.contentDigest });
        results.push({ renditionId: Number(record.id), artifactId: Number(artifact.id), format, byteSize: stored.byteSize, contentDigest: stored.contentDigest, filename: request.title + (format === 'zip' ? '-项目源包.zip' : '.pptx') });
    }
    return { files: results, artifactId: Number(artifact.id), outputDigest: actualDigest, slideCount: receipt.packageCheck.slideCount,
        checks: receipt.packageCheck, editing: metadata.editing };
}
module.exports = { deliver };
