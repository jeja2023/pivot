'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../scripts/test_support/bi_modeling');
const { queryOne } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const models = require('../server/services/data-analysis/bi/models');
const repository = require('../server/repositories/analysis-production-models');
const flowPipeline = require('../server/services/data-analysis/bi/flow-pipeline');

test('内置算子、函数计算、自定义 SQL 与节点到节点实时预览完整闭环，且保持模型语义哈希不变', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const regionDict = await datasets.createDatasetFromRows({
        user,
        name: '地区字典',
        rows: [
            { 地区: '北', 大区负责人: '张敏' },
            { 地区: '南', 大区负责人: '李明' }
        ]
    });

    const beforeRow = await repository.get(model.id);
    const flowGraph = {
        nodes: [
            {
                id: 'op_src_dict',
                kind: 'source',
                name: '地区负责人输入',
                layout: { x: 40, y: 210 },
                config: { datasetId: regionDict.id }
            },
            {
                id: 'op_filter_north',
                kind: 'filter',
                name: '筛选大额明细',
                layout: { x: 320, y: 40 },
                config: {
                    match: 'all',
                    conditions: [{ field: '金额', operator: 'gte', value: '60' }]
                }
            },
            {
                id: 'op_formula_discount',
                kind: 'formula',
                name: '函数计算折后金额',
                layout: { x: 580, y: 40 },
                config: {
                    keepAll: true,
                    fields: [
                        { name: '折后金额', expression: 'ROUND(TRY_CAST("金额" AS DOUBLE) * 0.9, 2)' },
                        { name: '档位', expression: 'IF(TRY_CAST("金额" AS DOUBLE) >= 100, \'高额\', \'常规\')' }
                    ]
                }
            },
            {
                id: 'op_join_dict',
                kind: 'join',
                name: '关联大区负责人',
                layout: { x: 840, y: 120 },
                config: {
                    joinType: 'left',
                    keyPairs: [{ leftField: '地区', rightField: '地区' }]
                }
            },
            {
                id: 'op_agg_region',
                kind: 'aggregate',
                name: '按负责人汇总',
                layout: { x: 1100, y: 120 },
                config: {
                    groupBy: ['大区负责人'],
                    aggregations: [
                        { field: '折后金额', fn: 'sum', alias: '折后总金额' },
                        { field: '', fn: 'count', alias: '达标笔数' }
                    ]
                }
            },
            {
                id: 'op_custom_sql',
                kind: 'sql',
                name: '自定义 SQL 校验',
                layout: { x: 1360, y: 120 },
                config: {
                    sql: 'SELECT "大区负责人", "折后总金额", "达标笔数" FROM input_1 WHERE "达标笔数" >= 1 ORDER BY "折后总金额" DESC'
                }
            }
        ],
        edges: [
            { id: 'e1', fromNodeId: 'fact', toNodeId: 'op_filter_north' },
            { id: 'e2', fromNodeId: 'op_filter_north', toNodeId: 'op_formula_discount' },
            { id: 'e3', fromNodeId: 'op_formula_discount', toNodeId: 'op_join_dict' },
            { id: 'e4', fromNodeId: 'op_src_dict', toNodeId: 'op_join_dict' },
            { id: 'e5', fromNodeId: 'op_join_dict', toNodeId: 'op_agg_region' },
            { id: 'e6', fromNodeId: 'op_agg_region', toNodeId: 'op_custom_sql' }
        ]
    };

    const saved = await models.saveProductionDraft({
        user,
        modelId: model.id,
        body: {
            expectedVersion: model.version,
            definition: model.definition,
            canvasLayout: { fact: { x: 40, y: 40 } },
            flowGraph
        }
    });
    assert.equal(saved.flowGraph.nodes.length, 6);
    assert.equal(saved.flowGraph.edges.length, 6);

    const afterRow = await repository.get(model.id);
    assert.deepEqual(afterRow.definition_json, beforeRow.definition_json);
    assert.equal(afterRow.semantic_hash, beforeRow.semantic_hash);

    const reopened = await models.getProductionModel(user, model.id);
    assert.equal(reopened.model.flowGraph.nodes.length, 6);

    // 预览筛选节点：上游 3 行 -> 过滤后 2 行
    const filterPreview = await flowPipeline.previewModelNode({
        user,
        modelId: model.id,
        body: { targetNodeId: 'op_filter_north', definitionNodes: saved.definition.nodes, flowGraph: saved.flowGraph }
    });
    assert.equal(filterPreview.upstreamRows, 3);
    assert.equal(filterPreview.totalRows, 2);

    // 预览最终自定义 SQL 节点：验证内置函数、关联、聚合与 SQL 完整链路
    const sqlPreview = await flowPipeline.previewModelNode({
        user,
        modelId: model.id,
        body: { targetNodeId: 'op_custom_sql', definitionNodes: saved.definition.nodes, flowGraph: saved.flowGraph }
    });
    assert.equal(sqlPreview.totalRows, 1);
    assert.equal(sqlPreview.rows[0]['大区负责人'], '张敏');
    assert.equal(Number(sqlPreview.rows[0]['折后总金额']), 180.01);
    assert.equal(Number(sqlPreview.rows[0]['达标笔数']), 2);
    assert.ok(sqlPreview.steps.length >= 5);

    // 物化节点输出为标准受控数据集
    const materialized = await flowPipeline.materializeModelNodeDataset({
        user,
        modelId: model.id,
        body: {
            targetNodeId: 'op_custom_sql',
            datasetName: '大区负责人达标汇总',
            definitionNodes: saved.definition.nodes,
            flowGraph: saved.flowGraph
        }
    });
    assert.equal(materialized.dataset.name, '大区负责人达标汇总');
    assert.equal(materialized.dataset.rowCount, 1);
    assert.equal(materialized.dataset.columns.length, 3);

    const detail = await datasets.getDatasetDetail(user.id, materialized.dataset.id);
    assert.equal(detail.name, '大区负责人达标汇总');
}));

