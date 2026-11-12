/**
 * 受控代码文件产物。
 *
 * 代码仍然必须经过 Artifact → CAS → Rendition → Delivery 链，不允许模型或
 * 浏览器直接把任意文本写入用户磁盘。这里的“代码格式”只代表安全的文本文件
 * 扩展名，执行能力仍由桌面 Worker 的另一套审批边界控制。
 */
const crypto = require('crypto');
const path = require('path');
const { queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { getAgentArtifactForUser } = require('./agent-artifacts');
const { buildDeliveryFilename, DELIVERY_EXTENSION_BY_FORMAT } = require('./agent-path-safety');
const { CODE_FORMAT_ALIASES, CODE_MIME_TYPES, FILE_EXTENSION_ALIASES, extensionForLanguage } = require('../../client/common/code-formats');
const {
    buildCasRef,
    incrementRefCount,
    putBuffer
} = require('./agent-artifact-cas');

const MAX_CODE_BYTES = Math.max(1024, Number.parseInt(process.env.PIVOT_CODE_ARTIFACT_MAX_BYTES, 10) || 8 * 1024 * 1024);
const CODE_RENDERER_VERSION = 'code-1.0.0';

function codeRenditionError(message, code = 'CODE_RENDITION_INVALID', status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function normalizeCodeFormat(value, filename = '') {
    const rawValue = String(value || '').trim().toLowerCase();
    const extension = path.extname(String(filename || '').split(/[\\/]/).pop() || '').slice(1).toLowerCase();
    const fileFormat = Object.prototype.hasOwnProperty.call(FILE_EXTENSION_ALIASES, extension) ? FILE_EXTENSION_ALIASES[extension] : extension;
    const format = rawValue ? extensionForLanguage(rawValue) : (fileFormat || 'txt');
    if (!format || !Object.prototype.hasOwnProperty.call(DELIVERY_EXTENSION_BY_FORMAT, format)
        || !Object.prototype.hasOwnProperty.call(CODE_MIME_TYPES, format)) {
        throw codeRenditionError('暂不支持该代码文件格式。请选择 Python、JavaScript、TypeScript、Java、C/C++、Go、Rust、SQL、JSON、YAML、SVG、Markdown 或纯文本。', 'CODE_FORMAT_UNSUPPORTED', 400);
    }
    if (extension && fileFormat !== format) {
        throw codeRenditionError('文件扩展名与代码语言不一致，请重新选择文件名。', 'CODE_FORMAT_FILENAME_MISMATCH', 400);
    }
    return format;
}

function normalizeCodeFile({ filename = '', language = '', content = '' } = {}) {
    if (![filename, language, content].every(value => typeof value === 'string')) throw codeRenditionError('文件名、代码语言和内容必须是文本，请检查后重试。', 'CODE_INPUT_INVALID', 400);
    let text = String(content ?? '');
    if (!text.trim()) throw codeRenditionError('代码内容不能为空。', 'CODE_CONTENT_REQUIRED', 400);
    if (text.includes('\0')) throw codeRenditionError('代码内容包含非法控制字符。', 'CODE_CONTENT_INVALID', 400);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CODE_BYTES) throw codeRenditionError('代码文件超过大小上限，请缩短内容后重试。', 'CODE_CONTENT_TOO_LARGE', 413);
    const format = normalizeCodeFormat(language, filename);
    if (format === 'svg') {
        try { text = require('./document-rendering/image-renderer').sanitizeSvg(text, { maxBytes: 2 * 1024 * 1024 }); }
        catch (error) { throw codeRenditionError(`${error.message} 请移除不支持的内容后重试。`, 'CODE_SVG_INVALID', 400); }
    }
    const fallback = `代码.${format}`;
    const requestedFilename = String(filename || fallback);
    const extension = path.extname(requestedFilename).slice(1).toLowerCase();
    const canonicalFilename = Object.prototype.hasOwnProperty.call(FILE_EXTENSION_ALIASES, extension)
        ? requestedFilename.slice(0, -(extension.length + 1)) + `.${format}` : requestedFilename;
    const safeFilename = buildDeliveryFilename(canonicalFilename, format);
    return { content: text, bytes: Buffer.byteLength(text, 'utf8'), format, filename: safeFilename, mimeType: CODE_MIME_TYPES[format] };
}

function codeMetadataDigest(metadata) {
    return crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}

async function createCodeRendition({ user, artifactId, content, filename, language, runId = '', toolCallId = '' } = {}) {
    const tenant = await assertTenantContext(user);
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) throw codeRenditionError('产物不存在或无权访问。', 'ARTIFACT_NOT_FOUND', 404);
    const normalized = normalizeCodeFile({ filename, language, content });
    const contentDigest = crypto.createHash('sha256').update(Buffer.from(normalized.content, 'utf8')).digest('hex');
    const metadata = {
        kind: 'code',
        filename: normalized.filename,
        format: normalized.format,
        contentDigest,
        rendererVersion: CODE_RENDERER_VERSION
    };
    const irDigest = codeMetadataDigest(metadata);
    const existing = await queryOne(`
        SELECT * FROM agent_artifact_renditions
        WHERE tenant_id = ? AND artifact_id = ? AND ir_digest = ? AND format = ? AND renderer_version = ?
    `, [tenant.tenantId, artifact.id, irDigest, normalized.format, CODE_RENDERER_VERSION]);
    if (existing && existing.status === 'ready') return { rendition: existing, reused: true };

    const metadataObject = await putBuffer({
        buffer: Buffer.from(JSON.stringify(metadata), 'utf8'),
        mimeType: 'application/json; charset=utf-8',
        tenantId: tenant.tenantId,
        ownerUserId: user.id,
        kind: 'code_metadata'
    });
    const contentObject = await putBuffer({
        buffer: Buffer.from(normalized.content, 'utf8'),
        mimeType: normalized.mimeType,
        tenantId: tenant.tenantId,
        ownerUserId: user.id,
        kind: `code_${normalized.format}`
    });
    const now = getBeijingTimestamp();
    const safeRunId = String(runId || artifact.run_id || `standalone-artifact:${artifact.id}`).trim();
    const safeToolCallId = String(toolCallId || `user:${user.id}:code:${artifact.id}`).trim();
    const row = await queryOne(`
        INSERT INTO agent_artifact_renditions
            (tenant_id, artifact_id, run_id, tool_call_id, created_by, ir_ref, ir_digest, format, renderer_version,
             content_digest, mime_type, byte_size, storage_ref, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        RETURNING *
    `, [
        tenant.tenantId, artifact.id, safeRunId, safeToolCallId, user.id,
        buildCasRef(metadataObject.objectId), irDigest, normalized.format, CODE_RENDERER_VERSION,
        contentDigest, normalized.mimeType, normalized.bytes, buildCasRef(contentObject.objectId), now
    ]);
    await incrementRefCount(metadataObject.objectId, 1);
    await incrementRefCount(contentObject.objectId, 1);
    const { recordDeliveryEvent } = require('./agent-artifact-delivery');
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        renditionId: row.id,
        runId: safeRunId,
        toolCallId: safeToolCallId,
        actorType: 'user',
        actorId: String(user.id),
        eventType: 'code_render',
        pathHint: normalized.filename,
        contentDigest
    });
    return { rendition: row, reused: false };
}

module.exports = {
    CODE_FORMAT_ALIASES,
    CODE_MIME_TYPES,
    CODE_RENDERER_VERSION,
    MAX_CODE_BYTES,
    createCodeRendition,
    normalizeCodeFile,
    normalizeCodeFormat
};
