'use strict';

const { BI_POLICY } = require('./policy');
const { canonicalHash, canonicalJson } = require('./canonical');
const { biError } = require('./errors');
const { planModelGraph } = require('./graph');
const { validateMetricDefinitions } = require('./metrics');
const { decimalProjection, keyProjection, dimensionProjection } = require('./sql-expressions');

const ID = /^[\p{L}\p{N}_-]{1,120}$/u;
const POLICY_KEYS = ['schemaVersion', 'semanticVersion', 'compilerVersion', 'numericPolicyVersion', 'normalizationVersion'];
function invalid(message) { throw biError('ANALYSIS_MODEL_DEFINITION_INVALID', message); }
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须是对象。`);
    return value;
}
function keys(value, allowed, label) {
    object(value, label);
    if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label}包含未支持的配置项，请升级客户端或删除该配置。`);
}
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) invalid(`${label}无效。`); return value; }
function text(value, label, max = 1000) {
    if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) invalid(`${label}必须为不超过${max}字的文本。`);
    return value;
}
function instant(value) {
    if (typeof value !== 'string') invalid('指标有效期必须带明确时区。');
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!match) invalid('指标有效期必须使用带时区的完整日期时间。');
    const [, year, month, day, hour, minute, second] = match;
    const local = new Date(0); local.setUTCFullYear(Number(year), Number(month) - 1, Number(day)); local.setUTCHours(Number(hour), Number(minute), Number(second), 0);
    if (Number(year) < 1 || local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day) || local.getUTCHours() !== Number(hour) || local.getUTCMinutes() !== Number(minute) || local.getUTCSeconds() !== Number(second)
        || match[8] !== 'Z' && (Number(match[10]) > 14 || Number(match[11]) > 59 || Number(match[10]) === 14 && Number(match[11]) !== 0) || !Number.isFinite(Date.parse(value))) invalid('指标有效期包含无效日期、时间或时区偏移。');
    return new Date(value).toISOString();
}
function boundedDefinitionList(value, label, max) { if (!Array.isArray(value) || value.length > max) invalid(`${label}数量超过上限或格式无效。`); return value; }
function ids(value, label, max = 120) {
    const result = boundedDefinitionList(value, label, max).map(item => id(item, label));
    if (new Set(result).size !== result.length) invalid(`${label}不能重复。`);
    return result;
}
function bool(value, label) { if (typeof value !== 'boolean') invalid(`${label}必须为布尔值。`); return value; }
function positive(value, label, max) { if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(`${label}超出允许范围。`); return value; }
function reference(value, label) { keys(value, ['nodeId', 'fieldKey'], label); return { nodeId: id(value.nodeId, label), fieldKey: id(value.fieldKey, label) }; }

function normalization(value = {}) {
    keys(value, ['type', 'trim', 'emptyAsNull', 'caseSensitive', 'precision', 'scale', 'format'], '键规范化');
    const result = { type: value.type || 'text', trim: value.trim ?? false, emptyAsNull: value.emptyAsNull ?? false, caseSensitive: value.caseSensitive ?? true };
    for (const key of ['trim', 'emptyAsNull', 'caseSensitive']) bool(result[key], '键规范化开关');
    for (const key of ['precision', 'scale', 'format']) if (value[key] !== undefined) result[key] = value[key];
    keyProjection('field', result);
    return result;
}

function numeric(value = {}) {
    keys(value, ['precision', 'scale', 'allowThousands', 'allowCurrency', 'allowPercent'], '数值转换规则');
    const result = { precision: value.precision ?? 18, scale: value.scale ?? 2, allowThousands: value.allowThousands ?? false, allowCurrency: value.allowCurrency ?? false, allowPercent: value.allowPercent ?? false };
    for (const key of ['allowThousands', 'allowCurrency', 'allowPercent']) bool(result[key], '数值转换开关');
    decimalProjection('field', result);
    return result;
}

