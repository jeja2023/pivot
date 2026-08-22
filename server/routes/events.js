const express = require('express');
const { asyncHandler } = require('../http');
const { subscribeUserEvents } = require('../services/realtime-events');
const { query } = require('../db/client');

function createEventsRouter({ authMiddleware }) {
    const router = express.Router();

    router.get('/events', authMiddleware, asyncHandler(async (req, res) => {
        const after = Math.max(Number(req.get('Last-Event-ID') || req.query.after || 0) || 0, 0);
        let initialEvents = [];
        if (after > 0) {
            initialEvents = await query(`
                SELECT id, run_id, event_seq, event_type, payload
                FROM agent_events
                WHERE user_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT 200
            `, [req.user.id, after]);
        }
        subscribeUserEvents(req.user, res, { initialEvents });
    }));

    return router;
}

module.exports = { createEventsRouter };
