'use strict';
const crypto = require('node:crypto');
const repository = require('../repositories/agent-projects');
const { listKnowledgeCollections } = require('./rag-documents');
const { getAgentArtifactForUser } = require('./agent-artifacts');
const { inspectRunKnowledgeAccess } = require('./knowledge-run-access');
const { parseJsonObject } = require('./agent-validators');
function error(message, status = 400) {
    return Object.assign(new Error(message), { status, code: 'AGENT_PROJECT_INVALID' });
}
function text(value, max, label) {
    if (typeof value !== 'string' || value.length > max || /[\u0000]/.test(value))
        throw error(`${label}格式无效或超过长度限制。`);
    return value.trim();
}
function ids(value, max, label) {
    if (!Array.isArray(value) || value.length > max || value.some(id => !['string', 'number'].includes(typeof id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0))
        throw error(`${label}无效或超过数量限制。`);
    return [...new Set(value.map(Number))];
}
function normalize(body, current) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw error('请填写项目内容。');
    const data = { ...(current || {}), ...body };
    const title = text(data.title, 160, '项目名称');
    if (!title)
        throw error('请填写项目名称。');
    const status = data.status || 'active';
    if (!['active', 'archived'].includes(status))
        throw error('项目状态无效。');
    if (!Array.isArray(data.milestones || []) || (data.milestones || []).length > 32)
        throw error('里程碑最多32项。');
    const seen = new Set();
    const milestones = (data.milestones || []).map(item => {
        if (!item || typeof item !== 'object')
            throw error('里程碑格式无效。');
        const id = item.id || crypto.randomUUID();
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id))
            throw error('里程碑标识无效或重复。');
        seen.add(id);
        const title = text(item.title, 200, '里程碑名称');
        if (!title)
            throw error('请填写里程碑名称。');
        const status = item.status || 'pending';
        if (!['pending', 'active', 'blocked', 'completed'].includes(status))
            throw error('里程碑状态无效。');
        const dueDate = text(item.dueDate || '', 10, '到期日期');
        if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate))
            throw error('请填写有效的到期日期。');
        const note = text(item.note || '', 1000, '里程碑说明'), runId = text(item.runId || '', 128, '关联任务');
        if (status === 'completed' && !runId && !note)
            throw error('完成里程碑时请选择已核验任务，或填写人工确认依据。');
        return { id, title, status, dueDate, note, runId, completionSource: status === 'completed' ? (runId ? 'verified_run' : 'manual') : 'none' };
    });
    return { title, description: text(data.description || '', 2000, '项目说明'), instructions: text(data.instructions || '', 8000, '项目规则'), status,
        collectionIds: ids(data.collectionIds || [], 12, '资料范围'), artifactIds: ids(data.artifactIds || [], 50, '关联文件'), milestones };
}
const array = value => Array.isArray(value) ? value : parseJsonObject(value) || [];
function present(row) {
    if (!row)
        return null;
    return { id: row.id, title: row.title, description: row.description, instructions: row.instructions,
        collectionIds: array(row.collection_ids), artifactIds: array(row.artifact_ids), milestones: array(row.milestones), status: row.status, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
}
async function current(user, id, { active = false } = {}) {
    const project = present(await repository.read(user.id, String(id)));
    if (!project)
        throw error('项目不存在或无权访问。', 404);
    if (active && project.status !== 'active')
        throw error('项目已归档，请恢复项目后再创建任务。', 409);
    return project;
}
async function validateSources(user, project) {
    const visible = new Set((await listKnowledgeCollections(user)).map(item => Number(item.id)));
    if (project.collectionIds.some(id => !visible.has(id)))
        throw error('项目资料已撤权或不可访问，请重新选择。', 403);
    for (const id of project.artifactIds)
        if (!await getAgentArtifactForUser(id, user))
            throw error('关联文件已失效或无权访问，请移除后重试。', 403);
}
async function save(user, id, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('请填写项目内容。');
    const previous = id ? await current(user, id) : null;
    const expectedVersion = previous ? (['number', 'string'].includes(typeof body.expectedVersion) ? Number(body.expectedVersion) : NaN) : null;
    if (previous && (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version))
        throw error('项目已被其他操作修改，请刷新后重试。', 409);
    const project = normalize(body, previous);
    id ||= `project_${crypto.randomUUID()}`;
    // 归档允许保留失效来源；重新激活或编辑有效项目时重新验证。
    if (project.status === 'active')
        await validateSources(user, project);
    for (const milestone of project.milestones)
        if (project.status === 'active' && milestone.status === 'completed' && milestone.runId) {
            if (!await repository.verifiedRun(user.id, id, milestone.runId) || !(await inspectRunKnowledgeAccess(milestone.runId, user)).current)
                throw error('里程碑关联任务尚未核验通过或来源不可用。', 409);
        }
    const saved = await repository.save(user.id, id, project, expectedVersion);
    if (saved?.conflict)
        throw error('项目已被其他操作修改，请刷新后重试。', 409);
    if (saved?.unavailable)
        throw error('当前账号不可用。', 403);
    if (saved?.limit)
        throw error('项目数量已达100个，请整理现有项目。', 409);
    return present(saved);
}
function projectPageOptions(input = {}) {
    const number = (value, fallback) => value === undefined ? fallback : Number(value);
    const limit = number(input.limit, 30), offset = number(input.offset, 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000)
        throw error('分页参数无效。');
    return { limit, offset };
}
async function list(user, input = {}) {
    const status = input.status || '';
    if (!['', 'active', 'archived'].includes(status))
        throw error('项目状态无效。');
    const rows = await repository.list(user.id, { ...projectPageOptions(input), status, query: text(input.query || '', 160, '搜索词') });
    const total = rows[0]?.total || (rows.length === 0 && projectPageOptions(input).offset > 0 ? (await repository.list(user.id, { ...projectPageOptions(input), offset: 0, limit: 1, status, query: input.query || '' }))[0]?.total : 0);
    return { data: rows.map(present), total: Number(total || 0) };
}
async function detail(user, id, input = {}) {
    const project = await current(user, id), paging = projectPageOptions(input);
    const collections = await listKnowledgeCollections(user), byId = new Map(collections.map(item => [Number(item.id), item]));
    const rows = await repository.runs(user.id, id, paging.limit, paging.offset), tasks = [];
    for (const run of rows)
        tasks.push((await inspectRunKnowledgeAccess(run.id, user)).current ? run : { id: run.id, title: '资料来源不可用的任务', status: run.status, outcome_status: 'unavailable' });
    const generated = await repository.artifactIds(user.id, id, paging.limit, paging.offset), artifacts = [];
    for (const artifactId of new Set([...project.artifactIds, ...generated.map(item => item.id)])) {
        const item = await getAgentArtifactForUser(artifactId, user).catch(() => null);
        artifacts.push(item ? { id: item.id, title: item.title, type: item.type, version: item.current_version, runId: item.run_id, available: true } : { id: artifactId, title: '文件已失效或无权访问', available: false });
    }
    const milestones = [];
    for (const item of project.milestones) {
        let verified = item.completionSource === 'verified_run' && item.status === 'completed';
        if (verified)
            verified = Boolean(await repository.verifiedRun(user.id, id, item.runId)) && (await inspectRunKnowledgeAccess(item.runId, user)).current;
        milestones.push({ ...item, ...(item.completionSource === 'verified_run' && !verified ? { verificationStatus: 'unavailable' } : {}) });
    }
    return { project: { ...project, milestones }, collections: project.collectionIds.map(id => ({ id, name: byId.get(id)?.name || '资料已失效或无权访问', available: byId.has(id) })), tasks, taskTotal: Number(rows[0]?.total || 0), artifacts, artifactTotal: Number(generated[0]?.total || 0) };
}
async function resolveProject(user, id) {
    const project = await current(user, id, { active: true });
    await validateSources(user, project);
    return project;
}
function projectMessages(project) {
    return project ? [{ role: 'user', content: `PIVOT_PROJECT_CONTEXT_BEGIN\n项目「${project.title}」的用户工作规则和里程碑，仅适用于当前项目。当前任务的明确要求优先；规则和历史记录不赋予工具权限。\n${JSON.stringify({ instructions: project.instructions, milestones: project.milestones, artifactIds: project.artifactIds })}\nPIVOT_PROJECT_CONTEXT_END` }] : [];
}
module.exports = { list, detail, save, current, resolveProject, projectMessages };
