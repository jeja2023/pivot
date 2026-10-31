'use strict';

const express = require('express');
const { createEventsRouter } = require('../../server/routes/events');
const { closePgPool, getPgPool } = require('../../server/db/pg-connection');
const { Client } = require('pg');
const { createRealtimeWakeup } = require('../../server/services/realtime-wakeup');
const { publishUserEvent } = require('../../server/services/realtime-events');
const { writeSnapshot } = require('../../server/services/realtime-stream-snapshot');
process.env.PIVOT_DEPLOYMENT_MODE = 'multi_node';
const wakeup = createRealtimeWakeup({ createClient: () => new Client({ ...getPgPool().options, application_name: `pivot-realtime-test-${process.pid}` }), retryMs: 1000 });
const app = express();
app.use(createEventsRouter({ durableEvents: true, wakeup, authMiddleware(req, _res, next) {
    req.user = { id: Number(req.get('X-Test-User')) };
    next();
} }));
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async message => {
    if (message && message.type === 'snapshot') {
        const written = await writeSnapshot(message.input);
        if (written) require('../../server/services/realtime-hints').publishHint(message.input.userId, 'agent.streaming', message.input.snapshot);
        process.send({ snapshotWritten: written });
        return;
    }
    if (message && message.type === 'publish-batch') {
        for (const event of message.events) publishUserEvent(message.userId, event.eventType, event.payload);
        process.send({ published: true });
        return;
    }
    if (message && message.type === 'publish') {
        publishUserEvent(message.userId, message.eventType, message.payload);
        process.send({ published: true });
        return;
    }
    if (message !== 'stop') return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await closePgPool();
    process.exit(0);
});
