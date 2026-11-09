/**
 * Agent task budget and circuit breaker.
 *
 * The budget is deliberately independent from persistence and tool execution so
 * both the server runtime and the desktop execution plane can share the same
 * deterministic guard.
 */

const DEFAULT_RUNTIME_SECONDS = Math.max(
    60,
    Math.floor((Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '600000', 10) || 600000) / 1000)
);

const DEFAULT_BUDGET = Object.freeze({
    // Matches the highest deep/audit run-mode limit.
    max_steps: 60,
    max_tool_calls: 80,
    max_consecutive_errors: 3,
    // Keep the budget deadline aligned with the runtime deadline. A caller can
    // still opt into a shorter per-run budget through budget_config.
    max_runtime_seconds: DEFAULT_RUNTIME_SECONDS,
    max_python_timeout_seconds: 30,
    max_tokens_total: Math.max(128000, Number.parseInt(process.env.AGENT_TASK_MAX_TOKENS_TOTAL || '500000', 10) || 500000),
    // 默认容量覆盖多步发现、读取和交付；显式预算及旧运行持久化限额仍原样生效。
    risk_budget: 80,
    // Approval remains the gate for risky calls; this bounded default prevents
    // every ordinary MCP read/write from being rejected before approval.
    max_external_side_effects: 10,
    max_file_writes: 100,
    max_network_requests: 50
});

const LIMIT_KEYS = Object.keys(DEFAULT_BUDGET);

function toLimit(value, fallback) {
    if (value === Infinity) return Infinity;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeTaskBudget(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const output = {};
    LIMIT_KEYS.forEach(key => {
        const camel = key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
        output[key] = toLimit(source[key] ?? source[camel], DEFAULT_BUDGET[key]);
    });
    return output;
}

class BudgetExceededError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'BudgetExceededError';
        this.code = 'AGENT_BUDGET_EXCEEDED';
        this.category = 'resource';
        this.details = details;
    }
}

class TaskBudget {
    constructor(config = {}, options = {}) {
        this.limits = normalizeTaskBudget(config);
        this.enabled = options.enabled !== false;
        this.startedAt = Number(options.startedAt) || Date.now();
        this.counts = {
            steps: 0,
            tool_calls: 0,
            consecutive_errors: 0,
            tokens_total: 0,
            risk: 0,
            external_side_effects: 0,
            file_writes: 0,
            network_requests: 0
        };
        this.lastTool = '';
        this.tripped = null;
        this.phase = 'execution';
        this.policy = options.policy || null;
        this.priorElapsedSeconds = Math.max(0, Number(options.priorElapsedSeconds) || 0);
        for (const key of Object.keys(this.counts)) this.counts[key] = Math.max(0, Number(options.counts?.[key]) || 0);
        this.progress = { count: 0, lastProgressRound: this.counts.steps, fingerprints: [], preparedTools: [], ...(options.progress || {}) };
        this.segmentStartSteps = Math.min(this.counts.steps, Math.max(0, Number(options.segmentStartSteps ?? this.counts.steps) || 0));
        this.segmentStartProgress = Math.min(Number(this.progress.count) || 0, Math.max(0, Number(options.segmentStartProgress ?? this.progress.count) || 0));
        this.segmentNumber = Math.max(1, Number(options.segmentNumber) || 1);
        this.segmentStartElapsed = Math.max(0, Number(options.segmentStartElapsed ?? this.priorElapsedSeconds) || 0);
        this.persist = options.persist || null;
        this.persistQueue = Promise.resolve();
    }

    elapsedSeconds(now = Date.now()) {
        return this.priorElapsedSeconds + Math.max((Number(now) - this.startedAt) / 1000, 0);
    }

    snapshot(now = Date.now()) {
        return {
            accountingVersion: 2,
            limits: { ...this.limits },
            counts: { ...this.counts },
            elapsed_seconds: this.elapsedSeconds(now),
            tripped: this.tripped ? { ...this.tripped } : null,
            progress: { ...this.progress, fingerprints: this.progress.fingerprints.slice(-128) },
            segment: { number: this.segmentNumber, startSteps: this.segmentStartSteps, startProgress: this.segmentStartProgress,
                startElapsedSeconds: this.segmentStartElapsed, maxSteps: this.policy?.segmentSteps || this.limits.max_steps },
            phase: this.phase
        };
    }

