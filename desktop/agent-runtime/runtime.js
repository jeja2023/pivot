const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TaskBudget, normalizeTaskBudget } = require('../../server/services/agent-budget');
const { normalizeToolContract } = require('../../server/services/agent-contracts');
const { evaluateToolPolicy } = require('../../server/services/agent-policy');
const { buildToolExecutionPlan, summarizeToolExecutionPlan } = require('../../server/services/agent-tool-execution-plan');
const { createAgentStepContext } = require('../../server/services/agent-step-context');
const { buildRecoveryPlan, diagnoseError } = require('../../server/services/agent-diagnosis');
const { compileTraceToWorkflow } = require('../../server/services/agent-trace-compiler');
const { DesktopAgentStateStore } = require('./state-store');

class DesktopAgentRuntime extends EventEmitter {
    constructor(options = {}) {
        super();
        this.store = options.store || new DesktopAgentStateStore(options.dbPath);
        this.registry = options.registry || null;
        this.executor = options.executor || (async tool => {
            if (typeof tool.handler !== 'function') throw new Error(`桌面工具未提供执行器：${tool.name}`);
            return tool.handler(tool.input);
        });
        this.now = options.now || (() => Date.now());
        this.budgets = new Map();
    }

    createRun(options = {}) {
        const budgetConfig = normalizeTaskBudget(options.budgetConfig || options.budget_config || {});
        const run = this.store.createRun({ ...options, budgetConfig });
        this.budgets.set(run.id, new TaskBudget(budgetConfig, { startedAt: this.now() }));
        this.emit('run', { run, reason: 'created' });
        return run;
    }

    _budget(run) {
        if (!this.budgets.has(run.id)) this.budgets.set(run.id, new TaskBudget(run.budgetConfig || {}, { startedAt: this.now() }));
        return this.budgets.get(run.id);
    }

    _persistBudget(runId, budget) {
        const snapshot = budget?.snapshot?.(this.now());
        if (snapshot && typeof this.store.updateUsageStats === 'function') this.store.updateUsageStats(runId, snapshot);
        return snapshot;
    }

