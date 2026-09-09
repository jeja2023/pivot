const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const { nowExpr } = require('../db/dialect');
const { parseJsonObject } = require('./agent-validators');
const { patchAgentRunMetadata, updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
const { insertPendingRequest } = require('./agent-approval-persistence');
const { buildAgentResumeContext } = require('./agent-checkpoints');
const { resolveCredentialSecret } = require('./workflow-credentials');
const {
    getRequiredBuiltinConfigAsync
} = require('./builtin-mcp-common');
const {
    buildImPayload,
    sendIm,
    validateImTarget
} = require('./builtin-mcp-im');
const {
    actorRequirementKeys,
    approvalCompletionKind,
    canUserDecide,
    currentLevel,
    formatRequest,
    invalid,
    levelRequirementKeys,
    normalizeApprovalLevels,
    normalizeTimeoutAction,
    normalizeTimeoutMs,
    parseJson,
    resolveApprovalTimeoutMs,
    uniqueNumbers,
    uniqueStrings
} = require('./agent-approval-levels');
const CALLBACK_TOKEN_PATTERN = /^apr_[0-9a-f]{48}$/;
const callbacks = {
    updateRun: null,
    updateRunCas: null,
    insertStep: null,
    listSteps: null,
    setRunMetadata: null,
    upsertDagNode: null,
    createAgentNotification: null,
    enqueueAgentRun: null,
    getAgentRunTitle: run => run?.title || run?.goal || run?.id || ''
};
function configureAgentApprovalRequests(next = {}) {
    Object.entries(next || {}).forEach(([key, value]) => {
        if (Object.hasOwn(callbacks, key) && typeof value === 'function') callbacks[key] = value;
    });
}


async function getRun(runId) {
    return await queryOne('SELECT * FROM agent_runs WHERE id = ? AND deleted_at IS NULL', [runId]);
}

async function getRunOwner(runId) {
    return await queryOne(`
        SELECT u.id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username,
               u.nickname, u.unit, u.role
        FROM agent_runs r
        JOIN users u ON u.id = r.user_id
        WHERE r.id = ? AND COALESCE(u.status, 'active') != 'disabled' AND u.deleted_at IS NULL
    `, [runId]);
}

async function getRunMetadataById(runId) {
    const row = (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])) || {};
    return parseJsonObject(row.metadata) || {};
}

async function mergeRunMetadata(runId, patch = {}) {
    if (typeof callbacks.setRunMetadata === 'function') {
        await callbacks.setRunMetadata(runId, patch);
        return;
    }
    await patchAgentRunMetadata(runId, patch);
}

async function refreshRunResumeContext(runId) {
    const resumeContext = await buildAgentResumeContext(runId);
    await mergeRunMetadata(runId, { resumeContext });
    return resumeContext;
}

async function updateRunRecord(runId, fields = {}) {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    if (typeof callbacks.updateRun === 'function') {
        await callbacks.updateRun(runId, fields);
        return;
    }
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    await execute(`UPDATE agent_runs SET ${set} WHERE id = ?`, [...entries.map(([, value]) => value), runId]);
}

async function updateRunRecordCas(runId, expectedStatuses, fields = {}) {
    if (typeof callbacks.updateRunCas === 'function') {
        return await callbacks.updateRunCas(runId, expectedStatuses, fields);
    }
    const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
    const entries = Object.entries(fields);
    if (!entries.length || !statuses.length) return 0;
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    const placeholders = statuses.map(() => '?').join(', ');
    return await execute(`UPDATE agent_runs SET ${set} WHERE id = ? AND status IN (${placeholders})`, [
        ...entries.map(([, value]) => value), runId, ...statuses
    ]);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createCallbackToken() {
    return `apr_${crypto.randomBytes(24).toString('hex')}`;
}

function createCallbackNonce() {
    return crypto.randomBytes(16).toString('hex');
}

async function resolveCallbackSecretSlug(slug, user) {
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedSlug) return '';
    const resolved = user ? await resolveCredentialSecret(normalizedSlug, user) : null;
    return resolved?.value || '';
}

function approvalKeyFor(node = {}, input = {}, fallback = '') {
    const scopedFallback = String(fallback || '').trim();
    if (scopedFallback.includes(':subworkflow:')) return scopedFallback.slice(0, 240);
    return String(
        input.approvalKey ||
        input.approval_key ||
        node.approvalKey ||
        node.approval_key ||
        fallback ||
        `workflow.approval:${node.id || 'node'}`
    ).trim().slice(0, 240);
}

function persistedApprovalNodeKey(node = {}, approvalKey = '') {
    const key = String(approvalKey || '').trim();
    return key.includes(':subworkflow:') ? key.slice(0, 240) : String(node.id || key || '').trim().slice(0, 240);
}

