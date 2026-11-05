'use strict';

const { getDataModel } = require('./semantic-models');
const { numericValueSql } = require('./numeric-values');
const { getAccessibleDatasetColumns, assertDatasetFieldsAccessible } = require('./governance');
const { getDatasetForUser, getDatasetPaths, sqlIdent, sqlLiteral, withAnalysisSlot, createDuckConnection, withDuckTimeout } = require('./shared');

function invalid(message) {
    return Object.assign(new Error(message), { status: 400, code: 'ANALYSIS_MODEL_QUERY_INVALID' });
}

// 模型关联为有向关系：左侧已在结果集中，右侧加入新数据集。严格校验图结构，拒绝含歧义或未连通的关联。
function planRelations(relations) {
    const active = relations.filter(relation => relation.status === 'active');
    if (!active.length || active.length > 8) throw invalid('模型需要 1 至 8 条有效关联。');
    const ordered = [active[0]];
    const included = new Set([active[0].leftDatasetId, active[0].rightDatasetId]);
    if (included.size !== 2) throw invalid('关联必须连接不同的数据集。');
    const pending = active.slice(1);
    while (pending.length) {
        const index = pending.findIndex(relation => included.has(relation.leftDatasetId) && !included.has(relation.rightDatasetId));
        if (index < 0) throw invalid('模型关联必须从已有数据集连接到新的右侧数据集，不能存在环路或不相连的表。');
        const [relation] = pending.splice(index, 1);
        included.add(relation.rightDatasetId);
        ordered.push(relation);
    }
    return { relations: ordered, datasetIds: [...included] };
}

async function runDataModelAnalysis({ user, modelId, dimension, measure, aggregation = 'count', limit = 100 } = {}) {
    const { model } = await getDataModel(user, modelId);
    const plan = planRelations(model.relations || []);
    const datasets = new Map();
    for (const id of plan.datasetIds) {
        const dataset = await getDatasetForUser(user, id);
        datasets.set(id, { dataset, columns: await getAccessibleDatasetColumns(user, dataset), alias: `t${datasets.size}` });
    }
    for (const relation of plan.relations) {
        if (!['left', 'inner'].includes(relation.joinType)) throw invalid('模型包含不支持的关联类型。');
        await assertDatasetFieldsAccessible(user, datasets.get(relation.leftDatasetId).dataset, [relation.leftFieldKey]);
        await assertDatasetFieldsAccessible(user, datasets.get(relation.rightDatasetId).dataset, [relation.rightFieldKey]);
    }
    function field(ref, label) {
        const entry = datasets.get(ref?.datasetId);
        const column = entry?.columns.find(item => item.key === ref?.fieldKey);
        if (!column) throw invalid(`请选择模型中可访问的${label}字段。`);
        return `${entry.alias}.${sqlIdent(column.key)}`;
    }
    const dimensionSql = field(dimension, '分组');
    const kind = String(aggregation).toLowerCase();
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(kind)) throw invalid('不支持的汇总方式。');
    const valueSql = kind === 'count' ? 'COUNT(*)' : `${kind.toUpperCase()}(${numericValueSql(field(measure, '数值'))})`;
    const base = datasets.get(plan.datasetIds[0]);
    const from = [`read_parquet(${sqlLiteral(getDatasetPaths(base.dataset).parquetPath)}) ${base.alias}`];
    for (const relation of plan.relations) {
        const left = datasets.get(relation.leftDatasetId);
        const right = datasets.get(relation.rightDatasetId);
        from.push(`${relation.joinType.toUpperCase()} JOIN read_parquet(${sqlLiteral(getDatasetPaths(right.dataset).parquetPath)}) ${right.alias} ON CAST(${left.alias}.${sqlIdent(relation.leftFieldKey)} AS VARCHAR) = CAST(${right.alias}.${sqlIdent(relation.rightFieldKey)} AS VARCHAR)`);
    }
    const parsedLimit = Number.parseInt(limit, 10);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
    const rows = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`SELECT ${dimensionSql} AS "分组", ${valueSql} AS "汇总值" FROM ${from.join(' ')} GROUP BY 1 ORDER BY 2 DESC NULLS LAST, 1 LIMIT ${safeLimit + 1}`));
            return reader.getRowObjectsJson();
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    const warnings = ['汇总基于关联后的记录；一对多或多对多关系可能重复统计，请先预览关联质量并核对口径。'];
    if ([...datasets.values()].some(entry => entry.dataset.truncated || entry.dataset.is_truncated)) warnings.push('模型包含截断导入的数据集，结果仅覆盖已导入的数据范围。');
    return { columns: ['分组', '汇总值'], rows: rows.slice(0, safeLimit), truncated: rows.length > safeLimit, limit: safeLimit, datasetCount: datasets.size, warnings };
}

module.exports = { planRelations, runDataModelAnalysis };
