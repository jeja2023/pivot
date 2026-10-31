'use strict';

const express = require('express');
const { createPresentationsRouter } = require('../../server/routes/apps/presentations');
const { closePgPool } = require('../../server/db/pg-connection');
process.env.PIVOT_DEPLOYMENT_MODE = 'multi_node';
const tenantId = Number(process.env.PIVOT_TEST_PRESENCE_TENANT_ID);
const authMiddleware = (req, res, next) => {
    const id = Number(req.get('X-Test-User'));
    if (!Number.isSafeInteger(id) || id <= 0) return res.sendStatus(401);
    req.user = { id, role: 'user', tenant_id: tenantId };
    next();
};
const passthrough = (_req, _res, next) => next();
const app = express();
app.use(express.json());
app.use('/api', createPresentationsRouter({ authMiddleware, logAction() {}, uploadLimiter: passthrough, upload: { single: () => passthrough } }));
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async message => {
    if (message !== 'stop') return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await closePgPool();
    process.exit(0);
});
