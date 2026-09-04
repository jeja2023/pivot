const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getUserSettingValueAsync, setUserSettingAsync } = require('./user-settings');
const { getRunnableModelForUserAsync } = require('./models');
const { callModelText } = require('./agent-model');
const { parseJsonObject } = require('./agent-validators');
const { listAgentToolCalls } = require('./agent-tool-audit');
const { compileTraceToWorkflow } = require('./agent-trace-compiler');
const { resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');
const { normalizeToolContract } = require('./agent-contracts');
const { upsertMemory } = require('./long-term-memory');
const { hasSensitiveContent } = require('./long-term-memory/memory-utils');
const { createEvolutionProposal, updateEvolutionArtifact } = require('./agent-evolution');

const SETTINGS_KEY = 'agent_learning_settings';
const MAX_DAILY_JOBS = 3;
const MAX_JOB_ATTEMPTS = 3;
const ARCHIVE_AFTER_DAYS = Math.max(30, Math.min(Number.parseInt(process.env.AGENT_LEARNING_ARCHIVE_AFTER_DAYS, 10) || 90, 3650));
const JOB_STATUSES = Object.freeze(['queued', 'analyzing', 'candidate_created', 'validating', 'completed', 'failed', 'validation_failed']);
const TRIGGERS = Object.freeze(['success', 'recovery', 'correction', 'explicit']);
const UNSAFE_INSTRUCTION_RE = /(?:ignore\s+(?:all\s+)?previous|system\s+prompt|developer\s+message|reveal\s+(?:the\s+)?(?:secret|token|password)|泄露(?:密钥|令牌|密码)|忽略(?:之前|前文|系统)|系统提示词|开发者消息)/i;
const SAFE_LEARNING_CAPABILITIES = new Set(['knowledge.search', 'knowledge.read', 'knowledge.graph_query', 'data.sql.query', 'data.duckdb.query', 'data.dataset.read', 'system.observe']);
let lastArchiveSweepAt = 0;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeSettings(value = {}) {
    const parsed = typeof value === 'string' ? parseJson(value, {}) : value;
    return {
        autoLearning: parsed?.autoLearning !== false,
        autoActivate: parsed?.autoActivate !== false,
        notifyLearning: parsed?.notifyLearning !== false,
        dailyLimit: Math.max(1, Math.min(Number.parseInt(parsed?.dailyLimit, 10) || MAX_DAILY_JOBS, 20)),
        minConfidence: clamp(parsed?.minConfidence ?? 0.7, 0, 1),
        maxSkillTools: Math.max(1, Math.min(Number.parseInt(parsed?.maxSkillTools, 10) || 8, 20))
    };
}

async function getAgentLearningSettings(userId) {
    return normalizeSettings(await getUserSettingValueAsync(userId, SETTINGS_KEY));
}

async function updateAgentLearningSettings(userId, patch = {}) {
    const settings = normalizeSettings({ ...(await getAgentLearningSettings(userId)), ...(patch || {}) });
    await setUserSettingAsync(userId, SETTINGS_KEY, JSON.stringify(settings));
    return settings;
}

function normalizeTrigger(value) {
    const trigger = String(value || 'success').trim().toLowerCase();
    return TRIGGERS.includes(trigger) ? trigger : 'success';
}

function jobId() { return `learn_${crypto.randomUUID()}`; }

async function enqueueAgentLearningJob(user, sourceRunId, triggerType = 'success', options = {}) {
    const userId = Number.parseInt(user?.id || user, 10);
    const runId = String(sourceRunId || '').trim();
    const trigger = normalizeTrigger(triggerType);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !runId) return { scheduled: false, reason: 'invalid_input' };
    const run = await queryOne('SELECT id, user_id, tenant_id, status, model_id, chosen_model_id, metadata, goal, title, final_answer, error_message FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [runId, userId]);
    if (!run) return { scheduled: false, reason: 'run_not_found' };
    if (hasSensitiveContent(`${run.goal || ''}\n${run.final_answer || ''}\n${run.error_message || ''}`)) return { scheduled: false, reason: 'sensitive_source' };
    const metadata = parseJson(run.metadata, {});
    if (metadata.evaluation || metadata.evaluationRunId) return { scheduled: false, reason: 'evaluation_run' };
    const settings = await getAgentLearningSettings(userId);
    if (trigger !== 'explicit' && !settings.autoLearning) return { scheduled: false, reason: 'disabled' };
    if (['success', 'recovery'].includes(trigger) && (await listAgentToolCalls(runId, { limit: 500 })).filter(isSafeLearningCall).length < 2) return { scheduled: false, reason: 'insufficient_safe_steps' };
    const today = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const count = await queryOne("SELECT COUNT(*) AS count FROM agent_learning_jobs WHERE user_id = ? AND created_at >= ? AND status NOT IN ('failed', 'validation_failed')", [userId, today]);
    if (trigger !== 'explicit' && Number(count?.count || 0) >= settings.dailyLimit) return { scheduled: false, reason: 'daily_limit' };
    const now = getBeijingTimestamp();
    const existing = await queryOne('SELECT * FROM agent_learning_jobs WHERE user_id = ? AND source_run_id = ? AND trigger_type = ?', [userId, runId, trigger]);
    if (existing) return { scheduled: true, deduped: true, job: serializeLearningJob(existing) };
    const id = jobId();
    const modelId = Number(run.chosen_model_id || run.model_id || 0) || null;
    const resultSummary = { requestedKind: options.kind || '', requestedTitle: String(options.title || '').slice(0, 120), requestedVariables: options.variables || {} };
    await execute(`INSERT INTO agent_learning_jobs (id, user_id, tenant_id, source_run_id, trigger_type, status, attempts, max_attempts, next_run_at, model_id, budget_snapshot, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)`, [id, userId, user.tenant_id || run.tenant_id || null, runId, trigger, MAX_JOB_ATTEMPTS, now, modelId, JSON.stringify({ maxTokens: 3000, timeoutMs: 120000 }), JSON.stringify(resultSummary), now, now]);
    return { scheduled: true, deduped: false, job: serializeLearningJob(await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [id])) };
}

