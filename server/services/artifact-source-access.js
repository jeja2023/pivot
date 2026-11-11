'use strict';

async function assertGenericArtifactAccess(artifact, user, { shared = false } = {}) {
    if (!artifact || artifact.status === 'deleted') throw Object.assign(new Error('产物不存在或无权访问。'), { status: 404 });
    require('./policy-review/artifact-boundary').assertGenericAccess(artifact);
    const owner = !shared && String(artifact.user_id) === String(user?.id);
    if (!owner && (artifact.type === 'mindmap' || (!shared && artifact.status !== 'public'))) throw Object.assign(new Error('产物不存在或无权访问。'), { status: 404 });
    const actor = await require('../db/client').queryOne('SELECT id, username, role, unit, status FROM users WHERE id = ? AND deleted_at IS NULL', [artifact.user_id]);
    if (!actor || actor.status === 'disabled') throw Object.assign(new Error('产物所有者已不可用。'), { status: 404 });
    const access = await require('./knowledge-run-access').inspectRunKnowledgeAccess(artifact.run_id, actor);
    if (!access.current) throw Object.assign(new Error(access.message || '产物来源已不可访问，请重新生成。'), { status: 403, code: access.reasonCode || 'ARTIFACT_SOURCE_UNAVAILABLE' });
    await assertArtifactSources(artifact, actor);
    // 公开链接不能将受治理资料的读取权扩展到匿名用户或其他账号。
    const bound = String(artifact.type || '').startsWith('presentation') && String(artifact.content || '').includes('analysisBinding');
    if (!owner && (access.tracked || bound)) throw Object.assign(new Error('该产物包含受权限保护的来源，请通过原业务应用查看。'), { status: 403, code: 'ARTIFACT_PUBLIC_SOURCE_DENIED' });
    return artifact;
}

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

module.exports = { assertArtifactSources, protectVersion, assertRenditionSources, assertGenericArtifactAccess };