test('算子流与自定义 SQL 严格阻断外部文件读取、破坏性语句、循环连线与越权访问', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    // 阻断循环依赖
    await assert.rejects(
        models.saveProductionDraft({
            user,
            modelId: model.id,
            body: {
                expectedVersion: model.version,
                definition: model.definition,
                flowGraph: {
                    nodes: [
                        { id: 'n1', kind: 'filter', name: '步骤1', config: {} },
                        { id: 'n2', kind: 'filter', name: '步骤2', config: {} }
                    ],
                    edges: [
                        { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2' },
                        { id: 'e2', fromNodeId: 'n2', toNodeId: 'n1' }
                    ]
                }
            }
        }),
        error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID'
    );

    // 阻断自定义 SQL 中的本地文件读取函数与写操作
    for (const unsafeSql of [
        "SELECT * FROM read_parquet('/etc/passwd')",
        'DROP TABLE input_1',
        'COPY input_1 TO \'out.csv\''
    ]) {
        await assert.rejects(
            flowPipeline.previewModelNode({
                user,
                modelId: model.id,
                body: {
                    targetNodeId: 'bad_sql',
                    definitionNodes: model.definition.nodes,
                    flowGraph: {
                        nodes: [{ id: 'bad_sql', kind: 'sql', name: '非法SQL', config: { sql: unsafeSql } }],
                        edges: [{ id: 'e1', fromNodeId: 'fact', toNodeId: 'bad_sql' }]
                    }
                }
            }),
            error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID'
        );
    }

    // 阻断未授权用户预览个人草稿节点
    const admin = await queryOne("SELECT * FROM users WHERE username='admin'");
    await assert.rejects(
        flowPipeline.previewModelNode({
            user: admin,
            modelId: model.id,
            body: { targetNodeId: 'fact', definitionNodes: model.definition.nodes, flowGraph: { nodes: [], edges: [] } }
        }),
        error => [403, 404].includes(error.status)
    );
}));

