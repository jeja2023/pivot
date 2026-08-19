const { recoverStaleKnowledgeDocumentIndexes } = require('./services/rag-documents');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');
const { recoverAgentRuns, startAgentRecoveryRunner, startAgentScheduleRunner } = require('./services/agent-runtime');

function registerProcessErrorHandlers({ logger, flushAllWrites, processRef = process, setTimeoutFn = setTimeout }) {
    let fatalExitScheduled = false;

    const fatalExit = (reason, err) => {
        logger.fatal({ err }, reason);
        try {
            const flushResult = typeof flushAllWrites === 'function' ? flushAllWrites() : null;
            if (flushResult && typeof flushResult.catch === 'function') {
                flushResult.catch(flushErr => {
                    logger.warn({ err: flushErr }, '致命退出时刷新写队列失败');
                });
            }
        } catch (flushErr) {
            logger.warn({ err: flushErr }, '致命退出时刷新写队列失败');
        }
        if (fatalExitScheduled) return;
        fatalExitScheduled = true;
        setTimeoutFn(() => processRef.exit(1), 250).unref();
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

function startBackgroundServices({
    logger,
    setImmediateFn = setImmediate,
    dependencies = {
        startGpuMonitor,
        startModelEndpointMonitor,
        recoverStaleKnowledgeDocumentIndexes,
        recoverAgentRuns,
        startAgentRecoveryRunner,
        startAgentScheduleRunner
    }
}) {
    dependencies.startGpuMonitor().catch(err => {
        logger.warn({ err: err && err.message ? err.message : err }, 'GPU 监控服务启动失败');
    });
    dependencies.startModelEndpointMonitor().catch(err => {
        logger.warn({ err: err && err.message ? err.message : err }, '模型端点监控服务启动失败');
    });
    setImmediateFn(() => {
        try { dependencies.recoverStaleKnowledgeDocumentIndexes(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, '知识库索引恢复执行失败');
        }
        try { dependencies.recoverAgentRuns(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, '智能体任务恢复执行失败');
        }
        if (typeof dependencies.startAgentRecoveryRunner === 'function') {
            try { dependencies.startAgentRecoveryRunner(); } catch (err) {
                logger.warn({ err: err && err.message ? err.message : err }, '智能体周期性恢复服务启动失败');
            }
        }
        try { dependencies.startAgentScheduleRunner(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, '智能体计划调度器启动失败');
        }
    });
}

module.exports = {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
};