function serializeLearningJob(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: Number(row.user_id),
        tenantId: row.tenant_id ? Number(row.tenant_id) : null,
        sourceRunId: row.source_run_id,
        triggerType: row.trigger_type,
        status: row.status,
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || MAX_JOB_ATTEMPTS),
        modelId: row.model_id ? Number(row.model_id) : null,
        resultSummary: parseJson(row.result_summary, {}),
        errorCode: row.error_code || '',
        errorMessage: row.error_message || '',
        proposalId: row.proposal_id || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        completedAt: row.completed_at || null
    };
}

async function claimAgentLearningJobs(limit = 2) {
    const now = getBeijingTimestamp();
    const stale = getBeijingTimestamp(new Date(Date.now() - 15 * 60 * 1000));
    await execute(`UPDATE agent_learning_jobs SET status = 'failed', error_code = 'LEARNING_ATTEMPTS_EXHAUSTED', error_message = '学习任务在恢复前已耗尽重试次数。', locked_at = NULL, locked_by = '', completed_at = ?, updated_at = ? WHERE status = 'analyzing' AND locked_at IS NOT NULL AND locked_at < ? AND attempts >= max_attempts`, [now, now, stale]);
    const rows = await query(`SELECT * FROM agent_learning_jobs WHERE attempts < max_attempts AND ((status = 'queued' AND COALESCE(next_run_at, created_at) <= ?) OR (status = 'analyzing' AND locked_at IS NOT NULL AND locked_at < ?)) ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC LIMIT ?`, [now, stale, Math.max(1, Math.min(Number(limit) || 2, 10))]);
    const claimed = [];
    for (const row of rows) {
        const token = `${process.pid}:${crypto.randomUUID()}`;
        const changes = await execute("UPDATE agent_learning_jobs SET status = 'analyzing', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ? WHERE id = ? AND attempts < max_attempts AND (status = 'queued' OR (status = 'analyzing' AND locked_at < ?))", [now, token, now, row.id, stale]);
        if (Number(changes || 0) > 0) claimed.push(await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [row.id]));
    }
    return claimed;
}

