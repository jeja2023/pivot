'use strict';

const express = require('express');
const { createEventsRouter } = require('../../server/routes/events');
const { closePgPool } = require('../../server/db/pg-connection');
const app = express();
app.use(createEventsRouter({ durableEvents: true, authMiddleware(req, _res, next) {
    req.user = { id: Number(req.get('X-Test-User')) };
    next();
} }));
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async message => {
    if (message !== 'stop') return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await closePgPool();
    process.exit(0);
});
