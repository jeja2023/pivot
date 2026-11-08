'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../../../db/client');
const models = require('../../../repositories/analysis-production-models');
const jobs = require('../../../repositories/analysis-model-jobs');
const { modelForUser, visibleDefinition } = require('./access');
const { normalizeModelQuery } = require('./query-contract');
const { resolveAnalysisUser } = require('../shared');
const service = require('./jobs');
const { biError } = require('./errors');
const delivery = require('./delivery');
const { allRequired } = require('./manifests');

function toolDefinitions() {
    const fields = { modelId: { type: 'string', maxLength: 120 }, publishedVersion: { type: 'integer', minimum: 1 }, dimensions: { type: 'array', maxItems: 5, items: { type: 'string' } }, metrics: { type: 'array', maxItems: 10, items: { type: 'string' } },
        filters: { type: 'array', maxItems: 20, items: { type: 'object' } }, limit: { type: 'integer', minimum: 1, maximum: 5000 }, binding: { type: 'object' }, requestKey: { type: 'string', maxLength: 120 } };
    return [
        { name: 'analysis.modelCatalog', title: '查看已发布分析模型', description: '按当前身份列出可用的已发布 BI 模型，或读取指定版本的可见维度、指标、有效期、单位及口径。来源不可用时不返回来源名称和定义。先使用此能力确认稳定 ID，不按名称猜测指标。', capabilities: ['data.dataset.read'], input_schema: { type: 'object', properties: { modelId: fields.modelId, publishedVersion: fields.publishedVersion }, additionalProperties: false } },
        { name: 'analysis.modelQuery', title: '运行正式模型分析', description: '使用明确的发布版本、可见维度/指标 ID 和结构化筛选创建持久分析任务，不接收 SQL，不修改模型。先展示已解析条件；口径、日期字段或范围存在歧义时必须向用户澄清，confirmed=true 只能用于用户已明确的条件或工作流中固定配置。返回任务 ID，随后用 analysis.modelResult 读取确定性结果。', capabilities: ['data.dataset.read'], input_schema: { type: 'object', properties: { ...fields, confirmed: { type: 'boolean' } }, required: ['modelId', 'publishedVersion', 'metrics', 'requestKey'], additionalProperties: false } },
        { name: 'analysis.modelResult', title: '读取正式模型运行结果', description: '按当前身份读取本人分析任务及精确十进制结果、总计范围、来源清单和截止时间。不可读取其他用户的缓存；失败时保留明确错误，不推测数值。', capabilities: ['data.dataset.read'], input_schema: { type: 'object', properties: { runId: { type: 'string', maxLength: 120 } }, required: ['runId'], additionalProperties: false } }
    ];
}

async function catalog(user, input) {
    if (!input.modelId) {
        const list = await require('../semantic-models').listDataModels(user, { limit: 200 });
        return { models: list.filter(model => model.modelKind === 'production' && model.publishedVersion && model.lifecycle !== 'archived').map(model => delivery.inherit({ id: model.id, name: model.name, description: model.description, publishedVersion: model.publishedVersion, availability: model.availability }, model)), text: '请选择明确的模型及发布版本，再读取指标口径。' };
    }
    const model = await modelForUser(user, input.modelId);
    const number = input.publishedVersion ?? Number(model.published_version);
    if (!Number.isSafeInteger(number) || number < 1) throw biError('ANALYSIS_MODEL_PUBLISH_REQUIRED', '请先发布模型，再通过问数或工作流使用。', 409);
    const version = await models.version(model.id, number);
    if (!version) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '指定模型版本不存在。', 404);
    const visible = await visibleDefinition(user, version.definition_json);
    const definition = visible.definition;
    return delivery.protect({ modelId: model.id, publishedVersion: number, semanticHash: version.semantic_hash, name: model.name, grainDescription: definition.grainDescription, timezone: definition.timezone,
        dimensions: definition.dimensions.map(item => ({ id: item.id, name: item.name, logicalType: item.logicalType, granularity: item.granularity, description: item.description })),
        metrics: definition.metrics.map(item => ({ id: item.id, name: item.name, description: item.description, type: item.type, unit: item.unit, currency: item.currency, validFrom: item.validFrom, validTo: item.validTo, allowedDimensionIds: item.allowedDimensionIds })) },
    { userId: user.id, modelId: model.id, definition, required: allRequired(definition) });
}

