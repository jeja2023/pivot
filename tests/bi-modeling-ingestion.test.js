'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true';
process.env.DATA_ANALYSIS_MODEL_RUNTIME ||= 'development_process';
const { execute, queryOne } = require('../server/db/client');
const service = require('../server/services/data-analysis/bi/ingestions');
const runner = require('../server/services/data-analysis/bi/runner');
const { tempRoot, fromProjectRelative, createDuckConnection, sqlLiteral } = require('../server/services/data-analysis/shared');

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,username,role,status", [`ingest_${crypto.randomUUID()}`]);
    const root = path.join(tempRoot, `ingestion-test-${crypto.randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    try { await run({ user, root }); }
    finally {
        await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_ingestion_sessions WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_dataset_versions WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_datasets WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [user.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(tempRoot));
        await fs.rm(resolved, { recursive: true, force: true });
    }
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function input(bytes, overrides = {}) { return { name: '完整受控导入', originalName: 'large.csv', role: 'fact', headers: ['订单号', '金额'], expectedBytes: bytes.length, expectedRows: 2, requestKey: crypto.randomUUID(), ...overrides }; }
async function uploadBuffer(user, bytes, body) {
    const session = await service.createIngestion(user, body);
    for (let index = 0; index < session.expectedChunks; index++) {
        const part = bytes.subarray(index * session.chunkBytes, Math.min(bytes.length, (index + 1) * session.chunkBytes));
        await service.putIngestionChunk(user, session.id, index, part, digest(part));
    }
    return session;
}

test('完整分块、幂等提交和隔离全量导入原子登记数据集及版本，保留编码和精确金额', { timeout: process.env.DATA_ANALYSIS_MODEL_RUNTIME === 'docker' ? 180000 : 60000 }, async () => fixture(async ({ user }) => {
    const bytes = Buffer.from('订单号,金额\r\n00001,100.01\r\n00002,9007199254740993.25\r\n');
    const sourceMetadata = { inputBatchId: '订单共同批次202611', businessPeriod: '2026-11', dataUpdatedAt: '2026-11-01T00:00:00.000Z', coverage: 'full' };
    const body = input(bytes, { sourceMetadata }), session = await uploadBuffer(user, bytes, body);
    assert.equal((await service.createIngestion(user, body)).id, session.id);
    assert.deepEqual(session.sourceMetadata, sourceMetadata);
    await assert.rejects(service.createIngestion(user, { ...body, sourceMetadata: { ...sourceMetadata, inputBatchId: '其他批次' } }), error => error.code === 'ANALYSIS_INGESTION_CONFLICT');
    await assert.rejects(execute("UPDATE analysis_ingestion_sessions SET source_metadata_json='{}' WHERE id=?", [session.id]), error => error.code === 'P0001');
    await service.putIngestionChunk(user, session.id, 0, bytes, digest(bytes));
    const submitted = await service.submitIngestion(user, session.id);
    assert.equal((await service.submitIngestion(user, session.id)).jobId, submitted.jobId);
    await runner.processModelJobs();
    const complete = await service.getIngestion(user, session.id);
    assert.equal(complete.status, 'succeeded', complete.lastError); assert.ok(complete.datasetId);
    const row = await queryOne('SELECT * FROM analysis_datasets WHERE id=?', [complete.datasetId]);
    assert.equal(Number(row.row_count), 2); assert.equal(Number(row.truncated), 0);
    assert.equal(JSON.parse(row.preview_json)[0].c_1, '00001');
    assert.equal(JSON.parse(row.preview_json)[1].c_2, '9007199254740993.25');
    const version = await queryOne('SELECT * FROM analysis_dataset_versions WHERE dataset_id=?', [complete.datasetId]);
    assert.equal(version.operation, 'controlled_import'); assert.equal(version.manifest_json.coverage, 'full');
    assert.deepEqual(version.manifest_json.sourceMetadata, sourceMetadata);
    const job = await queryOne('SELECT * FROM analysis_query_jobs WHERE id=?', [complete.jobId]);
    assert.equal(job.result_object_id, version.manifest_json.objectId);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references WHERE object_id=? AND reference_kind='manifest'", [job.result_object_id])).n), 1);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='dataset_ingested'", [complete.jobId])).n), 1);
}));

test('未齐分块、错误摘要、替换已确认分块和停用账号均拒绝，不生成部分数据集', { timeout: process.env.DATA_ANALYSIS_MODEL_RUNTIME === 'docker' ? 180000 : 60000 }, async () => fixture(async ({ user }) => {
    const bytes = Buffer.from('订单号,金额\n00001,1\n00002,2\n');
    const session = await service.createIngestion(user, input(bytes));
    await assert.rejects(service.submitIngestion(user, session.id), error => error.code === 'ANALYSIS_INGESTION_CONFLICT');
    await assert.rejects(service.putIngestionChunk(user, session.id, 0, bytes, '0'.repeat(64)), error => error.code === 'ANALYSIS_INGESTION_INVALID');
    await service.putIngestionChunk(user, session.id, 0, bytes, digest(bytes));
    const changed = Buffer.from(bytes); changed[changed.length - 2] = 0x33;
    await assert.rejects(service.putIngestionChunk(user, session.id, 0, changed, digest(changed)), error => error.code === 'ANALYSIS_INGESTION_CONFLICT');
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(service.getIngestion(user, session.id), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_datasets WHERE user_id=?', [user.id])).n), 0);
}));

test('实际行数或字段合同不一致时整个导入失败，取消排队导入不创建数据集', { timeout: process.env.DATA_ANALYSIS_MODEL_RUNTIME === 'docker' ? 180000 : 60000 }, async () => fixture(async ({ user }) => {
    const bytes = Buffer.from('订单号,金额\n00001,1\n00002,2\n');
    const session = await uploadBuffer(user, bytes, input(bytes, { expectedRows: 3 }));
    await service.submitIngestion(user, session.id); await runner.processModelJobs();
    const failed = await service.getIngestion(user, session.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.datasetId, null);
    const invalid = await uploadBuffer(user, bytes, input(bytes, { headers: ['错误表头', '金额'] }));
    await service.submitIngestion(user, invalid.id); await runner.processModelJobs();
    assert.equal((await service.getIngestion(user, invalid.id)).status, 'failed');
    const cancelled = await uploadBuffer(user, bytes, input(bytes));
    await service.submitIngestion(user, cancelled.id); await service.cancelIngestion(user, cancelled.id);
    assert.equal((await service.getIngestion(user, cancelled.id)).status, 'cancelled');
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_datasets WHERE user_id=?', [user.id])).n), 0);
}));

test('格式探测范围之外的缺列仍按全量严格读取拒绝，不把非法 CSV 计为平台故障或登记部分数据', async () => fixture(async ({ user }) => {
    const bytes = Buffer.from('订单号,金额\n' + Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(8, '0')},0.25\n`).join('') + '末行缺少金额\n');
    const session = await uploadBuffer(user, bytes, input(bytes, { expectedRows: 3001 }));
    const queued = await service.submitIngestion(user, session.id); await runner.processModelJobs();
    const result = await service.getIngestion(user, session.id); assert.equal(result.status, 'failed'); assert.equal(result.datasetId, null);
    assert.match(result.lastError, /CSV 数据行或编码/);
    const audit = await queryOne("SELECT error_code FROM analysis_audit_events WHERE run_id=? AND action='job_failed'", [queued.jobId]); assert.equal(audit.error_code, 'ANALYSIS_INGESTION_INVALID');
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_datasets WHERE user_id=?', [user.id])).n), 0);
}));

