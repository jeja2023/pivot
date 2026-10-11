'use strict';

const { asyncHandler } = require('../../http');
const {
    listFieldGovernance, updateFieldGovernance, previewCalculatedField, materializeCalculatedField, listCalculatedFields,
    listSavedViews, saveAnalysisView, getSavedView, runSavedView, deleteSavedView,
    listDashboards, getDashboard, saveDashboard, saveDashboardItem, deleteDashboardItem, refreshDashboard,
    listRefreshSchedules, saveRefreshSchedule, saveAlertRule, getAlertRule, listAlertRules, getDatasetSourceState,
    listMetricDefinitions, saveMetricDefinition, evaluateMetricDefinition,
    getDataModel, listDataModels, saveDataModel, addDataModelRelation, runDataModelJoin,
    createAsyncQueryJob, getAsyncQueryJob, listAsyncQueryJobs, cancelAsyncQueryJob,
    getScalabilityState, createDatasetPartitions, listMaterializations, saveMaterialization
} = require('../../services/data-analysis');

function registerDataAnalysisProductRoutes(router, { authMiddleware, logAction }) {
    router.get('/apps/data-analysis/datasets/:id/fields', authMiddleware, asyncHandler(async (req, res) => res.json({ fields: await listFieldGovernance(req.user, req.params.id) })));
    router.put('/apps/data-analysis/datasets/:id/fields', authMiddleware, asyncHandler(async (req, res) => {
        const result = await updateFieldGovernance({ user: req.user, datasetId: req.params.id, fields: req.body?.fields });
        logAction(req, '数据分析-更新字段治理', `数据集: ${req.params.id}，字段数: ${result.fields.length}`);
        res.json({ success: true, ...result });
    }));
    router.get('/apps/data-analysis/datasets/:id/source-state', authMiddleware, asyncHandler(async (req, res) => res.json(await getDatasetSourceState(req.user, req.params.id))));
    router.get('/apps/data-analysis/datasets/:id/calculated-fields', authMiddleware, asyncHandler(async (req, res) => res.json({ fields: await listCalculatedFields(req.user, req.params.id) })));
    router.post('/apps/data-analysis/datasets/:id/calculated-fields/preview', authMiddleware, asyncHandler(async (req, res) => res.json(await previewCalculatedField({ user: req.user, datasetId: req.params.id, input: req.body || {} }))));
    router.post('/apps/data-analysis/datasets/:id/calculated-fields', authMiddleware, asyncHandler(async (req, res) => {
        const result = await materializeCalculatedField({ user: req.user, datasetId: req.params.id, input: req.body || {} });
        logAction(req, '数据分析-创建计算字段', `源数据集: ${req.params.id}，派生数据集: ${result.dataset.id}`);
        res.status(201).json({ success: true, ...result });
    }));

    router.get('/apps/data-analysis/views', authMiddleware, asyncHandler(async (req, res) => res.json({ views: await listSavedViews(req.user, { datasetId: req.query?.datasetId, limit: req.query?.limit }) })));
    router.post('/apps/data-analysis/datasets/:id/views', authMiddleware, asyncHandler(async (req, res) => {
        const view = await saveAnalysisView({ user: req.user, datasetId: req.params.id, body: req.body || {} });
        logAction(req, '数据分析-保存分析视图', `数据集: ${req.params.id}，视图: ${view.id}`);
        res.status(201).json({ success: true, view });
    }));
    router.put('/apps/data-analysis/datasets/:id/views/:viewId', authMiddleware, asyncHandler(async (req, res) => {
        const view = await saveAnalysisView({ user: req.user, datasetId: req.params.id, viewId: req.params.viewId, body: req.body || {} });
        logAction(req, '数据分析-更新分析视图', `数据集: ${req.params.id}，视图: ${view.id}`);
        res.json({ success: true, view });
    }));
    router.get('/apps/data-analysis/views/:viewId', authMiddleware, asyncHandler(async (req, res) => res.json({ view: (await getSavedView(req.user, req.params.viewId)).view })));
    router.post('/apps/data-analysis/views/:viewId/run', authMiddleware, asyncHandler(async (req, res) => {
        const result = await runSavedView(req.user, req.params.viewId);
        logAction(req, '数据分析-运行分析视图', `视图: ${req.params.viewId}`);
        res.json(result);
    }));
    router.delete('/apps/data-analysis/views/:viewId', authMiddleware, asyncHandler(async (req, res) => {
        const result = await deleteSavedView(req.user, req.params.viewId);
        logAction(req, '数据分析-删除分析视图', `视图: ${req.params.viewId}`);
        res.json({ success: true, ...result });
    }));

    router.get('/apps/data-analysis/dashboards', authMiddleware, asyncHandler(async (req, res) => res.json({ dashboards: await listDashboards(req.user, { limit: req.query?.limit }) })));
    router.post('/apps/data-analysis/dashboards', authMiddleware, asyncHandler(async (req, res) => {
        const dashboard = await saveDashboard({ user: req.user, body: req.body || {} });
        logAction(req, '数据分析-创建仪表盘', `仪表盘: ${dashboard.id}`);
        res.status(201).json({ success: true, dashboard });
    }));
    router.get('/apps/data-analysis/dashboards/:dashboardId', authMiddleware, asyncHandler(async (req, res) => res.json({ dashboard: (await getDashboard(req.user, req.params.dashboardId)).dashboard })));
    router.put('/apps/data-analysis/dashboards/:dashboardId', authMiddleware, asyncHandler(async (req, res) => {
        const dashboard = await saveDashboard({ user: req.user, dashboardId: req.params.dashboardId, body: req.body || {} });
        logAction(req, '数据分析-更新仪表盘', `仪表盘: ${dashboard.id}`);
        res.json({ success: true, dashboard });
    }));
    router.post('/apps/data-analysis/dashboards/:dashboardId/items', authMiddleware, asyncHandler(async (req, res) => {
        const item = await saveDashboardItem({ user: req.user, dashboardId: req.params.dashboardId, body: req.body || {} });
        logAction(req, '数据分析-添加仪表盘项目', `仪表盘: ${req.params.dashboardId}，项目: ${item.id}`);
        res.status(201).json({ success: true, item });
    }));
    router.put('/apps/data-analysis/dashboards/:dashboardId/items/:itemId', authMiddleware, asyncHandler(async (req, res) => {
        const item = await saveDashboardItem({ user: req.user, dashboardId: req.params.dashboardId, itemId: req.params.itemId, body: req.body || {} });
        logAction(req, '数据分析-更新仪表盘项目', `仪表盘: ${req.params.dashboardId}，项目: ${item.id}`);
        res.json({ success: true, item });
    }));
    router.delete('/apps/data-analysis/dashboards/:dashboardId/items/:itemId', authMiddleware, asyncHandler(async (req, res) => {
        const result = await deleteDashboardItem({ user: req.user, dashboardId: req.params.dashboardId, itemId: req.params.itemId });
        logAction(req, '数据分析-删除仪表盘项目', `仪表盘: ${req.params.dashboardId}，项目: ${result.id}`);
        res.json({ success: true, ...result });
    }));
    router.post('/apps/data-analysis/dashboards/:dashboardId/refresh', authMiddleware, asyncHandler(async (req, res) => {
        const result = await refreshDashboard({ user: req.user, dashboardId: req.params.dashboardId });
        logAction(req, '数据分析-刷新仪表盘', `仪表盘: ${req.params.dashboardId}，运行: ${result.runId}`);
        res.status(202).json({ success: true, ...result });
    }));
    router.get('/apps/data-analysis/refresh-schedules', authMiddleware, asyncHandler(async (req, res) => res.json({ schedules: await listRefreshSchedules(req.user, { dashboardId: req.query?.dashboardId }) })));
    router.post('/apps/data-analysis/refresh-schedules', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = await saveRefreshSchedule({ user: req.user, body: req.body || {} });
        logAction(req, '数据分析-创建刷新计划', `计划: ${schedule.id}`);
        res.status(201).json({ success: true, schedule });
    }));
    router.put('/apps/data-analysis/refresh-schedules/:scheduleId', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = await saveRefreshSchedule({ user: req.user, scheduleId: req.params.scheduleId, body: req.body || {} });
        logAction(req, '数据分析-更新刷新计划', `计划: ${schedule.id}`);
        res.json({ success: true, schedule });
    }));
    router.get('/apps/data-analysis/alerts', authMiddleware, asyncHandler(async (req, res) => res.json({ alerts: await listAlertRules(req.user, { datasetId: req.query?.datasetId }) })));
    router.post('/apps/data-analysis/alerts', authMiddleware, asyncHandler(async (req, res) => {
        const alert = await saveAlertRule({ user: req.user, body: req.body || {} });
        logAction(req, '数据分析-创建数据告警', `告警: ${alert.id}`);
        res.status(201).json({ success: true, alert });
    }));
    router.put('/apps/data-analysis/alerts/:alertId', authMiddleware, asyncHandler(async (req, res) => {
        const alert = await saveAlertRule({ user: req.user, alertId: req.params.alertId, body: req.body || {} });
        logAction(req, '数据分析-更新数据告警', `告警: ${alert.id}`);
        res.json({ success: true, alert });
    }));
    router.get('/apps/data-analysis/alerts/:alertId', authMiddleware, asyncHandler(async (req, res) => res.json({ alert: await getAlertRule(req.user, req.params.alertId) })));

    router.get('/apps/data-analysis/metrics', authMiddleware, asyncHandler(async (req, res) => res.json({ metrics: await listMetricDefinitions(req.user, { datasetId: req.query?.datasetId, limit: req.query?.limit }) })));
    router.post('/apps/data-analysis/datasets/:id/metrics', authMiddleware, asyncHandler(async (req, res) => {
        const metric = await saveMetricDefinition({ user: req.user, datasetId: req.params.id, body: req.body || {} });
        logAction(req, '数据分析-创建指标口径', `数据集: ${req.params.id}，指标: ${metric.id}`);
        res.status(201).json({ success: true, metric });
    }));
    router.put('/apps/data-analysis/datasets/:id/metrics/:metricId', authMiddleware, asyncHandler(async (req, res) => {
        const metric = await saveMetricDefinition({ user: req.user, datasetId: req.params.id, metricId: req.params.metricId, body: req.body || {} });
        logAction(req, '数据分析-更新指标口径', `数据集: ${req.params.id}，指标: ${metric.id}`);
        res.json({ success: true, metric });
    }));
    router.post('/apps/data-analysis/metrics/:metricId/evaluate', authMiddleware, asyncHandler(async (req, res) => {
        const result = await evaluateMetricDefinition(req.user, req.params.metricId);
        logAction(req, '数据分析-计算指标口径', `指标: ${req.params.metricId}`);
        res.json(result);
    }));

    router.get('/apps/data-analysis/models', authMiddleware, asyncHandler(async (req, res) => res.json({ models: await listDataModels(req.user, { limit: req.query?.limit }) })));
    router.post('/apps/data-analysis/models', authMiddleware, asyncHandler(async (req, res) => {
        const model = await saveDataModel({ user: req.user, body: req.body || {} });
        logAction(req, '数据分析-创建数据模型', `模型: ${model.id}`);
        res.status(201).json({ success: true, model });
    }));
    router.get('/apps/data-analysis/models/:modelId', authMiddleware, asyncHandler(async (req, res) => res.json({ model: (await getDataModel(req.user, req.params.modelId)).model })));
    router.put('/apps/data-analysis/models/:modelId', authMiddleware, asyncHandler(async (req, res) => {
        const model = await saveDataModel({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        logAction(req, '数据分析-更新数据模型', `模型: ${model.id}`);
        res.json({ success: true, model });
    }));
    router.post('/apps/data-analysis/models/:modelId/relations', authMiddleware, asyncHandler(async (req, res) => {
        const relation = await addDataModelRelation({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        logAction(req, '数据分析-创建数据模型关联', `模型: ${req.params.modelId}，关联: ${relation.id}`);
        res.status(201).json({ success: true, relation });
    }));
    router.put('/apps/data-analysis/models/:modelId/relations/:relationId', authMiddleware, asyncHandler(async (req, res) => {
        const relation = await addDataModelRelation({ user: req.user, modelId: req.params.modelId, relationId: req.params.relationId, body: req.body || {} });
        logAction(req, '数据分析-更新数据模型关联', `模型: ${req.params.modelId}，关联: ${relation.id}`);
        res.json({ success: true, relation });
    }));
    router.post('/apps/data-analysis/models/:modelId/query', authMiddleware, asyncHandler(async (req, res) => {
        const result = await runDataModelJoin({ user: req.user, modelId: req.params.modelId, relationId: req.body?.relationId, limit: req.body?.limit });
        logAction(req, '数据分析-运行跨数据集关联', `模型: ${req.params.modelId}，关联: ${result.relation.id}`);
        res.json(result);
    }));

    router.post('/apps/data-analysis/datasets/:id/async-queries', authMiddleware, asyncHandler(async (req, res) => {
        const job = await createAsyncQueryJob({ user: req.user, datasetId: req.params.id, sql: req.body?.sql, limit: req.body?.limit });
        logAction(req, '数据分析-创建异步查询任务', `数据集: ${req.params.id}，任务: ${job.id}`);
        res.status(202).json({ success: true, job });
    }));
    router.get('/apps/data-analysis/datasets/:id/async-queries', authMiddleware, asyncHandler(async (req, res) => res.json({ jobs: await listAsyncQueryJobs(req.user, { datasetId: req.params.id, limit: req.query?.limit }) })));
    router.get('/apps/data-analysis/async-queries/:jobId', authMiddleware, asyncHandler(async (req, res) => res.json({ job: await getAsyncQueryJob(req.user, req.params.jobId) })));
    router.post('/apps/data-analysis/async-queries/:jobId/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const job = await cancelAsyncQueryJob(req.user, req.params.jobId);
        logAction(req, '数据分析-取消异步查询任务', `任务: ${req.params.jobId}`);
        res.json({ success: true, job });
    }));

    router.get('/apps/data-analysis/datasets/:id/scalability', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await getScalabilityState(req.user, req.params.id));
    }));
    router.post('/apps/data-analysis/datasets/:id/partitions', authMiddleware, asyncHandler(async (req, res) => {
        const result = await createDatasetPartitions({ user: req.user, datasetId: req.params.id, fieldKey: req.body?.fieldKey });
        logAction(req, '数据分析-创建分区Parquet', `数据集: ${req.params.id}，字段: ${result.fieldKey}，分区: ${result.partitionCount}`);
        res.status(201).json({ success: true, ...result });
    }));
    router.get('/apps/data-analysis/datasets/:id/materializations', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ materializations: await listMaterializations(req.user, req.params.id) });
    }));
    router.post('/apps/data-analysis/datasets/:id/materializations', authMiddleware, asyncHandler(async (req, res) => {
        const materialization = await saveMaterialization({ user: req.user, datasetId: req.params.id, body: req.body || {} });
        logAction(req, '数据分析-创建物化聚合', `数据集: ${req.params.id}，物化: ${materialization.id}`);
        res.status(201).json({ success: true, materialization });
    }));
    router.put('/apps/data-analysis/datasets/:id/materializations/:materializationId', authMiddleware, asyncHandler(async (req, res) => {
        const materialization = await saveMaterialization({ user: req.user, datasetId: req.params.id, materializationId: req.params.materializationId, body: req.body || {} });
        logAction(req, '数据分析-刷新物化聚合', `数据集: ${req.params.id}，物化: ${materialization.id}`);
        res.json({ success: true, materialization });
    }));
}

module.exports = { registerDataAnalysisProductRoutes };
