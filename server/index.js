const { app, appConfig, appVersion, logger, flushAllWrites } = require('./app');
const {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
} = require('./bootstrap');
const { startHttpServer } = require('./server');
const { startMaintenanceTasks } = require('./services/maintenance');

const { initPostgresDatabase } = require('./db');

registerProcessErrorHandlers({ logger, flushAllWrites });

async function init() {
    await initPostgresDatabase();
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
