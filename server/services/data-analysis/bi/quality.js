'use strict';

const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { planModelGraph } = require('./graph');
const { validateMetricDefinitions } = require('./metrics');
const { decimalFromRatio, formatDecimal, parseDecimal } = require('./decimal');
const { sqlIdentifier, keyProjection, decimalProjection, dimensionProjection } = require('./sql-expressions');

function amount(value) { return BigInt(value ?? 0); }

async function checkModelQuality(connection, definition, sources) {
    const graph = planModelGraph(definition);
    const metricPlan = validateMetricDefinitions(definition.metrics, graph.factNodeId);
    const blockers = [], warnings = [], grains = [], relations = [], values = [];
    function field(nodeId, fieldKey) {
        const source = sources[nodeId];
        if (!source || !/^bi_input_[0-9]+$/.test(source.tableName) || !source.columns?.some(column => column.key === fieldKey)) {
            throw biError('ANALYSIS_MODEL_FIELD_UNAVAILABLE', '模型字段不存在或当前不可访问。');
        }
        return sqlIdentifier(fieldKey);
    }
    function table(nodeId) {
        const source = sources[nodeId];
        if (!source || !/^bi_input_[0-9]+$/.test(source.tableName)) throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '模型来源尚未由受控执行器准备。');
        return sqlIdentifier(source.tableName);
    }
    async function readQualityCounts(sql) { return (await connection.runAndReadAll(sql)).getRowObjectsJson()[0] || {}; }
    for (const node of graph.nodes) {
        const incoming = graph.incoming.get(node.id);
        const projections = node.grainKeys.map(fieldKey => {
            const pair = incoming?.keyPairs.find(item => item.rightFieldKey === fieldKey);
            return keyProjection(field(node.id, fieldKey), pair?.normalization || node.grainNormalization?.[fieldKey] || { type: 'text' });
        });
        const names = projections.map((_projection, index) => `k${index}`);
        const keys = projections.map((projection, index) => `${projection.sql} AS ${names[index]}`);
        const missing = names.map(name => `(${name} IS NULL OR CAST(${name} AS VARCHAR) = '')`).join(' OR ');
        const row = await readQualityCounts(`WITH keyed AS (SELECT ${keys.join(',')}, (${projections.map(projection => projection.invalidSql).join(' OR ')}) AS conversion_invalid FROM ${table(node.id)}),
            grouped AS (SELECT ${names.join(',')}, COUNT(*) AS n FROM keyed GROUP BY ${names.join(',')})
            SELECT (SELECT COUNT(*) FROM keyed) AS row_count,
                (SELECT COUNT(*) FROM keyed WHERE ${missing}) AS missing_rows,
                (SELECT COUNT(*) FROM keyed WHERE conversion_invalid) AS conversion_errors,
                (SELECT COUNT(*) FROM grouped WHERE n > 1) AS duplicate_keys,
                (SELECT COALESCE(SUM(n - 1), 0) FROM grouped WHERE n > 1) AS duplicate_rows`);
        grains.push({ nodeId: node.id, rowCount: String(row.row_count), missingRows: String(row.missing_rows), conversionErrors: String(row.conversion_errors), duplicateKeys: String(row.duplicate_keys), duplicateRows: String(row.duplicate_rows) });
        if (amount(row.missing_rows)) blockers.push({ code: 'ANALYSIS_MODEL_GRAIN_NULL', nodeId: node.id, message: '粒度或维度主键包含空值。' });
        if (amount(row.conversion_errors)) blockers.push({ code: 'ANALYSIS_MODEL_KEY_CONVERSION', nodeId: node.id, message: '粒度或维度主键不能按已声明的类型转换。' });
        if (amount(row.duplicate_keys)) blockers.push({ code: 'ANALYSIS_MODEL_GRAIN_DUPLICATE', nodeId: node.id, message: '粒度或维度主键存在重复，请调整业务粒度或来源数据。' });
    }
    for (const relation of graph.relations) {
        const names = relation.keyPairs.map((_pair, index) => `k${index}`);
        function grouped(nodeId, side) {
            const keys = relation.keyPairs.map((pair, index) => `${keyProjection(field(nodeId, pair[`${side}FieldKey`]), pair.normalization).sql} AS ${names[index]}`);
            return `(SELECT ${names.join(',')}, COUNT(*) AS n FROM (SELECT ${keys.join(',')} FROM ${table(nodeId)}) projected GROUP BY ${names.join(',')})`;
        }
        const match = names.map(name => `l.${name} = r.${name}`).join(' AND ');
        const row = await readQualityCounts(`WITH l AS ${grouped(relation.leftNodeId, 'left')}, r AS ${grouped(relation.rightNodeId, 'right')},
            matches AS (SELECT l.n AS ln, r.n AS rn FROM l JOIN r ON ${match})
            SELECT (SELECT COALESCE(SUM(n), 0) FROM l) AS left_rows,
                (SELECT COALESCE(SUM(n), 0) FROM r) AS right_rows,
                (SELECT COUNT(*) FROM l WHERE n > 1) AS left_duplicate_keys,
                (SELECT COUNT(*) FROM r WHERE n > 1) AS right_duplicate_keys,
                (SELECT COALESCE(SUM(ln), 0) FROM matches) AS matched_left,
                (SELECT COALESCE(SUM(CAST(ln AS HUGEINT) * rn), 0) FROM matches) AS inner_rows`);
        const unmatched = amount(row.left_rows) - amount(row.matched_left);
        const joined = amount(row.inner_rows) + (relation.joinType === 'left' ? unmatched : 0n);
        relations.push({ relationId: relation.id, leftRows: String(row.left_rows), rightRows: String(row.right_rows), matchedLeftRows: String(row.matched_left),
            unmatchedLeftRows: String(unmatched), leftDuplicateKeys: String(row.left_duplicate_keys), rightDuplicateKeys: String(row.right_duplicate_keys),
            joinedRows: String(joined), leftMatchRate: amount(row.left_rows) ? formatDecimal(decimalFromRatio(amount(row.matched_left), amount(row.left_rows), 8)) : null });
        if (amount(row.right_duplicate_keys) || (relation.cardinality === 'one_to_one' && amount(row.left_duplicate_keys))) blockers.push({ code: 'ANALYSIS_MODEL_CARDINALITY_INVALID', relationId: relation.id, message: '关联键实际唯一性与对应基数不符，禁止启用可能重复统计的数据。' });
        if (unmatched) warnings.push({ code: 'ANALYSIS_MODEL_UNMATCHED_ROWS', relationId: relation.id, rows: String(unmatched), message: relation.joinType === 'inner' ? '内关联将排除未匹配事实范围，请核对口径。' : '存在未匹配记录，左关联将予以保留。' });
        if (relation.minMatchRate !== undefined) {
            const threshold = parseDecimal(relation.minMatchRate);
            if (amount(row.matched_left) * (10n ** BigInt(threshold.scale)) < threshold.coefficient * amount(row.left_rows)) blockers.push({ code: 'ANALYSIS_MODEL_MATCH_THRESHOLD', relationId: relation.id, message: '关联匹配率未达到模型设置的强约束。' });
        }
        for (const pair of relation.keyPairs) {
            const converted = keyProjection(field(relation.leftNodeId, pair.leftFieldKey), pair.normalization);
            const invalid = await readQualityCounts(`SELECT COUNT(*) AS invalid_count FROM ${table(relation.leftNodeId)} WHERE ${converted.invalidSql}`);
            if (amount(invalid.invalid_count)) blockers.push({ code: 'ANALYSIS_MODEL_KEY_CONVERSION', relationId: relation.id, message: '关联键存在类型转换失败，不能静默当作未匹配。' });
        }
    }
    const checkedFields = new Map();
    for (const metric of metricPlan.ordered) {
        if (!['sum', 'avg', 'min', 'max'].includes(metric.type)) continue;
        const identity = canonicalHash({ field: metric.field, rule: metric.numeric || {} });
        const raw = field(metric.field.nodeId, metric.field.fieldKey);
        const projection = decimalProjection(raw, metric.numeric);
        let row = checkedFields.get(identity);
        if (!row) {
            row = await readQualityCounts(`SELECT COUNT(*) AS row_count, COUNT(*) FILTER (WHERE ${projection.invalidSql}) AS invalid_count,
                COUNT(*) FILTER (WHERE ${projection.sql} IS NULL) AS null_count FROM ${table(metric.field.nodeId)}`);
            checkedFields.set(identity, row);
        }
        values.push({ metricId: metric.id, rowCount: String(row.row_count), invalidRows: String(row.invalid_count), nullRows: String(row.null_count) });
        if (amount(row.invalid_count)) {
            const issue = { code: 'ANALYSIS_MODEL_NUMERIC_INVALID', metricId: metric.id, rows: String(row.invalid_count), message: '数值字段存在不能按声明口径解析的值。' };
            if (metric.invalidValuePolicy === 'ignore' && !metric.currency && !metric.currencyField) warnings.push(issue);
            else blockers.push(issue);
        }
        if (metric.required === true && amount(row.null_count)) blockers.push({ code: 'ANALYSIS_MODEL_REQUIRED_VALUE', metricId: metric.id, message: '必填数值字段存在空值或无效值。' });
        if (metric.currencyField) {
            const currency = field(metric.currencyField.nodeId, metric.currencyField.fieldKey);
            const checked = await readQualityCounts(`SELECT COUNT(DISTINCT ${currency}) AS distinct_count, COUNT(*) FILTER (WHERE ${currency} IS NULL OR NOT regexp_full_match(CAST(${currency} AS VARCHAR), '[A-Z]{3}')) AS invalid_count FROM ${table(metric.currencyField.nodeId)}`);
            values[values.length - 1].currencyCount = String(checked.distinct_count);
            if (amount(checked.invalid_count)) blockers.push({ code: 'ANALYSIS_MODEL_CURRENCY_INVALID', metricId: metric.id, rows: String(checked.invalid_count), message: '金额存在缺失或无效币种，请准备明确的币种字段。' });
        }
    }
    for (const dimension of definition.dimensions || []) {
        if (!dimension.granularity) continue;
        const raw = field(dimension.nodeId, dimension.fieldKey);
        const parsed = dimensionProjection(raw, dimension, definition.timezone || 'Asia/Shanghai');
        const row = await readQualityCounts(`SELECT COUNT(*) AS invalid_count FROM ${table(dimension.nodeId)} WHERE ${raw} IS NOT NULL AND CAST(${raw} AS VARCHAR) <> '' AND (${parsed}) IS NULL`);
        if (amount(row.invalid_count)) blockers.push({ code: 'ANALYSIS_MODEL_DATE_INVALID', dimensionId: dimension.id, rows: String(row.invalid_count), message: '日期字段存在不能按指定格式或时区解释的值。' });
    }
    return { complete: true, fullScan: true, passed: blockers.length === 0, semanticHash: canonicalHash(definition), grains, relations, values, blockers, warnings };
}

module.exports = { checkModelQuality };
