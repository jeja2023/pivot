const {
    recoverStaleKnowledgeDocumentIndexes,
    startKnowledgeIngestionWorker,
    createKnowledgeEmbeddingRecoveryRunner,
    scheduleEmbeddingProfileMismatchedDocuments
} = require('./services/rag-documents');
const { recoverKnowledgeEvaluationRuns } = require('./services/knowledge-evaluations');
const { createKnowledgeSourceSyncScheduler } = require('./services/knowledge-sources');
const { backfillKnowledgeProductProjections, refreshKnowledgeFreshness } = require('./services/knowledge-content');
const { recoverManualKnowledgeArticleEmbeddings } = require('./services/knowledge-manual-embeddings');
const { createKnowledgeWikiCompileWorker } = require('./services/knowledge-wiki');
const { createKnowledgeGraphMaintenanceRunner } = require('./services/knowledge-graph');
const { createKnowledgeSourceLifecycleWorker } = require('./services/knowledge-source-lifecycle');
const { createWorkspaceMemorySourceLifecycleWorker } = require('./services/workspace-memory-source-lifecycle');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');
const {
    runs: { recoverAgentRuns, startAgentRecoveryRunner },
    schedules: { startAgentScheduleRunner }
} = require('./services/agent-runtime');
const { createAgentEventOutboxDispatcher } = require('./services/agent-event-outbox');
const { createSkillReleaseBreakerRunner } = require('./services/agent-skill-breaker');
const { createWorkflowReleaseBreakerRunner } = require('./services/agent-workflow-breaker');
const { startRuntimeDiagnostics } = require('./services/runtime-diagnostics');
const { startLongTermMemoryMaintenanceRunner } = require('./services/long-term-memory');
const { createMemoryOutcomeMetricsRunner } = require('./services/long-term-memory/memory-outcome-metrics');
const { startDecisionLearningMaintenanceRunner } = require('./services/decision-maintenance');
const { createDecisionArtifactBreakerRunner } = require('./services/decision-artifact-breaker');
const { startAnalysisRefreshRunner, startAsyncQueryRunner } = require('./services/data-analysis');
const { startRegulationImportWorker, startRegulationIndexRecoveryRunner } = require('./services/regulations');

function registerProcessErrorHandlers({ logger, flushAllWrites, processRef = process, setTimeoutFn = setTimeout }) {
    let fatalExitScheduled = false;

    const fatalExit = (reason, err) => {
        if (fatalExitScheduled) return;
        fatalExitScheduled = true;
        logger.fatal({ err }, reason);
        const flushResult = typeof flushAllWrites === 'function' ? flushAllWrites() : null;
        const flushPromise = flushResult && typeof flushResult.then === 'function' ? flushResult : Promise.resolve();
        Promise.race([
            flushPromise.catch(flushErr => logger.warn({ err: flushErr }, '致命退出时刷新写队列失败')),
            new Promise(resolve => {
                const timer = setTimeoutFn(resolve, 5000);
                timer?.unref?.();
            })
        ]).finally(() => processRef.exit(1));
    };

    processRef.on('uncaughtException', (err) => fatalExit('未捕获的全局异常', err));
    processRef.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        logger.error({ err }, '未处理的 Promise 拒绝');
    });

    return { fatalExit };
}

function createMaintenanceScheduler({ delayMs, logger, startMaintenanceTasks, setTimeoutFn = setTimeout }) {
    return function scheduleMaintenanceTasks() {
        const start = () => {
            try {
                startMaintenanceTasks();
            } catch (err) {
                logger.error({ err }, '后台维护服务启动失败');
            }
        };
        if (delayMs <= 0) {
            start();
            return;
        }
        logger.info({ delayMs }, '后台维护服务将在服务就绪后启动');
        setTimeoutFn(start, delayMs).unref();
    };
}

function runBackgroundTask(task, logger, failureMessage) {
    if (typeof task !== 'function') return;
    return Promise.resolve()
        .then(() => task())
        .catch(err => {
            logger.warn({ err: err && err.message ? err.message : err }, failureMessage);
        });
}

