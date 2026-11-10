'use strict';

async function assertArtifactSources(artifact, user) {
    if (String(artifact?.type || '').startsWith('presentation')) return require('./presentations/presentation-analysis-sources').assertAnalysisArtifact(artifact, user);
    if (artifact?.type === 'policy_review_report') return require('./policy-review/sources').assertArtifact(artifact, user);
}

async function protectVersion(artifact, content, user) {
    if (artifact.type === 'policy_review_report') throw Object.assign(new Error('请在材料审查中修订报告并重新导出，不能直接改写报告来源绑定。'), { status: 409, code: 'POLICY_REVIEW_EDIT_REQUIRED' });
    if (String(artifact.type || '').startsWith('presentation') && String(artifact.content || '').includes('analysisBinding')) {
        const sources = require('./presentations/presentation-analysis-sources');
        content = JSON.stringify(sources.preserveAnalysisSources(JSON.parse(artifact.content), JSON.parse(content)));
        await sources.assertAnalysisArtifact({ ...artifact, content }, user);
    }
    return content;
}

function assertRenditionSources(artifact, rendition) {
    if (artifact.type !== 'policy_review_report') return;
    const binding = JSON.parse(artifact.content);
    const { computeIrDigest, validateDocumentIr } = require('./document-ir');
    const checked = validateDocumentIr(binding.ir);
    const expected = checked.valid ? computeIrDigest(checked.ir) : '';
    if (rendition.format !== 'docx' || rendition.ir_digest !== expected) throw Object.assign(new Error('报告文件与已保存版本不一致，请在材料审查中重新导出。'), { status: 409, code: 'POLICY_REVIEW_RENDITION_MISMATCH' });
}

module.exports = { assertArtifactSources, protectVersion, assertRenditionSources };
