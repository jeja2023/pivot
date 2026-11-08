'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const jwt = require('jsonwebtoken');
const jobs = require('../../../repositories/analysis-model-jobs');
const models = require('../../../repositories/analysis-production-models');
const repository = require('../../../repositories/analysis-model-results');
const objectRepository = require('../../../repositories/analysis-objects');
const objects = require('./objects');
const service = require('./jobs');
const { requestKey } = require('./query-contract');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { protect } = require('./delivery');
const { requiredFields } = require('./access');

function signingKey() {
    if (String(process.env.JWT_SECRET || '').length < 32) throw biError('ANALYSIS_MODEL_DELIVERY_UNREADY', '结果交付服务尚未配置有效签名密钥，请联系维护者。', 503);
    return crypto.createHmac('sha256', process.env.JWT_SECRET).update('pivot-bi-result-intent-v1').digest();
}
function sessionFingerprint(req) {
    const authorization = String(req.headers?.authorization || '');
    const cookie = String(req.headers?.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('pivot_access_token='));
    const credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : cookie?.slice('pivot_access_token='.length);
    if (!credential) throw biError('ANALYSIS_MODEL_SESSION_REQUIRED', '请使用当前登录会话读取结果。', 401);
    return crypto.createHmac('sha256', signingKey()).update(credential).digest('hex');
}
function sign(purpose, data, seconds) { return jwt.sign({ purpose, ...data }, signingKey(), { algorithm: 'HS256', expiresIn: seconds, audience: 'pivot-bi-result' }); }
function verifyResultToken(token, purpose, { user, session, jobId, object, authorizationHash }) {
    let claims;
    try { claims = jwt.verify(String(token || ''), signingKey(), { algorithms: ['HS256'], audience: 'pivot-bi-result' }); }
    catch (_) { throw biError('ANALYSIS_MODEL_RESULT_TOKEN_INVALID', '结果凭据无效或已过期，请重新请求。', 403); }
    if (claims.purpose !== purpose || Number(claims.userId) !== Number(user.id) || claims.session !== session || claims.jobId !== jobId || claims.objectId !== object.id || claims.digest !== object.digest || claims.authorizationHash !== authorizationHash) throw biError('ANALYSIS_MODEL_RESULT_TOKEN_INVALID', '当前会话或权限与结果凭据不一致，请重新请求。', 403);
    return claims;
}

async function resolveResultContext(user, jobId) {
    await service.getModelJob(user, jobId);
    const row = await jobs.get(user.id, jobId);
    if (!['model_query', 'model_trial', 'model_export'].includes(row.execution_kind)) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '质量检查没有分析结果文件。', 409);
    const definition = row.execution_kind === 'model_trial' ? (await jobs.check(user.id, row.model_id, row.check_id)).definition_json : (await models.version(row.model_id, row.published_version)).definition_json;
    return { row, definition, authorize: service.authorize(user, row.model_id, definition, { query: row.query_ast_json }) };
}

