'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const repository = require('../../../repositories/analysis-integrity');
const objectRepository = require('../../../repositories/analysis-objects');
const manifestRepository = require('../../../repositories/analysis-manifests');
const { withRuntimeBudget, executionSignal } = require('../runtime-budget');
const { readTypedEnv } = require('../../../config/env-registry');
const { canonicalHash } = require('./canonical');
const objects = require('./objects');
const { logger } = require('../../../logger');

async function* storageFiles(root, relative = '') {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { yield { key, symbolic: true }; continue; }
        if (entry.isDirectory()) {
            if (key.split('/').length <= 4) yield* storageFiles(root, key);
        } else if (entry.isFile()) yield { key, symbolic: false };
    }
}
async function scanFiles(state) {
    let count = 0, cursor = state.file_cursor;
    for await (const entry of storageFiles(objects.store.casRoot())) {
        if (entry.key <= cursor || entry.key.startsWith('.tmp-write/')) continue;
        if (executionSignal()?.aborted) throw new Error('完整性巡检已取消。');
        const registered = !entry.symbolic && await repository.storageRegistered(entry.key);
        if (!registered) await repository.finding(entry.symbolic ? 'storage_symlink' : 'orphan_file', entry.key);
        else await repository.resolveFinding('orphan_file', entry.key);
        cursor = entry.key; count++;
        if (count >= 256) { await repository.fileCheckpoint(cursor, false); return { filesChecked: count, fileScanComplete: false }; }
    }
    await repository.fileCheckpoint('', true);
    return { filesChecked: count, fileScanComplete: true };
}
async function scanManifests(state) {
    const manifests = await repository.manifests(state.manifest_cursor);
    for (const manifest of manifests) {
        const rows = await manifestRepository.members(manifest.id), members = manifest.manifest_json?.members;
        const valid = canonicalHash(manifest.manifest_json) === manifest.manifest_hash && Array.isArray(members) && members.length === rows.length && members.every(member => rows.some(row => row.node_id === member.nodeId && row.object_id === member.objectId && row.dataset_version_id === member.datasetVersionId && row.digest === member.digest && String(row.byte_length) === member.byteLength));
        if (!valid) await repository.finding('manifest_invalid', manifest.id);
        else await repository.resolveFinding('manifest_invalid', manifest.id);
    }
    await repository.manifestCheckpoint(manifests.length < 100 ? '' : manifests.at(-1).id);
    return manifests.length;
}
async function reconcileAnalysisObjects() {
    if (!readTypedEnv('DATA_ANALYSIS_MODEL_ENABLED')) return { skipped: 'disabled' };
    return repository.exclusive(async () => {
        const principal = await repository.principal();
        if (!principal) return { skipped: 'no_active_principal' };
        return withRuntimeBudget(async () => {
            const state = await repository.state();
            let cursor = state.object_cursor, checked = 0, bytes = 0, complete = false;
            try {
                const rows = await repository.candidates(cursor);
                for (const row of rows) {
                    try {
                        await objects.verify(row, { signal: executionSignal() });
                        await repository.verified(row.id); await repository.resolveFinding('object_corrupted', row.id);
                    } catch (error) {
                        if (error.code !== 'ANALYSIS_OBJECT_CORRUPTED') throw error;
                        await repository.finding('object_corrupted', row.id, { purpose: row.purpose });
                    }
                    checked++; bytes += Number(row.byte_length); cursor = row.id;
                    if (bytes >= 512 * 1024 ** 2) break;
                }
                complete = checked === rows.length && rows.length < 64;
                await repository.checkpoint(complete ? '' : cursor, { completed: complete });
                const manifestsChecked = await scanManifests(state), fileScan = await scanFiles(state);
                const issues = await repository.metadataIssues();
                for (const issue of issues) await repository.finding(issue.kind, issue.target_id);
                for (const reference of await repository.unexpectedReferences()) {
                    await repository.finding('reference_leak', `${reference.reference_kind}:${reference.reference_id}`);
                    await objectRepository.release(reference.reference_kind, reference.reference_id);
                }
                const retention = await repository.retention(), gc = await objects.garbageCollect();
                const temporary = await objects.store.sweepTemporaryFiles({ signal: executionSignal() });
                if (Date.now() - new Date(state.last_full_scan_at || state.scan_started_at).getTime() > 86400000 && !complete) await repository.finding('full_scan_overdue', 'main');
                else if (complete) await repository.resolveFinding('full_scan_overdue', 'main');
                if (Date.now() - new Date(state.last_file_scan_at || state.scan_started_at).getTime() > 86400000 && !fileScan.fileScanComplete) await repository.finding('file_scan_overdue', 'main');
                else if (fileScan.fileScanComplete) await repository.resolveFinding('file_scan_overdue', 'main');
                const result = { checked, bytes, objectScanComplete: complete, manifestsChecked, ...fileScan, issues: issues.length, temporaryFilesRemoved: temporary.removed, ...retention, ...gc };
                logger.info(result, '数据建模完整性巡检完成');
                return result;
            } catch (error) { await repository.checkpoint(cursor, { error: '巡检未完成，请检查执行预算、存储和数据库。' }).catch(() => {}); throw error; }
        }, { userId: principal.id });
    });
}

module.exports = { reconcileAnalysisObjects };
