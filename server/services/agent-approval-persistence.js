function isPendingRequestConflict(error) {
    return /unique|duplicate/i.test(String(error?.message || ''))
        && /approval|pending|run_id|approval_key/i.test(String(error?.constraint || error?.message || ''));
}

async function insertPendingRequest({ execute, getRequestByRunKey, runId, requestType, key, sql, params }) {
    try {
        const changes = await execute(sql, params);
        return { changes, existing: null };
    } catch (error) {
        if (!isPendingRequestConflict(error)) throw error;
        const existing = await getRequestByRunKey(runId, requestType, key);
        if (existing) return { changes: 0, existing };
        throw error;
    }
}

module.exports = { insertPendingRequest };