function normalizeFilters(value = []) {
    return boundedDefinitionList(value, '筛选条件', BI_POLICY.maxFilters).map(filter => {
        keys(filter, ['dimensionId', 'field', 'operator', 'value'], '筛选条件');
        if (Boolean(filter.dimensionId) === Boolean(filter.field)) invalid('筛选必须且只能引用一个维度或字段。');
        const result = filter.dimensionId ? { dimensionId: id(filter.dimensionId, '筛选维度') } : { field: reference(filter.field, '筛选字段') };
        const operator = filter.operator;
        if (!['eq', 'in', 'range', 'is_null', 'is_not_null', 'contains'].includes(operator)) invalid('筛选操作不受支持。');
        result.operator = operator;
        if (!['is_null', 'is_not_null'].includes(operator)) {
            const values = ['in', 'range'].includes(operator) ? boundedDefinitionList(filter.value, '筛选值', operator === 'in' ? BI_POLICY.maxSetValues : 2) : [filter.value];
            if (!values.length || (operator === 'range' && values.length !== 2)) invalid('筛选值数量无效。');
            for (const entry of values) {
                if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) invalid('筛选值必须是普通值。');
                if (typeof entry === 'number' && (!Number.isFinite(entry) || Math.abs(entry) > Number.MAX_SAFE_INTEGER)) invalid('高精度筛选值请使用字符串。');
                if (typeof entry === 'string' && entry.length > 10000) invalid('筛选文本过长。');
                if (entry === null && operator !== 'eq') invalid('此筛选操作不接受空值。');
            }
            if (operator === 'contains' && typeof filter.value !== 'string') invalid('文本匹配需要文本筛选值。');
            result.value = filter.value;
        }
        return result;
    });
}

