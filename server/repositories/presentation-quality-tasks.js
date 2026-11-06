'use strict';

const { queryOne, execute } = require('../db/client');
const TOOL = 'presentation.review_deck';

async function parentStatus(runId, userId) {
    return queryOne('SELECT status FROM agent_runs WHERE id=? AND user_id=? AND deleted_at IS NULL', [runId, userId]);
}
async function writeProgress(id, user, result) {
    await execute("UPDATE tool_tasks SET result_json=?::jsonb,updated_at=NOW() WHERE id=? AND user_id=? AND status='working'", [JSON.stringify(result), id, user.id]);
}
async function findWorking(user, input) {
    return queryOne("SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND input_request->>'presentationId'=? AND input_request->>'contentDigest'=? AND input_request->>'mode'=? AND input_request->>'modelId'=? AND COALESCE(input_request->>'runId','')=? ORDER BY created_at DESC LIMIT 1", [user.id, TOOL, input.presentationId, input.contentDigest, input.mode, input.modelId, input.runId]);
}
async function readTask(user, presentationId, taskId) {
    return taskId ? queryOne('SELECT id,input_request,result_json FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=?', [taskId, user.id, TOOL])
        : queryOne("SELECT id,input_request,result_json FROM tool_tasks WHERE user_id=? AND tool_name=? AND input_request->>'presentationId'=? ORDER BY created_at DESC LIMIT 1", [user.id, TOOL, presentationId]);
}

module.exports = { TOOL, parentStatus, writeProgress, findWorking, readTask };
