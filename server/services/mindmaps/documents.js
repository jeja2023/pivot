'use strict';
const crypto = require('node:crypto');
const schema = require('../../../client/common/mindmap-document');
const repository = require('../../repositories/mindmaps');
function id(value) { if (!/^[1-9]\d{0,17}$/.test(String(value || ''))) throw schema.error('文档或版本标识无效。', 'MINDMAP_ID_INVALID', 400); return String(value); }
function pagination(input = {}) {
    const page = Number(input.page || 1); const limit = Number(input.limit || 20);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw schema.error('分页参数无效。', 'MINDMAP_PAGE_INVALID', 400);
    return { page, limit };
}
function publicDocument(row, includeContent = true) {
    const role = row.access_role || 'owner';
    return { id: String(row.id), title: row.title, versionId: String(row.current_version_id), version: Number(row.current_version), source: row.run_id ? 'agent' : 'manual', updatedAt: row.updated_at, createdAt: row.created_at, role, canEdit: role !== 'viewer', canExport: role === 'owner', deleted: row.status === 'deleted', favorite: row.favorite === true, tags: row.tags || [], collaboration: row.collaboration_enabled === true, ...(includeContent ? { document: schema.normalize(row.content), ...(row.collaboration_enabled && row.y_state ? { collaborationState: Buffer.from(row.y_state).toString('base64'), collaborationEpoch: row.collaboration_epoch } : {}) } : {}) };
}
async function list(user, options = {}) {
    const paging = pagination(options);
    const search = String(options.search || '').trim();
    if (search.length > 120) throw schema.error('搜索内容不能超过 120 字符。');
    const scope = String(options.scope || 'all'); const tag = String(options.tag || '').trim();
    if (!['all','owned','shared','trash'].includes(scope) || tag.length > 32) throw schema.error('文档筛选条件无效。');
    const result = await repository.list(user.id, { ...paging, search, scope, tag, favorite: options.favorite === 'true' });
    return { ...result, rows: result.rows.map(row => publicDocument(row, false)) };
}
async function get(user, artifactId) { return publicDocument(await repository.get(user.id, id(artifactId))); }
async function save(user, input = {}, options = {}) {
    if (!user?.id) throw schema.error('请登录后保存导图。', 'MINDMAP_AUTH_REQUIRED', 401);
    const artifactId = input.artifactId ? id(input.artifactId) : null;
    const expectedVersionId = artifactId ? id(input.expectedVersionId) : null;
    const requestKey = String(input.requestKey || '');
    if (!/^[\w:.-]{8,160}$/.test(requestKey)) throw schema.error('保存请求缺少有效的幂等标识，请刷新后重试。', 'MINDMAP_REQUEST_REQUIRED', 400);
    const document = schema.normalize(input.document || input.tree || input.content);
    const note = String(input.note || (artifactId ? '导图编辑保存' : '新建思维导图')).trim();
    const collaborationUpdate = input.collaborationUpdate;
    if (collaborationUpdate !== undefined && (typeof collaborationUpdate !== 'string' || collaborationUpdate.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(collaborationUpdate) || typeof input.collaborationEpoch !== 'string')) throw schema.error('协作更新格式无效或过大，请另存副本。');
    if (note.length > 500) throw schema.error('版本说明不能超过 500 字符。');
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ artifactId, expectedVersionId, document, note, runId: options.runId || null, legacy: options.legacy === true, collaborationUpdate, collaborationEpoch: input.collaborationEpoch })).digest('hex');
    const row = await repository.save({ userId: user.id, id: artifactId, expectedVersionId, requestKey, inputHash, document, note, runId: options.runId || null, merge: options.legacy ? schema.mergeLegacy : null, collaborationUpdate, collaborationEpoch: input.collaborationEpoch });
    require('./events').changed(row.id);
    return { ...publicDocument(row), unchanged: row.unchanged === true, replay: row.replay === true };
}
async function versions(user, artifactId, options = {}) {
    const result = await repository.versions(user.id, id(artifactId), ...Object.values(pagination(options)));
    return { rows: result.rows.map(row => ({ id: String(row.id), version: Number(row.version), note: row.note, createdAt: row.created_at })), total: result.total, page: result.page, limit: result.limit };
}
async function snapshot(user, artifactId, versionId) {
    const row = await repository.version(user.id, id(artifactId), id(versionId));
    return { id: String(row.id), version: Number(row.version), document: schema.normalize(row.content), createdAt: row.created_at };
}
async function restore(user, artifactId, versionId, input = {}) {
    if ((await get(user, artifactId)).role !== 'owner') throw schema.error('只有所有者可以恢复历史版本。', 'MINDMAP_OWNER_REQUIRED', 403);
    const target = await snapshot(user, artifactId, versionId);
    return save(user, { ...input, artifactId, document: target.document, note: `恢复到版本 ${target.version}` });
}
async function remove(user, artifactId, expectedVersionId) { const result = await repository.remove(user.id, id(artifactId), id(expectedVersionId)); require('./events').changed(artifactId); return result; }
async function importDocument(input = {}) { return require('./formats').importDocument(input); }
function template(name = 'blank', title = '中心主题') {
    const topics = { blank: [], plan: ['目标', '任务拆解', '时间安排', '风险与对策', '验收标准'], analysis: ['背景', '现状', '证据', '原因分析', '结论与建议'], meeting: ['议题', '讨论要点', '决定事项', '责任分工', '下一步'] };
    if (!Object.prototype.hasOwnProperty.call(topics, name)) throw schema.error('请选择有效模板。');
    return schema.normalize({ id: 'root', text: title, children: topics[name].map((text, index) => ({ id: `node-${index + 1}`, text, children: [] })) });
}
module.exports = { id, pagination, list, get, save, versions, snapshot, restore, remove, importDocument, template };