function delayKeyFor(node = {}, fallback = '') {
    return String(fallback || `workflow.delay:${node.id || 'node'}`).trim().slice(0, 240);
}

async function getRequestByRunKey(runId, requestType, approvalKey) {
    return await queryOne(`
        SELECT * FROM agent_approval_requests
        WHERE run_id = ? AND request_type = ? AND approval_key = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `, [runId, requestType, approvalKey]);
}

async function getRequestById(requestId) {
    return await queryOne('SELECT * FROM agent_approval_requests WHERE id = ?', [requestId]);
}



async function listWorkflowApprovalRequests(user, options = {}) {
    const status = String(options.status || 'pending').trim();
    const rows = await query(`
        SELECT ar.*
        FROM agent_approval_requests ar
        JOIN agent_runs r ON r.id = ar.run_id
        WHERE ar.request_type = 'approval'
          AND (? = '' OR ar.status = ?)
          AND r.deleted_at IS NULL
        ORDER BY ar.created_at DESC
        LIMIT 200
    `, [status, status]);
    return rows
        .filter(row => row.user_id === user.id || canUserDecide(row, user) || isSuperAdmin(user))
        .map(row => formatRequest(row, user));
}

async function updateRunToAwaiting(runId, errorMessage = '') {
    const run = await getRun(runId);
    if (!run || ['cancelled', 'deleted', 'completed', 'completed_with_errors', 'error'].includes(run.status)) return;
    const now = getBeijingTimestamp();
    await updateRunRecord(runId, {
        status: 'awaiting_approval',
        error_message: errorMessage,
        last_heartbeat_at: now,
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
}

async function enqueueRun(runId) {
    const user = await getRunOwner(runId);
    if (!user) return;
    callbacks.enqueueAgentRun?.(runId, user);
}

async function insertStep(runId, data = {}) {
    let stepIndex = 1;
    if (typeof callbacks.listSteps === 'function') {
        const steps = await callbacks.listSteps(runId);
        stepIndex = (Array.isArray(steps) ? steps.length : 0) + 1;
    } else {
        const row = await queryOne('SELECT COALESCE(MAX(step_index), 0) AS "maxStep" FROM agent_steps WHERE run_id = ?', [runId]);
        stepIndex = Number(row?.maxStep || row?.maxstep || 0) + 1;
    }
    if (typeof callbacks.insertStep === 'function') {
        await callbacks.insertStep(runId, stepIndex, data);
        return;
    }
    const now = getBeijingTimestamp();
    await execute(`
        INSERT INTO agent_steps (
            run_id, step_index, type, title, tool_name, input, output, error_message,
            status, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        runId,
        stepIndex,
        data.type || 'note',
        String(data.title || 'Step').slice(0, 160),
        data.toolName || '',
        data.input ? JSON.stringify(data.input) : null,
        data.output ? JSON.stringify(data.output) : null,
        data.errorMessage || '',
        data.status || 'success',
        Number(data.durationMs) || 0,
        data.startedAt || now,
        data.completedAt || now,
        now
    ]);
}

function throwAwaiting(message, requestId) {
    const err = new Error(message);
    err.code = 'AGENT_RUN_AWAITING_APPROVAL';
    err.requestId = requestId;
    throw err;
}

function buildApprovalOutput(row, decision = 'approved') {
    const decisions = parseJson(row.decisions_json, []);
    const lastDecision = decisions[decisions.length - 1] || {};
    return {
        status: decision,
        requestId: row.id,
        approvalKey: row.approval_key,
        currentLevel: Number(row.current_level || 1),
        requiredLevels: Number(row.required_levels || 1),
        decisions,
        comment: String(lastDecision.comment || ''),
        decidedBy: lastDecision.userId || row.decided_by || null,
        decidedAt: lastDecision.decidedAt || row.decided_at || getBeijingTimestamp()
    };
}

function buildDelayOutput(row) {
    const input = parseJson(row.input_json, {});
    return {
        delayed: true,
        durationMs: Number(input.durationMs ?? input.duration_ms ?? 0),
        reason: String(input.reason || ''),
        requestId: row.id,
        completedAt: row.decided_at || getBeijingTimestamp()
    };
}

async function persistWorkflowApproval(runId, key, value) {
    await updateAgentRunMetadataWithRetry(runId, metadata => ({
        ...metadata,
        workflowApprovals: {
            ...(metadata.workflowApprovals && typeof metadata.workflowApprovals === 'object' ? metadata.workflowApprovals : {}),
            [key]: value
        },
        pendingWorkflowApproval: null
    }));
}

async function persistWorkflowDelay(runId, key, value) {
    await updateAgentRunMetadataWithRetry(runId, metadata => ({
        ...metadata,
        workflowDelays: {
            ...(metadata.workflowDelays && typeof metadata.workflowDelays === 'object' ? metadata.workflowDelays : {}),
            [key]: value
        },
        pendingWorkflowDelay: null
    }));
}

async function maybeCompleteDagNode(row, output) {
    if (!row.node_key || String(row.node_key).includes(':subworkflow:')) return;
    if (typeof callbacks.upsertDagNode === 'function') {
        await callbacks.upsertDagNode(
            row.run_id,
            { id: row.node_key, title: row.title || row.node_key, tool: row.request_type === 'delay' ? 'workflow.delay' : 'workflow.approval' },
            {
                status: 'completed',
                output,
                errorMessage: '',
                startedAt: row.started_at || getBeijingTimestamp(),
                completedAt: getBeijingTimestamp()
            }
        );
        return;
    }
    await execute(`
        UPDATE agent_dag_nodes
        SET status = 'completed',
            output = ?,
            error_message = '',
            completed_at = ?
        WHERE run_id = ? AND node_key = ?
    `, [JSON.stringify(output), getBeijingTimestamp(), row.run_id, row.node_key]);
}

async function markDagNodeWaiting(row, output) {
    if (!row.node_key || String(row.node_key).includes(':subworkflow:')) return;
    if (typeof callbacks.upsertDagNode === 'function') {
        await callbacks.upsertDagNode(
            row.run_id,
            { id: row.node_key, title: row.title || row.node_key, tool: row.request_type === 'delay' ? 'workflow.delay' : 'workflow.approval' },
            {
                status: 'waiting_approval',
                output,
                errorMessage: '',
                startedAt: row.started_at || getBeijingTimestamp(),
                completedAt: null
            }
        );
        return;
    }
    await execute(`
        UPDATE agent_dag_nodes
        SET status = 'waiting_approval',
            output = ?,
            error_message = '',
            started_at = COALESCE(started_at, ?),
            completed_at = NULL
        WHERE run_id = ? AND node_key = ?
    `, [JSON.stringify(output), row.started_at || getBeijingTimestamp(), row.run_id, row.node_key]);
}

function signatureFor(secret, token, requestId, decision, nonce = '', requirementKey = '') {
    return `sha256=${crypto
        .createHmac('sha256', secret)
        .update(`${token}.${requestId}.${decision}.${nonce}.${requirementKey}`)
        .digest('hex')}`;
}

async function getRequestSecret(row) {
    const slug = String(row.callback_credential_slug || '').trim();
    if (!slug) return '';
    const owner = (await getRunOwner(row.run_id)) || (row.user_id ? { id: row.user_id } : null);
    return owner ? await resolveCallbackSecretSlug(slug, owner) : '';
}

async function buildCallbackActions(row, token) {
    if (!token) return {};
    const secret = await getRequestSecret(row);
    const nonce = String(row.callback_nonce || '').trim();
    const build = decision => {
        const payload = { decision, requestId: row.id, approvalRequestId: row.id };
        if (secret) payload.signature = signatureFor(secret, token, row.id, decision, nonce, row.callback_requirement_key || '');
        return payload;
    };
    return {
        approve: build('approve'),
        reject: build('reject')
    };
}

function callbackUrlFor(input = {}, token = '') {
    const base = String(input.callbackBaseUrl || input.callback_base_url || process.env.PIVOT_PUBLIC_BASE_URL || '').trim();
    const path = `/hooks/im-callback/${token}`;
    return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

async function notifyApprovers(row, token = '') {
    const run = await getRun(row.run_id);
    if (!run) return;
    const owner = (await getRunOwner(row.run_id)) || { id: row.user_id };
    const level = currentLevel(row);
    const directIds = uniqueNumbers(level.approverUserIds || []);
    const units = uniqueStrings(level.approverUnits || []);
    let userIds = directIds;
    if (units.length) {
        const placeholders = units.map(() => '?').join(', ');
        const rows = await query(`
            SELECT id FROM users
            WHERE unit IN (${placeholders})
              AND COALESCE(status, 'active') != 'disabled'
              AND deleted_at IS NULL
            LIMIT 100
        `, units);
        userIds = uniqueNumbers([...userIds, ...rows.map(item => item.id)]);
    }
    if (!userIds.length && owner?.id) userIds = [owner.id];
    userIds.forEach(userId => {
        callbacks.createAgentNotification?.(
            userId,
            row.run_id,
            'approval',
            row.title || 'Workflow approval required',
            row.summary || callbacks.getAgentRunTitle(run)
        );
    });
    await maybeSendApprovalIm(row, token, run, owner);
}

async function maybeSendApprovalIm(row, token, run, user) {
    const input = parseJson(row.input_json, {});
    const serverId = Number.parseInt(input.imServerId ?? input.im_server_id ?? input.im_server ?? 0, 10);
    if (!serverId) return;
    try {
        const server = await queryOne("SELECT * FROM mcp_servers WHERE id = ? AND status != 'deleted'", [serverId]);
        if (!server) return;
        const { config, secret } = await getRequiredBuiltinConfigAsync(server, 'im');
        const targetType = String(input.imTargetType || input.im_target_type || input.targetType || 'user').toLowerCase() === 'group'
            ? 'group'
            : 'user';
        const target = validateImTarget(config, input.imTarget || input.im_target || input.target, targetType);
        const callbackUrl = callbackUrlFor(input, token);
        const defaultPayload = {
            source: 'pivot-agent-approval',
            target,
            targetType,
            title: row.title || 'Workflow approval required',
            message: row.summary || run.goal || '',
            format: 'markdown',
            timestamp: new Date().toISOString(),
            approval: {
                requestId: row.id,
                approvalRequestId: row.id,
                runId: row.run_id,
                nodeKey: row.node_key || '',
                approvalKey: row.approval_key || '',
                currentLevel: Number(row.current_level || 1),
                requiredLevels: Number(row.required_levels || 1),
                levelMode: String(currentLevel(row).mode || 'any'),
                callbackUrl,
                actions: await buildCallbackActions(row, token)
            }
        };
        const payload = buildImPayload(config, defaultPayload, user, { run, approval: formatRequest(row) });
        await sendIm(config, secret, payload, user);
    } catch (err) {
        logger.warn({ err: err.message, requestId: row.id }, '发送工作流审批即时通知失败');
    }
}

async function createApprovalRequest({ run, user, node, input, key }) {
    const levels = await normalizeApprovalLevels(input, user);
    if (!levels.length) throw invalid('Approval node has no valid approver.', 400);
    const now = getBeijingTimestamp();
    const timeoutMs = resolveApprovalTimeoutMs(input);
    const expiresAt = timeoutMs ? getBeijingTimestamp(new Date(Date.now() + timeoutMs)) : null;
    const callbackCredential = String(input.callbackCredential || input.callback_credential || '').trim();
    const callbackSecret = await resolveCallbackSecretSlug(callbackCredential, user);
    if (callbackCredential && !callbackSecret) {
        throw invalid('Callback credential is unavailable or cannot be decrypted.', 403);
    }
    const requestId = crypto.randomUUID();
    const summary = input.summary === undefined || input.summary === null
        ? ''
        : (typeof input.summary === 'string' ? input.summary : JSON.stringify(input.summary));
    const firstLevel = levels[0] || {}; const firstRequirementKeys = levelRequirementKeys(firstLevel);
    if (callbackSecret && (String(firstLevel.mode || 'any').toLowerCase() !== 'any' || firstRequirementKeys.length !== 1)) throw invalid('签名回调仅支持单一审批要求；多审批人或会签请使用站内审批。', 400);
    const callbackToken = callbackSecret ? createCallbackToken() : '';
    const callbackNonce = callbackSecret ? createCallbackNonce() : '';
    const pendingInsert = await insertPendingRequest({ execute, getRequestByRunKey, runId: run.id, requestType: 'approval', key, sql: `
        INSERT INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            callback_token_hash, callback_token_hint, callback_nonce, callback_credential_slug, callback_requirement_key, callback_signature_required,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', ?, ?, ?, ?, ?, 'pending', 1, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        `, params: [
        requestId,
        run.id,
        run.user_id,
        persistedApprovalNodeKey(node, key),
        key,
        String(input.title || node.title || 'Workflow approval').trim().slice(0, 160),
        summary.slice(0, 2000),
        String(input.instructions || '').trim().slice(0, 2000),
        levels.length,
        JSON.stringify(levels),
        JSON.stringify(input),
        callbackToken ? hashToken(callbackToken) : null,
        callbackToken ? callbackToken.slice(-8) : '',
        callbackNonce,
        callbackCredential,
        callbackSecret ? firstRequirementKeys[0] : '',
        callbackSecret ? 1 : 0,
        normalizeTimeoutAction(input.timeoutAction || input.timeout_action),
        expiresAt,
        now,
        now
        ] });
    const changes = pendingInsert.changes;
    if (pendingInsert.existing) return { row: pendingInsert.existing, token: '', created: false };
    if (!changes) {
        const existing = await getRequestByRunKey(run.id, 'approval', key);
        if (existing) return { row: existing, token: '', created: false };
        throw invalid('Approval request could not be created.', 409);
    }
    return { row: await getRequestById(requestId), token: callbackToken, created: true };
}
async function waitForWorkflowApproval({ run, user, node, input = {}, key = '' }) {
    const approvalKey = approvalKeyFor(node, input, key);
    const metadata = await getRunMetadataById(run.id);
    const recorded = metadata.workflowApprovals?.[approvalKey];
    if (recorded?.status === 'approved') return recorded.output || recorded;
    const existing = await getRequestByRunKey(run.id, 'approval', approvalKey);
    if (existing?.status === 'approved') {
        const output = buildApprovalOutput(existing, 'approved');
        await persistWorkflowApproval(run.id, approvalKey, { status: 'approved', requestId: existing.id, output });
        return output;
    }
    if (existing && ['rejected', 'expired', 'cancelled'].includes(existing.status)) {
        const err = new Error(`工作流审批状态当前为 ${existing.status}，无法继续执行。`);
        err.code = 'AGENT_APPROVAL_REJECTED';
        throw err;
    }
    let row = existing;
    let token = '';
    let shouldNotify = false;
    if (!row) {
        const created = await createApprovalRequest({ run, user, node, input, key: approvalKey });
        row = created.row;
        token = created.token;
        shouldNotify = created.created;
        if (created.created) {
            await markDagNodeWaiting(row, { status: 'pending', requestId: row.id, approvalKey });
            await insertStep(run.id, {
                type: 'approval',
                title: 'Workflow approval requested',
                toolName: 'workflow.approval',
                input,
                output: { status: 'pending', requestId: row.id, approvalKey }
            });
        }
    }
    await mergeRunMetadata(run.id, {
        pendingWorkflowApproval: {
            requestId: row.id,
            approvalKey,
            nodeId: node.id || '',
            title: row.title || '',
            currentLevel: row.current_level || 1,
            requiredLevels: row.required_levels || 1
        }
    });
    await updateRunToAwaiting(run.id, 'Waiting for workflow approval.');
    if (shouldNotify) await notifyApprovers(row, token);
    throwAwaiting('Workflow approval is pending.', row.id);
}