function safeName(value, fallback = 'personal-experience') {
    const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (text && /[a-z0-9]/i.test(text)) return text;
    return `${fallback}-${crypto.createHash('sha256').update(String(value || fallback)).digest('hex').slice(0, 10)}`;
}

function isSafeLearningInstruction(value) {
    const text = String(value || '').trim();
    return Boolean(text) && !hasSensitiveContent(text) && !UNSAFE_INSTRUCTION_RE.test(text);
}

function isSafeLearningCall(call = {}) {
    const capabilities = resolveRegisteredToolCapabilities(call.tool_name || call.toolName || call.tool);
    const contract = normalizeToolContract({ name: call.tool_name || call.toolName || call.tool, idempotent: Boolean(call.idempotent) });
    return ['success', 'completed'].includes(String(call.status || ''))
        && Boolean(call.idempotent) && !contract.side_effect && Number(call.risk_level || 0) < 5
        && capabilities.length > 0 && capabilities.every(capability => SAFE_LEARNING_CAPABILITIES.has(capability));
}

function buildDeterministicCandidate(calls, run, requestedKind = '') {
    const successful = calls.filter(call => ['success', 'completed'].includes(String(call.status)));
    const eligible = successful.filter(isSafeLearningCall);
    const kind = requestedKind === 'workflow' ? 'workflow' : requestedKind === 'memory' ? 'memory' : eligible.length < 2 ? 'memory' : 'skill';
    const tools = [...new Set(eligible.map(call => call.tool_name))].slice(0, 8);
    const capabilities = [...new Set(tools.flatMap(tool => resolveRegisteredToolCapabilities(tool)))].slice(0, 20);
    const title = String(run.title || run.goal || '').trim().slice(0, 80) || `个人经验：${tools[0] || '任务整理'}`;
    const summary = `从一次成功执行路径提取：${tools.join(' → ') || '无可复用只读工具'}。`;
    const instructions = [
        '适用于：与来源任务同类、且输入条件完整的任务。',
        `推荐步骤：${tools.join(' → ')}`,
        '只在输入满足适用条件时使用；所有工具调用仍必须经过 Pivot 权限、预算、网络和审批策略。',
        '不要编造工具结果；遇到输入不完整或工具失败时说明限制并停止扩权尝试。'
    ].join('\n');
    return {
        kind,
        title,
        summary,
        confidence: eligible.length >= 2 ? 0.78 : 0.45,
        expectedBenefit: 'reliability',
        applicability: { taskTypes: [safeName(run.title || 'agent-task')], keywords: String(run.goal || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, ' ').split(/\s+/).filter(word => word.length > 1).slice(0, 12) },
        permissionDiff: { added: [], removed: [] },
        tools,
        capabilities,
        manifest: {
            schemaVersion: 1,
            id: `${safeName(title).slice(0, 52)}-${crypto.createHash('sha256').update(String(run.id)).digest('hex').slice(0, 8)}`,
            name: `${safeName(title).slice(0, 60)}-${crypto.createHash('sha256').update(String(run.id)).digest('hex').slice(0, 8)}`,
            version: '1.0.0',
            title,
            description: summary.slice(0, 400),
            tools,
            capabilities,
            inputs: {},
            outputs: {},
            tags: ['personal', 'learned', ...String(run.goal || '').split(/\s+/).filter(Boolean).slice(0, 5)]
        },
        instructions,
        workflow: kind === 'workflow' ? compileTraceToWorkflow(eligible, { title, filterExploration: true }) : null
    };
}

