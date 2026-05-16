const express = require('express');
const { subscribeUserEvents } = require('../services/realtime-events');

function createEventsRouter({ authMiddleware }) {
    const router = express.Router();

    router.get('/events', authMiddleware, (req, res) => {
        subscribeUserEvents(req.user, res);
    });

    return router;
}

module.exports = { createEventsRouter };
