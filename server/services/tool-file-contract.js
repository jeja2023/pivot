'use strict';

const crypto = require('crypto');
const MIME_BY_FORMAT = { png: 'image/png', svg: 'image/svg+xml', wav: 'audio/wav' };
const MAX_BYTES = 8 * 1024 * 1024;

function validateToolFile(envelope) {
    if (!Object.hasOwn(MIME_BY_FORMAT, envelope.format) || envelope.mimeType !== MIME_BY_FORMAT[envelope.format]
        || envelope.encoding !== 'base64' || typeof envelope.content !== 'string' || envelope.content.length > Math.ceil(MAX_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.content)) throw new Error('工具文件格式、编码或体积不符合登记契约。');
    const buffer = Buffer.from(envelope.content, 'base64');
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!buffer.length || buffer.length > MAX_BYTES || !/^[a-f0-9]{64}$/.test(envelope.sha256 || '') || envelope.sha256 !== digest) throw new Error('工具文件内容为空、超过限制或摘要不一致。');
    if (envelope.format === 'png' && (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || buffer.readUInt32BE(16) > 16000 || buffer.readUInt32BE(20) > 16000)) throw new Error('工具图片不是有效 PNG 或尺寸超过限制。');
    if (envelope.format === 'wav' && (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE'
        || buffer.readUInt32LE(4) + 8 !== buffer.length)) throw new Error('工具音频不是完整 WAV 文件。');
    if (envelope.format === 'svg') require('./document-rendering/image-renderer').sanitizeSvg(buffer.toString('utf8'));
    const title = String(envelope.name || '工具文件').replace(/[\\/<>:"|?*\u0000-\u001f]/g, '').slice(0, 120) || '工具文件';
    return { buffer, digest, format: envelope.format, mimeType: envelope.mimeType, title };
}

async function toolFileIr(envelope, user, deps = {}) {
    const file = validateToolFile(envelope);
    if (file.format === 'png') {
        const metadata = await require('sharp')(file.buffer, { limitInputPixels: 40000000 }).metadata();
        if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('工具图片无法解码，请检查文件完整性。');
    }
    const tenant = await (deps.assertTenantContext || require('./agent-tenant-context').assertTenantContext)(user);
    const stored = await (deps.putBuffer || require('./agent-artifact-cas').putBuffer)({ buffer: file.buffer, mimeType: file.mimeType,
        tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'tool_file' });
    return { assetId: stored.objectId, format: file.format, ir: { ir_version: '1', doc_type: 'report', meta: { title: file.title },
        blocks: [file.format === 'wav' ? { type: 'audio', asset_ref: `artifact-cas://${stored.objectId}` } : { type: 'image', asset_ref: `artifact-cas://${stored.objectId}`, alt: file.title }] } };
}

module.exports = { toolFileIr, validateToolFile };