async function reflectCandidate(run, calls, requestedKind, user, modelCfg, corrections = []) {
    const fallback = buildDeterministicCandidate(calls, run, requestedKind);
    if (!modelCfg) return fallback;
    const evidence = calls.slice(0, 20).map(call => ({ tool: call.tool_name, status: call.status, idempotent: Boolean(call.idempotent), safeForLearning: isSafeLearningCall(call), risk: Number(call.risk_level || 0) }));
    const messages = [
        { role: 'system', content: '你是 Pivot 的后台学习复盘器。只输出 JSON，不调用工具，不输出敏感数据。只允许 kind=skill、workflow、memory；个人 Skill 只能使用下面列出的已成功、幂等、无副作用工具。' },
        { role: 'user', content: JSON.stringify({ goal: String(run.goal || '').slice(0, 1000), title: String(run.title || '').slice(0, 200), requestedKind, evidence, corrections: corrections.slice(0, 3).map(item => String(item).slice(0, 1000)), fallback: { title: fallback.title, tools: fallback.tools, capabilities: fallback.capabilities, instructions: fallback.instructions } }) }
    ];
    try {
        const output = await callModelText(modelCfg, messages, { user, maxTokens: 2200, responseFormat: { type: 'json_object' } });
        const parsed = parseJsonObject(output);
        if (!parsed || !['skill', 'workflow', 'memory'].includes(String(parsed.kind || ''))) return fallback;
        if (String(parsed.kind) === 'workflow' && requestedKind !== 'workflow') return fallback;
        const candidate = { ...fallback, ...parsed };
        if (['skill', 'workflow', 'memory'].includes(requestedKind)) candidate.kind = requestedKind;
        candidate.tools = fallback.tools;
        candidate.capabilities = fallback.capabilities;
        candidate.manifest = { ...fallback.manifest, title: String(candidate.title || fallback.title).slice(0, 80), description: String(candidate.summary || fallback.summary).slice(0, 400), tools: fallback.tools, capabilities: fallback.capabilities };
        candidate.instructions = String(candidate.instructions || fallback.instructions).slice(0, 12000);
        candidate.confidence = clamp(candidate.confidence || fallback.confidence);
        if (candidate.kind === 'workflow') candidate.workflow = fallback.workflow;
        return candidate;
    } catch (_) {
        return fallback;
    }
}

async function setJobResult(jobIdValue, fields = {}) {
    const row = await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [jobIdValue]);
    if (!row) return null;
    const now = getBeijingTimestamp();
    const status = JOB_STATUSES.includes(String(fields.status || '')) ? String(fields.status) : row.status;
    const summary = fields.resultSummary || parseJson(row.result_summary, {});
    const retryDelayMs = Math.min(15 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, Number(row.attempts || 1) - 1)));
    const nextRunAt = fields.nextRunAt === undefined
        ? (status === 'queued' ? getBeijingTimestamp(new Date(Date.now() + retryDelayMs)) : null)
        : fields.nextRunAt;
    await execute(`UPDATE agent_learning_jobs SET status = ?, result_summary = ?, error_code = ?, error_message = ?, proposal_id = ?, next_run_at = ?, locked_at = NULL, locked_by = '', completed_at = ?, updated_at = ? WHERE id = ?`, [status, JSON.stringify(summary), String(fields.errorCode || ''), String(fields.errorMessage || '').slice(0, 2000), fields.proposalId || row.proposal_id || null, nextRunAt, ['completed', 'failed', 'validation_failed'].includes(status) ? now : null, now, row.id]);
    const updated = serializeLearningJob(await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [row.id]));
    const notificationSettings = fields.notify === false ? { notifyLearning: false } : await getAgentLearningSettings(row.user_id).catch(() => ({ notifyLearning: true }));
    if (notificationSettings.notifyLearning && status === 'completed' && !summary?.skipped && summary?.kind) {
        try {
            const { createAgentInboxEvent } = require('./agent-inbox');
            const kind = summary?.kind === 'workflow' ? '工作流草稿' : summary?.kind === 'memory' ? '记忆' : '个人经验';
            await createAgentInboxEvent({ id: row.user_id, tenant_id: row.tenant_id }, {
                eventKey: `learning:${row.id}:${status}`,
                eventType: 'learning.completed',
                sourceRunId: row.source_run_id,
                sourceId: row.id,
                title: `已学习${kind}`,
                body: summary?.autoActivated ? '已验证并自动启用；下次相似任务会优先使用。' : summary?.proposalId ? '已生成待确认改进，可在“我的经验”中查看。' : '已安全沉淀为个人记忆。',
                risk: 'low',
                payload: { learningJobId: row.id, proposalId: fields.proposalId || row.proposal_id || null, kind: summary?.kind || '' }
            });
        } catch (_) {}
    }
    return updated;
}

