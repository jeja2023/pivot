async function resolveInitializedServer(serverModule) {
    if (!serverModule || !serverModule.initPromise) {
        throw new Error('Pivot 服务启动失败：缺少初始化 Promise。');
    }
    const initialized = await serverModule.initPromise;
    const server = initialized && initialized.server;
    if (!server) throw new Error('Pivot 服务启动失败：缺少 HTTP 服务器实例。');
    return server;
}

module.exports = { resolveInitializedServer };
