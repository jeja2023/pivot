/* 草稿修订和发布运行上下文复用既有工作流访问控制。 */
const repository = require('../repositories/workflow-editor-drafts');
const { getAgentWorkflowForUser, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { resolveAgentWorkflowDependencyBindings } = require('./agent-workflow-dependencies');

function invalid(message, status = 400, code = 'WORKFLOW_EDITOR_INVALID') {
    return Object.assign(new Error(message), { status, code });
}
function key(value) {
    const result = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(result)) throw invalid('草稿标识无效。');
    return result;
}
async function saveDraft(user, draftKey, body = {}) {
    key(draftKey);
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) throw invalid('保存草稿需要有效的修订号。');
    const existing = await repository.get(user.id, draftKey);
    const workflowId = body.workflowId ? Number(body.workflowId) : existing?.workflow_id ? Number(existing.workflow_id) : null;
    if (body.workflowId && (!Number.isSafeInteger(workflowId) || workflowId <= 0)) throw invalid('工作流标识无效。');
    if (workflowId) {
        const workflow = await getAgentWorkflowForUser(workflowId, user);
        if (!workflow?.can_edit) throw invalid('工作流不存在或无权编辑草稿。', 403);
    }
    if (typeof body.specText !== 'string' || Buffer.byteLength(body.specText) > 2 * 1024 * 1024) throw invalid('草稿内容必须是文本且不能超过 2 MB。');
    return repository.save(user.id, draftKey, {
        workflowId, name: String(body.name || '未命名工作流').trim().slice(0, 100),
        description: String(body.description || '').slice(0, 300), specText: body.specText,
        baseVersion: Math.max(0, Number.parseInt(body.baseVersion, 10) || 0), expectedRevision: body.expectedRevision
    });
}
async function getDraft(user, draftKey) {
    const draft = await repository.get(user.id, key(draftKey));
    if (draft?.workflow_id && !(await getAgentWorkflowForUser(draft.workflow_id, user))?.can_edit) throw invalid('原工作流已不可编辑，不能读取关联草稿。', 403);
    return draft;
}
async function runContext(user, workflowId) {
    const resolved = await resolveAgentWorkflowVersion(workflowId, user, 'published');
    if (!resolved) throw invalid('工作流不存在、无权访问或尚未发布。', 404);
    const bound = await resolveAgentWorkflowDependencyBindings(resolved, user, { enforce: false });
    const { sanitizeSharedDagSpec } = require('./agent-workflows');
    return {
        workflow: resolved.workflow, version: resolved.version, versionId: resolved.version_id,
        dagSpec: resolved.workflow.is_owner ? bound.dagSpec : sanitizeSharedDagSpec(bound.dagSpec),
        binding: bound.dependency_binding
    };
}
async function preference(user, workflowId, body) {
    if (!Number.isSafeInteger(Number(workflowId)) || Number(workflowId) <= 0) throw invalid('工作流标识无效。');
    for (const field of ['favorite', 'used']) if (body[field] !== undefined && typeof body[field] !== 'boolean') throw invalid('收藏与最近使用状态必须是布尔值。');
    if (!(await getAgentWorkflowForUser(workflowId, user))) throw invalid('工作流不存在或无权访问。', 404);
    return repository.setPreference(user.id, workflowId, body);
}
module.exports = { saveDraft, getDraft, runContext, preference, key };