async function processAgentLearningJob(row, options = {}) {
    const run = await queryOne('SELECT * FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [row.source_run_id, row.user_id]);
    if (!run) return setJobResult(row.id, { status: 'failed', errorCode: 'SOURCE_RUN_MISSING', errorMessage: '来源任务不存在。' });
    const calls = await listAgentToolCalls(run.id, { limit: 500 });
    if (calls.some(call => hasSensitiveContent(JSON.stringify({ input: call.input_payload || {}, error: call.error_message || '' })))) {
        return setJobResult(row.id, { status: 'completed', resultSummary: { skipped: true, reason: 'sensitive_trace' } });
    }
    const stored = parseJson(row.result_summary, {});
    const requestedKind = String(options.kind || stored.requestedKind || '').trim().toLowerCase();
    const user = await queryOne('SELECT id, username, nickname, unit, role FROM users WHERE id = ?', [row.user_id]) || { id: row.user_id };
    const modelCfg = await getRunnableModelForUserAsync(row.model_id || run.chosen_model_id || run.model_id, user).catch(() => null);
    const feedbackRows = await query(`SELECT correction, modified_answer FROM agent_feedback WHERE user_id = ? AND run_id = ? AND source = 'user' ORDER BY updated_at DESC LIMIT 3`, [row.user_id, run.id]);
    const corrections = feedbackRows.flatMap(item => [item.correction, item.modified_answer])
        .map(item => String(item || '').trim()).filter(item => item && !hasSensitiveContent(item));
    const candidate = await reflectCandidate(run, calls, requestedKind, user, modelCfg, corrections);
    if (hasSensitiveContent(`${candidate.title || ''}\n${candidate.summary || ''}`) || candidate.kind !== 'memory' && !isSafeLearningInstruction(candidate.instructions)) {
        return setJobResult(row.id, { status: 'completed', resultSummary: { skipped: true, reason: 'unsafe_instruction' } });
    }
    if (candidate.kind === 'memory') {
        const content = String(candidate.summary || '').trim();
        if (!content || content.length < 8) return setJobResult(row.id, { status: 'completed', resultSummary: { skipped: true, reason: 'memory_empty' } });
        const memory = await upsertMemory(row.user_id, { type: 'fact', category: 'fact', content: content.slice(0, 1000), salience: candidate.confidence, confidence: candidate.confidence, sourceRunId: run.id, sourceSessionId: run.session_id }, { user });
        return setJobResult(row.id, { status: 'completed', resultSummary: { kind: 'memory', memoryId: memory?.id || null, confidence: candidate.confidence } });
    }
    if (candidate.kind === 'workflow') {
        const { createAgentWorkflow } = require('./agent-workflows');
        const draft = candidate.workflow || compileTraceToWorkflow(calls, { title: candidate.title, filterExploration: true });
        if (!draft?.dagSpec?.nodes?.length) return setJobResult(row.id, { status: 'completed', resultSummary: { skipped: true, reason: 'workflow_no_nodes' } });
        const proposal = await createEvolutionProposal(user, { _internal: true, kind: 'workflow', title: candidate.title, description: candidate.summary, proposedChange: { dagSpec: draft.dagSpec, applicability: candidate.applicability, permissionDiff: candidate.permissionDiff }, sourceRunId: run.id, sourceType: 'learning', evidenceSummary: { sourceRunId: run.id, tools: calls.map(call => call.tool_name).slice(0, 20) }, scope: 'personal', activationMode: 'user_confirmed', confidence: candidate.confidence, status: 'waiting_user_review', reviewReason: '工作流默认只创建草稿，需用户确认发布。', idempotencyKey: `learning:${row.id}` });
        const workflowName = `学习草稿-${String(row.id).slice(-24)}`;
        let workflow = proposal.artifactId
            ? await require('./agent-workflows').getAgentWorkflowForUser(proposal.artifactId, user)
            : null;
        if (!workflow) workflow = await queryOne('SELECT w.id, v.version AS current_version, v.id AS version_id FROM agent_workflows w LEFT JOIN agent_workflow_versions v ON v.id = w.current_version_id WHERE w.user_id = ? AND w.name = ? AND w.deleted_at IS NULL ORDER BY w.id DESC LIMIT 1', [user.id, workflowName]);
        if (!workflow) workflow = await createAgentWorkflow(user, { name: workflowName, description: String(candidate.summary || '').slice(0, 400), dagSpec: draft.dagSpec, note: `由学习任务 ${row.id} 生成` });
        await updateEvolutionArtifact(proposal.id, user, { artifactType: 'workflow', artifactId: String(workflow.id), artifactVersionId: String(workflow.version_id || workflow.current_version || 1) });
        return setJobResult(row.id, { status: 'completed', proposalId: proposal.id, resultSummary: { kind: 'workflow', proposalId: proposal.id, workflowId: workflow.id, confidence: candidate.confidence } });
    }
    const settings = await getAgentLearningSettings(row.user_id);
    if (candidate.tools.length < 2 || candidate.permissionDiff?.added?.length) return setJobResult(row.id, { status: 'completed', resultSummary: { skipped: true, reason: 'insufficient_safe_steps', tools: candidate.tools } });
    const allowAutoActivate = settings.autoLearning && settings.autoActivate && candidate.confidence >= settings.minConfidence;
    const proposal = await createEvolutionProposal(user, { _internal: true, kind: 'skill', title: candidate.title, description: candidate.summary, proposedChange: { manifest: candidate.manifest, instructions: candidate.instructions, applicability: candidate.applicability, permissionDiff: { added: [], removed: [] } }, sourceRunId: run.id, sourceType: 'learning', evidenceSummary: { sourceRunId: run.id, tools: candidate.tools, successfulSteps: candidate.tools.length }, scope: 'personal', activationMode: allowAutoActivate ? 'auto' : 'user_confirmed', confidence: candidate.confidence, status: 'candidate_created', reviewReason: allowAutoActivate ? '' : '自动学习已关闭、置信度不足或需用户确认。', idempotencyKey: `learning:${row.id}` });
    await setJobResult(row.id, { status: 'candidate_created', proposalId: proposal.id, resultSummary: { kind: 'skill', proposalId: proposal.id, confidence: candidate.confidence, tools: candidate.tools } });
    const { createSkillVersion, validateSkillVersion, publishSkillVersion } = require('./agent-releases');
    let version = proposal.artifactVersionId
        ? await queryOne('SELECT * FROM agent_skill_versions WHERE id = ? AND created_by = ?', [proposal.artifactVersionId, user.id])
        : null;
    if (!version) version = await queryOne('SELECT * FROM agent_skill_versions WHERE created_by = ? AND source_run_id = ? AND owner_key = ? AND name = ? ORDER BY id DESC LIMIT 1', [user.id, run.id, `user:${user.id}`, candidate.manifest.name]);
    if (!version) version = await createSkillVersion(user, { manifest: candidate.manifest, instructions: candidate.instructions, sourceRunId: run.id, strictSpec: true });
    const validation = await validateSkillVersion(version.id, user, { strictSpec: true, requireSignature: false });
    await updateEvolutionArtifact(proposal.id, user, { artifactType: 'skill', artifactId: String(version.skill_id || version.id), artifactVersionId: String(version.id) });
    if (!validation?.passed) return setJobResult(row.id, { status: 'validation_failed', proposalId: proposal.id, errorCode: 'SKILL_VALIDATION_FAILED', errorMessage: validation?.manifest?.errors?.[0] || validation?.sandbox?.result?.stderr || 'Skill 验证未通过。', resultSummary: { kind: 'skill', proposalId: proposal.id, validation: validation?.passed === true } });
    if (allowAutoActivate) {
        let release = proposal.releaseId
            ? await queryOne("SELECT * FROM agent_skill_releases WHERE id = ? AND status = 'published'", [proposal.releaseId])
            : null;
        if (!release) release = await queryOne("SELECT * FROM agent_skill_releases WHERE skill_version_id = ? AND owner_key = ? AND rollout_scope = 'personal' AND status = 'published' ORDER BY published_at DESC, id DESC LIMIT 1", [version.id, `user:${user.id}`]);
        if (!release) release = await publishSkillVersion(version.id, user, { scope: 'personal', rolloutScope: 'personal', rolloutPercent: 100 });
        await updateEvolutionArtifact(proposal.id, user, { artifactType: 'skill', artifactId: String(version.skill_id || version.id), artifactVersionId: String(version.id), releaseId: String(release.id), status: 'personal_active', activationMode: 'auto' });
        return setJobResult(row.id, { status: 'completed', proposalId: proposal.id, resultSummary: { kind: 'skill', proposalId: proposal.id, releaseId: release.id, autoActivated: true, confidence: candidate.confidence } });
    }
    await updateEvolutionArtifact(proposal.id, user, { artifactType: 'skill', artifactId: String(version.skill_id || version.id), artifactVersionId: String(version.id), status: 'waiting_user_review', activationMode: 'user_confirmed' });
    return setJobResult(row.id, { status: 'completed', proposalId: proposal.id, resultSummary: { kind: 'skill', proposalId: proposal.id, validated: true, autoActivated: false, confidence: candidate.confidence } });
}

async function processAgentLearningJobs(options = {}) {
    const claimed = await claimAgentLearningJobs(options.limit || 2);
    const results = [];
    for (const row of claimed) {
        try { results.push(await processAgentLearningJob(row, options)); }
        catch (error) { results.push(await setJobResult(row.id, { status: Number(row.attempts || 0) >= Number(row.max_attempts || MAX_JOB_ATTEMPTS) ? 'failed' : 'queued', errorCode: error.code || 'LEARNING_FAILED', errorMessage: error.message || '学习任务失败。', resultSummary: parseJson(row.result_summary, {}) })); }
    }
    return results;
}

/** Archive unused personal Skill experience without deleting its immutable history. */
async function archiveStalePersonalExperiences(options = {}) {
    const days = Math.max(30, Math.min(Number.parseInt(options.days, 10) || ARCHIVE_AFTER_DAYS, 3650));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const rows = await query(`
            SELECT p.*, r.id AS skill_release_id, r.owner_key, r.name, r.tenant_id AS release_tenant_id,
               r.published_by, r.previous_release_id, r.status AS release_status
        FROM agent_evolution_proposals p
        JOIN agent_skill_releases r ON r.id::text = p.release_id
        WHERE p.scope = 'personal' AND p.kind = 'skill' AND p.status = 'personal_active'
          AND r.status = 'published' AND p.updated_at < ?
          AND NOT EXISTS (
              SELECT 1 FROM agent_runs ar
              WHERE ar.user_id = p.user_id AND ar.deleted_at IS NULL
                AND pivot_json_extract(ar.metadata::text, ARRAY['skillReleaseId']) = r.id::text
                AND ar.created_at >= ?
          )
        ORDER BY p.updated_at ASC LIMIT ?
    `, [cutoff, cutoff, Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200))]);
    const archived = [];
    const { pauseSkillReleaseBySystem } = require('./agent-releases');
    for (const row of rows) {
        const action = await pauseSkillReleaseBySystem({
            id: row.skill_release_id,
            owner_key: row.owner_key,
            name: row.name,
            tenant_id: row.release_tenant_id,
            published_by: row.published_by,
            previous_release_id: row.previous_release_id
        }, `连续 ${days} 天未被使用，已归档个人经验。`);
        if (action.action !== 'paused') continue;
        await execute("UPDATE agent_evolution_proposals SET status = 'archived', review_reason = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'personal_active'", [`连续 ${days} 天未使用，已归档；可随时恢复。`, getBeijingTimestamp(), row.id, row.user_id]);
        archived.push(row.id);
    }
    return { archived: archived.length, proposalIds: archived, days };
}

