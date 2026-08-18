const crypto = require('crypto');
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const {
    normalizeJsonSchema,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');

const TERMINAL_RUN_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'cancelled']);
const MAX_CASES_PER_SUITE = 50;

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (e) { return fallback; }
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function normalizeStringList(value, limit = 20) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，]/);
    return Array.from(new Set(source.map(item => String(item || '').trim()).filter(Boolean))).slice(0, limit);
}

function normalizeAssertions(value = {}) {
    const source = parseJson(value, {}) || {};
    const outputSchema = normalizeJsonSchema(source.outputSchema || source.output_schema || {});
    const schemaErrors = [];
    validateJsonSchemaDefinition(outputSchema, '输出结构', schemaErrors);
    if (schemaErrors.length) {
        const error = new Error(schemaErrors[0]);
        error.status = 400;
        throw error;
    }
    return {
        requiredPhrases: normalizeStringList(source.requiredPhrases || source.required_phrases),
        forbiddenPhrases: normalizeStringList(source.forbiddenPhrases || source.forbidden_phrases),
        minLength: clampInt(source.minLength || source.min_length, 0, 0, 100000),
        maxDurationMs: clampInt(source.maxDurationMs || source.max_duration_ms, 0, 0, 24 * 60 * 60 * 1000),
        maxTokens: clampInt(source.maxTokens || source.max_tokens, 0, 0, 10000000),
        requireJson: source.requireJson === true || source.require_json === true,
        outputSchema: schemaHasRules(outputSchema) ? outputSchema : {}
    };
}

function normalizeRunConfig(value = {}) {
    const source = parseJson(value, {}) || {};
    return {
        passThreshold: clampInt(source.passThreshold || source.pass_threshold, 80, 1, 100),
        maxSteps: clampInt(source.maxSteps || source.max_steps, 10, 1, 60),
        runMode: String(source.runMode || source.run_mode || 'standard').trim().slice(0, 30),
        toolPolicy: String(source.toolPolicy || source.tool_policy || 'all').trim().slice(0, 30),
        approvalPolicy: String(source.approvalPolicy || source.approval_policy || 'safe_mcp_auto').trim().slice(0, 40),
        maxTokenBudget: clampInt(source.maxTokenBudget || source.max_token_budget, 0, 0, 10000000),
        modelRouter: String(source.modelRouter || source.model_router || 'fixed').trim().slice(0, 30)
    };
}

function normalizeCasePayload(value = {}, index = 0) {
    const name = String(value.name || `用例 ${index + 1}`).trim().slice(0, 100);
    const input = String(value.input || value.goal || '').trim().slice(0, 12000);
    if (!name || !input) {
        const error = new Error(`第 ${index + 1} 个评测用例缺少名称或任务输入。`);
        error.status = 400;
        throw error;
    }
    const variables = parseJson(value.inputVariables || value.input_variables || {}, null);
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
        const error = new Error(`评测用例“${name}”的工作流变量必须是 JSON 对象。`);
        error.status = 400;
        throw error;
    }
    return {
        id: Number.parseInt(value.id, 10) || null,
        name,
        input,
        inputVariables: variables,
        expectedOutput: String(value.expectedOutput || value.expected_output || '').trim().slice(0, 20000),
        assertions: normalizeAssertions(value.assertions || value),
        sortOrder: index
    };
}

function normalizeSuitePayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 100);
    if (!name) {
        const error = new Error('请填写评测集名称。');
        error.status = 400;
        throw error;
    }
    const targetType = body.targetType === 'workflow' || body.target_type === 'workflow' ? 'workflow' : 'free';
    const cases = Array.isArray(body.cases) ? body.cases.slice(0, MAX_CASES_PER_SUITE).map(normalizeCasePayload) : [];
    return {
        name,
        description: String(body.description || '').trim().slice(0, 500),
        targetType,
        workflowId: targetType === 'workflow' ? Number.parseInt(body.workflowId || body.workflow_id, 10) || null : null,
        workflowVersion: targetType === 'workflow' ? String(body.workflowVersion || body.workflow_version || 'published').trim().slice(0, 40) : '',
        modelId: Number.parseInt(body.modelId || body.model_id, 10) || null,
        runConfig: normalizeRunConfig(body.runConfig || body.run_config),
        cases
    };
}

