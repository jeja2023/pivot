'use strict';
const { queryOne, execute } = require('../db/client');

async function getModelForStatusManagement(modelId) {
    if (!modelId) return null;
    return await queryOne(
        "SELECT * FROM models WHERE id = ? AND COALESCE(status, 'active') IN ('active', 'disabled')",
        [modelId]
    );
}

async function updateModelStatus({ modelId, status, userId, isSuperAdmin }) {
    const nextStatus = status === 'disabled' ? 'disabled' : 'active';
    if (isSuperAdmin && (userId === null || userId === undefined)) {
        if (nextStatus === 'disabled') {
            return await execute("UPDATE models SET status = 'disabled', is_default = 0 WHERE id = ? AND user_id IS NULL", [modelId]);
        }
        return await execute("UPDATE models SET status = 'active' WHERE id = ? AND user_id IS NULL", [modelId]);
    }
    if (nextStatus === 'disabled') {
        return await execute("UPDATE models SET status = 'disabled', is_default = 0 WHERE id = ? AND user_id = ?", [modelId, userId]);
    }
    return await execute("UPDATE models SET status = 'active' WHERE id = ? AND user_id = ?", [modelId, userId]);
}

module.exports = {
    getModelForStatusManagement,
    updateModelStatus
};
