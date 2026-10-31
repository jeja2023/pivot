'use strict';
const crypto = require('node:crypto');
const schema = require('../../../client/common/mindmap-document');
const repository = require('../../repositories/mindmaps');
const documents = require('./documents');
const { canonicalJson } = require('../canonical-json');
const { createQueueRunner } = require('../queue-runner');
function publicJob(row) { return { id: row.id, artifactId: String(row.artifact_id), versionId: String(row.version_id), format: row.format, status: row.status, renditionId: row.rendition_id ? String(row.rendition_id) : null, error: row.error_message || '', createdAt: row.created_at }; }
async function create(user, artifactId, input = {}) {
    if (!require('./formats').EXPORT_FORMATS.includes(input.format)) throw schema.error('请选择受支持的导图导出格式。');
    const result = await repository.enqueue(user.id, documents.id(artifactId), documents.id(input.versionId), input.format);
    schedule();
    return publicJob(result);
}
async function get(user, jobId) { return publicJob(await repository.job(user.id, String(jobId))); }
async function execute(job) {
    const user = { id: job.user_id };
    const snapshot = await documents.snapshot(user, job.artifact_id, job.version_id);
    const { assertTenantContext } = require('../agent-tenant-context');
    const tenant = await assertTenantContext(user);
    const output = await require('./renderer').render(snapshot.document, job.format);
    const digest = crypto.createHash('sha256').update(output.buffer).digest('hex');
    const metadata = { kind: 'mindmap', schemaVersion: 1, rendererVersion: repository.RENDERER_VERSION, artifactId: String(job.artifact_id), versionId: String(job.version_id), format: job.format, document: snapshot.document };
    const irDigest = crypto.createHash('sha256').update(canonicalJson(metadata)).digest('hex');
    const { putBuffer, buildCasRef } = require('../agent-artifact-cas');
    const content = await putBuffer({ buffer: output.buffer, mimeType: output.mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'mindmap_export' });
    const ir = await putBuffer({ buffer: Buffer.from(JSON.stringify(metadata)), mimeType: 'application/json', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'mindmap_source' });
    const result = await repository.registerRendition(job, tenant.tenantId, { digest: irDigest, objectIds: [content.objectId, ir.objectId] }, buildCasRef(content.objectId), buildCasRef(ir.objectId), output.mimeType, output.buffer.length, digest);
    await require('../agent-artifact-delivery').recordDeliveryEvent({ tenantId: tenant.tenantId, renditionId: result.row.id, runId: result.row.run_id, toolCallId: result.row.tool_call_id, actorType: 'user', actorId: String(user.id), eventType: 'mindmap_render', contentDigest: result.row.content_digest });
    await repository.finishJob(job, result.row.id);
}
async function runBatch({ shouldStop }) {
    try {
        for (let count = 0; count < 10; count++) {
            if (shouldStop()) break;
            const job = await repository.claimJob(); if (!job) break;
            try { await execute(job); }
            catch (error) { await repository.finishJob(job, null, error.expose ? error.message : '导出失败，请重试或联系管理员检查运行环境。'); }
        }
    } catch (error) { require('../../logger').logger.error({ code: error.code || 'MINDMAP_EXPORT_FAILED' }, '思维导图导出队列处理失败'); }
}
const runner = createQueueRunner(runBatch);
const { schedule, drain, start, stop } = runner;
module.exports = { create, get, drain, start, stop };
