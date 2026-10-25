'use strict';

function normalizeMindmap(tree, options = {}) {
    const allowEmpty = options.allowEmpty === true;
    let count = 0;
    const ids = new Set();
    function normalize(node, depth) {
        if (!node || typeof node !== 'object' || depth > 12 || ++count > 5000 || typeof node.text !== 'string' || node.text.length > 120
            || (!allowEmpty && !node.text.trim()) || !/^[\w-]{1,64}$/.test(node.id || '') || ids.has(node.id)) throw Object.assign(new Error('脑图节点、层级或标识无效（最多 5000 个节点、12 层）。'), { status: 422 });
        ids.add(node.id);
        if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('脑图子节点必须是数组。');
        const text = node.text.trim() || (allowEmpty ? '新分支' : '');
        return { id: node.id, text, children: (node.children || []).map(child => normalize(child, depth + 1)) };
    }
    return normalize(tree, 0);
}

const THEME_PALETTES = {
    indigo: { root: '#4338ca', rootStroke: '#3730a3', branches: ['#4f46e5', '#0284c7', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#2563eb'] },
    forest: { root: '#065f46', rootStroke: '#047857', branches: ['#059669', '#0d9488', '#10b981', '#0284c7', '#0891b2', '#6366f1', '#d97706', '#475569'] },
    ocean: { root: '#0369a1', rootStroke: '#0284c7', branches: ['#0284c7', '#0ea5e9', '#06b6d4', '#3b82f6', '#6366f1', '#0d9488', '#10b981', '#4f46e5'] },
    sunset: { root: '#c2410c', rootStroke: '#ea580c', branches: ['#d97706', '#ea580c', '#e11d48', '#b45309', '#ca8a04', '#7c3aed', '#059669', '#2563eb'] }
};

function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const char of String(text || '')) {
        if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char)) {
            w += fontSize * 1.05;
        } else {
            w += fontSize * 0.62;
        }
    }
    return Math.round(w);
}

