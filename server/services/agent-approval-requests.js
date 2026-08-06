const crypto = require('crypto');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const { nowExpr } = require('../db/dialect');
const { parseJsonObject } = require('./agent-validators');
const { buildAgentResumeContext } = require('./agent-checkpoints');
const { resolveCredentialSecret } = require('./workflow-credentials');
const {
    getRequiredBuiltinConfig
} = require('./builtin-mcp-common');
const {
    buildImPayload,
    sendIm,
    validateImTarget
} = require('./builtin-mcp-im');

const CALLBACK_TOKEN_PATTERN = /^apr_[0-9a-f]{48}$/;
const MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_ACTION = 'reject';

const callbacks = {
    updateRun: null,
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

function invalid(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (_err) {
        return fallback;
    }
}

function splitList(value) {
    if (Array.isArray(value)) return value.flatMap(item => splitList(item));
    return String(value || '')
        .split(/[\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function uniqueNumbers(values = []) {
    return [...new Set(values
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isInteger(value) && value > 0))];
}

function uniqueStrings(values = []) {
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeTimeoutMs(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(parsed, MAX_WAIT_MS);
}

function normalizeTimeoutAction(value) {
    const action = String(value || DEFAULT_TIMEOUT_ACTION).trim().toLowerCase();
    return ['reject', 'approve', 'cancel'].includes(action) ? action : DEFAULT_TIMEOUT_ACTION;
}

function resolveApprovalTimeoutMs(input = {}) {
    const directMs = normalizeTimeoutMs(input.timeoutMs ?? input.timeout_ms);
    if (directMs) return directMs;
    const rawHours = input.timeoutHours ?? input.timeout_hours;
    const hours = Number.parseFloat(String(rawHours ?? '').trim());
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return normalizeTimeoutMs(hours * 60 * 60 * 1000);
}

function resolveUserReferences(values = []) {
    const refs = Array.isArray(values) ? values : splitList(values);
    const ids = [];
    const usernames = [];
    refs.forEach(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            ids.push(item.userId ?? item.user_id ?? item.id);
            if (item.username) usernames.push(item.username);
            return;
        }
        const text = String(item || '').trim();
        if (!text) return;
        if (/^\d+$/.test(text)) ids.push(text);
        else usernames.push(text);
    });
    const resolvedIds = uniqueNumbers(ids);
    const names = uniqueStrings(usernames);
    if (names.length) {
        const placeholders = names.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT id FROM users
            WHERE username IN (${placeholders})
               OR nickname IN (${placeholders})
        `).all(...names, ...names);
        rows.forEach(row => resolvedIds.push(row.id));
    }
    return uniqueNumbers(resolvedIds);
}

function collectLevelUserRefs(source = {}) {
    return [
        ...(Array.isArray(source.approvers) ? source.approvers : splitList(source.approvers)),
        ...(Array.isArray(source.approverUserIds) ? source.approverUserIds : splitList(source.approverUserIds)),
        ...(Array.isArray(source.approver_user_ids) ? source.approver_user_ids : splitList(source.approver_user_ids)),
        ...(Array.isArray(source.userIds) ? source.userIds : splitList(source.userIds)),
        ...(Array.isArray(source.user_ids) ? source.user_ids : splitList(source.user_ids)),
        ...(Array.isArray(source.users) ? source.users : splitList(source.users))
    ];
}

function normalizeLevel(source = {}, ownerUser = {}, fallbackMode = 'any') {
    const approverUserIds = resolveUserReferences(collectLevelUserRefs(source));
    const approverUnits = uniqueStrings([
        ...splitList(source.approverUnits),
        ...splitList(source.approver_units),
        ...splitList(source.units),
        ...splitList(source.unit)
    ]);
    const mode = String(source.mode || source.approvalMode || source.approval_mode || fallbackMode || 'any').trim().toLowerCase() === 'all'
        ? 'all'
        : 'any';
    if (!approverUserIds.length && !approverUnits.length && ownerUser?.id) {
        approverUserIds.push(Number(ownerUser.id));
    }
    return {
        title: String(source.title || '').trim().slice(0, 120),
        mode,
        approverUserIds: uniqueNumbers(approverUserIds),
        approverUnits
    };
}

function normalizeApprovalLevels(input = {}, ownerUser = {}) {
    const fallbackMode = String(input.mode || input.approvalMode || input.approval_mode || 'any').trim().toLowerCase() === 'all'
        ? 'all'
        : 'any';
    const rawLevels = Array.isArray(input.approvalLevels || input.approval_levels || input.levels)
        ? (input.approvalLevels || input.approval_levels || input.levels)
        : [];
    const levels = rawLevels.length
        ? rawLevels.map(level => normalizeLevel(level, ownerUser, fallbackMode))
        : [normalizeLevel(input, ownerUser, fallbackMode)];
    return levels
        .filter(level => level.approverUserIds.length || level.approverUnits.length)
        .slice(0, 10);
}

function getRun(runId) {
    return db.prepare('SELECT * FROM agent_runs WHERE id = ? AND deleted_at IS NULL').get(runId) || null;
}

function getRunOwner(runId) {
    return db.prepare(`
        SELECT u.id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username,
               u.nickname, u.unit, u.role
        FROM agent_runs r
        JOIN users u ON u.id = r.user_id
        WHERE r.id = ? AND COALESCE(u.status, 'active') != 'disabled' AND u.deleted_at IS NULL
    `).get(runId) || null;
}

function getRunMetadataById(runId) {
    const row = db.prepare('SELECT metadata FROM agent_runs WHERE id = ?').get(runId) || {};
    return parseJsonObject(row.metadata) || {};
}

function mergeRunMetadata(runId, patch = {}) {
    if (typeof callbacks.setRunMetadata === 'function') {
        callbacks.setRunMetadata(runId, patch);
        return;
    }
    const current = getRunMetadataById(runId);
    db.prepare('UPDATE agent_runs SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...current, ...patch }), getBeijingTimestamp(), runId);
}

function refreshRunResumeContext(runId) {
    const resumeContext = buildAgentResumeContext(runId);
    mergeRunMetadata(runId, { resumeContext });
    return resumeContext;
}

function updateRunRecord(runId, fields = {}) {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    if (typeof callbacks.updateRun === 'function') {
        callbacks.updateRun(runId, fields);
        return;
    }
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE agent_runs SET ${set} WHERE id = ?`).run(...entries.map(([, value]) => value), runId);
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

function resolveCallbackSecretSlug(slug, user) {
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedSlug) return '';
    const resolved = user ? resolveCredentialSecret(normalizedSlug, user) : null;
    return resolved?.value || '';
}

function approvalKeyFor(node = {}, input = {}, fallback = '') {
    return String(
        input.approvalKey ||
        input.approval_key ||
        node.approvalKey ||
        node.approval_key ||
        fallback ||
        `workflow.approval:${node.id || 'node'}`
    ).trim().slice(0, 240);
}

function delayKeyFor(node = {}, fallback = '') {
    return String(fallback || `workflow.delay:${node.id || 'node'}`).trim().slice(0, 240);
}

function getRequestByRunKey(runId, requestType, approvalKey) {
    return db.prepare(`
        SELECT * FROM agent_approval_requests
        WHERE run_id = ? AND request_type = ? AND approval_key = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `).get(runId, requestType, approvalKey) || null;
}

function getRequestById(requestId) {
    return db.prepare('SELECT * FROM agent_approval_requests WHERE id = ?').get(requestId) || null;
}

function formatRequest(row, user = null) {
    if (!row) return null;
    const levels = parseJson(row.levels_json, []);
    const decisions = parseJson(row.decisions_json, []);
    return {
        id: row.id,
        run_id: row.run_id,
        user_id: row.user_id,
        request_type: row.request_type || 'approval',
        node_key: row.node_key || '',
        approval_key: row.approval_key || '',
        title: row.title || '',
        summary: row.summary || '',
        instructions: row.instructions || '',
        status: row.status || 'pending',
        current_level: Number(row.current_level || 1),
        required_levels: Number(row.required_levels || levels.length || 1),
        levels,
        decisions,
        expires_at: row.expires_at || '',
        decided_at: row.decided_at || '',
        decided_by: row.decided_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        can_decide: user ? canUserDecide(row, user) : false
    };
}

function currentLevel(row) {
    const levels = parseJson(row.levels_json, []);
    const index = Math.max(Number(row.current_level || 1) - 1, 0);
    return levels[index] || levels[0] || { approverUserIds: [], approverUnits: [] };
}

function levelRequirementKeys(level = {}) {
    return [
        ...uniqueNumbers(level.approverUserIds || level.approver_user_ids || []).map(id => `user:${id}`),
        ...uniqueStrings(level.approverUnits || level.approver_units || []).map(unit => `unit:${unit}`)
    ];
}

function actorRequirementKeys(actor = {}, level = {}) {
    if (isSuperAdmin(actor)) return levelRequirementKeys(level);
    const keys = [];
    if (actor?.id) keys.push(`user:${Number(actor.id)}`);
    const unit = String(actor?.unit || '').trim();
    if (unit) keys.push(`unit:${unit}`);
    return uniqueStrings(keys);
}

function decisionSatisfiedKeys(decision = {}, level = {}) {
    if (Array.isArray(decision.satisfiedKeys) && decision.satisfiedKeys.length) {
        return uniqueStrings(decision.satisfiedKeys);
    }
    const keys = [];
    const userId = Number(decision.userId || 0);
    if (userId && uniqueNumbers(level.approverUserIds || []).includes(userId)) {
        keys.push(`user:${userId}`);
    }
    const unit = String(decision.unit || decision.userUnit || '').trim();
    if (unit && uniqueStrings(level.approverUnits || []).includes(unit)) {
        keys.push(`unit:${unit}`);
    }
    if ((decision.system || String(decision.username || '').trim() === 'timeout') && !keys.length) {
        return levelRequirementKeys(level);
    }
    return uniqueStrings(keys);
}

function collectSatisfiedKeys(row, level = {}, levelNumber = 1) {
    const satisfied = new Set();
    const decisions = parseJson(row.decisions_json, []);
    decisions
        .filter(decision => Number(decision.level || 1) === Number(levelNumber) && String(decision.decision || '').toLowerCase() === 'approved')
        .forEach(decision => {
            decisionSatisfiedKeys(decision, level).forEach(key => satisfied.add(key));
        });
    return satisfied;
}

function canUserDecide(row, user) {
    if (!row || row.status !== 'pending') return false;
    if (isSuperAdmin(user)) return true;
    const level = currentLevel(row);
    const requirements = levelRequirementKeys(level);
    if (!requirements.length) return false;
    const actorKeys = actorRequirementKeys(user, level);
    if (!actorKeys.length) return false;
    const satisfied = collectSatisfiedKeys(row, level, Number(row.current_level || 1));
    return actorKeys.some(key => requirements.includes(key) && !satisfied.has(key));
}

function approvalCompletionKind(row, level = {}, decisions = []) {
    const requirementKeys = levelRequirementKeys(level);
    if (!requirementKeys.length) return 'pending';
    const satisfied = new Set();
    decisions
        .filter(decision => Number(decision.level || 1) === Number(row.current_level || 1) && String(decision.decision || '').toLowerCase() === 'approved')
        .forEach(decision => {
            decisionSatisfiedKeys(decision, level).forEach(key => satisfied.add(key));
        });
    const mode = String(level.mode || 'any').trim().toLowerCase() === 'all' ? 'all' : 'any';
    const done = mode === 'all'
        ? requirementKeys.every(key => satisfied.has(key))
        : requirementKeys.some(key => satisfied.has(key));
    return done ? 'completed' : 'pending';
}

function listWorkflowApprovalRequests(user, options = {}) {
    const status = String(options.status || 'pending').trim();
    const rows = db.prepare(`
        SELECT ar.*
        FROM agent_approval_requests ar
        JOIN agent_runs r ON r.id = ar.run_id
        WHERE ar.request_type = 'approval'
          AND (? = '' OR ar.status = ?)
          AND r.deleted_at IS NULL
        ORDER BY ar.created_at DESC
        LIMIT 200
    `).all(status, status);
    return rows
        .filter(row => row.user_id === user.id || canUserDecide(row, user) || isSuperAdmin(user))
        .map(row => formatRequest(row, user));
}

function updateRunToAwaiting(runId, errorMessage = '') {
    const run = getRun(runId);
    if (!run || ['cancelled', 'deleted', 'completed', 'completed_with_errors', 'error'].includes(run.status)) return;
    const now = getBeijingTimestamp();
    updateRunRecord(runId, {
        status: 'awaiting_approval',
        error_message: errorMessage,
        last_heartbeat_at: now,
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
}

function enqueueRun(runId) {
    const user = getRunOwner(runId);
    if (!user) return;
    callbacks.enqueueAgentRun?.(runId, user);
}

function insertStep(runId, data = {}) {
    const stepIndex = typeof callbacks.listSteps === 'function'
        ? callbacks.listSteps(runId).length + 1
        : (db.prepare('SELECT COALESCE(MAX(step_index), 0) AS maxStep FROM agent_steps WHERE run_id = ?').get(runId)?.maxStep || 0) + 1;
    if (typeof callbacks.insertStep === 'function') {
        callbacks.insertStep(runId, stepIndex, data);
        return;
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO agent_steps (
            run_id, step_index, type, title, tool_name, input, output, error_message,
            status, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        stepIndex,
        data.type || 'note',
        data.title || '',
        data.toolName || '',
        data.input === undefined ? '' : JSON.stringify(data.input),
        data.output === undefined ? '' : JSON.stringify(data.output),
        data.errorMessage || '',
        data.status || 'success',
        Number(data.durationMs) || 0,
        data.startedAt || now,
        data.completedAt || now,
        now
    );
}

function throwAwaiting(message, requestId = '') {
    const err = new Error(message);
    err.code = 'AGENT_APPROVAL_REQUIRED';
    err.approvalRequestId = requestId;
    throw err;
}

function buildApprovalOutput(row, status = 'approved') {
    return {
        approved: status === 'approved',
        status,
        requestId: row.id,
        approvalKey: row.approval_key,
        title: row.title || '',
        summary: row.summary || '',
        currentLevel: Number(row.current_level || 1),
        requiredLevels: Number(row.required_levels || 1),
        decisions: parseJson(row.decisions_json, [])
    };
}

function buildDelayOutput(row) {
    const input = parseJson(row.input_json, {});
    return {
        delayed: true,
        status: 'completed',
        requestId: row.id,
        delayKey: row.approval_key,
        durationMs: Number(input.durationMs ?? input.duration_ms ?? 0) || 0,
        reason: String(input.reason || ''),
        completedAt: row.decided_at || getBeijingTimestamp()
    };
}

function persistWorkflowApproval(runId, key, value) {
    const metadata = getRunMetadataById(runId);
    mergeRunMetadata(runId, {
        workflowApprovals: {
            ...(metadata.workflowApprovals && typeof metadata.workflowApprovals === 'object' ? metadata.workflowApprovals : {}),
            [key]: value
        },
        pendingWorkflowApproval: null
    });
}

function persistWorkflowDelay(runId, key, value) {
    const metadata = getRunMetadataById(runId);
    mergeRunMetadata(runId, {
        workflowDelays: {
            ...(metadata.workflowDelays && typeof metadata.workflowDelays === 'object' ? metadata.workflowDelays : {}),
            [key]: value
        },
        pendingWorkflowDelay: null
    });
}

function maybeCompleteDagNode(row, output) {
    if (!row.node_key) return;
    if (typeof callbacks.upsertDagNode === 'function') {
        callbacks.upsertDagNode(
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
    db.prepare(`
        UPDATE agent_dag_nodes
        SET status = 'completed',
            output = ?,
            error_message = '',
            completed_at = ?
        WHERE run_id = ? AND node_key = ?
    `).run(JSON.stringify(output), getBeijingTimestamp(), row.run_id, row.node_key);
}

function markDagNodeWaiting(row, output) {
    if (!row.node_key) return;
    if (typeof callbacks.upsertDagNode === 'function') {
        callbacks.upsertDagNode(
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
    db.prepare(`
        UPDATE agent_dag_nodes
        SET status = 'waiting_approval',
            output = ?,
            error_message = '',
            started_at = COALESCE(started_at, ?),
            completed_at = NULL
        WHERE run_id = ? AND node_key = ?
    `).run(JSON.stringify(output), row.started_at || getBeijingTimestamp(), row.run_id, row.node_key);
}

function signatureFor(secret, token, requestId, decision, nonce = '') {
    return `sha256=${crypto
        .createHmac('sha256', secret)
        .update(`${token}.${requestId}.${decision}.${nonce}`)
        .digest('hex')}`;
}

function getRequestSecret(row) {
    const slug = String(row.callback_credential_slug || '').trim();
    if (!slug) return '';
    const owner = getRunOwner(row.run_id);
    return owner ? resolveCallbackSecretSlug(slug, owner) : '';
}

function buildCallbackActions(row, token) {
    if (!token) return {};
    const secret = getRequestSecret(row);
    const nonce = String(row.callback_nonce || '').trim();
    const build = decision => {
        const payload = { decision, requestId: row.id, approvalRequestId: row.id };
        if (secret) payload.signature = signatureFor(secret, token, row.id, decision, nonce);
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
    const run = getRun(row.run_id);
    if (!run) return;
    const owner = getRunOwner(row.run_id) || { id: row.user_id };
    const level = currentLevel(row);
    const directIds = uniqueNumbers(level.approverUserIds || []);
    const units = uniqueStrings(level.approverUnits || []);
    let userIds = directIds;
    if (units.length) {
        const placeholders = units.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT id FROM users
            WHERE unit IN (${placeholders})
              AND COALESCE(status, 'active') != 'disabled'
              AND deleted_at IS NULL
            LIMIT 100
        `).all(...units);
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
        const server = db.prepare("SELECT * FROM mcp_servers WHERE id = ? AND status != 'deleted'").get(serverId);
        if (!server) return;
        const { config, secret } = getRequiredBuiltinConfig(server, 'im');
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
                actions: buildCallbackActions(row, token)
            }
        };
        const payload = buildImPayload(config, defaultPayload, user, { run, approval: formatRequest(row) });
        await sendIm(config, secret, payload, user);
    } catch (err) {
        logger.warn({ err: err.message, requestId: row.id }, 'Failed to send workflow approval IM notification');
    }
}

function createApprovalRequest({ run, user, node, input, key }) {
    const levels = normalizeApprovalLevels(input, user);
    if (!levels.length) throw invalid('Approval node has no valid approver.', 400);
    const token = createCallbackToken();
    const now = getBeijingTimestamp();
    const timeoutMs = resolveApprovalTimeoutMs(input);
    const expiresAt = timeoutMs ? getBeijingTimestamp(new Date(Date.now() + timeoutMs)) : null;
    const callbackCredential = String(input.callbackCredential || input.callback_credential || '').trim();
    const callbackSecret = resolveCallbackSecretSlug(callbackCredential, user);
    if (callbackCredential && !callbackSecret) {
        throw invalid('Callback credential is unavailable or cannot be decrypted.', 403);
    }
    const requestId = crypto.randomUUID();
    const summary = input.summary === undefined || input.summary === null
        ? ''
        : (typeof input.summary === 'string' ? input.summary : JSON.stringify(input.summary));
    const callbackNonce = callbackSecret ? createCallbackNonce() : '';
    db.prepare(`
        INSERT INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            callback_token_hash, callback_token_hint, callback_nonce, callback_credential_slug, callback_signature_required,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', ?, ?, ?, ?, ?, 'pending', 1, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        requestId,
        run.id,
        run.user_id,
        node.id || '',
        key,
        String(input.title || node.title || 'Workflow approval').trim().slice(0, 160),
        summary.slice(0, 2000),
        String(input.instructions || '').trim().slice(0, 2000),
        levels.length,
        JSON.stringify(levels),
        JSON.stringify(input),
        hashToken(token),
        token.slice(-8),
        callbackNonce,
        callbackCredential,
        callbackSecret ? 1 : 0,
        normalizeTimeoutAction(input.timeoutAction || input.timeout_action),
        expiresAt,
        now,
        now
    );
    return { row: getRequestById(requestId), token };
}

async function waitForWorkflowApproval({ run, user, node, input = {}, key = '' }) {
    const approvalKey = approvalKeyFor(node, input, key);
    const metadata = getRunMetadataById(run.id);
    const recorded = metadata.workflowApprovals?.[approvalKey];
    if (recorded?.status === 'approved') return recorded.output || recorded;
    const existing = getRequestByRunKey(run.id, 'approval', approvalKey);
    if (existing?.status === 'approved') {
        const output = buildApprovalOutput(existing, 'approved');
        persistWorkflowApproval(run.id, approvalKey, { status: 'approved', requestId: existing.id, output });
        return output;
    }
    if (existing && ['rejected', 'expired', 'cancelled'].includes(existing.status)) {
        const err = new Error(`Workflow approval ${existing.status}.`);
        err.code = 'AGENT_APPROVAL_REJECTED';
        throw err;
    }
    let row = existing;
    let token = '';
    if (!row) {
        const created = createApprovalRequest({ run, user, node, input, key: approvalKey });
        row = created.row;
        token = created.token;
        markDagNodeWaiting(row, { status: 'pending', requestId: row.id, approvalKey });
        insertStep(run.id, {
            type: 'approval',
            title: 'Workflow approval requested',
            toolName: 'workflow.approval',
            input,
            output: { status: 'pending', requestId: row.id, approvalKey }
        });
        await notifyApprovers(row, token);
    }
    mergeRunMetadata(run.id, {
        pendingWorkflowApproval: {
            requestId: row.id,
            approvalKey,
            nodeId: node.id || '',
            title: row.title || '',
            currentLevel: row.current_level || 1,
            requiredLevels: row.required_levels || 1
        }
    });
    updateRunToAwaiting(run.id, 'Waiting for workflow approval.');
    throwAwaiting('Workflow approval is pending.', row.id);
}

function createDelayRequest({ run, node, input, key }) {
    const durationMs = normalizeTimeoutMs(input.durationMs ?? input.duration_ms);
    const now = getBeijingTimestamp();
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + durationMs));
    const requestId = crypto.randomUUID();
    db.prepare(`
        INSERT INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'delay', ?, ?, ?, ?, '', 'pending', 1, 1, '[]', '[]', ?, 'approve', ?, ?, ?)
    `).run(
        requestId,
        run.id,
        run.user_id,
        node.id || '',
        key,
        String(node.title || input.reason || 'Workflow delay').trim().slice(0, 160),
        String(input.reason || '').trim().slice(0, 1000),
        JSON.stringify({ ...input, durationMs }),
        expiresAt,
        now,
        now
    );
    return getRequestById(requestId);
}

function completeDelayRequest(row, { enqueue = true } = {}) {
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE agent_approval_requests
        SET status = 'completed', decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
    `).run(now, now, row.id);
    const updated = getRequestById(row.id) || row;
    const output = buildDelayOutput(updated);
    persistWorkflowDelay(row.run_id, row.approval_key, { status: 'completed', requestId: row.id, output });
    refreshRunResumeContext(row.run_id);
    maybeCompleteDagNode(updated, output);
    updateRunRecord(row.run_id, {
        status: 'queued',
        error_message: '',
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
    insertStep(row.run_id, {
        type: 'control',
        title: 'Workflow delay completed',
        output
    });
    if (enqueue) enqueueRun(row.run_id);
    return output;
}

async function waitForWorkflowDelay({ run, node, input = {}, key = '' }) {
    const durationMs = normalizeTimeoutMs(input.durationMs ?? input.duration_ms);
    if (!durationMs) {
        return { delayed: false, durationMs: 0, reason: String(input.reason || ''), completedAt: getBeijingTimestamp() };
    }
    const delayKey = delayKeyFor(node, key);
    const metadata = getRunMetadataById(run.id);
    const recorded = metadata.workflowDelays?.[delayKey];
    if (recorded?.status === 'completed') return recorded.output || recorded;
    const existing = getRequestByRunKey(run.id, 'delay', delayKey);
    if (existing?.status === 'completed') {
        const output = buildDelayOutput(existing);
        persistWorkflowDelay(run.id, delayKey, { status: 'completed', requestId: existing.id, output });
        return output;
    }
    if (existing?.status === 'pending' && existing.expires_at && existing.expires_at <= getBeijingTimestamp()) {
        return completeDelayRequest(existing, { enqueue: false });
    }
    const row = existing || createDelayRequest({ run, node, input: { ...input, durationMs }, key: delayKey });
    markDagNodeWaiting(row, { status: 'pending', requestId: row.id, delayKey, durationMs });
    if (!existing) {
        insertStep(run.id, {
            type: 'control',
            title: 'Workflow delay requested',
            toolName: 'workflow.delay',
            input,
            output: { status: 'pending', requestId: row.id, delayKey, durationMs }
        });
    }
    mergeRunMetadata(run.id, {
        pendingWorkflowDelay: {
            requestId: row.id,
            delayKey,
            nodeId: node.id || '',
            expiresAt: row.expires_at || ''
        }
    });
    updateRunToAwaiting(run.id, 'Waiting for workflow delay.');
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
    let matchedKeys = options.system && approve
        ? requirementKeys
        : actorKeys.filter(key => requirementKeys.includes(key));
    if (approve && !matchedKeys.length && options.tokenAuthenticated && levelMode === 'any' && requirementKeys.length) {
        matchedKeys = [requirementKeys[0]];
    }
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
        db.prepare(`
            UPDATE agent_approval_requests
            SET status = 'rejected', decisions_json = ?, decided_at = ?, decided_by = ?, updated_at = ?,
                callback_token_hash = NULL, callback_nonce = ''
            WHERE id = ? AND status = 'pending'
        `).run(JSON.stringify(decisions), now, actor?.id || null, now, row.id);
        persistWorkflowApproval(row.run_id, row.approval_key, { status: 'rejected', requestId: row.id });
        updateRunRecord(row.run_id, {
            status: 'cancelled',
            error_message: 'Workflow approval rejected.',
            cancelled_at: now,
            completed_at: now,
            locked_by: null,
            lock_expires_at: null,
            updated_at: now
        });
        insertStep(row.run_id, {
            type: 'approval',
            title: 'Workflow approval rejected',
            toolName: 'workflow.approval',
            output: { status: 'rejected', requestId: row.id, comment: String(comment || '') }
        });
        return formatRequest(getRequestById(row.id), actor);
    }

    const required = Number(row.required_levels || 1);
    const current = Number(row.current_level || 1);
    if (approvalCompletionKind(row, level, decisions) !== 'completed') {
        db.prepare(`
            UPDATE agent_approval_requests
            SET decisions_json = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(JSON.stringify(decisions), now, row.id);
        return formatRequest(getRequestById(row.id), actor);
    }
    if (current < required) {
        const token = createCallbackToken();
        db.prepare(`
            UPDATE agent_approval_requests
            SET current_level = current_level + 1, decisions_json = ?, updated_at = ?,
                callback_token_hash = ?, callback_token_hint = ?, callback_nonce = ?
            WHERE id = ? AND status = 'pending'
        `).run(JSON.stringify(decisions), now, hashToken(token), token.slice(-8), createCallbackNonce(), row.id);
        const updated = getRequestById(row.id);
        insertStep(row.run_id, {
            type: 'approval',
            title: 'Workflow approval advanced to next level',
            toolName: 'workflow.approval',
            output: { status: 'pending', requestId: row.id, currentLevel: updated.current_level, requiredLevels: required }
        });
        await notifyApprovers(updated, token);
        return formatRequest(updated, actor);
    }

    db.prepare(`
        UPDATE agent_approval_requests
        SET status = 'approved', decisions_json = ?, decided_at = ?, decided_by = ?, updated_at = ?,
            callback_token_hash = NULL, callback_nonce = ''
        WHERE id = ? AND status = 'pending'
    `).run(JSON.stringify(decisions), now, actor?.id || null, now, row.id);
    const updated = getRequestById(row.id);
    const output = buildApprovalOutput(updated, 'approved');
    persistWorkflowApproval(row.run_id, row.approval_key, { status: 'approved', requestId: row.id, output });
    refreshRunResumeContext(row.run_id);
    maybeCompleteDagNode(updated, output);
    updateRunRecord(row.run_id, {
        status: 'queued',
        error_message: '',
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
    insertStep(row.run_id, {
        type: 'approval',
        title: 'Workflow approval approved',
        toolName: 'workflow.approval',
        output
    });
    enqueueRun(row.run_id);
    return formatRequest(updated, actor);
}

async function decideWorkflowApprovalRequest(requestId, user, body = {}) {
    const row = getRequestById(requestId);
    if (!row || row.request_type !== 'approval') return null;
    if (!canUserDecide(row, user)) throw invalid('Current user is not a designated approver for this level.', 403);
    const approve = body.approve !== false && String(body.decision || body.action || 'approve').toLowerCase() !== 'reject';
    return applyApprovalDecision(row, user, approve, body.comment || body.reason || '');
}

function verifyCallbackSignature(row, token, payload = {}, headers = {}) {
    if (!row.callback_signature_required) return;
    const secret = getRequestSecret(row);
    if (!secret) throw invalid('Approval callback signature secret is unavailable.', 403);
    const decision = normalizeCallbackDecision(payload);
    const nonce = String(row.callback_nonce || '').trim();
    const supplied = String(
        headers['x-pivot-signature'] ||
        headers['X-Pivot-Signature'] ||
        payload.signature ||
        ''
    ).trim();
    const expected = signatureFor(secret, token, row.id, decision, nonce);
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
    const row = db.prepare(`
        SELECT * FROM agent_approval_requests
        WHERE request_type = 'approval'
          AND status = 'pending'
          AND callback_token_hash = ?
        LIMIT 1
    `).get(hashToken(safeToken));
    if (!row) return null;
    const suppliedRequestId = String(payload.approvalRequestId || payload.requestId || '').trim();
    if (suppliedRequestId && suppliedRequestId !== String(row.id)) {
        throw invalid('Approval callback requestId does not match the token.', 403);
    }
    verifyCallbackSignature(row, safeToken, payload, headers);
    const decision = normalizeCallbackDecision(payload);
    const actor = {
        id: Number(payload.userId || payload.user_id || 0) || null,
        username: String(payload.username || payload.approver || 'im-callback').slice(0, 120),
        unit: String(payload.unit || payload.approverUnit || '').trim()
    };
    return applyApprovalDecision(row, actor, decision === 'approve', payload.comment || payload.reason || '', {
        source: 'im-callback',
        tokenAuthenticated: true
    });
}

async function expireApprovalRequest(row) {
    const action = normalizeTimeoutAction(row.timeout_action);
    if (action === 'approve') {
        return applyApprovalDecision(row, { username: 'timeout' }, true, '', { system: true, reason: 'timeout' });
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE agent_approval_requests
        SET status = 'expired', decided_at = ?, updated_at = ?, callback_token_hash = NULL, callback_nonce = ''
        WHERE id = ? AND status = 'pending'
    `).run(now, now, row.id);
    persistWorkflowApproval(row.run_id, row.approval_key, { status: 'expired', requestId: row.id });
    updateRunRecord(row.run_id, {
        status: 'cancelled',
        error_message: 'Workflow approval timed out.',
        cancelled_at: now,
        completed_at: now,
        locked_by: null,
        lock_expires_at: null,
        updated_at: now
    });
    insertStep(row.run_id, {
        type: 'approval',
        title: 'Workflow approval timed out',
        toolName: 'workflow.approval',
        output: { status: 'expired', requestId: row.id }
    });
    return formatRequest(getRequestById(row.id));
}

async function runApprovalTimeouts(limit = 50) {
    const currentTimeExpr = nowExpr();
    const rows = db.prepare(`
        SELECT *
        FROM agent_approval_requests
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= ${currentTimeExpr}
        ORDER BY expires_at ASC
        LIMIT ?
    `).all(Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200)));
    for (const row of rows) {
        try {
            const run = getRun(row.run_id);
            if (!run || ['cancelled', 'deleted', 'completed', 'completed_with_errors', 'error'].includes(run.status)) {
                db.prepare("UPDATE agent_approval_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'")
                    .run(getBeijingTimestamp(), row.id);
                continue;
            }
            if (row.request_type === 'delay') completeDelayRequest(row);
            else await expireApprovalRequest(row);
        } catch (err) {
            logger.warn({ err: err.message, requestId: row.id }, 'Approval timeout processing failed');
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