async function createDelayRequest({ run, node, input, key }) {
    const durationMs = normalizeTimeoutMs(input.durationMs ?? input.duration_ms);
    const now = getBeijingTimestamp();
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + durationMs));
    const requestId = crypto.randomUUID();
    const pendingInsert = await insertPendingRequest({ execute, getRequestByRunKey, runId: run.id, requestType: 'delay', key, sql: `
        INSERT INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'delay', ?, ?, ?, ?, '', 'pending', 1, 1, '[]', '[]', ?, 'approve', ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        `, params: [
        requestId,
        run.id,
        run.user_id,
        persistedApprovalNodeKey(node, key),
        key,
        String(node.title || input.reason || 'Workflow delay').trim().slice(0, 160),
        String(input.reason || '').trim().slice(0, 1000),
        JSON.stringify({ ...input, durationMs }),
        expiresAt,
        now,
        now
        ] });
    const changes = pendingInsert.changes;
    if (pendingInsert.existing) return { row: pendingInsert.existing, created: false };
    if (!changes) {
        const existing = await getRequestByRunKey(run.id, 'delay', key);
        if (existing) return { row: existing, created: false };
        throw invalid('Delay request could not be created.', 409);
    }
    return { row: await getRequestById(requestId), created: true };
}

async function completeDelayRequest(row, { enqueue = true } = {}) {
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE agent_approval_requests
        SET status = 'completed', decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND updated_at IS NOT DISTINCT FROM ?
    `, [now, now, row.id, row.updated_at]);
    if (!changes) return buildDelayOutput((await getRequestById(row.id)) || row);
    const updated = (await getRequestById(row.id)) || row;
    const output = buildDelayOutput(updated);
    if (enqueue) {
        const runChanged = await updateRunRecordCas(row.run_id, ['awaiting_approval'], {
            status: 'queued',
            error_message: '',
            locked_by: null,
            lock_expires_at: null,
            updated_at: now
        });
        if (!runChanged) throw invalid('Workflow run is no longer awaiting this delay.', 409);
    }
    await persistWorkflowDelay(row.run_id, row.approval_key, { status: 'completed', requestId: row.id, output });
    await refreshRunResumeContext(row.run_id);
    await maybeCompleteDagNode(updated, output);
    await insertStep(row.run_id, {
        type: 'control',
        title: 'Workflow delay completed',
        output
    });
    if (enqueue) await enqueueRun(row.run_id);
    return output;
}

async function waitForWorkflowDelay({ run, node, input = {}, key = '' }) {
    const durationMs = normalizeTimeoutMs(input.durationMs ?? input.duration_ms);
    if (!durationMs) {
        return { delayed: false, durationMs: 0, reason: String(input.reason || ''), completedAt: getBeijingTimestamp() };
    }
    const delayKey = delayKeyFor(node, key);
    const metadata = await getRunMetadataById(run.id);
    const recorded = metadata.workflowDelays?.[delayKey];
    if (recorded?.status === 'completed') return recorded.output || recorded;
    const existing = await getRequestByRunKey(run.id, 'delay', delayKey);
    if (existing?.status === 'completed') {
        const output = buildDelayOutput(existing);
        await persistWorkflowDelay(run.id, delayKey, { status: 'completed', requestId: existing.id, output });
        return output;
    }
    if (existing?.status === 'pending' && existing.expires_at && existing.expires_at <= getBeijingTimestamp()) {
        return await completeDelayRequest(existing, { enqueue: false });
    }
    const created = existing ? { row: existing, created: false } : (await createDelayRequest({ run, node, input: { ...input, durationMs }, key: delayKey }));
    const row = created.row;
    await markDagNodeWaiting(row, { status: 'pending', requestId: row.id, delayKey, durationMs });
    if (created.created) {
        await insertStep(run.id, {
            type: 'control',
            title: 'Workflow delay requested',
            toolName: 'workflow.delay',
            input,
            output: { status: 'pending', requestId: row.id, delayKey, durationMs }
        });
    }
    await mergeRunMetadata(run.id, {
        pendingWorkflowDelay: {
            requestId: row.id,
            delayKey,
            nodeId: node.id || '',
            expiresAt: row.expires_at || ''
        }
    });
    await updateRunToAwaiting(run.id, 'Waiting for workflow delay.');
    throwAwaiting('Workflow delay is pending.', row.id);
}

async function applyApprovalDecision(row, actor, approve = true, comment = '', options = {}) {
    if (!row || row.status !== 'pending') return formatRequest(row, actor);
    const decision = approve ? 'approved' : 'rejected';
    const now = getBeijingTimestamp();
    const level = currentLevel(row);
    const levelNumber = Number(row.current_level || 1);
    const decisions = parseJson(row.decisions_json, []);
    const requirementKeys = levelRequirementKeys(level);
    const levelMode = String(level.mode || 'any').trim().toLowerCase() === 'all' ? 'all' : 'any';
    const actorKeys = options.system && approve ? requirementKeys : actorRequirementKeys(actor, level);
    let matchedKeys = options.system && approve ? requirementKeys : options.callbackRequirementKey ? [String(options.callbackRequirementKey)] : actorKeys.filter(key => requirementKeys.includes(key));
    if (options.callbackRequirementKey && !requirementKeys.includes(String(options.callbackRequirementKey))) throw invalid('Approval callback is not bound to the current approval requirement.', 403);
    if (approve && !matchedKeys.length && !isSuperAdmin(actor) && !options.system) {
        throw invalid('Current user is not a designated approver for this level.', 403);
    }
    decisions.push({
        level: levelNumber,
        decision,
        userId: actor?.id || null,
        username: actor?.username || actor?.nickname || (options.system ? 'system' : ''),
        unit: String(actor?.unit || '').trim(),
        mode: levelMode,
        matchedKeys,
        satisfiedKeys: matchedKeys,
        system: Boolean(options.system),
        comment: String(comment || options.reason || '').trim().slice(0, 1000),
        decidedAt: now
    });
    if (!approve) {
        const changes = await execute(`
            UPDATE agent_approval_requests
            SET status = 'rejected', decisions_json = ?, decided_at = ?, decided_by = ?, updated_at = ?,
                callback_token_hash = NULL, callback_nonce = ''
            WHERE id = ? AND status = 'pending' AND updated_at IS NOT DISTINCT FROM ? AND COALESCE(decisions_json, '[]') = COALESCE(?, '[]')
        `, [JSON.stringify(decisions), now, actor?.id || null, now, row.id, row.updated_at, row.decisions_json]);
        if (!changes) return formatRequest(await getRequestById(row.id), actor);
        const runChanged = await updateRunRecordCas(row.run_id, ['awaiting_approval', 'running'], {
            status: 'cancelled',
            error_message: 'Workflow approval rejected.',
            cancelled_at: now,
            completed_at: now,
            locked_by: null,
            lock_expires_at: null,
            updated_at: now
        });
        if (!runChanged) throw invalid('Workflow run is no longer awaiting this approval.', 409);
        await persistWorkflowApproval(row.run_id, row.approval_key, { status: 'rejected', requestId: row.id });
        await insertStep(row.run_id, {
            type: 'approval',
            title: 'Workflow approval rejected',
            toolName: 'workflow.approval',
            output: { status: 'rejected', requestId: row.id, comment: String(comment || '') }
        });
        return formatRequest(await getRequestById(row.id), actor);
    }

    const required = Number(row.required_levels || 1);
    const current = Number(row.current_level || 1);
    if (approvalCompletionKind(row, level, decisions) !== 'completed') {
        await execute(`
            UPDATE agent_approval_requests
            SET decisions_json = ?, updated_at = ?
            WHERE id = ? AND status = 'pending' AND updated_at IS NOT DISTINCT FROM ? AND COALESCE(decisions_json, '[]') = COALESCE(?, '[]')
        `, [JSON.stringify(decisions), now, row.id, row.updated_at, row.decisions_json]);
        return formatRequest(await getRequestById(row.id), actor);
    }
    if (current < required) {
        const token = createCallbackToken();
        const nextLevel = parseJson(row.levels_json, [])[current] || {}; const nextRequirementKeys = levelRequirementKeys(nextLevel);
        if (row.callback_signature_required && (String(nextLevel.mode || 'any').toLowerCase() !== 'any' || nextRequirementKeys.length !== 1)) throw invalid('下一审批级别不支持单一签名回调，请改用站内审批。', 400);
        const changes = await execute(`
            UPDATE agent_approval_requests
            SET current_level = current_level + 1, decisions_json = ?, updated_at = ?,
                callback_token_hash = ?, callback_token_hint = ?, callback_nonce = ?, callback_requirement_key = ?
            WHERE id = ? AND status = 'pending' AND current_level = ? AND updated_at IS NOT DISTINCT FROM ? AND COALESCE(decisions_json, '[]') = COALESCE(?, '[]')
        `, [JSON.stringify(decisions), now, row.callback_signature_required ? hashToken(token) : null, row.callback_signature_required ? token.slice(-8) : '', row.callback_signature_required ? createCallbackNonce() : '', row.callback_signature_required ? nextRequirementKeys[0] : '', row.id, current, row.updated_at, row.decisions_json]);
        if (!changes) return formatRequest(await getRequestById(row.id), actor);
        const updated = await getRequestById(row.id);
        await insertStep(row.run_id, {
            type: 'approval',
            title: 'Workflow approval advanced to next level',
            toolName: 'workflow.approval',
            output: { status: 'pending', requestId: row.id, currentLevel: updated.current_level, requiredLevels: required }
        });
        await notifyApprovers(updated, token);
        return formatRequest(updated, actor);
    }

    const changes = await execute(`
        UPDATE agent_approval_requests
        SET status = 'approved', decisions_json = ?, decided_at = ?, decided_by = ?, updated_at = ?,
            callback_token_hash = NULL, callback_nonce = ''
        WHERE id = ? AND status = 'pending' AND current_level = ? AND updated_at IS NOT DISTINCT FROM ? AND COALESCE(decisions_json, '[]') = COALESCE(?, '[]')
    `, [JSON.stringify(decisions), now, actor?.id || null, now, row.id, current, row.updated_at, row.decisions_json]);
    if (!changes) return formatRequest(await getRequestById(row.id), actor);
    const updated = await getRequestById(row.id);
    const output = buildApprovalOutput(updated, 'approved');
    const runChanged = await updateRunRecordCas(row.run_id, ['awaiting_approval'], {
        status: 'queued',
        error_message: '',
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
    if (!runChanged) throw invalid('Workflow run is no longer awaiting this approval.', 409);
    await persistWorkflowApproval(row.run_id, row.approval_key, { status: 'approved', requestId: row.id, output });
    await refreshRunResumeContext(row.run_id);
    await maybeCompleteDagNode(updated, output);
    await insertStep(row.run_id, {
        type: 'approval',
        title: 'Workflow approval approved',
        toolName: 'workflow.approval',
        output
    });
    await enqueueRun(row.run_id);
    return formatRequest(updated, actor);
}

async function decideWorkflowApprovalRequest(requestId, user, body = {}) {
    const row = await getRequestById(requestId);
    if (!row || row.request_type !== 'approval') return null;
    if (!canUserDecide(row, user)) throw invalid('Current user is not a designated approver for this level.', 403);
    const approve = body.approve !== false && String(body.decision || body.action || 'approve').toLowerCase() !== 'reject';
    return await applyApprovalDecision(row, user, approve, body.comment || body.reason || '');
}

async function verifyCallbackSignature(row, token, payload = {}, headers = {}) {
    if (!row.callback_signature_required) return;
    const secret = await getRequestSecret(row);
    if (!secret) throw invalid('Approval callback signature secret is unavailable.', 403);
    const decision = normalizeCallbackDecision(payload);
    const nonce = String(row.callback_nonce || '').trim();
    const supplied = String(
        headers['x-pivot-signature'] ||
        headers['X-Pivot-Signature'] ||
        payload.signature ||
        ''
    ).trim();
    const expected = signatureFor(secret, token, row.id, decision, nonce, row.callback_requirement_key || '');
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        throw invalid('Approval callback signature is invalid.', 403);
    }
}

function normalizeCallbackDecision(payload = {}) {
    const raw = payload.decision ?? payload.action ?? (payload.approve === false ? 'reject' : 'approve');
    const value = String(raw || 'approve').trim().toLowerCase();
    return ['reject', 'rejected', 'deny', 'denied', 'false'].includes(value) ? 'reject' : 'approve';
}

async function handleImApprovalCallback(token, payload = {}, headers = {}) {
    const safeToken = String(token || '').trim();
    if (!CALLBACK_TOKEN_PATTERN.test(safeToken)) return null;
    const row = await queryOne(`
        SELECT * FROM agent_approval_requests
        WHERE request_type = 'approval'
          AND status = 'pending'
          AND callback_token_hash = ?
        LIMIT 1
    `, [hashToken(safeToken)]);
    if (!row) return null;
    const suppliedRequestId = String(payload.approvalRequestId || payload.requestId || '').trim();
    if (suppliedRequestId && suppliedRequestId !== String(row.id)) {
        throw invalid('Approval callback requestId does not match the token.', 403);
    }
    await verifyCallbackSignature(row, safeToken, payload, headers);
    const decision = normalizeCallbackDecision(payload);
    if (!row.callback_signature_required || !row.callback_requirement_key) {
        throw invalid('该审批回调未绑定签名审批要求，请改用站内审批。', 403);
    }
    const actor = { id: null, username: 'im-callback', unit: '' };
    return await applyApprovalDecision(row, actor, decision === 'approve', payload.comment || payload.reason || '', {
        source: 'im-callback',
        tokenAuthenticated: true,
        callbackRequirementKey: row.callback_requirement_key
    });
}

async function expireApprovalRequest(row) {
    const action = normalizeTimeoutAction(row.timeout_action);
    if (action === 'approve') {
        return await applyApprovalDecision(row, { username: 'timeout' }, true, '', { system: true, reason: 'timeout' });
    }
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE agent_approval_requests
        SET status = 'expired', decided_at = ?, updated_at = ?, callback_token_hash = NULL, callback_nonce = ''
        WHERE id = ? AND status = 'pending' AND updated_at IS NOT DISTINCT FROM ?
    `, [now, now, row.id, row.updated_at]);
    if (!changes) return formatRequest(await getRequestById(row.id));
    const runChanged = await updateRunRecordCas(row.run_id, ['awaiting_approval'], {
        status: 'cancelled',
        error_message: 'Workflow approval timed out.',
        cancelled_at: now,
        completed_at: now,
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
    if (!runChanged) throw invalid('Workflow run is no longer awaiting this approval.', 409);
    await persistWorkflowApproval(row.run_id, row.approval_key, { status: 'expired', requestId: row.id });
    await insertStep(row.run_id, {
        type: 'approval',
        title: 'Workflow approval timed out',
        toolName: 'workflow.approval',
        output: { status: 'expired', requestId: row.id }
    });
    return formatRequest(await getRequestById(row.id));
}

async function runApprovalTimeouts(limit = 50) {
    const currentTimeExpr = nowExpr();
    const rows = await query(`
        SELECT *
        FROM agent_approval_requests
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= ${currentTimeExpr}
        ORDER BY expires_at ASC
        LIMIT ?
    `, [Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200))]);
    for (const row of rows) {
        try {
            const run = await getRun(row.run_id);
            if (!run || ['cancelled', 'deleted', 'completed', 'completed_with_errors', 'error'].includes(run.status)) {
                await execute("UPDATE agent_approval_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'", [
                    getBeijingTimestamp(), row.id
                ]);
                continue;
            }
            if (row.request_type === 'delay') await completeDelayRequest(row);
            else await expireApprovalRequest(row);
        } catch (err) {
            logger.warn({ err: err.message, requestId: row.id }, '审批超时状态处理失败');
        }
    }
    return rows.length;
}

module.exports = {
    CALLBACK_TOKEN_PATTERN,
    configureAgentApprovalRequests,
    decideWorkflowApprovalRequest,
    formatRequest,
    handleImApprovalCallback,
    listWorkflowApprovalRequests,
    runApprovalTimeouts,
    waitForWorkflowApproval,
    waitForWorkflowDelay
};
