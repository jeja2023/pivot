'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const repository = require('../../../repositories/analysis-ingestions');
const objectRepository = require('../../../repositories/analysis-objects');
const objects = require('./objects');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { normalizeSourceMetadata } = require('./source-metadata');
const { tempRoot, resolveInside, toProjectRelative } = require('../shared');

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 ** 3;
const invalid = message => biError('ANALYSIS_INGESTION_INVALID', message);
function text(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw invalid(`${label}不能为空且不能超过${max}字。`);
    return value.trim();
}

function normalizeIngestion(input) {
    const requestKey = text(input.requestKey, 128, '请求标识');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)) throw invalid('请求标识格式不正确。');
    const originalName = text(input.originalName, 200, '文件名');
    if (!/\.csv$/i.test(originalName) || /[/\\]/.test(originalName)) throw invalid('分批导入只接受 UTF-8 CSV 文件。');
    if (!['fact', 'dimension'].includes(input.role)) throw invalid('请选择事实明细或维度数据。');
    if (!Array.isArray(input.headers) || !input.headers.length || input.headers.length > 120) throw invalid('分批导入支持一至一百二十个字段。');
    const headers = input.headers.map(value => text(value, 80, '字段名称'));
    if (new Set(headers.map(value => value.toLocaleLowerCase('en-US'))).size !== headers.length) throw invalid('字段名称不能重复，请整理 CSV 表头后重新导入。');
    const expectedBytes = input.expectedBytes;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_BYTES) throw invalid('分批导入文件不能超过 2 GiB。');
    const expectedChunks = Math.ceil(expectedBytes / CHUNK_BYTES);
    const expectedRows = input.expectedRows === null || input.expectedRows === undefined ? null : input.expectedRows;
    if (expectedRows !== null && (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > (input.role === 'fact' ? 1000000 : 2000000))) throw invalid('事实数据不能超过一百万行，维度数据不能超过两百万行。');
    const normalized = { name: text(input.name || originalName.replace(/\.csv$/i, ''), 120, '数据集名称'), originalName, role: input.role, headers, expectedBytes, expectedChunks, expectedRows, requestKey, sourceMetadata: normalizeSourceMetadata(input.sourceMetadata) };
    const hashInput = { ...normalized };
    // 旧会话没有业务标注；默认空标注维持原幂等摘要，升级后仍可重试同一上传请求。
    if (!normalized.sourceMetadata.inputBatchId && !normalized.sourceMetadata.businessPeriod && !normalized.sourceMetadata.dataUpdatedAt && normalized.sourceMetadata.coverage === 'full') delete hashInput.sourceMetadata;
    return { ...normalized, requestHash: canonicalHash(hashInput) };
}

async function storageForIngestion(bytes = MAX_BYTES) {
    await require('./readiness').ensureReady({ batch: true });
    await require('./readiness').storageState({ batch: true, reserveBytes: 2 * (8 * 1024 ** 3 + 2 * bytes) });
}

function publicIngestion({ session, chunks = [], job = null }) {
    return { id: session.id, name: session.name, originalName: session.original_name, role: session.role, headers: session.headers_json, status: job?.status || session.status,
        expectedBytes: Number(session.expected_bytes), receivedBytes: Number(session.received_bytes), expectedChunks: Number(session.expected_chunks), expectedRows: session.expected_rows === null ? null : Number(session.expected_rows),
        chunks: chunks.map(row => ({ index: Number(row.part_index), digest: row.digest, bytes: Number(row.byte_length) })), chunkBytes: CHUNK_BYTES,
        datasetId: session.dataset_id || null, jobId: session.job_id || null, sourceMetadata: session.source_metadata_json || {}, progress: Number(job?.progress || 0), lastError: job?.last_error || session.last_error || '', createdAt: session.created_at, expiresAt: session.expires_at };
}

async function createIngestion(user, body) {
    const input = normalizeIngestion(body);
    await storageForIngestion(input.expectedBytes);
    const session = await repository.createSession(user.id, input);
    return publicIngestion(await repository.get(user.id, session.id));
}