test('真实 HTTP 分块使用当前会话，限制类型、大小和摘要；跨用户和撤权后均拒绝', { timeout: process.env.DATA_ANALYSIS_MODEL_RUNTIME === 'docker' ? 180000 : 60000 }, async () => fixture(async ({ user }) => {
    const express = require('express'), http = require('node:http');
    const { authMiddleware, generateAccessToken } = require('../server/auth');
    const app = express(); app.use(express.json());
    require('../server/routes/apps/data-analysis-ingestion-routes').registerDataAnalysisIngestionRoutes(app, { authMiddleware });
    app.use((error, _req, res, _next) => { res.status(error.status || 500).json({ code: error.code, error: error.message }); });
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const viewer = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,username,role,status", [`ingest_viewer_${crypto.randomUUID()}`]);
    const token = generateAccessToken(user, { sessionIp: '127.0.0.1' });
    const request = (suffix, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis/ingestions${suffix}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    try {
        const bytes = Buffer.from('订单号,金额\n00001,1\n00002,2\n');
        const created = await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(bytes)) });
        assert.equal(created.status, 201); assert.match(created.headers.get('cache-control'), /no-store/);
        const { ingestion } = await created.json();
        const put = (data, headers = {}) => request(`/${ingestion.id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': digest(bytes), ...headers }, body: data });
        assert.equal((await put(bytes, { 'Content-Type': 'text/plain' })).status, 415);
        assert.equal((await put(bytes, { 'X-Content-SHA256': '0'.repeat(64) })).status, 400);
        assert.equal((await put(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
        assert.equal((await put(bytes)).status, 200);
        const viewerToken = generateAccessToken(viewer, { sessionIp: '127.0.0.1' });
        assert.equal((await request(`/${ingestion.id}`, { headers: { Authorization: `Bearer ${viewerToken}` } })).status, 404);
        const submitted = await request(`/${ingestion.id}/submit`, { method: 'POST' }); assert.equal(submitted.status, 202);
        await runner.processModelJobs();
        assert.equal((await (await request(`/${ingestion.id}`)).json()).ingestion.status, 'succeeded');
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [user.id]);
        assert.equal((await request(`/${ingestion.id}`)).status, 401);
        assert.equal((await put(bytes)).status, 401);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await execute('DELETE FROM users WHERE id=?', [viewer.id]); }
}));

test('受控摄取真实一百万事实行，跨块 UTF-8、带引号换行和全量金额均不截断', { timeout: 240000 }, async () => fixture(async ({ user, root }) => {
    const file = path.join(root, 'million.csv'), handle = await fs.open(file, 'wx');
    const started = Date.now();
    try {
        await handle.writeFile('订单号,金额,地区,说明\n');
        for (let begin = 0; begin < 1000000; begin += 10000) {
            const lines = [];
            for (let index = begin; index < begin + 10000; index++) lines.push(`${String(index).padStart(10, '0')},1.01,${index % 2 ? '华北' : '华南'},"第${index}笔,包含\n换行和中文"\n`);
            await handle.writeFile(lines.join(''));
        }
        await handle.sync();
    } finally { await handle.close(); }
    const stat = await fs.stat(file), body = { name: '百万行档位实际验证', originalName: 'million.csv', role: 'fact', headers: ['订单号', '金额', '地区', '说明'], expectedBytes: stat.size, expectedRows: 1000000, requestKey: crypto.randomUUID() };
    const session = await service.createIngestion(user, body), reader = await fs.open(file, 'r');
    try {
        for (let index = 0; index < session.expectedChunks; index++) {
            const buffer = Buffer.alloc(Math.min(session.chunkBytes, stat.size - index * session.chunkBytes));
            const read = await reader.read(buffer, 0, buffer.length, index * session.chunkBytes);
            assert.equal(read.bytesRead, buffer.length);
            await service.putIngestionChunk(user, session.id, index, buffer, digest(buffer));
        }
    } finally { await reader.close(); }
    await service.submitIngestion(user, session.id);
    const executionStarted = Date.now(); await runner.processModelJobs();
    const result = await service.getIngestion(user, session.id);
    assert.equal(result.status, 'succeeded', result.lastError);
    const dataset = await queryOne('SELECT * FROM analysis_datasets WHERE id=?', [result.datasetId]);
    assert.equal(Number(dataset.row_count), 1000000); assert.equal(Number(dataset.source_row_count), 1000000); assert.equal(Number(dataset.truncated), 0);
    const { instance, connection } = await createDuckConnection();
    try {
        const row = (await connection.runAndReadAll(`SELECT COUNT(*) AS n,COUNT(DISTINCT c_1) AS ids,SUM(CAST(c_2 AS DECIMAL(18,2)))::VARCHAR AS amount,COUNT(*) FILTER(WHERE contains(c_4,chr(10))) AS quoted FROM read_parquet(${sqlLiteral(fromProjectRelative(dataset.parquet_path))})`)).getRowObjectsJson()[0];
        assert.equal(Number(row.n), 1000000); assert.equal(Number(row.ids), 1000000); assert.equal(row.amount, '1010000.00'); assert.equal(Number(row.quoted), 1000000);
    } finally { connection.closeSync(); instance.closeSync(); }
    const evidence = { rows: 1000000, columns: 4, inputBytes: stat.size, parts: session.expectedChunks, ingestMs: Date.now() - executionStarted, totalMs: Date.now() - started, runtime: process.env.DATA_ANALYSIS_MODEL_RUNTIME, exactTotal: '1010000.00', truncated: false };
    console.log(`百万行受控摄取本地证据：${JSON.stringify(evidence)}`);
}));
