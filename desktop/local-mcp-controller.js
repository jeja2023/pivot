const { createLocalMcpConnector } = require('./local-mcp-connector');

function createLocalMcpController(options = {}) {
    return createLocalMcpConnector({
        request: options.request,
        getLocalAuthorizationStatus: options.getLocalAuthorizationStatus,
        executeLocalTool: options.executeLocalTool,
        logger: options.logger || console
    });
}

function createLazyLocalMcpController(options = {}) {
    let controller = null;
    return () => {
        if (!controller) controller = createLocalMcpController(options);
        return controller;
    };
}

module.exports = { createLazyLocalMcpController, createLocalMcpController };
