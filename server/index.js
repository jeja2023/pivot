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
const { closePgPool } = require('./db/pg-connection');
const { closeRealtimeEventClients } = require('./services/realtime-events');
const { shutdownSandboxProcesses } = require('./services/agent-sandbox');
const { shutdownCapabilityWorkers } = require('./services/agent-capability-worker');
const { voiceStreaming } = require('./services/speech-recognition/streaming');
const { embeddedSpeech } = require('./services/speech-recognition/embedded');
const { refreshAppSettingsCache } = require('./services/app-settings');

registerProcessErrorHandlers({ logger, flushAllWrites });

async function init() {
    await initPostgresDatabase();
    await refreshAppSettingsCache();
    // A cluster rollout can opt into a hard startup gate. Without it, the
    // profile remains observable and degrades safely to single-node mode for
    // staged infrastructure migrations.
    assertDeploymentReady();
    await recoverDocumentProcessingJobs();
    startBackgroundServices({ logger });
    if (embeddedSpeech.enabled()) embeddedSpeech.ensureReady().then(() => {
        logger.info({ code: 'VOICE_EMBEDDED_READY' }, '内置 CPU 中文语音模型已就绪');
    }).catch(() => {
        logger.warn({ code: 'VOICE_EMBEDDED_UNAVAILABLE' }, '内置中文语音未就绪，文本服务继续运行，请检查模型与语音依赖');
    });

    const scheduleMaintenanceTasks = createMaintenanceScheduler({
        delayMs: appConfig.maintenanceStartDelayMs,
        logger,
        startMaintenanceTasks
    });

    let closeVoice = () => {};
    const { server } = startHttpServer({
        app,
        port: appConfig.port,
        logger,
        version: appVersion,
        scheduleMaintenanceTasks,
        flushAllWrites,
        closePgPool,
        closeRealtimeClients: options => { closeRealtimeEventClients(options); closeVoice(); },
        terminateSandboxProcesses: shutdownSandboxProcesses,
        terminateCapabilityWorkers: shutdownCapabilityWorkers,
        stopSpeechService: () => embeddedSpeech.stop()
    });

    closeVoice = voiceStreaming.attach(server);
    server.once('close', closeVoice);
    return { server };
}

const initPromise = init().catch(err => {
    logger.fatal({ err }, '服务器启动失败');
    process.exit(1);
});

module.exports = { app, initPromise };