    async _executeWithWatchdog(tool, run, options = {}) {
        const contractTimeout = Number(tool.timeout?.max_seconds || tool.timeout?.default_seconds || 30) * 1000;
        const configuredTimeout = Number(options.timeoutMs) || contractTimeout;
        const runtimeLimit = Number(run.budgetConfig?.max_runtime_seconds || 0) * 1000;
        const timeoutMs = Math.max(100, Math.min(configuredTimeout, runtimeLimit > 0 ? runtimeLimit : configuredTimeout));
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(options.signal?.reason);
        if (options.signal) {
            if (options.signal.aborted) forwardAbort();
            else options.signal.addEventListener('abort', forwardAbort, { once: true });
        }
        let timer;
        let timedOut = false;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                const error = new Error(`桌面 Agent 工具超过 ${timeoutMs}ms 限时。`);
                error.code = 'AGENT_RUNTIME_TIMEOUT';
                error.category = 'timeout';
                controller.abort(error);
                reject(error);
            }, timeoutMs);
        });
        try {
            return await Promise.race([
                Promise.resolve().then(() => this.executor(tool, { run, signal: controller.signal })),
                timeout
            ]);
        } finally {
            clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener?.('abort', forwardAbort);
            if (timedOut) controller.abort();
        }
    }

    _tool(toolName, input) {
        const raw = typeof this.registry?.get === 'function' ? this.registry.get(toolName) : null;
        if (!raw) throw new Error(`桌面工具不可用：${toolName}`);
        const contract = normalizeToolContract(raw);
        return { ...contract, input };
    }

    async execute(runId, plans = [], options = {}) {
        let run = this.store.getRun(runId);
        if (!run) throw new Error(`桌面 Agent 任务不存在：${runId}`);
        if (run.status === 'queued') run = this.store.transitionRun(runId, 'planning');
        if (['waiting_approval', 'approval_required', 'awaiting_approval'].includes(run.status) && options.approvalGranted === true) {
            run = this.store.transitionRun(runId, 'resuming');
        }
        const budget = this._budget(run);
        const items = typeof plans === 'function' ? await plans({ run, budget, runtime: this }) : plans;
        if (!Array.isArray(items)) throw new Error('桌面 Agent 执行计划必须是数组。');
        if (['waiting_approval', 'approval_required', 'awaiting_approval'].includes(run.status)
            && options.approvalGranted !== true) {
            return { status: 'waiting_approval', run };
        }
        for (let index = 0; index < items.length; index += 1) {
            const plan = items[index] || {};
            const tool = this._tool(plan.tool || plan.name, plan.input || {});
            const executionPlan = await buildToolExecutionPlan({
                run,
                tool,
                input: tool.input,
                user: options.user || null,
                context: {
                    autonomous: true,
                    allowApproval: options.approvalGranted === true,
                    sandboxMode: options.sandboxMode || run.metadata?.sandboxMode,
                    sandboxAvailable: options.sandboxAvailable !== false
                }
            });
            tool.input = executionPlan.input;
            const stepContext = createAgentStepContext({
                run: {
                    ...run,
                    run_mode: run.run_mode || 'desktop',
                    metadata: { ...(run.metadata || {}), entrypoint: 'desktop' }
                },
                turnId: `${runId}:turn:${index + 1}`,
                stepIndex: index + 1,
                modelCfg: options.modelCfg || null,
                toolList: this.registry?.list?.() || [tool],
                contextConfig: {
                    entrypoint: 'desktop',
                    sandboxMode: options.sandboxMode || run.metadata?.sandboxMode || '',
                    budget: run.budgetConfig || {}
                },
                environment: {
                    entrypoint: 'desktop',
                    platform: process.platform,
                    arch: process.arch
                },
                forceWorldStateFull: true
            });
            const stepId = `${runId}:step:${index + 1}`;
            const operationKey = String(plan.operationKey || `${runId}:${index + 1}:${tool.name}:${crypto.createHash('sha256').update(JSON.stringify(tool.input)).digest('hex')}`);
            budget.consumeStep();
            this._persistBudget(runId, budget);
            if (this.store.getRun(runId)?.status === 'observing') this.store.transitionRun(runId, 'planning');
            run = this.store.transitionRun(runId, 'executing');
            const policy = evaluateToolPolicy({
                run: { ...run, ...(options.policy || {}) },
                tool,
                input: tool.input,
                user: options.user || null,
                budget,
                allowApproval: options.approvalGranted === true
            });
            this.store.appendStep(runId, {
                stepIndex: index + 1,
                phase: 'plan',
                toolName: tool.name,
                input: tool.input,
                output: {
                    ...policy,
                    executionPlan: summarizeToolExecutionPlan(executionPlan),
                    contextHash: stepContext.contextHash,
                    worldStateHash: stepContext.worldStateHash
                },
                status: policy.decision === 'denied' ? 'error' : 'success'
            });
            if (executionPlan.network.preflight === 'denied' || executionPlan.sandbox.preflight === 'denied') {
                const error = new Error(executionPlan.network.error?.message || executionPlan.sandbox.error?.message || '桌面工具执行前置策略检查失败。');
                error.code = executionPlan.network.error?.code || executionPlan.sandbox.error?.code || 'AGENT_EXECUTION_PREFLIGHT_DENIED';
                error.category = 'policy';
                throw error;
            }
            if (policy.decision === 'denied') {
                run = this.store.transitionRun(runId, 'diagnosing');
                const error = new Error(policy.reasons.join('；'));
                error.code = 'AGENT_POLICY_DENIED';
                const diagnosis = diagnoseError(error, { tool: tool.name, step: index + 1 });
                this.store.appendStep(runId, { stepIndex: index + 1, phase: 'diagnose', toolName: tool.name, input: tool.input, output: diagnosis, status: 'error', errorCategory: diagnosis.category, errorMessage: error.message });
                throw error;
            }
            if (policy.decision === 'require_approval' && options.approvalGranted !== true) {
                run = this.store.transitionRun(runId, 'waiting_approval', { metadata: { pendingTool: tool.name, operationKey } });
                this.emit('approval', { run, tool: tool.name, operationKey });
                return { status: 'waiting_approval', run, operationKey };
            }
            const checkpoint = this.store.beginTool({ runId, stepId, operationKey, toolName: tool.name, input: tool.input, inputHash: crypto.createHash('sha256').update(JSON.stringify(tool.input)).digest('hex'), idempotent: tool.idempotent, policyDecision: policy.decision });
            if (checkpoint.replay) continue;
            const started = this.now();
            try {
                const output = await this._executeWithWatchdog(tool, run, options);
                this.store.completeTool(operationKey, output);
                this.store.writeCheckpoint(runId, index + 1, {
                    tool: tool.name,
                    input: tool.input,
                    output,
                    contextHash: stepContext.contextHash,
                    worldStateHash: stepContext.worldStateHash
                }, 'completed');
                this.store.appendStep(runId, { stepIndex: index + 1, phase: 'execute', toolName: tool.name, input: tool.input, output, status: 'success', durationMs: this.now() - started });
                budget.recordSuccess();
                this._persistBudget(runId, budget);
                this.emit('step', { runId, tool: tool.name, output });
            } catch (error) {
                this.store.completeTool(operationKey, null, error);
                const diagnosis = diagnoseError(error, { tool: tool.name, step: index + 1 });
                const recoveryPlan = buildRecoveryPlan(diagnosis, 0);
                budget.recordError();
                this._persistBudget(runId, budget);
                this.store.writeCheckpoint(runId, index + 1, {
                    tool: tool.name,
                    input: tool.input,
                    error: error.message,
                    diagnosis,
                    recoveryPlan,
                    contextHash: stepContext.contextHash,
                    worldStateHash: stepContext.worldStateHash
                }, 'error');
                this.store.appendStep(runId, { stepIndex: index + 1, phase: 'diagnose', toolName: tool.name, input: tool.input, output: { diagnosis, recoveryPlan }, status: 'error', errorCategory: diagnosis.category, errorMessage: error.message, durationMs: this.now() - started });
                run = this.store.transitionRun(runId, 'diagnosing');
                throw error;
            }
            run = this.store.getRun(runId);
            if (index < items.length - 1) run = this.store.transitionRun(runId, 'observing');
        }
        run = this.store.transitionRun(runId, 'completed');
        this.emit('run', { run, reason: 'completed' });
        return { status: 'completed', run, steps: this.store.listSteps(runId) };
    }

    recover(runId) {
        const context = this.store.recoverRun(runId);
        if (!context) return null;
        if (context.pendingTool && !context.pendingTool.idempotent) {
            const run = this.store.transitionRun(runId, 'waiting_approval', { metadata: { pendingTool: context.pendingTool.tool_name, recovery: true } });
            return { ...context, run, requiresApproval: true };
        }
        return { ...context, requiresApproval: false };
    }

    compileWorkflowDraft(runId, options = {}) {
        const run = this.store.getRun(runId);
        if (!run) return null;
        return compileTraceToWorkflow(this.store.listToolCalls(runId), options);
    }

    close() { this.store.close(); }
}

module.exports = { DesktopAgentRuntime };
