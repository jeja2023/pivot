'use strict';

const { canonicalHash } = require('./canonical');
const { sqlIdentifier } = require('./sql-expressions');
const { numericValueSql } = require('../numeric-values');
const { compileModelQuery } = require('./query');
const { consumeModelQuery } = require('./result');
const { parseDecimal, formatDecimal } = require('./decimal');
const { biError } = require('./errors');

function ordered(snapshot) {
    const active = snapshot.relations.filter(item => item.status === 'active');
    if (!active.length || active.length > 8 || active.some(item => !['left', 'inner'].includes(item.joinType) || item.leftNodeId === item.rightNodeId)) throw biError('ANALYSIS_MODEL_MIGRATION_INVALID', '旧探索关联类型、数量或方向无效，请先修复旧探索。');
    const result = [active[0]], included = new Set([active[0].leftNodeId, active[0].rightNodeId]), pending = active.slice(1);
    while (pending.length) {
        const index = pending.findIndex(item => included.has(item.leftNodeId) && !included.has(item.rightNodeId));
        if (index < 0) throw biError('ANALYSIS_MODEL_MIGRATION_INVALID', '旧探索原图无有效查询顺序；请先修复旧探索后重新创建草稿。');
        const [relation] = pending.splice(index, 1); included.add(relation.rightNodeId); result.push(relation);
    }
    return result;
}
function decimalText(value, scale) {
    if (value === null) return null;
    let text = String(value);
    const exponent = text.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    if (exponent) {
        const digits = exponent[2] + (exponent[3] || ''), position = exponent[2].length + Number(exponent[4]);
        if (Math.abs(position) > 76) return text;
        text = exponent[1] + (position <= 0 ? '0.' + '0'.repeat(-position) + digits : position >= digits.length ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position) + '.' + digits.slice(position));
    }
    try { return formatDecimal(parseDecimal(text), { scale }); } catch (_) { return text; }
}

