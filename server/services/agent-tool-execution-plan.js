const { evaluateToolPolicy, normalizeToolInput } = require('./agent-policy');
const { normalizeToolContract } = require('./agent-contracts');
const { assertNetworkPolicyUrl } = require('./agent-network-policy');

function extractNetworkUrl(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    for (const key of ['url', 'uri', 'targetUrl', 'target_url', 'endpoint', 'webhookUrl', 'webhook_url']) {
        const value = String(input[key] || '').trim();
        if (/^https?:\/\//i.test(value)) return value;
    }
    return '';
}

function sandboxChoice(tool, context = {}) {
    const name = String(tool?.name || '').trim();
    const explicit = String(context.sandboxMode || context.sandbox_mode || '').trim().toLowerCase();
    const required = context.autonomous === true && ['agent.code', 'workflow.foreach'].includes(name);
    if (required) return { mode: explicit || 'workspace-worker', required: true, escalationAllowed: false };
    if (explicit) return { mode: explicit, required: false, escalationAllowed: false };
    return { mode: 'none', required: false, escalationAllowed: false };
}

function retrySemantics(tool, policy = {}) {
    const category = tool?.side_effect || tool?.sideEffect ? 'side_effect' : 'read_only';
    return {
        category,
        retryable: category === 'read_only' && Boolean(tool?.idempotent),
        onPolicyDenied: 'fail_without_retry',
        onNetworkDenied: 'fail_without_retry',
        onSandboxDenied: 'fail_without_escalation',
        approvalRequired: policy.decision === 'require_approval'
    };
}

async function buildToolExecutionPlan({ run = {}, tool: rawTool = {}, input = {}, user = null, context = {}, policyEvaluator = evaluateToolPolicy } = {}) {
    const tool = normalizeToolContract(rawTool);
    const normalizedInput = normalizeToolInput(tool.name, input, run);
    const policy = policyEvaluator({
        run,
        tool,
        input: normalizedInput,
        user,
        budget: context.consumeBudget === true ? context.budget || null : null,
        allowApproval: context.allowApproval === true
    });
    const plan = {
        version: 1,
        tool: tool.name,
        input: normalizedInput,
        policy: {
            decision: policy.decision,
            reasons: policy.reasons || [],
            riskLevel: Number(tool.risk_level || 0) || 0
        },
        approval: {
            required: policy.decision === 'require_approval',
            key: String(context.approvalKey || context.operationKey || '').slice(0, 255),
            inputHash: ''
        },
        network: { required: Boolean(tool.network), url: '', preflight: 'not_applicable' },
        sandbox: sandboxChoice(tool, context),
        retry: retrySemantics(tool, policy)
    };
    if (policy.decision === 'denied') return plan;

    const url = extractNetworkUrl(normalizedInput);
    if (tool.network || url) {
        plan.network.required = true;
        plan.network.url = url;
        if (!url) {
            plan.network.preflight = 'deferred_to_adapter';
        } else {
            try {
                await assertNetworkPolicyUrl(url, run.network_policy || run.networkPolicy || {}, { requireAllowlist: context.autonomous === true });
                plan.network.preflight = 'passed';
            } catch (error) {
                plan.network.preflight = 'denied';
                plan.network.error = { code: error.code || 'AGENT_NETWORK_POLICY_DENIED', message: String(error.message || '').slice(0, 500) };
            }
        }
    }
    if (plan.sandbox.required && context.sandboxAvailable === false) {
        plan.sandbox.preflight = 'denied';
        plan.sandbox.error = { code: 'AGENT_SANDBOX_REQUIRED', message: '该工具必须在受控 Worker 沙箱中执行。' };
    } else {
        plan.sandbox.preflight = plan.sandbox.required ? 'deferred_to_adapter' : 'not_required';
    }
    return plan;
}

function summarizeToolExecutionPlan(plan = {}) {
    return {
        version: plan.version || 1,
        tool: plan.tool || '',
        policy: plan.policy?.decision || '',
        approvalRequired: Boolean(plan.approval?.required),
        networkPreflight: plan.network?.preflight || 'not_applicable',
        sandboxMode: plan.sandbox?.mode || 'none',
        sandboxRequired: Boolean(plan.sandbox?.required),
        retryable: Boolean(plan.retry?.retryable),
        retryPolicy: plan.retry?.onSandboxDenied || ''
    };
}

module.exports = {
    buildToolExecutionPlan,
    extractNetworkUrl,
    sandboxChoice,
    summarizeToolExecutionPlan
};