    _trip(key, actual, limit, message) {
        const details = { key, actual, limit, snapshot: this.snapshot() };
        this.tripped = { key, actual, limit };
        throw new BudgetExceededError(message, details);
    }

    _assertLimit(key, actual, message) {
        const limit = this.limits[key];
        if (limit !== Infinity && actual > limit) this._trip(key, actual, limit, message);
    }

    assertWithin(now = Date.now()) {
        if (!this.enabled) return this.snapshot(now);
        this._assertLimit('max_runtime_seconds', this.elapsedSeconds(now), '任务运行时间超过预算。');
        this._assertLimit('max_steps', this.counts.steps, '任务步骤数超过预算。');
        this._assertLimit('max_tool_calls', this.counts.tool_calls, '工具调用次数超过预算。');
        if (this.phase !== 'finalization') this._assertLimit('max_consecutive_errors', this.counts.consecutive_errors, '连续错误次数超过预算。');
        this._assertLimit('max_tokens_total', this.counts.tokens_total, '任务 Token 用量超过预算。');
        this._assertLimit('risk_budget', this.counts.risk, '任务风险预算已耗尽。');
        this._assertLimit('max_external_side_effects', this.counts.external_side_effects, '外部副作用次数超过预算。');
        this._assertLimit('max_file_writes', this.counts.file_writes, '文件写入次数超过预算。');
        this._assertLimit('max_network_requests', this.counts.network_requests, '网络请求次数超过预算。');
        return this.snapshot(now);
    }

    assertCanRequestModel() {
        this.assertWithin();
        const limit = this.limits.max_tokens_total;
        if (this.enabled && Number.isFinite(limit) && this.counts.tokens_total >= limit) {
            this._trip('max_tokens_total', this.counts.tokens_total, limit, '任务 Token 预算已用完，不能继续调用模型。');
        }
        if (this.enabled && this.policy && this.phase !== 'finalization') {
            const tokens = Math.min(this.policy.reserveTokens || 0, Math.floor(limit * .1));
            const seconds = Math.min(this.policy.reserveRuntimeSeconds || 0, Math.floor(this.limits.max_runtime_seconds / 4));
            if (this.counts.tokens_total >= limit - tokens || this.elapsedSeconds() >= this.limits.max_runtime_seconds - seconds) {
                throw Object.assign(new Error('已预留结果整理与核验额度，正在结束本段执行。'), { code: 'AGENT_FINALIZATION_REQUIRED', category: 'resource' });
            }
        }
    }

    consumeStep() {
        if (!this.enabled) return this.snapshot();
        this._assertLimit('max_steps', this.counts.steps + 1, '任务累计轮次已达到上限。');
        this.counts.steps += 1;
        this.assertWithin();
        return this.snapshot();
    }

    consumeTool(tool = {}) {
        if (!this.enabled) return this.snapshot();
        if (this.policy && this.phase !== 'finalization' && !/^(?:artifact\.render|tools\.execute)$/.test(String(tool.name || ''))
            && this.counts.tool_calls >= this.limits.max_tool_calls - Math.min(this.policy.reserveToolCalls || 0, Math.floor(this.limits.max_tool_calls / 4))) {
            throw Object.assign(new Error('已预留结果文件登记与核验所需调用额度。'), { code: 'AGENT_FINALIZATION_REQUIRED', category: 'resource' });
        }
        this._assertLimit('max_tool_calls', this.counts.tool_calls + 1, '任务累计工具调用次数已达到上限。');
        const risk = Number(tool.risk_level ?? tool.riskLevel ?? 0) || 0;
        this.counts.tool_calls += 1;
        this.counts.risk += Math.max(risk, 0);
        if (tool.side_effect || tool.sideEffect) this.counts.external_side_effects += 1;
        if (tool.network) this.counts.network_requests += 1;
        const name = String(tool.name || '').toLowerCase();
        if (tool.file_write || tool.fileWrite || /(?:write|upload|delete|move|save|export)/.test(name)) {
            this.counts.file_writes += 1;
        }
        this.lastTool = String(tool.name || '');
        this.assertWithin();
        return this.snapshot();
    }