function startBackgroundServices({
    logger,
    setImmediateFn = setImmediate,
    dependencies = {
        startGpuMonitor,
        startModelEndpointMonitor,
        recoverStaleKnowledgeDocumentIndexes,
        startKnowledgeIngestionWorker,
        startRegulationImportWorker,
        startRegulationIndexRecoveryRunner,
        recoverKnowledgeEvaluationRuns,
        refreshKnowledgeFreshness,
        backfillKnowledgeProductProjections,
        recoverManualKnowledgeArticleEmbeddings,
        startKnowledgeWikiCompileWorker: () => {
            const worker = createKnowledgeWikiCompileWorker({ logger });
            return worker?.start?.() || null;
        },
        startKnowledgeSourceLifecycleWorker: () => createKnowledgeSourceLifecycleWorker({ logger }).start(),
        startWorkspaceMemorySourceLifecycleWorker: () => createWorkspaceMemorySourceLifecycleWorker({ logger }).start(),
        startKnowledgeGraphMaintenanceRunner: () => createKnowledgeGraphMaintenanceRunner({ logger }).start(),
        startKnowledgeEmbeddingRecoveryRunner: () => createKnowledgeEmbeddingRecoveryRunner({
            recover: async () => {
                const [lexical, mismatched, manual] = await Promise.all([
                    require('./services/rag-documents').scheduleLexicalReadyKnowledgeDocuments(),
                    scheduleEmbeddingProfileMismatchedDocuments(),
                    recoverManualKnowledgeArticleEmbeddings()
                ]);
                return { scheduled: Number(lexical.scheduled || 0) + Number(mismatched.scheduled || 0) + Number(manual.ready || 0), lexical, mismatched, manual };
            }
        }).start(),
        startKnowledgeSourceSyncScheduler: () => createKnowledgeSourceSyncScheduler().start(),
        recoverAgentRuns,
        startAgentRecoveryRunner,
        startAgentScheduleRunner,
        startAgentEventOutboxDispatcher: () => createAgentEventOutboxDispatcher({ logger }).start(),
        startSkillReleaseBreakerRunner: () => createSkillReleaseBreakerRunner().start(),
        startWorkflowReleaseBreakerRunner: () => createWorkflowReleaseBreakerRunner().start(),
        startLongTermMemoryMaintenanceRunner,
        startMemoryOutcomeMetricsRunner: () => createMemoryOutcomeMetricsRunner({ logger }).start(),
        startDecisionLearningMaintenanceRunner,
        startDecisionArtifactBreakerRunner: () => createDecisionArtifactBreakerRunner().start(),
        startAnalysisRefreshRunner,
        startAsyncQueryRunner,
        startRuntimeDiagnostics
    }
}) {
    // 运行时压力采样必须最先起来：故障往往在数小时后才发作，届时需要有历史序列可查。
    if (typeof dependencies.startRuntimeDiagnostics === 'function') {
        try { dependencies.startRuntimeDiagnostics(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, '运行时压力采样启动失败');
        }
    }
    runBackgroundTask(dependencies.startGpuMonitor, logger, 'GPU 监控服务启动失败');
    runBackgroundTask(dependencies.startModelEndpointMonitor, logger, '模型端点监控服务启动失败');
    setImmediateFn(() => {
        runBackgroundTask(dependencies.startKnowledgeIngestionWorker, logger, '知识库持久化索引 Worker 启动失败');
        runBackgroundTask(dependencies.startRegulationImportWorker, logger, '法规导入任务 Worker 启动失败');
        runBackgroundTask(dependencies.startRegulationIndexRecoveryRunner, logger, '法规向量索引恢复巡检器启动失败');
        runBackgroundTask(dependencies.recoverStaleKnowledgeDocumentIndexes, logger, '知识库索引恢复执行失败');
        runBackgroundTask(dependencies.recoverKnowledgeEvaluationRuns, logger, '知识库评测运行恢复失败');
        runBackgroundTask(dependencies.refreshKnowledgeFreshness, logger, '知识库文档新鲜度巡检失败');
        runBackgroundTask(dependencies.backfillKnowledgeProductProjections, logger, '知识库历史产品投影回填失败');
        runBackgroundTask(dependencies.recoverManualKnowledgeArticleEmbeddings, logger, '人工知识文章向量补齐失败');
        if (typeof dependencies.startKnowledgeWikiCompileWorker === 'function') {
            runBackgroundTask(dependencies.startKnowledgeWikiCompileWorker, logger, '知识 Wiki 编译 Worker 启动失败');
        }
        if (typeof dependencies.startKnowledgeSourceLifecycleWorker === 'function') {
            runBackgroundTask(dependencies.startKnowledgeSourceLifecycleWorker, logger, '知识来源生命周期 Worker 启动失败');
        }
        if (typeof dependencies.startWorkspaceMemorySourceLifecycleWorker === 'function') {
            runBackgroundTask(dependencies.startWorkspaceMemorySourceLifecycleWorker, logger, '代码工作区记忆来源 Worker 启动失败');
        }
        if (typeof dependencies.startKnowledgeGraphMaintenanceRunner === 'function') {
            runBackgroundTask(dependencies.startKnowledgeGraphMaintenanceRunner, logger, '知识图谱自动维护任务启动失败');
        }
        runBackgroundTask(dependencies.startKnowledgeEmbeddingRecoveryRunner, logger, '知识库向量补齐巡检器启动失败');
        runBackgroundTask(dependencies.startKnowledgeSourceSyncScheduler, logger, '知识库局域网来源同步调度器启动失败');
        runBackgroundTask(dependencies.recoverAgentRuns, logger, '智能体任务恢复执行失败');
        if (typeof dependencies.startAgentRecoveryRunner === 'function') {
            runBackgroundTask(dependencies.startAgentRecoveryRunner, logger, '智能体周期性恢复服务启动失败');
        }
        runBackgroundTask(dependencies.startAgentScheduleRunner, logger, '智能体计划调度器启动失败');
        if (typeof dependencies.startAgentEventOutboxDispatcher === 'function') {
            runBackgroundTask(dependencies.startAgentEventOutboxDispatcher, logger, 'Agent 事件 outbox 投递器启动失败');
        }
        // 技能发布熔断巡检：达到冻结阈值即自动回滚或暂停，避免坏版本长时间留在灰度里。
        if (typeof dependencies.startSkillReleaseBreakerRunner === 'function') {
            runBackgroundTask(dependencies.startSkillReleaseBreakerRunner, logger, '技能发布熔断巡检器启动失败');
        }
        if (typeof dependencies.startWorkflowReleaseBreakerRunner === 'function') {
            runBackgroundTask(dependencies.startWorkflowReleaseBreakerRunner, logger, '工作流发布熔断巡检器启动失败');
        }
        runBackgroundTask(dependencies.startLongTermMemoryMaintenanceRunner, logger, '长期记忆生命周期巡检器启动失败');
        if (typeof dependencies.startMemoryOutcomeMetricsRunner === 'function') {
            runBackgroundTask(dependencies.startMemoryOutcomeMetricsRunner, logger, '长期记忆效用周期指标刷新失败');
        }
        runBackgroundTask(dependencies.startDecisionLearningMaintenanceRunner, logger, '智能决策学习维护巡检器启动失败');
        runBackgroundTask(dependencies.startDecisionArtifactBreakerRunner, logger, '智能决策模型制品熔断巡检器启动失败');
        runBackgroundTask(dependencies.startAnalysisRefreshRunner, logger, '数据分析刷新与告警调度器启动失败');
        runBackgroundTask(dependencies.startAsyncQueryRunner, logger, '数据分析异步查询 Worker 启动失败');
    });
}

module.exports = {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
};
