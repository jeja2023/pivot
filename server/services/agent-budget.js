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
    risk_budget: 20,
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
    }

    elapsedSeconds(now = Date.now()) {
        return Math.max((Number(now) - this.startedAt) / 1000, 0);
    }

    snapshot(now = Date.now()) {
        return {
            limits: { ...this.limits },
            counts: { ...this.counts },
            elapsed_seconds: this.elapsedSeconds(now),
            tripped: this.tripped ? { ...this.tripped } : null
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
        this._assertLimit('max_consecutive_errors', this.counts.consecutive_errors, '连续错误次数超过预算。');
        this._assertLimit('max_tokens_total', this.counts.tokens_total, '任务 Token 用量超过预算。');
        this._assertLimit('risk_budget', this.counts.risk, '任务风险预算已耗尽。');
        this._assertLimit('max_external_side_effects', this.counts.external_side_effects, '外部副作用次数超过预算。');
        this._assertLimit('max_file_writes', this.counts.file_writes, '文件写入次数超过预算。');
        this._assertLimit('max_network_requests', this.counts.network_requests, '网络请求次数超过预算。');
        return this.snapshot(now);
    }

    consumeStep() {
        if (!this.enabled) return this.snapshot();
        this.counts.steps += 1;
        this.assertWithin();
        return this.snapshot();
    }

    consumeTool(tool = {}) {
        if (!this.enabled) return this.snapshot();
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
