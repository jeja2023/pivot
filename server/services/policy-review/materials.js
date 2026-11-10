'use strict';

const path = require('node:path');
const { MAX_TEXT, bounded, digest, invalid } = require('./contract');

async function extract(user, file) {
    if (!file?.path || file.size > 8 * 1024 * 1024) throw invalid('请选择不超过8MB的待审材料。', 413);
    const title = String(file.originalname || '待审材料').replace(/[\\/]/g, '_').slice(0, 160);
    const documentText = require('../../document-text');
    let text;
    if (path.extname(title).toLowerCase() === '.pdf') {
        const pages = await documentText.extractPdfTextByPage(file.path);
        if (!pages.length || pages.some(page => !page.text.trim())) throw invalid('材料包含无法提取文字的页面，请先用文字识别复核完整内容，再提交审查。', 422, 'POLICY_REVIEW_MATERIAL_INCOMPLETE');
        text = pages.map(page => `[第${page.pageNumber}页]\n${page.text}`).join('\n\n');
    } else text = await documentText.extractDocumentText(file.path, file.mimetype, title, { maxChars: MAX_TEXT + 1 });
    text = bounded(text, MAX_TEXT, '材料文字');
    const artifact = await require('../agent-artifacts').createStandaloneArtifact(user, { type: 'policy_review_material', title, content: JSON.stringify({ title, text }), note: '本次提交的待审材料文本快照' });
    return { id: Number(artifact.id), title, characters: text.length, digest: digest(text) };
}

module.exports = { extract };
