'use strict';

const repository = require('../../../repositories/analysis-model-catalog');
const { transaction } = require('../../../db/client');
const authorization = require('../../../repositories/analysis-authorization');
const { canAccessSharedResource, normalizeShareScope } = require('../../unit-visibility');
const { protect } = require('./delivery');

function summary(row, user, sources) {
    const owner = Number(row.user_id) === Number(user.id);
    const ownerName = row.owner_name || (owner ? (user.username || '当前用户') : `用户 ${row.user_id}`);
    const model = { id: row.id, userId: Number(row.user_id), ownerName, name: row.name, description: row.description || '', modelKind: row.model_kind,
        scope: normalizeShareScope(row.scope), allowedUnits: row.allowed_units || '', allowedUserIds: row.allowed_user_ids || '',
        version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at, isOwner: owner };
    if (row.model_kind !== 'production') return model;
    Object.assign(model, { publishedVersion: row.published_version === null ? null : Number(row.published_version), lifecycle: row.archived_at ? 'archived' : row.published_version ? 'published' : 'draft',
        archivedAt: row.archived_at, businessOwner: row.business_owner, maintenanceContact: row.maintenance_contact, availability: 'available' });
    if (Object.hasOwn(row, 'computed_availability')) {
        model.availability = row.computed_availability;
        if (model.availability === 'source_unavailable') model.message = '模型来源不可用，请联系模型维护者检查来源和字段权限。';
        if (row.published_version) {
            model.dataBinding = row.manifest_id ? { manifestId: row.manifest_id, revision: Number(row.binding_revision), checkId: row.check_id, dataState: row.data_state, lastRefreshError: row.last_refresh_error } : null;
            model.dataTimes = (row.members_json || []).map(member => ({ nodeId: member.nodeId, ...member.watermark }));
        }
        return model;
    }
    const graph = row.graph_json;
    const required = new Map(graph.nodes.map(node => [node.id, new Set(node.grainKeys || [])]));
    for (const relation of graph.relations) for (const pair of relation.keyPairs || []) {
        required.get(relation.leftNodeId)?.add(pair.leftFieldKey); required.get(relation.rightNodeId)?.add(pair.rightFieldKey);
    }
    const available = graph.nodes.every(node => {
        const source = sources.get(node.datasetId);
        if (!source || source.status !== 'ready' || !canAccessSharedResource(source, user)) return false;
        const blocked = new Set(Number(source.user_id) === Number(user.id) ? [] : source.restricted_keys);
        return [...required.get(node.id)].every(key => source.column_keys.includes(key) && !blocked.has(key));
    });
    if (!available) {
        model.availability = 'source_unavailable'; model.message = '模型来源不可用，请联系模型维护者检查来源和字段权限。';
        return model;
    }
    if (row.published_version) {
        const members = row.members_json || [];
        const nodeSources = new Map(graph.nodes.map(node => [node.id, sources.get(node.datasetId)]));
        const changed = members.some(member => String(nodeSources.get(member.nodeId)?.source_version) !== member.sourceRevision);
        model.dataBinding = row.manifest_id ? { manifestId: row.manifest_id, revision: Number(row.binding_revision), checkId: row.check_id, dataState: row.data_state, lastRefreshError: row.last_refresh_error } : null;
        model.dataTimes = members.map(member => ({ nodeId: member.nodeId, ...member.watermark }));
        model.availability = row.data_state === 'source_unavailable' ? 'source_unavailable' : row.data_state === 'refresh_failed' ? 'refresh_failed' : row.data_state === 'pending' || changed ? 'pending' : 'available';
        if (row.data_state === 'source_unavailable') model.message = '来源完整性异常，已停止新分析；请联系维护者恢复或重新检查来源。';
    }
    return model;
}

async function list(user, { limit = 100 } = {}) {
    const { actor, rows } = await transaction(async trx => {
        const { user: actor } = await authorization.authorize(trx, { userId: user.id, definition: { nodes: [] }, required: new Map() });
        const rows = (await repository.list(actor, limit, trx)).filter(row => canAccessSharedResource(row, actor));
        return { actor, rows };
    });
    const ids = [...new Set(rows.flatMap(row => row.graph_json.nodes.map(node => node.datasetId)))];
    const sources = new Map((await repository.sources(ids)).map(row => [row.id, row]));
    // 所有摘要共享一个栅栏描述符，工具筛选后仍能继承当前权限复核，避免逐模型往返数据库。
    const descriptor = { userId: actor.id, modelIds: rows.map(row => row.id), definition: { nodes: [] }, required: new Map(), beforeSend: (trx, current) => repository.confirm(trx, current.user, rows) };
    return rows.map(row => protect(summary(row, actor, sources), descriptor));
}

async function page(user, input = {}) {
    const invalid = () => { throw require('./errors').biError('ANALYSIS_MODEL_INPUT_INVALID', '模型目录筛选或分页参数无效，请重新选择。'); };
    const options = { page: input.page === undefined ? 1 : Number(input.page), limit: input.limit === undefined ? 10 : Number(input.limit),
        search: input.search ?? '', ownership: input.ownership ?? 'all', lifecycle: input.lifecycle ?? 'all', availability: input.availability ?? 'all' };
    if (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 1000000 || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200
        || typeof options.search !== 'string' || options.search.length > 120 || /[\u0000-\u001f]/.test(options.search)
        || !['all', 'mine', 'shared'].includes(options.ownership) || !['all', 'draft', 'published', 'archived', 'exploration'].includes(options.lifecycle)
        || !['all', 'available', 'pending', 'source_unavailable', 'refresh_failed'].includes(options.availability)) invalid();
    options.search = options.search.trim();
    const { actor, result, authorizationHash } = await transaction(async trx => {
        const current = await authorization.authorize(trx, { userId: user.id, definition: { nodes: [] }, required: new Map() });
        return { actor: current.user, result: await repository.page(current.user, options, trx), authorizationHash: current.authorizationHash };
    });
    const rows = result.rows;
    const descriptor = { userId: actor.id, modelIds: rows.map(row => row.id), definition: { nodes: [] }, required: new Map(), beforeSend: (trx, current) => {
        if (current.authorizationHash !== authorizationHash) throw require('./errors').biError('ANALYSIS_MODEL_VERSION_CONFLICT', '当前身份或共享范围已变化，请重新加载模型目录。', 409);
        return repository.confirm(trx, current.user, rows);
    } };
    return protect({ models: rows.map(row => summary(row, actor, new Map())), total: result.total, page: result.page, limit: result.limit }, descriptor);
}

module.exports = { list, page };
