'use strict';
const schema = require('../../../client/common/mindmap-document');
const governance = require('../data-analysis/governance');
async function views(user) {
    const available = await governance.listSavedViews(user, { limit: 200 });
    // 首次接入只允许本人维护的图表视图，避免复制其他用户的共享字段结果。
    return available.filter(view => view.isOwner && view.viewType === 'chart').map(view => ({ id: view.id, name: view.name, datasetId: view.datasetId, version: view.version }));
}
async function preview(user, viewId) {
    if (typeof viewId !== 'string' || !/^[\w-]{1,96}$/.test(viewId)) throw schema.error('请选择有效的分析视图。');
    const { view } = await governance.getSavedView(user, viewId);
    const dataset = await require('../data-analysis/shared').getDatasetForUser(user, view.datasetId);
    if (!view.isOwner || Number(dataset.user_id) !== Number(user.id) || view.viewType !== 'chart') throw schema.error('请选择本人数据集的图表视图；共享视图暂不支持复制为导图。', 'MINDMAP_DATA_FORBIDDEN', 403);
    const { result, view: executedView } = await governance.runSavedView(user, viewId);
    const rows = result.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length >= schema.LIMITS.nodes || rows.some(row => typeof row !== 'object' || !Object.hasOwn(row, 'label') || !Object.hasOwn(row, 'value'))) throw schema.error('当前图表结果无法转换为导图，请选择不超过 119 项的分类汇总图。');
    const document = schema.normalize({ id: 'root', text: executedView.name, children: rows.map((row, index) => ({ id: `data-${index + 1}`, text: `${String(row.label)}${row.group_label ? ` / ${row.group_label}` : ''}：${row.value}`, children: [] })) });
    const description = `来自分析视图“${executedView.name}”第 ${executedView.version} 版；展示图表配置筛选与排序后的前 ${rows.length} 项聚合结果，可能不是全量数据。`;
    document.source = { datasetId: executedView.datasetId, viewId: executedView.id, viewVersion: executedView.version, generatedAt: new Date().toISOString(), description };
    document.presentation.nodes.root = { note: description };
    return schema.normalize(document);
}
async function datasets(user) {
    return (await require('../data-analysis/datasets').listDatasets(user)).map(dataset => ({ id: dataset.id, name: dataset.name, columns: dataset.columns.map(column => ({ key: column.key, name: column.name })) }));
}
function mapping(input = {}) {
    const value = { dimensions: input.dimensions, metric: input.metric || '', aggregation: input.aggregation || 'count', limit: input.limit ?? 100 };
    if (!Array.isArray(value.dimensions) || value.dimensions.length < 1 || value.dimensions.length > 5 || value.dimensions.some(key => typeof key !== 'string' || key.length > 96) || new Set(value.dimensions).size !== value.dimensions.length || !['count','sum','avg','min','max'].includes(value.aggregation) || typeof value.metric !== 'string' || value.metric.length > 96 || (value.aggregation !== 'count' && !value.metric) || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500) throw schema.error('请选择 1–5 个不同维度，最多生成 500 组汇总结果。');
    return value;
}
async function fromDataset(user, input = {}) {
    if (typeof input.datasetId !== 'string' || !/^[\w-]{1,96}$/.test(input.datasetId)) throw schema.error('请选择有效数据集。');
    const config = mapping(input.mapping);
    const { sqlIdent } = require('../data-analysis/shared');
    return require('../data-analysis/row-source').withDatasetColumns(user, input.datasetId, [...config.dimensions, ...(config.metric ? [config.metric] : [])], async ({ dataset, connection }) => {
        const expressions = config.dimensions.map(key => `COALESCE(NULLIF(TRIM(CAST(${sqlIdent(key)} AS VARCHAR)),''),'（空值）')`);
        const metric = config.metric ? `TRY_CAST(${sqlIdent(config.metric)} AS DECIMAL(38,8))` : '';
        if (config.metric && config.aggregation !== 'count') {
            const invalid = (await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM source WHERE ${sqlIdent(config.metric)} IS NOT NULL AND ${metric} IS NULL`)).getRowObjectsJson()[0];
            if (Number(invalid.n) > 0) throw schema.error('度量字段包含无法汇总的数字，请先清洗数据。');
        }
        const aggregate = config.aggregation === 'count' ? 'COUNT(*)' : `${config.aggregation.toUpperCase()}(${metric})`;
        const sql = `SELECT ${expressions.map((expr, index) => `${expr} AS d${index}`).join(',')},CAST(${aggregate} AS VARCHAR) AS value FROM source GROUP BY ${expressions.join(',')} ORDER BY ${expressions.map((_, index) => `d${index}`).join(',')} LIMIT ${config.limit + 1}`;
        const rows = (await connection.runAndReadAll(sql)).getRowObjectsJson(); const truncated = rows.length > config.limit; rows.length = Math.min(rows.length, config.limit);
        if (!rows.length) throw schema.error('数据集为空，无法生成导图。');
        const tree = { id: 'root', text: String(input.title || dataset.name).slice(0, 120), children: [] }; const groups = new Map(); let sequence = 0;
        for (const row of rows) {
            let parent = tree; const path = [];
            config.dimensions.forEach((_, index) => { const label = row[`d${index}`]; path.push(label); const key = JSON.stringify(path); let node = groups.get(key); if (!node) { node = { id: `data-${++sequence}`, text: String(label).slice(0, 100), children: [] }; parent.children.push(node); groups.set(key, node); } parent = node; });
            parent.text = `${parent.text}：${String(row.value || '0')}`.slice(0, 120);
        }
        const description = `来自数据集“${dataset.name}”；按 ${config.dimensions.length} 个维度进行 ${config.aggregation} 汇总，当前 ${rows.length} 组${truncated ? '，已达到组数上限，结果被截断' : ''}。复制为个人导图后保留当前快照；来源撤权后停止刷新。`;
        const document = schema.normalize(tree);
        document.presentation.nodes.root = { note: description };
        document.source = { datasetId: dataset.id, viewId: 'dataset-mapping', viewVersion: 1, datasetRevision: String(dataset.updated_at), generatedAt: new Date().toISOString(), description, mapping: config, refreshMode: input.refreshMode === 'auto' ? 'auto' : 'manual' };
        const latest = await require('../data-analysis/shared').getDatasetForUser(user, dataset.id);
        if (String(latest.updated_at) !== String(dataset.updated_at)) throw schema.error('生成期间数据源已更新，请重新生成预览。', 'MINDMAP_SOURCE_CHANGED', 409);
        return schema.normalize(document);
    });
}
async function refresh(user, artifactId, input = {}) {
    const documents = require('./documents'); const current = await documents.get(user, artifactId);
    if (current.role !== 'owner' || !current.document.source?.mapping) throw schema.error('只有所有者可以刷新来自数据集的导图。', 'MINDMAP_SOURCE_FORBIDDEN', 403);
    const source = current.document.source;
    const next = await fromDataset(user, { datasetId: source.datasetId, mapping: source.mapping, refreshMode: source.refreshMode, title: current.document.tree.text });
    if (JSON.stringify(next.tree) === JSON.stringify(current.document.tree) && next.source.datasetRevision === source.datasetRevision) return { ...current, unchanged: true };
    next.presentation = { ...current.document.presentation, nodes: next.presentation.nodes };
    return documents.save(user, { artifactId, expectedVersionId: input.expectedVersionId, requestKey: input.requestKey, document: next, note: '按已保存的映射刷新数据导图' });
}
module.exports = { views, preview, datasets, fromDataset, refresh };
