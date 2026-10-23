'use strict';

function normalizeMindmap(tree) {
    let count = 0;
    const ids = new Set();
    function normalize(node, depth) {
        if (!node || typeof node !== 'object' || depth > 6 || ++count > 120 || typeof node.text !== 'string' || node.text.length > 120
            || !node.text.trim() || !/^[\w-]{1,64}$/.test(node.id || '') || ids.has(node.id)) throw Object.assign(new Error('脑图节点、层级或标识无效（最多 120 个节点、6 层）。'), { status: 422 });
        ids.add(node.id);
        if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('脑图子节点必须是数组。');
        return { id: node.id, text: node.text.trim(), children: (node.children || []).map(child => normalize(child, depth + 1)) };
    }
    return normalize(tree, 0);
}

function mindmapSvg(input) {
    const tree = normalizeMindmap(input), nodes = [], lines = []; let row = 0;
    const escape = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    function layout(node, depth, parent) {
        const position = { x: depth * 250 + 10, y: row++ * 150 + 10 };
        if (parent) lines.push(`<path d="M${parent.x + 220},${parent.y + 20} H${position.x - 10} V${position.y + 20} H${position.x}" fill="none" stroke="#64748b"/>`);
        const wrapped = Array.from(node.text).join('').match(/[\s\S]{1,16}/gu) || [];
        nodes.push(`<g><rect x="${position.x}" y="${position.y}" width="220" height="140" rx="6" fill="#f8fafc" stroke="#64748b"/><text x="${position.x + 8}" y="${position.y + 20}" font-size="12">${wrapped.map((line, i) => `<tspan x="${position.x + 8}" dy="${i ? 16 : 0}">${escape(line)}</tspan>`).join('')}</text></g>`);
        node.children.forEach(child => layout(child, depth + 1, position));
    }
    layout(tree, 0, null);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1760" height="${Math.max(160, row * 150)}" viewBox="0 0 1760 ${Math.max(160, row * 150)}">${lines.join('')}${nodes.join('')}</svg>`;
}

async function saveMindmap(user, input, context = {}) {
    const tree = normalizeMindmap(input.tree);
    const { createStandaloneArtifact, createOrUpdateRunArtifact, getAgentArtifactForUser } = require('./agent-artifacts');
    let artifact;
    if (input.artifactId) {
        const existing = await getAgentArtifactForUser(input.artifactId, user);
        if (!existing || existing.type !== 'mindmap') throw Object.assign(new Error('脑图不存在或无权编辑。'), { status: 404 });
        artifact = await require('./agent-artifacts').createAgentArtifactVersion(existing.id, user, { content: JSON.stringify(tree), note: '脑图编辑保存' });
    } else if (context.run?.id) artifact = await createOrUpdateRunArtifact({ user, runId: context.run.id, type: 'mindmap', title: tree.text, content: JSON.stringify(tree) });
    else artifact = await createStandaloneArtifact(user, { type: 'mindmap', title: tree.text, content: JSON.stringify(tree) });
    const { materializeToolArtifact } = require('./tool-result-artifacts');
    const rendition = await materializeToolArtifact({ structuredContent: { pivotArtifact: { kind: 'diagram', svg: mindmapSvg(tree) } } }, user, { ...context, targetArtifactId: artifact.id });
    return { ...rendition, mindmapArtifactId: artifact.id, tree, text: '脑图已保存，可在产物中编辑节点并下载矢量图。' };
}

module.exports = { normalizeMindmap, mindmapSvg, saveMindmap };