    async persistUsageSnapshot() {
        if (!this.persist || this.requeued) return;
        const snapshot = this.snapshot();
        this.persistQueue = this.persistQueue.then(() => this.persist(snapshot));
        try { await this.persistQueue; }
        catch (error) {
            if (['AGENT_RUN_LEASE_LOST', 'AGENT_RUN_CANCELLED', 'AGENT_RUN_PAUSED'].includes(error.code)) throw error;
            throw Object.assign(new Error('任务累计用量无法保存，已停止继续执行，请检查存储后重试。'), { code: 'AGENT_BUDGET_PERSIST_FAILED', category: 'resource' });
        }
    }

    recordProgress(tool, input, output) {
        const { preparationFingerprint, progressFingerprint } = require('./agent-execution-progress');
        const preparations = tool === 'tools.describe' && output?.type === 'tools_descriptions'
            ? (output.descriptions || []).map(description => preparationFingerprint(tool, description)) : [preparationFingerprint(tool, output)];
        for (const preparation of preparations) {
            if (preparation && !this.progress.preparedTools.includes(preparation)) {
                this.progress.preparedTools = [...this.progress.preparedTools, preparation].slice(-128);
                this.progress.lastProgressRound = this.counts.steps;
            }
        }
        const fingerprint = progressFingerprint(tool, input, output);
        if (!fingerprint || this.progress.fingerprints.includes(fingerprint)) return false;
        this.progress.count += 1;
        this.progress.lastProgressRound = this.counts.steps;
        this.progress.fingerprints = [...this.progress.fingerprints, fingerprint].slice(-128);
        return true;
    }

    stopSummary(code) {
        return { code, cumulativeRounds: this.counts.steps, totalRoundLimit: this.limits.max_steps,
            toolCalls: this.counts.tool_calls, tokens: this.counts.tokens_total, progressCount: this.progress.count };
    }

    async beginPlanningRound() {
        this.assertCanRequestModel();
        if (this.policy && this.counts.steps - this.progress.lastProgressRound >= this.policy.noProgressRounds) {
            this.tripped = { key: 'no_progress', actual: this.counts.steps - this.progress.lastProgressRound, limit: this.policy.noProgressRounds };
            throw Object.assign(new Error('连续多轮未取得新的资料或执行结果，已停止重复处理，请补充要求或检查工具。'), { code: 'AGENT_NO_PROGRESS', category: 'capability' });
        }
        this.consumeStep();
        await this.persistUsageSnapshot();
    }

    remainingSegmentRounds() {
        return Math.max(0, Math.min((this.policy?.segmentSteps || this.limits.max_steps) - (this.counts.steps - this.segmentStartSteps), this.limits.max_steps - this.counts.steps));
    }

    planningHint() {
        return `本段剩余 ${this.remainingSegmentRounds()} 轮，任务累计已用 ${this.counts.steps}/${this.limits.max_steps} 轮；工具已用 ${this.counts.tool_calls}/${this.limits.max_tool_calls} 次。先完成必要文件登记，再核验与返回最终答案。剩余很少时不要开启新的支线，不得声称未执行的操作已完成。`;
    }

    async withFinalization(operation) {
        const previous = this.phase;
        this.phase = 'finalization';
        try { return await operation(); } finally { this.phase = previous; }
    }

    modelOutputAllowance(inputTokens, requestedTokens) {
        this.assertCanRequestModel();
        const reserve = this.phase === 'finalization' ? 0 : Math.min(this.policy?.reserveTokens || 0, Math.floor(this.limits.max_tokens_total * .1));
        const available = this.limits.max_tokens_total - this.counts.tokens_total - Math.max(0, inputTokens) - reserve;
        if (available < 1) throw Object.assign(new Error('剩余额度不足以读取上下文并生成结果。'), { code: this.phase === 'finalization' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_FINALIZATION_REQUIRED', category: 'resource' });
        return Math.min(requestedTokens, Math.floor(available));
    }

    recordError() {
        if (!this.enabled) return this.snapshot();
        this.counts.consecutive_errors += 1;
        this.assertWithin();
        return this.snapshot();
    }

    recordSuccess() {
        this.counts.consecutive_errors = 0;
        return this.snapshot();
    }

    recordTokens(tokens = 0) {
        if (!this.enabled) return this.snapshot();
        this.counts.tokens_total += Math.max(Number(tokens) || 0, 0);
        this.assertWithin();
        return this.snapshot();
    }
}

module.exports = {
    BudgetExceededError,
    DEFAULT_BUDGET,
    TaskBudget,
    normalizeTaskBudget
};
