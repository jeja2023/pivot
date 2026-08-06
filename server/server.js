/**
 * HTTP server lifecycle. App assembly stays in index.js until the bootstrap
 * migration is complete; this module owns listening and graceful shutdown.
 */
function startHttpServer({ app, port, logger, version, scheduleMaintenanceTasks, flushAllSqliteWrites, processRef = process }) {
    let shuttingDown = false;
    const server = app.listen(port, () => {
        logger.info({ port, url: 'http://localhost:' + port, version }, 'Pivot AI（智枢）服务已启动');
        if (typeof scheduleMaintenanceTasks === 'function') scheduleMaintenanceTasks();
    });

    const gracefulShutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, '进程退出，正在关闭 HTTP 服务');
        const exitWithCode = (code) => {
            try {
                if (typeof flushAllSqliteWrites === 'function') flushAllSqliteWrites();
            } catch (err) {
                logger.warn({ err }, '关闭服务时 SQLite 写入队列刷新失败');
            }
            processRef.exit(code);
        };
        server.close(() => exitWithCode(0));
        setTimeout(() => exitWithCode(1), 5000).unref();
    };

    processRef.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    processRef.on('SIGINT', () => gracefulShutdown('SIGINT'));
    return { server, gracefulShutdown };
}

module.exports = { startHttpServer };
