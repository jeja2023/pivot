const { asyncHandler } = require('../../http');
const { assertDeviceSignature } = require('../../services/agent-local-devices');
const {
    claimConnectorTask, completeConnectorTask, connectorClaimPayload,
    connectorHeartbeatPayload, connectorResultPayload, heartbeatConnector, listConnectorDevices
} = require('../../services/agent-local-connector');

function mountLocalConnectorRoutes(router, authMiddleware) {
    router.post('/mcp/local-device/connector/heartbeat', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        await assertDeviceSignature(req.user, { deviceId: body.deviceId, purpose: 'connector', nonce: body.nonce, signature: body.signature, payload: connectorHeartbeatPayload({ nonce: body.nonce, deviceId: body.deviceId }) });
        res.json({ success: true, connector: await heartbeatConnector(req.user, body) });
    }));
    router.get('/mcp/local-device/connector/status', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, devices: await listConnectorDevices(req.user) });
    }));
    router.post('/mcp/local-device/connector/tasks/claim', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        await assertDeviceSignature(req.user, { deviceId: body.deviceId, purpose: 'connector', nonce: body.nonce, signature: body.signature, payload: connectorClaimPayload({ nonce: body.nonce, deviceId: body.deviceId }) });
        res.json({ success: true, ...(await claimConnectorTask(req.user, body)) });
    }));
    router.post('/mcp/local-device/connector/tasks/:id/result', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        await assertDeviceSignature(req.user, { deviceId: body.deviceId, purpose: 'connector', nonce: body.nonce, signature: body.signature, payload: connectorResultPayload({ nonce: body.nonce, deviceId: body.deviceId, taskId: req.params.id, claimToken: body.claimToken }) });
        res.json({ success: true, result: await completeConnectorTask(req.user, req.params.id, body) });
    }));
}

module.exports = { mountLocalConnectorRoutes };
