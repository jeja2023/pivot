'use strict';

const { transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const deployment = require('./presentation-engine-deployment');
async function replace(key, previous, next, userId) {
    return transaction(async client => {
        await deployment.lock(client);
        const row = await client.queryOne('SELECT value FROM app_settings WHERE key=? FOR UPDATE', [key]);
        if ((row?.value ?? null) !== previous) return { conflict: true };
        if (Number((await deployment.active(client)).total) > 0) return { busy: true };
        await client.execute(`INSERT INTO app_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`, [key, next, getBeijingTimestamp(), userId || null]);
        return { saved: true };
    });
}
module.exports = { replace };
