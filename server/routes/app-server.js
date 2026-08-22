const express = require('express');
const { asyncHandler } = require('../http');
const { createAppServerProtocol, JSON_RPC_ERRORS } = require('../services/app-server-protocol');

function normalizeRpcError(error) {
    return {
        code: Number(error?.rpcCode || error?.code) || JSON_RPC_ERRORS.internal,
        message: String(error?.message || 'App Server 请求失败'),
        ...(error?.data === undefined ? {} : { data: error.data })
    };
}

function createAppServerRouter({ authMiddleware, protocol = createAppServerProtocol() } = {}) {
    const router = express.Router();
    router.post('/app-server', authMiddleware, asyncHandler(async (req, res) => {
        const requests = Array.isArray(req.body) ? req.body : [req.body];
        if (!requests.length) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'JSON-RPC 请求不能为空。' } });
        const responses = [];
        for (const request of requests) {
            try {
                const response = await protocol.handle(request, req.user);
                if (response) responses.push(response);
            } catch (error) {
                if (request?.id !== undefined) responses.push({ jsonrpc: '2.0', id: request.id, error: normalizeRpcError(error) });
            }
        }
        if (!responses.length) return res.status(204).end();
        if (Array.isArray(req.body)) return res.json(responses);
        res.json(responses[0]);
    }));
    return router;
}

module.exports = { createAppServerRouter, normalizeRpcError };
