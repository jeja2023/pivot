/**
 * HTTP server lifecycle. App assembly stays in index.js until the bootstrap
 * migration is complete; this module owns listening and graceful shutdown.
 */
function startHttpServer({
    app,
    port,
    logger,
    version,
    scheduleMaintenanceTasks,
    flushAllWrites,
    closePgPool,
    closeRealtimeClients,
    terminateSandboxProcesses,
    terminateCapabilityWorkers,
    processRef = process
}) {
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
        try { closeRealtimeClients?.({ reason: signal.toLowerCase(), retryAfterMs: 0 }); } catch (err) {
            logger.warn({ err }, '关闭服务时通知 SSE 客户端失败');
        }
        try { terminateSandboxProcesses?.(); } catch (err) {
            logger.warn({ err }, '关闭服务时终止沙箱进程失败');
        }
        try { terminateCapabilityWorkers?.(); } catch (err) {
            logger.warn({ err }, '关闭服务时终止能力工作进程失败');
        }
        let forceCloseTimer = null;
        const exitWithCode = async (code) => {
            if (exitStarted) return;
            exitStarted = true;
            if (forceCloseTimer) clearTimeout(forceCloseTimer);
            try {
                if (typeof flushAllWrites === 'function') await flushAllWrites();
            } catch (err) {
                logger.warn({ err }, '关闭服务时数据库写入队列刷新失败');
            }
            try {
                if (typeof closePgPool === 'function') await closePgPool();
            } catch (err) {
                logger.warn({ err }, '关闭服务时 PostgreSQL 连接池关闭失败');
            }
            processRef.exit(code);
        };
        server.closeIdleConnections?.();
        server.close(() => {
            exitWithCode(0).catch(err => {
                logger.warn({ err }, '关闭服务时数据库写入队列刷新失败');
                processRef.exit(1);
            });
        });
        forceCloseTimer = setTimeout(() => {
            server.closeAllConnections?.();
            // 信号触发的连接收口仍属于有序关闭，而不是服务故障。
            exitWithCode(0).catch(err => {
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
