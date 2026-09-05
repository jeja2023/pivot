const { app, appConfig, appVersion, logger, flushAllWrites } = require('./app');
const {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
} = require('./bootstrap');
const { startHttpServer } = require('./server');
const { startMaintenanceTasks } = require('./services/maintenance');
const { recoverDocumentProcessingJobs } = require('./services/document-processing/jobs');
const { assertDeploymentReady } = require('./services/deployment-profile');

const { initPostgresDatabase } = require('./db');

registerProcessErrorHandlers({ logger, flushAllWrites });

async function init() {
    await initPostgresDatabase();
    // A cluster rollout can opt into a hard startup gate. Without it, the
    // profile remains observable and degrades safely to single-node mode for
    // staged infrastructure migrations.
    assertDeploymentReady();
    await recoverDocumentProcessingJobs();
    startBackgroundServices({ logger });

    const scheduleMaintenanceTasks = createMaintenanceScheduler({
        delayMs: appConfig.maintenanceStartDelayMs,
        logger,
        startMaintenanceTasks
    });

    const { server } = startHttpServer({
        app,
        port: appConfig.port,
        logger,
        version: appVersion,
        scheduleMaintenanceTasks,
        flushAllWrites
    });

    return { server };
}

const initPromise = init().catch(err => {
    logger.fatal({ err }, '服务器启动失败');
    process.exit(1);
});

module.exports = { app, initPromise };