function parseCaseRow(row) {
    if (!row) return row;
    return {
        ...row,
        input_variables: parseJson(row.input_variables, {}),
        assertions: normalizeAssertions(row.assertions)
    };
}

function parseSuiteRow(row) {
    if (!row) return row;
    return { ...row, run_config: normalizeRunConfig(row.run_config) };
}

async function getSuiteRow(suiteId, user) {
    return await queryOne(`
        SELECT s.*, w.name AS workflow_name, m.name AS model_name
        FROM agent_eval_suites s
        LEFT JOIN agent_workflows w ON w.id = s.workflow_id
        LEFT JOIN models m ON m.id = s.model_id
        WHERE s.id = ? AND s.user_id = ? AND s.deleted_at IS NULL
    `, [suiteId, user.id]);
}

async function assertEvaluationTarget(user, data) {
    if (data.modelId) {
        const model = await queryOne(`
            SELECT id FROM models
            WHERE id = ? AND status = 'active' AND (user_id IS NULL OR user_id = ?)
        `, [data.modelId, user.id]);
        if (!model) {
            const error = new Error('评测模型不存在、已停用或无权访问。');
            error.status = 400;
            throw error;
        }
    }
    if (data.targetType === 'workflow') {
        const workflow = await queryOne(`
            SELECT id, published_version_id FROM agent_workflows
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [data.workflowId, user.id]);
        if (!workflow || !workflow.published_version_id) {
            const error = new Error('请选择当前用户已发布的工作流进行评测。');
            error.status = 400;
            throw error;
        }
    }
}

async function listAgentEvalSuites(user) {
    const runningBatches = await query("SELECT id FROM agent_eval_runs WHERE user_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 20", [user.id]);
    for (const row of runningBatches) {
        await reconcileAgentEvalRun(row.id, user);
    }
    const rows = await query(`
        SELECT s.*, w.name AS workflow_name, m.name AS model_name,
               (SELECT COUNT(*) FROM agent_eval_cases c WHERE c.suite_id = s.id AND c.deleted_at IS NULL) AS case_count,
               (SELECT er.status FROM agent_eval_runs er WHERE er.suite_id = s.id ORDER BY er.created_at DESC LIMIT 1) AS latest_status,
               (SELECT er.summary FROM agent_eval_runs er WHERE er.suite_id = s.id ORDER BY er.created_at DESC LIMIT 1) AS latest_summary,
               (SELECT er.created_at FROM agent_eval_runs er WHERE er.suite_id = s.id ORDER BY er.created_at DESC LIMIT 1) AS latest_run_at
        FROM agent_eval_suites s
        LEFT JOIN agent_workflows w ON w.id = s.workflow_id
        LEFT JOIN models m ON m.id = s.model_id
        WHERE s.user_id = ? AND s.deleted_at IS NULL
        ORDER BY s.updated_at DESC, s.id DESC
        LIMIT 100
    `, [user.id]);
    return rows.map(row => ({
        ...parseSuiteRow(row),
        latest_summary: parseJson(row.latest_summary, null)
    }));
}

async function saveCases(trx, suiteId, cases, now) {
    const existing = await trx.query('SELECT id FROM agent_eval_cases WHERE suite_id = ? AND deleted_at IS NULL', [suiteId]);
    const retained = new Set();
    for (const item of cases) {
        const owned = item.id && existing.some(row => Number(row.id) === Number(item.id));
        if (owned) {
            await trx.execute(`
                UPDATE agent_eval_cases
                SET name = ?, input = ?, input_variables = ?, expected_output = ?, assertions = ?, sort_order = ?, updated_at = ?, deleted_at = NULL
                WHERE id = ? AND suite_id = ?
            `, [
                item.name, item.input, JSON.stringify(item.inputVariables), item.expectedOutput,
                JSON.stringify(item.assertions), item.sortOrder, now, item.id, suiteId
            ]);
            retained.add(Number(item.id));
            continue;
        }
        const row = await trx.queryOne(`
            INSERT INTO agent_eval_cases (
                suite_id, name, input, input_variables, expected_output, assertions, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [
            suiteId, item.name, item.input, JSON.stringify(item.inputVariables), item.expectedOutput,
            JSON.stringify(item.assertions), item.sortOrder, now, now
        ]);
        retained.add(Number(row?.id));
    }
    for (const row of existing) {
        if (!retained.has(Number(row.id))) {
            await trx.execute('UPDATE agent_eval_cases SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, row.id]);
        }
    }
}

async function createAgentEvalSuite(user, body = {}) {
    const data = normalizeSuitePayload(body);
    await assertEvaluationTarget(user, data);
    const now = getBeijingTimestamp();
    let suiteId = 0;
    await transaction(async trx => {
        const result = await trx.queryOne(`
            INSERT INTO agent_eval_suites (
                user_id, name, description, target_type, workflow_id, workflow_version, model_id,
                run_config, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            RETURNING id
        `, [
            user.id, data.name, data.description, data.targetType, data.workflowId, data.workflowVersion,
            data.modelId, JSON.stringify(data.runConfig), now, now
        ]);
        suiteId = Number(result?.id);
        await saveCases(trx, suiteId, data.cases, now);
    });
    return await getAgentEvalSuite(suiteId, user);
}

async function updateAgentEvalSuite(suiteId, user, body = {}) {
    const existing = await getSuiteRow(suiteId, user);
    if (!existing) return null;
    const data = normalizeSuitePayload(body);
    await assertEvaluationTarget(user, data);
    const now = getBeijingTimestamp();
    await transaction(async trx => {
        await trx.execute(`
            UPDATE agent_eval_suites
            SET name = ?, description = ?, target_type = ?, workflow_id = ?, workflow_version = ?,
                model_id = ?, run_config = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [
            data.name, data.description, data.targetType, data.workflowId, data.workflowVersion,
            data.modelId, JSON.stringify(data.runConfig), now, suiteId, user.id
        ]);
        await saveCases(trx, Number(suiteId), data.cases, now);
    });
    return await getAgentEvalSuite(suiteId, user);
}

async function deleteAgentEvalSuite(suiteId, user) {
    const suite = await getSuiteRow(suiteId, user);
    if (!suite) return null;
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_eval_suites SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
        now, 'archived', now, suiteId, user.id
    ]);
    return parseSuiteRow({ ...suite, deleted_at: now, status: 'archived' });
}

function parseOutputForSchema(output) {
    if (typeof output !== 'string') return output;
    const trimmed = output.trim();
    if (!trimmed) return output;
    try { return JSON.parse(trimmed); } catch (e) {
        const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (!fenced) return output;
        try { return JSON.parse(fenced[1]); } catch (inner) { return output; }
    }
}

function addRule(rules, key, label, passed, actual = '') {
    rules.push({ key, label, passed: Boolean(passed), actual: String(actual || '').slice(0, 500) });
}

function gradeAgentOutput({ run = {}, evalCase = {}, passThreshold = 80 } = {}) {
    const assertions = normalizeAssertions(evalCase.assertions || {});
    const output = String(run.final_answer || '');
    const rules = [];
    const completed = run.status === 'completed';
    addRule(rules, 'execution', '任务成功完成', completed, run.status || 'unknown');
    assertions.requiredPhrases.forEach(phrase => {
        addRule(rules, 'required_phrase', `包含“${phrase}”`, output.includes(phrase), phrase);
    });
    assertions.forbiddenPhrases.forEach(phrase => {
        addRule(rules, 'forbidden_phrase', `不包含“${phrase}”`, !output.includes(phrase), phrase);
    });
    if (evalCase.expected_output) {
        addRule(rules, 'expected_output', '包含参考答案要点', output.includes(String(evalCase.expected_output).trim()), evalCase.expected_output);
    }
    if (assertions.minLength > 0) {
        addRule(rules, 'min_length', `结果不少于 ${assertions.minLength} 字`, output.length >= assertions.minLength, output.length);
    }
    const durationMs = Number(run.duration_ms || 0);
    if (assertions.maxDurationMs > 0) {
        addRule(rules, 'max_duration', `耗时不超过 ${assertions.maxDurationMs} 毫秒`, durationMs <= assertions.maxDurationMs, durationMs);
    }
    const totalTokens = Number(run.total_tokens || 0);
    if (assertions.maxTokens > 0) {
        addRule(rules, 'max_tokens', `模型用量不超过 ${assertions.maxTokens}`, totalTokens <= assertions.maxTokens, totalTokens);
    }
    const parsedOutput = parseOutputForSchema(output);
    if (assertions.requireJson) {
        addRule(rules, 'valid_json', '结果是有效结构化数据', typeof parsedOutput !== 'string', typeof parsedOutput);
    }
    if (schemaHasRules(assertions.outputSchema)) {
        const schemaErrors = [];
        validateValueAgainstSchema(parsedOutput, assertions.outputSchema, { allowTemplates: false }, '结果', schemaErrors);
        addRule(rules, 'output_schema', '结果符合输出结构', schemaErrors.length === 0, schemaErrors[0] || '符合');
    }
    if (rules.length === 1 && completed) addRule(rules, 'non_empty', '生成了非空结果', Boolean(output.trim()), output.length);
    const passedCount = rules.filter(rule => rule.passed).length;
    const score = completed ? Math.round((passedCount / Math.max(rules.length, 1)) * 100) : 0;
    return {
        score,
        passed: completed && score >= clampInt(passThreshold, 80, 1, 100),
        rules,
        passedCount,
        ruleCount: rules.length
    };
}

async function evaluationRunSummary(evalRunId) {
    const rows = await query(`
        SELECT status, score, passed, duration_ms, total_tokens
        FROM agent_eval_results
        WHERE eval_run_id = ?
    `, [evalRunId]);
    const completed = rows.filter(row => ['passed', 'failed', 'error'].includes(row.status));
    const passed = rows.filter(row => row.passed).length;
    return {
        total: rows.length,
        completed: completed.length,
        pending: rows.length - completed.length,
        passed,
        failed: completed.length - passed,
        averageScore: completed.length ? Math.round(completed.reduce((sum, row) => sum + Number(row.score || 0), 0) / completed.length) : 0,
        passRate: completed.length ? Math.round((passed / completed.length) * 100) : 0,
        durationMs: rows.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0),
        totalTokens: rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0)
    };
}

async function reconcileAgentEvalRun(evalRunId, user) {
    const batch = await queryOne('SELECT * FROM agent_eval_runs WHERE id = ? AND user_id = ?', [evalRunId, user.id]);
    if (!batch) return null;
    const pending = await query(`
        SELECT er.*, c.expected_output, c.assertions
        FROM agent_eval_results er
        JOIN agent_eval_cases c ON c.id = er.case_id
        WHERE er.eval_run_id = ? AND er.status IN ('queued', 'running')
    `, [evalRunId]);
    const config = normalizeRunConfig(parseJson(batch.target_snapshot, {})?.runConfig || {});
    const now = getBeijingTimestamp();
    for (const result of pending) {
        const run = result.agent_run_id ? await queryOne(`
            SELECT r.*, COALESCE(t.duration_ms, 0) AS trace_duration_ms
            FROM agent_runs r
            LEFT JOIN agent_traces t ON t.run_id = r.id
            WHERE r.id = ? AND r.user_id = ?
        `, [result.agent_run_id, user.id]) : null;
        if (!run) continue;
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
            if (result.status !== 'running') await execute("UPDATE agent_eval_results SET status = 'running' WHERE id = ?", [result.id]);
            continue;
        }
        run.duration_ms = Number(run.trace_duration_ms || 0);
        const graded = gradeAgentOutput({ run, evalCase: result, passThreshold: config.passThreshold });
        await execute(`
            UPDATE agent_eval_results
            SET status = ?, score = ?, passed = ?, grader_results = ?, actual_output = ?, error_message = ?,
                duration_ms = ?, total_tokens = ?, completed_at = ?
            WHERE id = ?
        `, [
            graded.passed ? 'passed' : (run.status === 'completed' ? 'failed' : 'error'), graded.score,
            graded.passed ? 1 : 0, JSON.stringify(graded), String(run.final_answer || '').slice(0, 120000),
            String(run.error_message || '').slice(0, 4000), run.duration_ms, Number(run.total_tokens || 0), now, result.id
        ]);
    }
    const summary = await evaluationRunSummary(evalRunId);
    const status = summary.pending > 0 ? 'running' : 'completed';
    await execute(`
        UPDATE agent_eval_runs SET status = ?, summary = ?, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE id = ? AND user_id = ?
    `, [status, JSON.stringify(summary), status, now, evalRunId, user.id]);
    return { ...batch, status, summary, completed_at: status === 'completed' ? (batch.completed_at || now) : null };
}

function parseEvalResult(row) {
    return { ...row, passed: Boolean(row.passed), grader_results: parseJson(row.grader_results, null) };
}

async function getAgentEvalRun(evalRunId, user) {
    const batch = await reconcileAgentEvalRun(evalRunId, user);
    if (!batch) return null;
    const results = (await query(`
        SELECT er.*, c.name AS case_name, c.input AS case_input, r.title AS agent_run_title, r.status AS agent_run_status
        FROM agent_eval_results er
        JOIN agent_eval_cases c ON c.id = er.case_id
        LEFT JOIN agent_runs r ON r.id = er.agent_run_id
        WHERE er.eval_run_id = ?
        ORDER BY c.sort_order ASC, c.id ASC
    `, [evalRunId])).map(parseEvalResult);
    const previous = await queryOne(`
        SELECT summary FROM agent_eval_runs
        WHERE suite_id = ? AND user_id = ? AND status = 'completed' AND id != ? AND created_at < ?
        ORDER BY created_at DESC LIMIT 1
    `, [batch.suite_id, user.id, evalRunId, batch.created_at]);
    const baseline = parseJson(previous?.summary, null);
    return {
        run: { ...batch, target_snapshot: parseJson(batch.target_snapshot, {}), summary: batch.summary },
        results,
        baseline,
        delta: baseline ? {
            score: Number(batch.summary.averageScore || 0) - Number(baseline.averageScore || 0),
            passRate: Number(batch.summary.passRate || 0) - Number(baseline.passRate || 0)
        } : null
    };
}

async function listAgentEvalRuns(suiteId, user, limit = 10) {
    if (!(await getSuiteRow(suiteId, user))) return null;
    const rows = await query(`
        SELECT * FROM agent_eval_runs WHERE suite_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?
    `, [suiteId, user.id, clampInt(limit, 10, 1, 50)]);
    const list = [];
    for (const row of rows) {
        const current = (await reconcileAgentEvalRun(row.id, user)) || row;
        list.push({ ...current, target_snapshot: parseJson(current.target_snapshot, {}), summary: parseJson(current.summary, current.summary || null) });
    }
    return list;
}

async function getAgentEvalSuite(suiteId, user) {
    const suite = await getSuiteRow(suiteId, user);
    if (!suite) return null;
    const cases = (await query(`
        SELECT * FROM agent_eval_cases WHERE suite_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC
    `, [suiteId])).map(parseCaseRow);
    const runs = (await listAgentEvalRuns(suiteId, user, 10)) || [];
    return { suite: parseSuiteRow(suite), cases, runs };
}

async function startAgentEvaluation(suiteId, user, body = {}, createAgentRun) {
    const runningBatches = await query("SELECT id FROM agent_eval_runs WHERE user_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 20", [user.id]);
    for (const row of runningBatches) {
        await reconcileAgentEvalRun(row.id, user);
    }
    const detail = await getAgentEvalSuite(suiteId, user);
    if (!detail) return null;
    if (typeof createAgentRun !== 'function') throw new Error('智能体评测运行时尚未配置。');
    if (!detail.cases.length) {
        const error = new Error('评测集至少需要一个用例。');
        error.status = 400;
        throw error;
    }
    const activeBatches = await query("SELECT id, suite_id FROM agent_eval_runs WHERE user_id = ? AND status = 'running'", [user.id]);
    if (activeBatches.some(row => String(row.suite_id) === String(suiteId))) {
        const error = new Error('该评测集已有运行中的批次，请等待完成后再运行。');
        error.status = 409;
        throw error;
    }
    if (activeBatches.length >= 3) {
        const error = new Error('最多同时运行 3 个评测批次，请稍后再试。');
        error.status = 429;
        throw error;
    }
    const suite = detail.suite;
    const config = normalizeRunConfig(suite.run_config);
    const modelId = Number.parseInt(body.modelId || body.model_id || suite.model_id, 10) || null;
    if (suite.target_type === 'free' && !modelId) {
        const error = new Error('自由任务评测必须选择模型。');
        error.status = 400;
        throw error;
    }
    if (suite.target_type === 'workflow' && !suite.workflow_id) {
        const error = new Error('工作流评测必须选择目标工作流。');
        error.status = 400;
        throw error;
    }
    const evalRunId = `eval-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = getBeijingTimestamp();
    const snapshot = {
        suiteId: suite.id,
        suiteName: suite.name,
        targetType: suite.target_type,
        workflowId: suite.workflow_id || null,
        workflowVersion: suite.workflow_version || '',
        modelId,
        runConfig: config
    };
    await execute(`
        INSERT INTO agent_eval_runs (id, suite_id, user_id, status, target_snapshot, summary, started_at, created_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `, [evalRunId, suite.id, user.id, JSON.stringify(snapshot), JSON.stringify({ total: detail.cases.length, completed: 0, pending: detail.cases.length }), now, now]);

    for (const evalCase of detail.cases) {
        try {
            const run = await createAgentRun({
                user,
                goal: evalCase.input,
                modelId,
                title: `[评测] ${evalCase.name}`,
                maxSteps: config.maxSteps,
                runMode: suite.target_type === 'workflow' ? 'dag' : config.runMode,
                toolPolicy: config.toolPolicy,
                approvalPolicy: config.approvalPolicy,
                maxTokenBudget: config.maxTokenBudget,
                modelRouter: config.modelRouter,
                dagInputs: evalCase.input_variables,
                workflowId: suite.target_type === 'workflow' ? suite.workflow_id : null,
                workflowVersion: suite.target_type === 'workflow' ? (suite.workflow_version || 'published') : null,
                metadata: { evaluation: { evalRunId, suiteId: suite.id, caseId: evalCase.id } }
            });
            await execute(`
                INSERT INTO agent_eval_results (eval_run_id, case_id, agent_run_id, status, created_at)
                VALUES (?, ?, ?, 'queued', ?)
            `, [evalRunId, evalCase.id, run.id, now]);
        } catch (error) {
            const graded = gradeAgentOutput({ run: { status: 'error' }, evalCase, passThreshold: config.passThreshold });
            await execute(`
                INSERT INTO agent_eval_results (
                    eval_run_id, case_id, status, score, passed, grader_results, error_message, created_at, completed_at
                ) VALUES (?, ?, 'error', 0, 0, ?, ?, ?, ?)
            `, [evalRunId, evalCase.id, JSON.stringify(graded), String(error.message || error).slice(0, 4000), now, now]);
        }
    }
    return await getAgentEvalRun(evalRunId, user);
}

module.exports = {
    createAgentEvalSuite,
    deleteAgentEvalSuite,
    getAgentEvalRun,
    getAgentEvalSuite,
    gradeAgentOutput,
    listAgentEvalRuns,
    listAgentEvalSuites,
    normalizeAssertions,
    reconcileAgentEvalRun,
    startAgentEvaluation,
    updateAgentEvalSuite
};