function mindmapSvg(input, themeName = 'indigo') {
    const tree = normalizeMindmap(input, { allowEmpty: true });
    const theme = THEME_PALETTES[themeName] || THEME_PALETTES.indigo;
    const branchColors = theme.branches;
    const nodes = [];
    const lines = [];
    const escape = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

    const depthConfig = [
        { h: 52, fontSize: 15, fontWeight: '700', rx: 12 },
        { h: 46, fontSize: 13.5, fontWeight: '600', rx: 9 },
        { h: 40, fontSize: 12.5, fontWeight: '500', rx: 7 }
    ];

    function getConfig(depth) {
        if (depth === 0) return depthConfig[0];
        if (depth === 1) return depthConfig[1];
        return depthConfig[2];
    }

    // 1. Measure and auto-fit node width and height based on text content
    const maxColWidth = {};
    function computeDimensions(node, depth) {
        const cfg = getConfig(depth);
        const textStr = node.text || '';
        const wrapped = Array.from(textStr).join('').match(/[\s\S]{1,16}/gu) || [textStr];
        const maxLineW = Math.max(...wrapped.map(l => estimateTextWidth(l, cfg.fontSize)), 20);
        const padding = depth === 0 ? 44 : depth === 1 ? 40 : 32;
        const minW = depth === 0 ? 104 : depth === 1 ? 88 : 76;
        const maxW = depth === 0 ? 320 : depth === 1 ? 280 : 250;
        
        node.w = Math.max(minW, Math.min(maxW, maxLineW + padding));
        node.h = cfg.h + (wrapped.length > 1 ? (wrapped.length - 1) * 16 : 0);
        node.wrapped = wrapped;
        maxColWidth[depth] = Math.max(maxColWidth[depth] || 0, node.w);

        (node.children || []).forEach(child => computeDimensions(child, depth + 1));
    }
    computeDimensions(tree, 0);

    // Compute column X coordinates based on adaptive widths
    const colX = { 0: 32 };
    for (let d = 1; d <= 12; d++) {
        if (maxColWidth[d - 1]) {
            const gap = d === 1 ? 54 : 44;
            colX[d] = colX[d - 1] + maxColWidth[d - 1] + gap;
        }
    }

    // 2. Vertical layout
    let leafY = 28;
    function layoutNode(node, depth, branchIndex) {
        const children = node.children || [];
        const isLeaf = children.length === 0;

        node.depth = depth;
        node.branchColor = depth === 0 ? theme.root : branchColors[branchIndex % branchColors.length];
        node.x = colX[depth] || (32 + depth * 140);

        if (isLeaf) {
            node.y = leafY;
            leafY += node.h + 20;
            node.yCenter = node.y + node.h / 2;
        } else {
            children.forEach((child, idx) => {
                layoutNode(child, depth + 1, depth === 0 ? idx : branchIndex);
            });
            const firstCenter = children[0].yCenter;
            const lastCenter = children[children.length - 1].yCenter;
            node.yCenter = (firstCenter + lastCenter) / 2;
            node.y = Math.round(node.yCenter - node.h / 2);
            if (node.y < 28) {
                const shift = 28 - node.y;
                node.y += shift;
                node.yCenter += shift;
            }
        }
    }

    layoutNode(tree, 0, 0);

    let maxX = 0;
    let maxY = 0;

    function renderNode(node, parent) {
        const cfg = getConfig(node.depth);
        const x = node.x;
        const y = node.y;
        const w = node.w;
        const h = node.h;
        const color = node.branchColor;

        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;

        if (parent) {
            const pX = parent.x + parent.w;
            const pY = parent.yCenter;
            const cX = node.x;
            const cY = node.yCenter;
            const cpx1 = pX + Math.min(48, Math.max(20, (cX - pX) / 2));
            const cpx2 = cX - Math.min(48, Math.max(20, (cX - pX) / 2));
            lines.push(`<path d="M ${pX} ${pY} C ${cpx1} ${pY}, ${cpx2} ${cY}, ${cX} ${cY}" fill="none" stroke="${color}" stroke-width="${node.depth === 1 ? 2.4 : 1.7}" stroke-linecap="round"/>`);
        }

        let rectFill = '#ffffff';
        let rectStroke = color;
        let strokeWidth = 1.5;
        let textColor = '#0f172a';
        let indicatorPill = '';
        const textOffsetX = node.depth === 1 ? 20 : 14;

        if (node.depth === 0) {
            rectFill = theme.root;
            rectStroke = theme.rootStroke;
            strokeWidth = 2;
            textColor = '#ffffff';
        } else if (node.depth === 1) {
            rectFill = '#ffffff';
            rectStroke = color;
            strokeWidth = 2;
            textColor = '#0f172a';
            indicatorPill = `<rect x="${x + 6}" y="${y + 10}" width="4" height="${h - 20}" rx="2" fill="${color}"/>`;
        } else {
            rectFill = '#ffffff';
            rectStroke = '#cbd5e1';
            strokeWidth = 1.4;
            textColor = '#334155';
        }

        const wrapped = node.wrapped || [node.text];
        const isRoot = node.depth === 0;
        const textX = isRoot ? (x + w / 2) : (x + textOffsetX);
        const textAnchorAttr = isRoot ? ' text-anchor="middle"' : '';
        const fontStack = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
        const vOffset = 1.8;
        let textElements = '';
        if (wrapped.length === 1) {
            textElements = `<text x="${textX}" y="${y + h / 2 + vOffset}"${textAnchorAttr} dominant-baseline="central" font-family="${fontStack}" font-size="${cfg.fontSize}" font-weight="${cfg.fontWeight}" fill="${textColor}">${escape(node.text)}</text>`;
        } else {
            const startY = y + h / 2 - ((wrapped.length - 1) * 8) + vOffset;
            textElements = wrapped.map((line, i) =>
                `<text x="${textX}" y="${startY + i * 16}"${textAnchorAttr} dominant-baseline="central" font-family="${fontStack}" font-size="${cfg.fontSize}" font-weight="${cfg.fontWeight}" fill="${textColor}">${escape(line)}</text>`
            ).join('');
        }

        nodes.push(`
            <g class="mindmap-node depth-${node.depth}" data-node-id="${escape(node.id)}">
                <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${cfg.rx}" fill="${rectFill}" stroke="${rectStroke}" stroke-width="${strokeWidth}"/>
                ${indicatorPill}
                ${textElements}
            </g>
        `);

        (node.children || []).forEach(child => renderNode(child, node));
    }

    renderNode(tree, null);

    const totalWidth = Math.max(760, maxX + 48);
    const totalHeight = Math.max(280, Math.max(maxY + 44, leafY + 24));

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" style="background: transparent;">
        <g class="mindmap-canvas">
            <g class="mindmap-connections">${lines.join('')}</g>
            <g class="mindmap-nodes">${nodes.join('')}</g>
        </g>
    </svg>`;
}

async function saveMindmap(user, input, context = {}) {
    const tree = normalizeMindmap(input.tree);
    const documents = require('./mindmaps/documents');
    if (input.artifactId) await documents.get(user, input.artifactId);
    const requestKey = `agent:${require('crypto').createHash('sha256').update(`${context.run?.id || user.id}:${context.stepId || context.toolCallId || require('crypto').randomUUID()}`).digest('hex')}`;
    const artifact = await documents.save(user, { ...input, tree, requestKey: input.requestKey || requestKey }, { legacy: true, runId: context.run?.id });
    if (require('../../client/common/mindmap-document').count(artifact.document) > 120) {
        const job = await require('./mindmaps/exports').create(user, artifact.id, { versionId: artifact.versionId, format: 'svg' });
        return { artifactId: artifact.id, mindmapArtifactId: artifact.id, versionId: artifact.versionId, exportJobId: job.id, exportStatus: job.status, text: '大图正文已保存，完整矢量图正在后台生成。可在思维导图应用中继续编辑和导出。' };
    }
    const { materializeToolArtifact } = require('./tool-result-artifacts');
    try {
        const rendition = await materializeToolArtifact({ structuredContent: { pivotArtifact: { kind: 'diagram', svg: mindmapSvg(tree) } } }, user, { ...context, targetArtifactId: artifact.id });
        return { ...rendition, mindmapArtifactId: Number(artifact.id), versionId: artifact.versionId, tree, text: '脑图已保存，可在思维导图应用中继续编辑。' };
    } catch (_) {
        return { artifactId: artifact.id, mindmapArtifactId: artifact.id, versionId: artifact.versionId, tree, exportStatus: 'failed', text: '导图正文已保存，图形生成失败。请在思维导图应用中重新导出。' };
    }
}

module.exports = { normalizeMindmap, mindmapSvg, saveMindmap };
