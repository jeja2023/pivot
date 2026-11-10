'use strict';

const { MAX_CLAUSES, MAX_TEXT, digest, invalid, bounded } = require('./contract');
const repository = require('../../repositories/policy-reviews');
const catalog = require('../regulations/catalog');

async function principal(user, { enabled = false } = {}) {
    const actor = await repository.actor(user?.id);
    if (!actor || actor.status !== 'active' || actor.deleted_at) throw invalid('当前账号不可用。', 403, 'POLICY_REVIEW_ACCESS_DENIED');
    if (enabled && !(await require('../app-availability').getAppAvailability()).some(app => app.id === 'regulations' && app.enabled)) throw invalid('法规查询应用已关闭，请联系系统 admin 开启。', 403, 'APP_DISABLED');
    return actor;
}

async function policies(ids, asOf) {
    const documents = [], clauses = [];
    for (const id of ids) {
        const document = await catalog.getRegulationDocumentById(id);
        if (!document) throw invalid('所选制度已删除、归档或不可访问，请重新选择。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
        const versions = await catalog.listRegulationVersions(id);
        const eligible = versions.filter(version => version.effect_status === 'effective' && version.review_status === 'approved'
            && version.effective_from && String(version.effective_from).slice(0, 10) <= asOf
            && (!version.effective_to || String(version.effective_to).slice(0, 10) >= asOf));
        if (eligible.length !== 1) throw invalid(eligible.length ? '业务日期存在多个已复核有效版本，请先在版本治理中消除冲突。' : '该制度在业务日期没有已复核的有效版本，请核对日期或完成版本治理。', 409, 'POLICY_REVIEW_VERSION_UNAVAILABLE');
        const version = eligible[0];
        const rows = await repository.clauses(id, version.id);
        if (!rows.length || rows.some(row => !String(row.content || '').trim())) throw invalid('制度条文不完整，请先修复导入结果。', 422, 'POLICY_REVIEW_SOURCE_INCOMPLETE');
        const selected = rows.map(row => ({ id: `clause_${row.id}`, documentId: Number(id), versionId: Number(version.id), articleId: Number(row.id),
            label: [row.heading_path, row.article_label, row.article_title].filter(Boolean).join(' / ') || `条目${row.id}`,
            text: String(row.content).replace(/\r\n?/g, '\n'), page: Number(row.page_number) || null }));
        const source = { id: Number(id), title: document.title, jurisdiction: document.jurisdiction || '', versionId: Number(version.id), versionLabel: version.version_label,
            effectiveFrom: version.effective_from, effectiveTo: version.effective_to, sourceUrl: document.official_source_url || '' };
        source.digest = digest({ ...source, clauses: selected });
        documents.push(source); clauses.push(...selected);
    }
    if (clauses.length > MAX_CLAUSES) throw invalid(`本次制度超过${MAX_CLAUSES}个条目，请分次选择制度。`, 413, 'POLICY_REVIEW_LIMIT');
    return { documents, clauses };
}

async function materialFromArtifact(user, id) {
    const artifact = await require('../agent-artifacts').getAgentArtifactForUser(id, user);
    if (!artifact || artifact.type !== 'policy_review_material') throw invalid('待审材料已撤回或无权访问，请重新提交。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    let material;
    try { material = JSON.parse(artifact.content); } catch (_) { throw invalid('材料记录损坏，请重新上传。', 422); }
    return { id: `upload_${id}`, artifactId: Number(id), title: bounded(material.title, 160, '材料名称'), text: bounded(material.text, MAX_TEXT, '待审材料'),
        digest: digest(material.text), kind: 'upload' };
}

async function prepare(user, input) {
    await principal(user, { enabled: true });
    const policy = await policies(input.documentIds, input.asOf);
    const materials = [...input.materials.map(item => ({ ...item, digest: digest(item.text), kind: 'text' })),
        ...await Promise.all(input.materialIds.map(id => materialFromArtifact(user, id)))];
    if (policy.clauses.reduce((sum, clause) => sum + clause.text.length, 0) + materials.reduce((sum, item) => sum + item.text.length, 0) > MAX_TEXT) throw invalid(`制度和材料合计超过${MAX_TEXT}字符，请分次提交，不会截断审查。`, 413, 'POLICY_REVIEW_LIMIT');
    return { ...policy, materials };
}

async function assertRequest(request, user, options = {}) {
    await principal(user, options);
    const current = await policies(request.documents.map(item => item.id), request.asOf);
    if (digest(current.documents) !== digest(request.documents)) throw invalid('制度版本、内容或效力已变化，请重新创建审查。', 409, 'POLICY_REVIEW_SOURCE_CHANGED');
    for (const material of request.materials) {
        if (material.artifactId && (await materialFromArtifact(user, material.artifactId)).digest !== material.digest) throw invalid('待审材料已修改，请重新创建审查。', 409, 'POLICY_REVIEW_SOURCE_CHANGED');
    }
    return current;
}

async function assertArtifact(artifact, user) {
    let binding;
    try { binding = JSON.parse(artifact.content); } catch (_) { throw invalid('审查报告来源绑定无效。', 403); }
    if (binding.kind !== 'policy_review_report' || typeof binding.taskId !== 'string') throw invalid('审查报告来源绑定无效。', 403);
    const row = await repository.read(user, binding.taskId);
    if (!row || row.result_json.withdrawn || row.input_request.sourceDigest !== binding.sourceDigest) throw invalid('审查报告来源不可用。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    if (!Number.isSafeInteger(binding.reportVersion) || !row.result_json.exports?.[binding.reportVersion]
        || String(row.result_json.exports[binding.reportVersion]) !== String(artifact.id)) throw invalid('报告产物不是已保存版本的交付记录。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    await assertRequest(row.input_request, user);
}

module.exports = { principal, prepare, assertRequest, assertArtifact };