async function executeModelTool(name, input, user, context = {}) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    if (!actor || actor.deleted_at || actor.status !== 'active') throw biError('ANALYSIS_MODEL_NOT_FOUND', '当前运行主体不可用，请重新登录或调整工作流运行主体。', 404);
    if (name === 'analysis.modelCatalog') return catalog(actor, input);
    if (name === 'analysis.modelResult') {
        const result = await service.getModelJob(actor, input.runId);
        if (result.executionKind !== 'model_query') throw biError('ANALYSIS_MODEL_QUERY_INVALID', '请提供已发布模型的正式分析运行编号。');
        return delivery.inherit({ ...result, analysisSource: { runId: result.id, modelId: result.modelId, publishedVersion: result.publishedVersion, manifestId: result.manifestId, userId: Number(actor.id) },
            text: result.status === 'succeeded' ? '模型结果使用精确十进制字符串，总计覆盖完整过滤范围；请保留运行编号、版本与数据截止时间。' : result.lastError || '任务尚未完成，请稍后读取同一运行，不创建重复任务。' }, result);
    }
    const { modelId, confirmed, ...body } = input;
    if (name !== 'analysis.modelQuery') throw biError('ANALYSIS_MODEL_QUERY_INVALID', '未知的受控模型能力。');
    if (context.run?.id || context.runId) body.requestKey = require('./canonical').canonicalHash({ inputKey: body.requestKey, runId: context.run?.id || context.runId, nodeId: context.node?.id || context.stepId || '' });
    const normalized = normalizeModelQuery(body);
    const available = await catalog(actor, { modelId, publishedVersion: normalized.publishedVersion });
    const resolvedConditions = { modelId, publishedVersion: normalized.publishedVersion, semanticHash: available.semanticHash, timezone: available.timezone, ...normalized.query, binding: normalized.binding };
    if (confirmed !== true) return delivery.inherit({ requiresConfirmation: true, resolvedConditions, text: '请向用户展示已解析的指标、维度、日期范围及数据绑定策略；有歧义时先澄清，确认后再运行。' }, available);
    const job = await service.createModelQuery({ user: actor, modelId, body });
    return { job, resolvedConditions, text: '模型分析已进入持久任务队列，请使用运行编号读取确定性结果。' };
}

async function assertModelDelivery({ sender, runId, recipientUserIds, channelType }) {
    const result = await service.getModelJob(sender, runId), row = await jobs.get(sender.id, runId);
    if (result.executionKind !== 'model_query' || result.status !== 'succeeded') throw biError('ANALYSIS_MODEL_DELIVERY_INVALID', '通知或报告只能引用已完成的正式模型运行。', 409);
    const version = await models.version(row.model_id, row.published_version);
    if (!Array.isArray(recipientUserIds) || !recipientUserIds.length || recipientUserIds.length > 100 || recipientUserIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw biError('ANALYSIS_MODEL_DELIVERY_INVALID', '模型交付必须绑定明确的有效接收者身份。');
    for (const id of [...new Set(recipientUserIds)].sort((a, b) => a - b)) {
        const recipient = await resolveAnalysisUser(id);
        if (!recipient || recipient.status !== 'active' || recipient.deleted_at) throw biError('ANALYSIS_MODEL_DELIVERY_DENIED', '接收者账号或来源权限不可用，已停止模型结果交付。', 403);
        await modelForUser(recipient, row.model_id);
        await transaction(service.authorize(recipient, row.model_id, version.definition_json, { query: row.query_ast_json }));
    }
    if (channelType !== 'web' || recipientUserIds.some(id => id !== Number(sender.id))) throw biError('ANALYSIS_MODEL_DELIVERY_DENIED', '模型数值通知仅允许绑定本人身份的站内渠道；其他接收者请在获授权视图中按本人身份重新运行。', 403);
    return delivery.inherit({ runId: row.id, modelId: row.model_id, publishedVersion: Number(row.published_version), manifestId: row.manifest_id, queryHash: row.result_metadata_json.queryHash, deliveryId: crypto.randomUUID() }, result);
}

module.exports = { toolDefinitions, executeModelTool, assertModelDelivery };
