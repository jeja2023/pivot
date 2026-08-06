const { recoverStaleKnowledgeDocumentIndexes } = require('./services/rag-documents');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');
const { recoverAgentRuns, startAgentScheduleRunner } = require('./services/agent-runtime');

function registerProcessErrorHandlers({ logger, flushAllSqliteWrites, processRef = process, setTimeoutFn = setTimeout }) {
    let fatalExitScheduled = false;

    const fatalExit = (reason, err) => {
        logger.fatal({ err }, reason);
        try {
            flushAllSqliteWrites();
        } catch (flushErr) {
            logger.warn({ err: flushErr }, 'Failed to flush SQLite write queue during fatal exit');
        }
        if (fatalExitScheduled) return;
        fatalExitScheduled = true;
        setTimeoutFn(() => processRef.exit(1), 250).unref();
    };

    processRef.on('uncaughtException', (err) => fatalExit('Uncaught exception', err));
    processRef.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        logger.error({ err }, 'Unhandled promise rejection');
    });

    return { fatalExit };
}

function createMaintenanceScheduler({ delayMs, logger, startMaintenanceTasks, setTimeoutFn = setTimeout }) {
    return function scheduleMaintenanceTasks() {
        const start = () => {
            try {
                startMaintenanceTasks();
            } catch (err) {
                logger.error({ err }, 'Background maintenance startup failed');
            }
        };
        if (delayMs <= 0) {
            start();
            return;
        }
        logger.info({ delayMs }, 'Background maintenance will start after the server is ready');
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
        startAgentScheduleRunner
    }
}) {
    dependencies.startGpuMonitor().catch(err => {
        logger.warn({ err: err && err.message ? err.message : err }, 'GPU monitor startup failed');
    });
    dependencies.startModelEndpointMonitor().catch(err => {
        logger.warn({ err: err && err.message ? err.message : err }, 'Model endpoint monitor startup failed');
    });
    setImmediateFn(() => {
        try { dependencies.recoverStaleKnowledgeDocumentIndexes(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, 'Knowledge index recovery failed');
        }
        try { dependencies.recoverAgentRuns(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, 'Agent run recovery failed');
        }
        try { dependencies.startAgentScheduleRunner(); } catch (err) {
            logger.warn({ err: err && err.message ? err.message : err }, 'Agent schedule runner startup failed');
        }
    });
}

module.exports = {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
};
