const { app, appConfig, appVersion, logger, flushAllSqliteWrites } = require('./app');
const {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
} = require('./bootstrap');
const { startHttpServer } = require('./server');
const { startMaintenanceTasks } = require('./services/maintenance');

registerProcessErrorHandlers({ logger, flushAllSqliteWrites });
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
    flushAllSqliteWrites
});

module.exports = { app, server };
