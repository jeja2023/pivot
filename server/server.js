/**
 * HTTP server lifecycle. App assembly stays in index.js until the bootstrap
 * migration is complete; this module owns listening and graceful shutdown.
 */
function startHttpServer({ app, port, logger, version, scheduleMaintenanceTasks, flushAllWrites, processRef = process }) {
    let shuttingDown = false;
    let exitStarted = false;
    const server = app.listen(port, () => {
        logger.info({ port, url: 'http://localhost:' + port, version }, 'Pivot AI（智枢）服务已启动');
        if (typeof scheduleMaintenanceTasks === 'function') scheduleMaintenanceTasks();
    });

    const gracefulShutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, '进程退出，正在关闭 HTTP 服务');
        const exitWithCode = async (code) => {
            if (exitStarted) return;
            exitStarted = true;
            try {
                if (typeof flushAllWrites === 'function') await flushAllWrites();
            } catch (err) {
                logger.warn({ err }, '关闭服务时数据库写入队列刷新失败');
            }
            processRef.exit(code);
        };
        server.close(() => {
            exitWithCode(0).catch(err => {
                logger.warn({ err }, '关闭服务时数据库写入队列刷新失败');
                processRef.exit(1);
            });
        });
        setTimeout(() => {
            exitWithCode(1).catch(err => {
                logger.warn({ err }, '强制关闭服务时数据库写入队列刷新失败');
                processRef.exit(1);
            });
        }, 5000).unref();
    };

    processRef.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    processRef.on('SIGINT', () => gracefulShutdown('SIGINT'));
    return { server, gracefulShutdown };
}

module.exports = { startHttpServer };
