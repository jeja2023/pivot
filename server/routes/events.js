const express = require('express');
const { asyncHandler } = require('../http');
const { subscribeUserEvents } = require('../services/realtime-events');
const { query } = require('../db/client');
const { normalizeRealtimeCursor } = require('../services/realtime-cursor');
const MAX_REPLAY_PAGES = 25;

function createEventsRouter({ authMiddleware, database = { query } }) {
    const router = express.Router();

    router.get('/events', authMiddleware, asyncHandler(async (req, res) => {
        const after = normalizeRealtimeCursor(req.get('Last-Event-ID') || req.query.after);
        const subscription = subscribeUserEvents(req.user, res, { bufferAgentEvents: after !== '0' });
        if (after === '0' || !subscription.writeReplay) return;
        try {
            // 先订阅并缓存实时事件，再以固定上界分页，避免查询与订阅之间的窗口。
            const bounds = await database.query('SELECT COALESCE(MAX(id), 0)::text AS max_id FROM agent_events WHERE user_id = ?', [req.user.id]);
            const upper = normalizeRealtimeCursor(bounds[0]?.max_id);
            let cursor = after;
            let pages = 0;
            let exhausted = false;
            while (subscription.isActive() && upper !== '0' && BigInt(cursor) < BigInt(upper) && pages < MAX_REPLAY_PAGES) {
                const page = await database.query(`
                    SELECT id::text AS id, run_id, event_seq, event_type, payload
                    FROM agent_events
                    WHERE user_id = ? AND id > ? AND id <= ?
                    ORDER BY agent_events.id ASC
                    LIMIT 200
                `, [req.user.id, cursor, upper]);
                pages += 1;
                for (const event of page) subscription.writeReplay(event);
                if (!await subscription.waitForDrain()) return;
                if (page.length) {
                    cursor = normalizeRealtimeCursor(page[page.length - 1].id);
                    if (cursor === '0') throw new Error('实时事件重放游标无效');
                }
                if (page.length < 200) { exhausted = true; break; }
            }
            if (subscription.isActive() && !exhausted && pages >= MAX_REPLAY_PAGES && BigInt(cursor) < BigInt(upper)) {
                // 分段重连限制单次读取；客户端按实际收到的最后 ID 继续，允许重复。
                subscription();
                res.end();
            } else if (subscription.isActive()) subscription.finishReplay(cursor);
        } catch (error) {
            subscription();
            res.destroy(error);
        }
    }));

    return router;
}

module.exports = { createEventsRouter };
