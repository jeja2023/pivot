'use strict';

const { sanitizeSvg } = require('./document-rendering/image-renderer');

function auditReportIr(data) {
    if (!data || !['completed', 'not_scanned'].includes(data.status) || !Array.isArray(data.issues || [])
        || (data.issues || []).length > 2000) throw new Error('审查结果结构或问题数量不符合限制。');
    const rows = (data.issues || []).map(item => [String(item.line || ''), String(item.column || ''), String(item.target || ''), String(item.risk || ''), String(item.description || '')]);
    return { ir_version: '1', doc_type: 'report', meta: { title: 'Python 源码规则审查报告' }, blocks: [
        { type: 'paragraph', runs: [{ text: data.status === 'not_scanned' ? `未完成扫描：${data.reason || ''}` : '仅覆盖所列静态规则；未命中不构成安全或合规证明。' }] },
        { type: 'table', header: ['行', '列', '调用', '风险', '说明'], rows: rows.length ? rows : [['', '', '', '', data.status === 'not_scanned' ? '未完成扫描，不能判断。' : '本次规则未检出问题。']] },
        // 原始结构化凭据进入 IR 的 CAS，保持完整可回放，按段控制渲染上限。
        ...JSON.stringify(data, null, 2).match(/[\s\S]{1,12000}/g).map(text => ({ type: 'paragraph', runs: [{ text }] }))
    ] };
}

async function materializeToolArtifact(output, user, context = {}) {
    const envelope = output?.structuredContent?.pivotArtifact;
    if (!envelope || output.isError) return output;
    if (!context.stepId && !context.toolCallId) throw new Error('工具产物缺少真实调用标识。');
    if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024) throw new Error('工具产物超过大小上限。');
    const { executeArtifactTool } = require('./agent-tools-artifacts');
    let ir, format, assetId;
    if (envelope.kind === 'audit') {
        ir = auditReportIr(envelope.data);
        format = 'html';
    } else if (envelope.kind === 'diagram') {
        const svg = sanitizeSvg(String(envelope.svg || ''));
        const { assertTenantContext } = require('./agent-tenant-context');
        const tenant = await assertTenantContext(user);
        const { putBuffer, buildCasRef } = require('./agent-artifact-cas');
        const object = await putBuffer({ buffer: Buffer.from(svg), mimeType: 'image/svg+xml', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'tool_diagram' });
        assetId = object.objectId;
        ir = { ir_version: '1', doc_type: 'report', meta: { title: '结构图' }, blocks: [{ type: 'image', asset_ref: buildCasRef(object.objectId), alt: '离线结构图' }] };
        format = 'svg';
    } else throw new Error('工具产物类型未登记。');
    const delivery = await executeArtifactTool('artifact.render', { ir, format }, user, context);
    if (assetId && !delivery.reused) await require('./agent-artifact-cas').incrementRefCount(assetId, 1);
    const { svg: _svg, ...summary } = envelope;
    return { ...output, structuredContent: { ...output.structuredContent, pivotArtifact: summary }, ...delivery };
}

module.exports = { auditReportIr, materializeToolArtifact };
