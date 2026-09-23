'use strict';

const { query } = require('../../db/client');
const { publishUserEvent } = require('../realtime-events');

async function presentationAudience(presentationId) {
    const rows = await query(`
        SELECT owner_user_id AS user_id FROM presentation_documents WHERE id = ? AND deleted_at IS NULL
        UNION
        SELECT user_id FROM presentation_collaborators WHERE presentation_id = ?
    `, [presentationId, presentationId]);
    return [...new Set(rows.map(row => Number(row.user_id)).filter(Number.isSafeInteger))];
}

async function publishPresentationRealtime(presentationId, type, payload = {}) {
    const id = Number.parseInt(presentationId, 10); if (!Number.isSafeInteger(id) || id <= 0) return 0;
    let audience = []; try { audience = await presentationAudience(id); } catch (_) { return 0; }
    let delivered = 0;
    audience.forEach(userId => { delivered += publishUserEvent(userId, type, { presentationId: payload.presentationId || '', presentationInternalId: id, ...payload }); });
    return delivered;
}

module.exports = { publishPresentationRealtime };
