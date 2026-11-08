'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const repository = require('../../../repositories/analysis-dataset-increments');
const objectRepository = require('../../../repositories/analysis-objects');
const objects = require('./objects');
const { biError } = require('./errors');
const { versionSourceMetadata } = require('./source-metadata');
const { protect } = require('./delivery');
const { executionSignal, executionJob } = require('../runtime-budget');
const { ingestUpload } = require('../datasets');
const { profileViaSql } = require('../profile');
const { tempRoot, ensureAnalysisDirs, resolveInside, getDatasetPaths, createDuckConnection, sqlIdent, sqlLiteral, parquetToRows, jsonParse, toProjectRelative } = require('../shared');

function requestBatch(input, object) {
    const raw = input.inputBatchId;
    if (raw !== undefined && (typeof raw !== 'string' || !raw.trim() || raw.length > 128 || /[\u0000-\u001f]/.test(raw))) throw biError('ANALYSIS_INCREMENTAL_INVALID', '追加批次需为一至一百二十八字，不能含控制字符。');
    const expected = input.expectedSourceRevision === undefined ? null : String(input.expectedSourceRevision);
    if (expected !== null && !/^[1-9]\d{0,15}$/.test(expected)) throw biError('ANALYSIS_INCREMENTAL_INVALID', '请重新加载有效来源修订后追加。');
    return { batchId: raw ? raw.trim() : `file:${object.digest}`, digest: object.digest, bytes: Number(object.byte_length), expectedSourceRevision: expected };
}

async function appendDatasetVersion({ user, datasetId, file, input = {}, fault }) {
    const ext = path.extname(file?.originalname || file?.filename || '').toLowerCase();
    if (!file?.path || !['.csv', '.xlsx', '.xls', '.sqlite', '.sqlite3', '.db'].includes(ext)) throw biError('ANALYSIS_INCREMENTAL_INVALID', '请选择 CSV、XLS/XLSX 或 SQLite 增量文件。');
    await ensureAnalysisDirs();
    await require('./readiness').storageState({ batch: true });
    const operationId = `increment_${crypto.randomUUID()}`, root = resolveInside(tempRoot, 'dataset-increments', operationId);
    const leaseId = `${operationId}:prepare`, maxBytes = 2 * 1024 ** 3;
    const signal = executionSignal(), job = executionJob();
    if (!job) throw biError('ANALYSIS_MODEL_LEASE_LOST', '追加操作缺少有效执行预算，请重新提交。', 409);
    try {
        // 先固定原始文件，再从私有副本解析；重复批次和合并均以相同真实字节为依据。
        const inputObject = await objects.importFile({ file: file.path, userId: user.id, purpose: 'source', leaseId, maxBytes, signal });
        const batch = requestBatch(input, inputObject), before = await repository.inspect(user.id, datasetId, batch);
        const protectResult = result => protect(result, { userId: user.id, definition: { nodes: [{ id: 'source', datasetId }] }, required: new Map() });
        if (before.duplicate) return protectResult(before.duplicate);
        const dataset = before.dataset, columns = jsonParse(dataset.columns_json, []);
        const baseObject = await objects.importFile({ file: getDatasetPaths(dataset).parquetPath, userId: user.id, purpose: 'source', leaseId, maxBytes, signal });
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const original = path.join(root, `input${ext}`);
        await fs.copyFile(await objects.verify(inputObject), original);
        const ingest = await ingestUpload({ stagingDir: root, datasetDir: root, file: { ...file, path: original }, ext });
        if (columns.length !== ingest.columns.length || columns.some((column, index) => column.key !== ingest.columns[index]?.key)) throw biError('ANALYSIS_INCREMENTAL_SCHEMA_MISMATCH', '增量字段数量或顺序与当前数据集不一致，请先统一字段。', 409);
        const output = path.join(root, 'merged.parquet'), rowCount = Number(dataset.row_count) + Number(ingest.rowCount);
        const { instance, connection } = await createDuckConnection();
        try {
            const base = await objects.verify(baseObject), actual = (await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(base)})`)).getRowObjectsJson()[0];
            if (Number(actual.n) !== Number(dataset.row_count)) throw biError('ANALYSIS_SOURCE_CHANGED', '来源实际行数与版本记录不一致，未执行追加，请先核对来源。', 409);
            const fields = columns.map(column => sqlIdent(column.key)).join(',');
            await connection.run(`COPY (SELECT ${fields} FROM read_parquet(${sqlLiteral(base)}) UNION ALL SELECT ${fields} FROM read_parquet(${sqlLiteral(ingest.parquetPath)})) TO ${sqlLiteral(output)} (FORMAT PARQUET,COMPRESSION ZSTD)`);
        } finally { connection.closeSync(); instance.closeSync(); }
        const profile = await profileViaSql(output, columns, rowCount), previewRows = await parquetToRows(output, { limit: 100 });
        const object = await objects.importFile({ file: output, userId: user.id, purpose: 'source', leaseId, maxBytes, signal });
        const previous = versionSourceMetadata(dataset, before.version);
        const coverage = previous.coverage === 'unknown' || Number(ingest.truncated) === 2 ? 'unknown' : previous.coverage !== 'full' || Number(ingest.truncated) === 1 ? 'partial' : 'full';
        const sourceMetadata = { inputBatchId: batch.batchId, businessPeriod: '', dataUpdatedAt: new Date().toISOString(), coverage };
        await fault?.('objects_prepared');
        return protectResult(await repository.commit({ userId: user.id, datasetId, before, input: batch, object, inputObject, baseObject, parquetPath: toProjectRelative(await objects.verify(object)), rowCount, columns, profile, previewRows, ingest, sourceMetadata, job }));
    } catch (error) {
        if (signal?.aborted && !error.applied) throw biError('ANALYSIS_MODEL_LEASE_LOST', '追加执行已取消或租约失效，未继续登记数据版本。', 409);
        throw error;
    } finally {
        await objectRepository.release('lease', leaseId);
        const target = path.resolve(root), parent = path.resolve(tempRoot, 'dataset-increments');
        if (path.dirname(target) === parent && /^increment_[a-f0-9-]+$/.test(path.basename(target))) await fs.rm(target, { recursive: true, force: true });
        await fs.unlink(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

module.exports = { appendDatasetVersion };
