const { recoverStaleKnowledgeDocumentIndexes } = require('./services/rag-documents');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');
const {
    runs: { recoverAgentRuns, startAgentRecoveryRunner },
    schedules: { startAgentScheduleRunner }
} = require('./services/agent-runtime');
const { createAgentEventOutboxDispatcher } = require('./services/agent-event-outbox');
const { createSkillReleaseBreakerRunner } = require('./services/agent-skill-breaker');
const { startRuntimeDiagnostics } = require('./services/runtime-diagnostics');

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
        recoverAgentRuns,
        startAgentRecoveryRunner,
        startAgentScheduleRunner,
        startAgentEventOutboxDispatcher: () => createAgentEventOutboxDispatcher({ logger }).start(),
        startSkillReleaseBreakerRunner: () => createSkillReleaseBreakerRunner().start(),
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
        runBackgroundTask(dependencies.recoverStaleKnowledgeDocumentIndexes, logger, '知识库索引恢复执行失败');
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
    });
}

module.exports = {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
};