function normalizeModelDefinition(input, { complete = true } = {}) {
    // 先验证普通 JSON，避免 getter、原型对象或循环引用进入持久快照。
    const bytes = canonicalJson(input);
    if (Buffer.byteLength(bytes, 'utf8') > BI_POLICY.maxRequestBytes) invalid('模型定义超过一 MiB 上限。');
    keys(input, [...POLICY_KEYS, 'engineVersion', 'timezone', 'grainDescription', 'nodes', 'relations', 'dimensions', 'metrics', 'refreshCadence', 'maxStaleness', 'freshnessPolicy', 'coveragePolicy', 'watermarkPolicy'], '模型定义');
    const definition = {};
    for (const key of POLICY_KEYS) {
        if (input[key] !== undefined && input[key] !== BI_POLICY[key]) throw biError('ANALYSIS_MODEL_COMPILER_INCOMPATIBLE', '模型语义版本不兼容，请先运行版本差异验证。', 409);
        definition[key] = BI_POLICY[key];
    }
    definition.engineVersion = input.engineVersion || 'duckdb-1.5';
    if (definition.engineVersion !== 'duckdb-1.5') invalid('模型执行引擎版本不受支持。');
    definition.timezone = input.timezone || BI_POLICY.defaultTimezone;
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: definition.timezone }).format(); } catch (_) { invalid('模型业务时区无效。'); }
    definition.grainDescription = text(input.grainDescription ?? '', '事实粒度说明');
    definition.refreshCadence = positive(input.refreshCadence ?? 3600, '刷新周期秒数', 366 * 86400);
    definition.maxStaleness = positive(input.maxStaleness ?? 86400, '最大陈旧秒数', 366 * 86400);
    definition.freshnessPolicy = input.freshnessPolicy || 'strict';
    definition.coveragePolicy = input.coveragePolicy || 'complete';
    definition.watermarkPolicy = input.watermarkPolicy || 'independent';
    if (!['strict', 'historical_manual'].includes(definition.freshnessPolicy) || !['complete', 'partial'].includes(definition.coveragePolicy) || !['independent', 'same_batch', 'same_period'].includes(definition.watermarkPolicy)) invalid('数据新鲜度、完整性或水位策略无效。');
    definition.nodes = boundedDefinitionList(input.nodes || [], '模型节点', 9).map(node => {
        keys(node, ['id', 'datasetId', 'role', 'name', 'grainKeys', 'grainNormalization', 'layout'], '模型节点');
        const result = { id: id(node.id, '节点标识'), datasetId: id(node.datasetId, '数据集标识'), role: node.role, name: text(node.name ?? node.id, '节点名称', 120), grainKeys: ids(node.grainKeys || [], '粒度字段'), grainNormalization: {} };
        if (!['fact', 'dimension'].includes(node.role)) invalid('节点必须是事实表或维度表。');
        for (const [fieldKey, rule] of Object.entries(node.grainNormalization || {})) { if (!result.grainKeys.includes(fieldKey)) invalid('粒度规范化引用了粒度以外字段。'); result.grainNormalization[fieldKey] = normalization(rule); }
        if (node.layout) {
            keys(node.layout, ['x', 'y'], '节点布局');
            if (![node.layout.x, node.layout.y].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) invalid('节点布局坐标无效。');
            result.layout = { x: node.layout.x, y: node.layout.y };
        }
        return result;
    });
    definition.relations = boundedDefinitionList(input.relations || [], '关联', BI_POLICY.maxRelations).map(relation => {
        keys(relation, ['id', 'leftNodeId', 'rightNodeId', 'joinType', 'cardinality', 'keyPairs', 'minMatchRate'], '关联');
        const result = { id: id(relation.id, '关联标识'), leftNodeId: id(relation.leftNodeId, '左侧节点'), rightNodeId: id(relation.rightNodeId, '右侧节点'), joinType: relation.joinType || 'left', cardinality: relation.cardinality || 'many_to_one', keyPairs: boundedDefinitionList(relation.keyPairs || [], '关联键对', BI_POLICY.maxKeyPairs).map(pair => {
            keys(pair, ['leftFieldKey', 'rightFieldKey', 'normalization'], '关联键对');
            return { leftFieldKey: id(pair.leftFieldKey, '左侧字段'), rightFieldKey: id(pair.rightFieldKey, '右侧字段'), normalization: normalization(pair.normalization) };
        }) };
        if (relation.minMatchRate !== undefined) {
            if (typeof relation.minMatchRate !== 'string' || !/^(?:0(?:\.\d{1,8})?|1(?:\.0{1,8})?)$/.test(relation.minMatchRate)) invalid('匹配率阈值须为零到一之间的十进制字符串。');
            result.minMatchRate = relation.minMatchRate;
        }
        return result;
    });
    definition.dimensions = boundedDefinitionList(input.dimensions || [], '维度', 1000).map(dimension => {
        keys(dimension, ['id', 'name', 'description', 'nodeId', 'fieldKey', 'logicalType', 'memberKeyFields', 'granularity', 'dateFormat', 'hierarchyId', 'hierarchyLevel', 'sort', 'nullLabel'], '维度');
        const result = { id: id(dimension.id, '维度标识'), name: text(dimension.name ?? dimension.id, '维度名称', 120), description: text(dimension.description ?? '', '维度说明'), nodeId: id(dimension.nodeId, '维度节点'), fieldKey: id(dimension.fieldKey, '维度字段'), logicalType: dimension.logicalType || 'text', memberKeyFields: ids(dimension.memberKeyFields || [dimension.fieldKey], '维度成员键'), sort: dimension.sort || 'asc', nullLabel: text(dimension.nullLabel ?? '空值', '空值标签', 120) };
        if (!['text', 'enum', 'date', 'timestamp'].includes(result.logicalType) || !['asc', 'desc'].includes(result.sort)) invalid('维度类型或排序规则无效。');
        if (dimension.granularity) result.granularity = dimension.granularity;
        if (dimension.dateFormat) result.dateFormat = dimension.dateFormat;
        if (['date', 'timestamp'].includes(result.logicalType)) { result.granularity ||= 'day'; dimensionProjection('field', result, definition.timezone); }
        else if (dimension.granularity || dimension.dateFormat) invalid('文本维度不能配置日期粒度。');
        if (dimension.hierarchyId) { result.hierarchyId = id(dimension.hierarchyId, '层级标识'); result.hierarchyLevel = positive(dimension.hierarchyLevel, '层级序号', 120); }
        return result;
    });
    const fact = definition.nodes.find(node => node.role === 'fact');
    definition.metrics = boundedDefinitionList(input.metrics || [], '指标', 1000).map(metric => {
        keys(metric, ['id', 'name', 'description', 'type', 'field', 'grainKey', 'scale', 'numeric', 'unit', 'currency', 'currencyField', 'additivity', 'filters', 'expression', 'validFrom', 'validTo', 'allowedDimensionIds', 'invalidValuePolicy', 'required', 'maintainerId'], '指标');
        const result = { id: id(metric.id, '指标标识'), name: text(metric.name ?? metric.id, '指标名称', 120), description: text(metric.description ?? '', '指标口径说明'), type: metric.type, scale: metric.scale ?? (String(metric.type).startsWith('count') ? 0 : 2), unit: text(metric.unit ?? '', '指标单位', 80), additivity: metric.additivity || (['avg', 'count_distinct', 'derived'].includes(metric.type) ? 'non_additive' : 'additive'), filters: normalizeFilters(metric.filters), invalidValuePolicy: metric.invalidValuePolicy || 'block', required: metric.required ?? false, allowedDimensionIds: ids(metric.allowedDimensionIds || definition.dimensions.map(dimension => dimension.id), '允许分组维度', 1000) };
        if (!['block', 'ignore'].includes(result.invalidValuePolicy)) invalid('无效值策略不受支持。');
        bool(result.required, '指标必填规则');
        if (metric.field) result.field = reference(metric.field, '指标字段');
        if (metric.grainKey !== undefined) { result.grainKey = bool(metric.grainKey, '复合粒度去重规则'); if (result.grainKey && (metric.type !== 'count_distinct' || metric.field)) invalid('复合粒度键只能用于去重计数，且不能同时指定普通字段。'); }
        if (['sum', 'avg', 'min', 'max'].includes(metric.type)) result.numeric = numeric(metric.numeric);
        if (metric.currency) { if (!/^[A-Z]{3}$/.test(metric.currency)) invalid('固定币种使用三位大写币种代码。'); result.currency = metric.currency; }
        if (metric.currencyField) result.currencyField = reference(metric.currencyField, '币种字段');
        if (metric.currency && metric.currencyField) invalid('固定币种与币种字段只能选择一种。');
        if (metric.type === 'derived' && (metric.currency || metric.currencyField)) invalid('派生指标的币种从依赖指标计算，请在基础指标声明币种。');
        if ((result.currency || result.currencyField) && result.invalidValuePolicy === 'ignore') invalid('金额转换失败必须阻断，不能配置为忽略。');
        if (metric.expression) result.expression = JSON.parse(canonicalJson(metric.expression));
        for (const key of ['validFrom', 'validTo']) if (metric[key]) {
            result[key] = instant(metric[key]);
        }
        if (metric.maintainerId !== undefined) result.maintainerId = positive(Number(metric.maintainerId), '指标维护者', Number.MAX_SAFE_INTEGER);
        return result;
    });
    // 节点、关联、维度和指标是按 ID 寻址的集合；键对、层级和 AST 的顺序保留。
    for (const key of ['nodes', 'relations', 'dimensions', 'metrics']) definition[key].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const issues = [];
    const collectDefinitionIssue = action => { try { action(); } catch (error) { if (!error.code?.startsWith('ANALYSIS_')) throw error; issues.push({ code: error.code, message: error.message }); } };
    collectDefinitionIssue(() => { if (!definition.grainDescription.trim()) invalid('请说明事实表每一行代表的业务事件。'); });
    collectDefinitionIssue(() => planModelGraph(definition));
    collectDefinitionIssue(() => validateMetricDefinitions(definition.metrics, fact?.id));
    collectDefinitionIssue(() => validateReferences(definition));
    if (complete && issues.length) throw biError(issues[0].code, issues[0].message);
    return { definition, semanticHash: canonicalHash(definition), issues };
}