async function compareMigration(connection, definition, sources, comparison, quality) {
    const { snapshot, snapshotHash, dimensions: dimensionIds, metrics: metricIds } = comparison;
    const report = { complete: false, snapshotHash, sourceModelId: snapshot.sourceModelId, dimensions: dimensionIds, metrics: metricIds, reasons: ['旧探索按原始文本键关联并使用双精度数值；正式模型按已声明的键、精确数值、事实范围和成员键计算。'], differences: [], unmatched: [] };
    if (canonicalHash(snapshot) !== snapshotHash) throw biError('ANALYSIS_MODEL_MIGRATION_INVALID', '旧探索迁移来源校验失败。');
    let relations;
    try { relations = ordered(snapshot); } catch (error) { report.reasons.push(error.message); return report; }
    const nodeById = new Map(definition.nodes.map(node => [node.id, node])), aliases = new Map(snapshot.nodes.map((node, index) => [node.id, `l${index}`]));
    const field = (nodeId, key) => {
        if (!sources[nodeId]?.columns.some(column => column.key === key)) throw biError('ANALYSIS_MODEL_FIELD_UNAVAILABLE', '旧探索对照字段缺失或无权访问，请检查来源。');
        return `${aliases.get(nodeId)}.${sqlIdentifier(key)}`;
    };
    const from = [`${sqlIdentifier(sources[relations[0].leftNodeId].tableName)} ${aliases.get(relations[0].leftNodeId)}`];
    for (const relation of relations) {
        from.push(`${relation.joinType.toUpperCase()} JOIN ${sqlIdentifier(sources[relation.rightNodeId].tableName)} ${aliases.get(relation.rightNodeId)} ON CAST(${field(relation.leftNodeId, relation.leftFieldKey)} AS VARCHAR)=CAST(${field(relation.rightNodeId, relation.rightFieldKey)} AS VARCHAR)`);
        const rows = (await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${sqlIdentifier(sources[relation.leftNodeId].tableName)} ${aliases.get(relation.leftNodeId)} WHERE NOT EXISTS(SELECT 1 FROM ${sqlIdentifier(sources[relation.rightNodeId].tableName)} ${aliases.get(relation.rightNodeId)} WHERE CAST(${field(relation.leftNodeId, relation.leftFieldKey)} AS VARCHAR)=CAST(${field(relation.rightNodeId, relation.rightFieldKey)} AS VARCHAR))`)).getRowObjectsJson();
        const modern = quality.relations.find(item => item.relationId === relation.id);
        report.unmatched.push({ relationId: relation.id, legacy: String(rows[0].n), formal: modern?.unmatchedLeftRows ?? null });
    }
    const selectedDimensions = dimensionIds.map(id => definition.dimensions.find(item => item.id === id)), selectedMetrics = metricIds.map(id => definition.metrics.find(item => item.id === id));
    const dimensions = selectedDimensions.map((dimension, index) => `${field(dimension.nodeId, dimension.fieldKey)} AS g${index}`);
    const metricSql = selectedMetrics.map((metric, index) => {
        const imported = metric.id.match(/^legacy_metric_(\d+)$/), original = imported && snapshot.metrics[Number(imported[1])];
        const type = original ? original.config.aggregation : metric.type;
        if (!['count', 'count_nonnull', 'count_distinct', 'sum', 'avg', 'min', 'max'].includes(type)) throw biError('ANALYSIS_MODEL_MIGRATION_INVALID', '旧指标包含不支持的聚合配置，请先修复原指标。');
        const reference = original ? { nodeId: snapshot.nodes.find(node => node.datasetId === original.datasetId).id, fieldKey: original.config.fieldKey } : metric.field;
        const expression = type === 'count' ? 'COUNT(*)' : type === 'count_nonnull' ? `COUNT(${field(reference.nodeId, reference.fieldKey)})` : type === 'count_distinct' ? `COUNT(DISTINCT ${field(reference.nodeId, reference.fieldKey)})` : `${type.toUpperCase()}(${numericValueSql(field(reference.nodeId, reference.fieldKey))})`;
        return `CAST(${expression} AS VARCHAR) AS m${index}`;
    });
    const grouping = dimensions.map((_, index) => String(index + 1)).join(',');
    const oldGroups = (await connection.runAndReadAll(`SELECT ${[...dimensions, ...metricSql].join(',')} FROM ${from.join(' ')} GROUP BY ${grouping} LIMIT 5001`)).getRowObjectsJson();
    const oldTotal = (await connection.runAndReadAll(`SELECT COUNT(*) AS n,${metricSql.join(',')} FROM ${from.join(' ')}`)).getRowObjectsJson()[0];
    const compiled = compileModelQuery(definition, { dimensions: dimensionIds, metrics: metricIds, filters: [], orderBy: [], limit: 5000 }, sources);
    const modern = await consumeModelQuery(connection, compiled);
    const modernTotal = (await connection.runAndReadAll(`SELECT fact_row_count FROM (${compiled.sql}) compared WHERE is_total`, compiled.parameters)).getRowObjectsJson()[0];
    report.rows = { legacy: String(oldTotal.n), formal: String(modernTotal.fact_row_count) };
    report.totals = selectedMetrics.map((metric, index) => ({ metricId: metric.id, legacy: decimalText(oldTotal[`m${index}`], metric.scale), formal: modern.total.values[metric.id].value }));
    report.groups = { legacy: oldGroups.length, formal: modern.groupCount, checkedLimit: 5000 };
    if (oldGroups.length > 5000 || modern.truncated) { report.reasons.push('分组超过五千个，对照尚未完成；请选择更粗的对照维度后重新检查。'); return report; }
    const oldMap = new Map(oldGroups.map(row => [canonicalHash(selectedDimensions.map((_, index) => row[`g${index}`])), row]));
    let groupDifferenceCount = 0;
    const add = difference => { groupDifferenceCount++; if (report.differences.length < 100) report.differences.push({ ...difference, group: difference.group.map(value => typeof value === 'string' ? value.slice(0, 256) : value) }); };
    for (const row of modern.rows) {
        const group = selectedDimensions.map(dimension => row.members[dimension.id].label), key = canonicalHash(group), old = oldMap.get(key);
        oldMap.delete(key);
        for (const [index, metric] of selectedMetrics.entries()) {
            const legacy = old ? decimalText(old[`m${index}`], metric.scale) : null, formal = row.values[metric.id].value;
            if (!old || legacy !== formal) add({ group, metricId: metric.id, legacy, formal, reason: !old ? '正式分组在旧探索中不存在，核对成员键、日期粒度或关联范围。' : '核对事实表、关联范围、数值转换、条件指标及精度规则。' });
        }
    }
    for (const old of oldMap.values()) add({ group: selectedDimensions.map((_, index) => old[`g${index}`]), legacyOnly: true, reason: '旧分组不在正式结果中，核对内关联范围和成员规则。' });
    report.groupDifferenceCount = groupDifferenceCount;
    report.hasDifferences = groupDifferenceCount > 0 || report.rows.legacy !== report.rows.formal || report.totals.some(item => item.legacy !== item.formal) || report.unmatched.some(item => item.legacy !== item.formal);
    const semanticReasons = [];
    if (relations[0].leftNodeId !== definition.nodes.find(node => node.role === 'fact').id) semanticReasons.push('正式模型选择了不同事实表，原探索起点未自动改写。');
    if (relations.length !== definition.relations.length || relations.some(relation => !definition.relations.some(item => item.id === relation.id && item.leftNodeId === relation.leftNodeId && item.rightNodeId === relation.rightNodeId && item.joinType === relation.joinType && item.keyPairs.length === 1 && item.keyPairs[0].leftFieldKey === relation.leftFieldKey && item.keyPairs[0].rightFieldKey === relation.rightFieldKey && item.keyPairs[0].normalization.type === 'text' && !item.keyPairs[0].normalization.trim && !item.keyPairs[0].normalization.emptyAsNull && item.keyPairs[0].normalization.caseSensitive))) semanticReasons.push('关联方向、键、规范化或范围已调整，请核对记录数及未匹配差异。');
    if (selectedMetrics.some(item => item.filters.length)) semanticReasons.push('正式条件指标包含筛选；旧探索汇总不应用该条件。');
    if (selectedMetrics.some(metric => { const match = metric.id.match(/^legacy_metric_(\d+)$/), original = match && snapshot.metrics[Number(match[1])]; return original && (original.config.aggregation !== metric.type || original.config.aggregation !== 'count' && (original.config.fieldKey !== metric.field?.fieldKey || original.datasetId !== nodeById.get(metric.field?.nodeId)?.datasetId) || original.unit !== metric.unit || metric.currency || metric.currencyField); })) semanticReasons.push('导入指标的字段、聚合方式或单位已修改；旧值仍使用迁移时冻结的原指标配置。');
    if (selectedDimensions.some(item => item.granularity)) semanticReasons.push('正式日期维度使用声明的粒度与时区，旧探索仍按原始显示字段分组。');
    report.reasons.push(...semanticReasons); report.hasDifferences ||= semanticReasons.length > 0;
    if (selectedDimensions.some(item => item.memberKeyFields.length !== 1 || item.memberKeyFields[0] !== item.fieldKey)) { report.reasons.push('正式维度使用不同成员键；旧探索只按显示字段分组，分组对照需要改选原始字段维度。'); return report; }
    if ([...nodeById.keys()].some(id => !snapshot.nodes.some(node => node.id === id))) report.reasons.push('正式模型增加了来源，旧探索对照仍使用原关联范围。');
    report.complete = true;
    return report;
}
module.exports = { compareMigration, decimalText };