async function maybeArchiveStalePersonalExperiences() {
    if (Date.now() - lastArchiveSweepAt < 6 * 60 * 60 * 1000) return { skipped: true, reason: 'interval' };
    lastArchiveSweepAt = Date.now();
    try { return await archiveStalePersonalExperiences(); }
    catch (error) { lastArchiveSweepAt = 0; throw error; }
}

async function learnAgentRun(user, runId, options = {}) {
    const scheduled = await enqueueAgentLearningJob(user, runId, 'explicit', options);
    if (!scheduled.scheduled || scheduled.deduped || options.runNow === false) return scheduled;
    const queued = await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [scheduled.job.id]);
    if (queued) {
        const now = getBeijingTimestamp();
        const claimed = await execute("UPDATE agent_learning_jobs SET status = 'analyzing', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [now, `manual:${process.pid}`, now, queued.id]);
        if (Number(claimed || 0) > 0) await processAgentLearningJob(await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [queued.id]), { kind: options.kind });
    }
    const job = await queryOne('SELECT * FROM agent_learning_jobs WHERE id = ?', [scheduled.job.id]);
    return { scheduled: true, job: serializeLearningJob(job) };
}

async function listAgentLearningJobs(user, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const rows = await query('SELECT * FROM agent_learning_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [user.id, limit]);
    return rows.map(serializeLearningJob);
}

async function getAgentLearningOverview(user) {
    const [settings, jobs, proposals] = await Promise.all([
        getAgentLearningSettings(user.id),
        listAgentLearningJobs(user, { limit: 20 }),
        require('./agent-evolution').listEvolutionProposals(user, { limit: 100 })
    ]);
    const releases = await require('./agent-releases').listSkillReleasesForUser(user, { limit: 200 });
    const personalReleases = releases.filter(item => String(item.owner_key || '') === `user:${user.id}` && item.rollout_scope === 'personal');
    const releaseIds = personalReleases.map(item => String(item.id)).filter(Boolean);
    const metricsByRelease = {};
    if (releaseIds.length) {
        const rows = await query(`
            SELECT pivot_json_extract(r.metadata::text, ARRAY['skillReleaseId']) AS release_id,
                COUNT(*) AS uses,
                COALESCE(SUM(CASE WHEN f.outcome = 'success' THEN 1 ELSE 0 END), 0) AS successes,
                COALESCE(SUM(CASE WHEN f.outcome IN ('failure', 'partial') THEN 1 ELSE 0 END), 0) AS failures,
                MAX(r.created_at) AS last_used_at
            FROM agent_runs r
            LEFT JOIN agent_feedback f ON f.run_id = r.id AND f.user_id = r.user_id
            WHERE r.user_id = ? AND r.deleted_at IS NULL
              AND pivot_json_extract(r.metadata::text, ARRAY['skillReleaseId']) IN (${releaseIds.map(() => '?').join(',')})
            GROUP BY pivot_json_extract(r.metadata::text, ARRAY['skillReleaseId'])
        `, [user.id, ...releaseIds]);
        rows.forEach(item => {
            const uses = Number(item.uses || 0);
            metricsByRelease[String(item.release_id)] = { uses, successes: Number(item.successes || 0), failures: Number(item.failures || 0), successRate: uses ? Number(item.successes || 0) / uses : null, lastUsedAt: item.last_used_at || null };
        });
    }
    const experiences = personalReleases.map(item => ({ ...item, metrics: metricsByRelease[String(item.id)] || { uses: 0, successes: 0, failures: 0, successRate: null, lastUsedAt: null } }));
    return { settings, jobs, experiences, proposals, generatedAt: getBeijingTimestamp() };
}

function startAgentLearningRunner() {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try { await processAgentLearningJobs({ limit: 2 }); await maybeArchiveStalePersonalExperiences(); } catch (_) {} finally { running = false; }
    };
    const initial = setTimeout(() => { void tick(); }, 10000); initial.unref?.();
    const timer = setInterval(tick, 60000); timer.unref?.();
    return timer;
}

module.exports = {
    ARCHIVE_AFTER_DAYS,
    JOB_STATUSES,
    SETTINGS_KEY,
    TRIGGERS,
    enqueueAgentLearningJob,
    getAgentLearningOverview,
    getAgentLearningSettings,
    learnAgentRun,
    isSafeLearningInstruction,
    listAgentLearningJobs,
    normalizeSettings,
    archiveStalePersonalExperiences,
    maybeArchiveStalePersonalExperiences,
    processAgentLearningJobs,
    startAgentLearningRunner,
    updateAgentLearningSettings
};