function validateReferences(definition) {
    const nodes = new Map(definition.nodes.map(node => [node.id, node]));
    if (nodes.size !== definition.nodes.length) invalid('节点标识不能重复。');
    const dimensions = new Map(definition.dimensions.map(dimension => [dimension.id, dimension]));
    if (dimensions.size !== definition.dimensions.length) invalid('维度标识不能重复。');
    function ref(value) { if (!nodes.has(value.nodeId)) invalid('字段引用的模型节点不存在。'); }
    function filters(values) { for (const filter of values) { if (filter.field) ref(filter.field); else if (!dimensions.has(filter.dimensionId)) invalid('条件指标引用的维度不存在。'); } }
    const hierarchyLevels = new Set();
    for (const dimension of definition.dimensions) {
        ref(dimension);
        if (dimension.hierarchyId) { const key = `${dimension.hierarchyId}:${dimension.hierarchyLevel}`; if (hierarchyLevels.has(key)) invalid('同一维度层级序号不能重复。'); hierarchyLevels.add(key); }
    }
    for (const metric of definition.metrics) {
        if (metric.field) ref(metric.field);
        if (metric.currencyField) { ref(metric.currencyField); if (nodes.get(metric.currencyField.nodeId).role !== 'fact') invalid('币种字段必须来自事实表。'); }
        filters(metric.filters);
        if (metric.allowedDimensionIds.some(value => !dimensions.has(value))) invalid('指标允许分组范围引用不存在的维度。');
    }
}

module.exports = { normalizeModelDefinition, normalizeFilters };
