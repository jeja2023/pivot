'use strict';

const models = require('../../../repositories/analysis-production-models');
const publications = require('../../../repositories/analysis-model-publications');
const consumers = require('../../../repositories/analysis-model-consumers');
const { transaction } = require('../../../db/client');
const { modelForUser, visibleDefinition } = require('./access');
const { authorize } = require('./jobs');
const { canonicalHash } = require('./canonical');
const { canAccessSharedResource } = require('../../unit-visibility');
const { biError } = require('./errors');
const { protect } = require('./delivery');
const { allRequired } = require('./manifests');

function definitionDiff(before, after) {
    const changes = [];
    for (const kind of ['nodes', 'relations', 'dimensions', 'metrics']) {
        const previous = new Map((before?.[kind] || []).map(item => [item.id, item]));
        const current = new Map((after?.[kind] || []).map(item => [item.id, item]));
        for (const id of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
            const left = previous.get(id), right = current.get(id);
            if (left && right && canonicalHash(left) === canonicalHash(right)) continue;
            const fields = left && right ? [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => canonicalHash(left[key] ?? null) !== canonicalHash(right[key] ?? null)).sort() : [];
            changes.push({ kind, id, name: right?.name || left?.name || id, change: !left ? 'added' : !right ? 'removed' : 'modified', fields });
        }
    }
    for (const key of ['grainDescription', 'timezone', 'coveragePolicy', 'watermarkPolicy', 'refreshCadence', 'maxStaleness', 'freshnessPolicy']) if (canonicalHash(before?.[key] ?? null) !== canonicalHash(after?.[key] ?? null)) changes.push({ kind: 'model', id: key, change: 'modified', fields: [key] });
    return changes;
}

async function modelDependencies(user, modelId) {
    await modelForUser(user, modelId);
    const found = await consumers.dependencies(modelId);
    const entry = { userId: user.id, modelId, definition: { nodes: [] }, required: new Map() };
    const finalAccess = require('../../../repositories/analysis-authorized-delivery');
    return protect({ views: found.views.filter(view => canAccessSharedResource(view, user)).map(view => protect({ id: view.id, name: view.name, publishedVersion: Number(view.published_version), viewType: view.view_type },
        { ...entry, beforeSend: (trx, current) => finalAccess.view(trx, current.user, view) })),
    dashboards: found.items.filter(item => canAccessSharedResource({ ...item, user_id: item.dashboard_user_id }, user)).map(item => protect({ id: item.dashboard_id, itemId: item.id, name: item.dashboard_name, publishedVersion: Number(item.published_version) },
        { ...entry, beforeSend: (trx, current) => finalAccess.item(trx, current.user, item) })) }, entry);
}

async function modelVersions(user, modelId, { compareVersion = null } = {}) {
    const model = await modelForUser(user, modelId);
    const rows = await publications.history(modelId);
    const owner = Number(model.user_id) === Number(user.id);
    const versions = [];
    for (const row of rows) {
        try {
            const visible = await visibleDefinition(user, row.definition_json);
            const binding = await publications.binding(modelId, row.version);
            versions.push(protect({ version: Number(row.version), semanticHash: row.semantic_hash, publishedAt: row.created_at, isCurrent: Number(model.published_version) === Number(row.version), definition: visible.definition,
                binding: binding && { manifestId: binding.manifest_id, revision: Number(binding.revision), dataState: binding.data_state, lastRefreshError: binding.last_refresh_error, updatedAt: binding.updated_at }, review: row.review_json },
            { userId: user.id, modelId, definition: visible.definition, required: allRequired(visible.definition) }));
        } catch (error) {
            if (!['ANALYSIS_MODEL_SOURCE_UNAVAILABLE', 'ANALYSIS_MODEL_FIELD_UNAVAILABLE'].includes(error.code)) throw error;
            versions.push({ version: Number(row.version), publishedAt: row.created_at, availability: 'source_unavailable', message: '来源不可用，请联系模型维护者。' });
        }
    }
    const base = compareVersion === null ? versions.find(item => item.isCurrent) : versions.find(item => item.version === Number(compareVersion));
    let target = versions.find(item => item.isCurrent)?.definition;
    if (owner) {
        try { target = (await visibleDefinition(user, model.definition_json)).definition; }
        catch (error) { if (!['ANALYSIS_MODEL_SOURCE_UNAVAILABLE', 'ANALYSIS_MODEL_FIELD_UNAVAILABLE'].includes(error.code)) throw error; target = null; }
    }
    return protect({ versions, changes: base?.definition && target ? definitionDiff(base.definition, target) : [], dependencies: await modelDependencies(user, modelId) },
        { userId: user.id, modelId, definition: target || { nodes: [] }, required: target ? allRequired(target) : new Map() });
}

async function rollbackModel({ user, modelId, body }) {
    await modelForUser(user, modelId, { write: true });
    if (!Number.isSafeInteger(body.publishedVersion) || body.publishedVersion < 1) throw biError('ANALYSIS_MODEL_INPUT_INVALID', '请选择有效的发布版本。');
    const version = await models.version(modelId, body.publishedVersion);
    if (!version) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '模型版本不存在。', 404);
    await transaction(authorize(user, modelId, version.definition_json, { all: true, write: true }));
    await publications.rollback({ userId: user.id, modelId, expectedVersion: body.expectedVersion, version: body.publishedVersion, authorize: authorize(user, modelId, version.definition_json, { all: true, write: true }) });
    return (await require('./models').getProductionModel(user, modelId)).model;
}

module.exports = { modelDependencies, modelVersions, rollbackModel };
