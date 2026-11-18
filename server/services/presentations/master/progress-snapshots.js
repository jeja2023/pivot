'use strict';

const crypto = require('node:crypto');
const repository = require('../../../repositories/presentation-master-tasks');
const cas = require('../../agent-artifact-cas');
const { assertTenantContext } = require('../../agent-tenant-context');
const runtime = require('./runtime');
const { exportReview } = require('./review-plan');

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const files = {
    source: ['progress-sources.zip', 'application/zip', '-待核验项目源包.zip'],
    export: ['progress-review.pptx', PPTX, '-待核验整稿快照.pptx'],
    passed: ['progress-passed.pptx', PPTX, '-已通过页面.pptx']
};
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function captureAction(state, action, result) {
    if (state.engine?.progressSnapshots !== 1 || !result || result.exitCode > 0) return null;
    const template = state.request.operation === 'create_template';
    const approved = state.review?.approvals?.[template ? 'template' : 'design'];
    const project = approved?.plan?.project;
    if (project && !template && result.progressExport?.startsWith(project + '/exports/')) {
        const { checklist, checklistDigest } = exportReview(state, project);
        return { action: 'capture_progress', project, export: result.progressExport, checklist, checklistDigest };
    }
    const pageProject = ['write', 'copy'].includes(action.action) && /^(.+)\/(?:svg_output|authoring-svg-flat)\/[^/]+\.svg$/i.exec(result.path || action.path);
    const templateChanged = template && project && ['write', 'copy', 'copy_template', 'run'].includes(action.action);
    if (pageProject && (!project || pageProject[1] === project) || templateChanged) {
        return { action: 'capture_progress', project: project || pageProject[1], template };
    }
    return null;
}

function snapshotView(snapshots) {
    if (!snapshots) return undefined;
    const { source, export: exported, passed, subsetUnavailable } = snapshots;
    return {
        ...(source ? { source: { count: source.files.length, files: source.files, savedAt: source.savedAt } } : {}),
        ...(exported ? { export: { passedPages: exported.passedPages, pendingPages: exported.pendingPages, savedAt: exported.savedAt } } : {}),
        ...(passed ? { passed: { pages: passed.pages, savedAt: passed.savedAt, historical: passed.originalDigest !== exported?.sha256 } } : {}),
        ...(subsetUnavailable ? { subsetUnavailable: true } : {})
    };
}

async function capture(user, id, lease, state, action, result, hooks, deps = {}) {
    const input = captureAction(state, action, result);
    if (!input) return;
    const receipt = await (deps.execute || runtime.execute)(user, id, input, hooks);
    if (!receipt.source && !receipt.export) return;
    if (receipt.export) {
        const pages = [...receipt.export.passedPages, ...receipt.export.pendingPages];
        if (!input.checklist || receipt.export.sha256 !== receipt.originalDigest || pages.length !== input.checklist.length
            || new Set(pages).size !== pages.length || pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > pages.length)) {
            throw runtime.error('快照页序与已确认清单无法对应。');
        }
    }
    const tenant = await (deps.tenantContext || assertTenantContext)(user), savedAt = new Date().toISOString();
    const prepared = {};
    for (const [kind, [name, mimeType]] of Object.entries(files)) {
        const entry = receipt[kind];
        if (!entry) continue;
        hooks.signal?.throwIfAborted();
        if (entry.file !== name || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 1 || entry.byteSize > 60 * 1024 * 1024) throw runtime.error('快照文件登记无效。');
        const buffer = await (deps.readOutput || runtime.readOutput)(user, id, name, entry.byteSize);
        if (buffer.length !== entry.byteSize || digest(buffer) !== entry.sha256) throw runtime.error('快照文件已变化。');
        const object = await (deps.put || cas.putBuffer)({ buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_progress' });
        prepared[kind] = { objectId: object.objectId, sha256: entry.sha256, savedAt };
    }
    if (prepared.source) prepared.source.files = receipt.source.files;
    if (prepared.export) {
        Object.assign(prepared.export, { checklistDigest: input.checklistDigest, passedPages: receipt.export.passedPages, pendingPages: receipt.export.pendingPages });
        if (prepared.passed) Object.assign(prepared.passed, { pages: receipt.export.passedPages, originalDigest: receipt.originalDigest });
        prepared.subsetUnavailable = Boolean(receipt.subsetUnavailable);
    }
    await hooks.ensureCurrent();
    const records = deps.repository || repository;
    await records.saveProgressSnapshot(user, id, lease, prepared, async (executor, before, after) => {
        const references = value => new Set(Object.values(value).map(item => item?.objectId).filter(Boolean));
        const oldIds = references(before), newIds = references(after);
        for (const objectId of [...new Set([...oldIds, ...newIds])].sort()) {
            const delta = Number(newIds.has(objectId)) - Number(oldIds.has(objectId));
            if (!delta) continue;
            const remaining = await (deps.increment || cas.incrementRefCount)(objectId, delta, { executor });
            if (delta > 0 || remaining === 0) await records.updateProgressRetention(executor, objectId);
        }
    });
}

async function readSnapshot(user, taskId, kind, lookup, deps = {}) {
    if (!Object.hasOwn(files, kind)) throw runtime.error('请选择有效的制作快照。');
    const result = await lookup(user, taskId);
    const snapshot = result?.row.result_json.progressSnapshots?.[kind];
    if (!snapshot) throw runtime.error('当前制作快照不可用。', 'PPT_MASTER_SNAPSHOT_UNAVAILABLE', 404);
    const tenant = await (deps.tenantContext || assertTenantContext)(user);
    const { buffer } = await (deps.read || cas.readBuffer)({ objectId: snapshot.objectId, tenantId: tenant.tenantId, tenantScoped: true });
    const current = await lookup(user, taskId);
    if (current?.row.result_json.progressSnapshots?.[kind]?.sha256 !== snapshot.sha256 || digest(buffer) !== snapshot.sha256) {
        throw runtime.error('制作快照已变化，请刷新后再试。', 'PPT_MASTER_DRAFT_CHANGED', 409);
    }
    const title = result.row.result_json.state?.request?.title || '演示文稿';
    return { buffer, filename: title.replace(/[\r\n\\/]/g, '_') + files[kind][2], mimeType: files[kind][1] };
}

module.exports = { capture, snapshotView, readSnapshot };
