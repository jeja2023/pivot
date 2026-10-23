'use strict';
const { compareDocuments, comparisonIr } = require('./document-comparison');

function offlineOfficeDefinitions() {
    return [
        { name: 'document.compare', title: '精细文档比较与修订', description: '比较两个文本的字符、段落移动，生成 DOCX 修订稿。先用已授权来源读取文本，支持最多各 30000 字符。', capabilities: ['document.render'],
            input_schema: { type: 'object', properties: { before: { type: 'string', maxLength: 30000 }, after: { type: 'string', maxLength: 30000 } }, required: ['before', 'after'], additionalProperties: false } },
        { name: 'viz.mindmap', title: '创建可编辑思维导图', description: '从带稳定 id、text、children 的节点树创建可编辑脑图并导出 SVG，最多120节点。', capabilities: ['viz.render'],
            input_schema: { type: 'object', properties: { tree: { type: 'object' } }, required: ['tree'], additionalProperties: false } }
    ];
}

async function executeOfflineOffice(name, input, user, context) {
    if (name === 'viz.mindmap') return await require('./mindmap').saveMindmap(user, input, context);
    const comparison = compareDocuments(input.before, input.after);
    const result = await require('./agent-tools-artifacts').executeArtifactTool('artifact.render', { ir: comparisonIr(comparison), format: 'docx' }, user, context);
    return { ...result, comparison };
}
module.exports = { offlineOfficeDefinitions, executeOfflineOffice };