async function resultPage({ user, jobId, session, cursor = '', limit = 100 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw biError('ANALYSIS_MODEL_PAGE_INVALID', '结果分页大小应为一至一百。');
    const { row, definition, authorize } = await resolveResultContext(user, jobId);
    if (row.execution_kind === 'model_export') throw biError('ANALYSIS_MODEL_PAGE_INVALID', '导出文件请使用受控下载。');
    const leaseId = `page_${crypto.randomUUID()}`;
    try {
        const access = await repository.access({ userId: user.id, jobId, authorize, leaseId, page: true });
        let offset = 0;
        if (cursor) { const claims = verifyResultToken(cursor, 'cursor', { user, session, jobId, object: access.object, authorizationHash: access.current.authorizationHash }); if (claims.limit !== limit || !Number.isSafeInteger(claims.offset) || claims.offset < 0 || claims.offset >= Number(access.object.byte_length)) throw biError('ANALYSIS_MODEL_PAGE_INVALID', '分页游标与当前请求不匹配，请从第一页重试。'); offset = claims.offset; }
        const file = await objects.verify(access.object), rows = [];
        const stream = fs.createReadStream(file, { start: offset, highWaterMark: 65536 }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try { for await (const line of lines) { offset += Buffer.byteLength(line + '\n'); if (line) rows.push(JSON.parse(line)); if (rows.length >= limit) break; } }
        finally { lines.close(); stream.destroy(); }
        const latest = await repository.access({ userId: user.id, jobId, authorize, page: true });
        const nextCursor = offset < Number(access.object.byte_length) ? sign('cursor', { userId: Number(user.id), session, jobId, objectId: access.object.id, digest: access.object.digest, authorizationHash: latest.current.authorizationHash, offset, limit }, 300) : null;
        return protect({ runId: jobId, rows, total: row.result_metadata_json.total, columns: row.result_metadata_json.columns, nextCursor, pageComplete: !nextCursor, truncated: row.result_metadata_json.truncated,
            metadata: { ...row.result_metadata_json, rows: undefined, total: undefined }, order: 'query_order' }, { userId: user.id, modelId: row.model_id, definition, required: requiredFields(definition, row.query_ast_json).fields,
            beforeSend: async (trx, current) => {
                const final = await repository.accessInTransaction(trx, { userId: user.id, jobId, authorize: () => current, page: true });
                if (final.object.id !== access.object.id || final.current.authorizationHash !== latest.current.authorizationHash) throw biError('ANALYSIS_MODEL_RESULT_TOKEN_INVALID', '权限或结果状态已变化，请从第一页重新读取。', 403);
            } });
    } finally { await objectRepository.release('lease', leaseId); }
}

async function createModelExport({ user, jobId, body }) {
    await require('./readiness').ensureReady({ batch: true });
    const { row, definition, authorize } = await resolveResultContext(user, jobId);
    if (row.execution_kind !== 'model_query' || row.status !== 'succeeded' || row.result_metadata_json?.resultExpired) throw biError('ANALYSIS_MODEL_EXPORT_INVALID', '请先完成正式发布版本的分析，再导出完整结果；过期结果需要重新计算。', 409);
    if (!['csv', 'xlsx'].includes(body.format)) throw biError('ANALYSIS_MODEL_EXPORT_INVALID', '仅支持 CSV 或 XLSX 导出。');
    const job = await jobs.admit({ userId: user.id, modelId: row.model_id, kind: 'model_export', publishedVersion: Number(row.published_version), manifestId: row.manifest_id, sourceRunId: row.id, resultFormat: body.format,
        query: row.query_ast_json, requestKey: requestKey(body.requestKey), requestHash: canonicalHash({ sourceRunId: row.id, format: body.format, semanticHash: canonicalHash(definition) }), authorize });
    return service.getModelJob(user, job.id);
}

async function issueDownload({ user, jobId, session }) {
    const { row, authorize } = await resolveResultContext(user, jobId);
    if (row.execution_kind !== 'model_export') throw biError('ANALYSIS_MODEL_EXPORT_REQUIRED', '请先生成 CSV 或 XLSX 导出任务。', 409);
    const access = await repository.access({ userId: user.id, jobId, authorize, auditAction: 'model_download_authorized' });
    await objects.verify(access.object);
    return { token: sign('download', { userId: Number(user.id), session, jobId, objectId: access.object.id, digest: access.object.digest, authorizationHash: access.current.authorizationHash }, 60), expiresIn: 60,
        format: row.result_format, byteLength: String(access.object.byte_length), fileName: `分析结果-${jobId}.${row.result_format}` };
}

function byteRange(value, size) {
    if (!value) return { start: 0, end: size - 1, partial: false };
    const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
    if (!match || !match[1] && !match[2]) throw biError('ANALYSIS_MODEL_RANGE_INVALID', '仅支持单个有效字节范围。', 416);
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw biError('ANALYSIS_MODEL_RANGE_INVALID', '下载字节范围超出文件，请重新请求。', 416);
    return { start, end: Math.min(end, size - 1), partial: true };
}

async function downloadModelExport({ user, jobId, session, token, range, response }) {
    const { row, authorize } = await resolveResultContext(user, jobId), leaseId = `download_${crypto.randomUUID()}`;
    if (row.execution_kind !== 'model_export') throw biError('ANALYSIS_MODEL_EXPORT_REQUIRED', '请先创建导出文件。', 409);
    let stream, timer, inFlight = null, lastConfirmed = Date.now(), started = false;
    const access = await repository.access({ userId: user.id, jobId, authorize, leaseId, auditAction: 'model_download_started' });
    let claims;
    const check = async (write = null) => repository.access({ userId: user.id, jobId, authorize, leaseId, deliver: current => {
        if (claims.authorizationHash !== current.current.authorizationHash || claims.digest !== current.object.digest || claims.objectId !== current.object.id) throw biError('ANALYSIS_MODEL_RESULT_TOKEN_INVALID', '下载期间权限或结果状态已变化，请重新请求。', 403);
        lastConfirmed = Date.now();
        return write ? write() : undefined;
    } });
    try {
        claims = verifyResultToken(token, 'download', { user, session, jobId, object: access.object, authorizationHash: access.current.authorizationHash });
        await check();
        const file = await objects.verify(access.object);
        await check();
        const requested = byteRange(range, Number(access.object.byte_length));
        response.status(requested.partial ? 206 : 200);
        response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Type', row.result_format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        response.setHeader('Content-Disposition', `attachment; filename="analysis.${row.result_format}"; filename*=UTF-8''${encodeURIComponent(`分析结果-${row.id}.${row.result_format}`)}`);
        response.setHeader('Content-Length', String(requested.end - requested.start + 1));
        if (requested.partial) response.setHeader('Content-Range', `bytes ${requested.start}-${requested.end}/${access.object.byte_length}`);
        stream = fs.createReadStream(file, { start: requested.start, end: requested.end, highWaterMark: 65536 });
        const abort = () => { stream?.destroy(); response.destroy(); };
        response.once('close', () => stream?.destroy());
        timer = setInterval(() => {
            if (Date.now() - lastConfirmed > 4500) { abort(); return; }
            if (!inFlight && Date.now() - lastConfirmed >= 1000) inFlight = check().catch(abort).finally(() => { inFlight = null; });
        }, 250); timer.unref?.();
        for await (const chunk of stream) {
            if (response.destroyed) break;
            if (inFlight) await inFlight;
            if (response.destroyed) break;
            const written = !started || Date.now() - lastConfirmed >= 1000 ? await check(() => response.destroyed ? true : response.write(chunk)) : response.write(chunk);
            started = true;
            if (!written) await waitWritable(response);
        }
        if (!response.destroyed) response.end();
    } catch (error) { if (response.headersSent) response.destroy(); else throw error; }
    finally { clearInterval(timer); stream?.destroy(); if (inFlight) await inFlight; await objectRepository.release('lease', leaseId); }
}

function waitWritable(response) {
    return new Promise(resolve => {
        const done = () => { response.removeListener('drain', done); response.removeListener('close', done); resolve(); };
        response.once('drain', done); response.once('close', done);
    });
}

module.exports = { sessionFingerprint, resultPage, createModelExport, issueDownload, downloadModelExport, byteRange };