async function getIngestion(user, id) { return publicIngestion(await repository.get(user.id, id)); }
async function listIngestions(user) {
    const result = [];
    for (const row of await repository.list(user.id)) result.push(await getIngestion(user, row.id));
    return result;
}

async function putIngestionChunk(user, id, index, bytes, digest) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 255 || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CHUNK_BYTES) throw invalid('分块序号或内容大小不符合合同。');
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || crypto.createHash('sha256').update(bytes).digest('hex') !== digest) throw invalid('分块摘要校验失败，请重新传输此分块。');
    const state = await repository.get(user.id, id);
    const expectedSize = index === Number(state.session.expected_chunks) - 1 ? Number(state.session.expected_bytes) - index * CHUNK_BYTES : CHUNK_BYTES;
    if (index >= Number(state.session.expected_chunks) || bytes.length !== expectedSize) throw invalid('分块边界或字节数与文件合同不一致。');
    await storageForIngestion(Number(state.session.expected_bytes));
    const file = resolveInside(tempRoot, 'ingestion-chunks', `${crypto.randomUUID()}.chunk`), leaseId = `${id}:upload:${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const object = await objects.importFile({ file, userId: user.id, purpose: 'source', leaseId, maxBytes: CHUNK_BYTES });
        if (object.digest !== digest) throw invalid('固定分块时摘要发生变化，请重试。');
        await repository.addChunk(user.id, id, index, object);
        return { index, digest, bytes: bytes.length };
    } finally { await fs.unlink(file).catch(() => {}); await objectRepository.release('lease', leaseId); }
}

async function submitIngestion(user, id) {
    const before = await repository.get(user.id, id);
    await storageForIngestion(Number(before.session.expected_bytes));
    await repository.submit(user.id, id);
    return getIngestion(user, id);
}

async function cancelIngestion(user, id) {
    const { session } = await repository.get(user.id, id);
    if (session.job_id) {
        await require('../../../repositories/analysis-model-jobs').cancel(user.id, session.job_id);
        await require('./runner').cancelActiveModelJob(session.job_id);
    } else await repository.cancelReceiving(user.id, id);
    return getIngestion(user, id);
}

async function executeIngestion(job, { outputRoot, signal }) {
    const preparationStarted = performance.now();
    const { session, chunks } = await repository.executionInput(job);
    const sources = Object.create(null);
    for (const part of chunks) {
        if (signal.aborted) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '分批导入已取消。', 409);
        sources[`chunk_${String(part.part_index).padStart(3, '0')}`] = { file: await objects.verify({ ...part, id: part.object_id }), digest: part.digest, byteLength: String(part.byte_length) };
    }
    const inputResolutionMs = Math.ceil(performance.now() - preparationStarted);
    const output = await require('./runtime').runIsolated({ job, definition: null, query: { headers: session.headers_json, expectedBytes: String(session.expected_bytes), expectedRows: session.expected_rows === null ? null : Number(session.expected_rows), role: session.role }, sources, outputRoot, signal });
    const registrationStarted = performance.now();
    if (signal.aborted) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '分批导入已取消。', 409);
    const object = await objects.importFile({ file: path.join(outputRoot, 'dataset.parquet'), userId: job.user_id, purpose: 'source', leaseId: `${job.id}:result`, maxBytes: MAX_BYTES, signal });
    const parquetPath = toProjectRelative(await objects.verify(object));
    if (!await repository.finish(job, { result: output.result, object, parquetPath, runtimeMetrics: { ...output.runtimeMetrics, inputResolutionMs, resultRegistrationMs: Math.ceil(performance.now() - registrationStarted) } })) throw biError('ANALYSIS_MODEL_LEASE_LOST', '导入完成时执行租约已失效，未登记数据集。', 409);
    await objectRepository.release('lease', `${job.id}:result`);
}

module.exports = { createIngestion, getIngestion, listIngestions, putIngestionChunk, submitIngestion, cancelIngestion, executeIngestion };
