// Execution Plane facade.  The same deterministic guards are used by the
// server control plane so desktop and web execution cannot disagree on policy.
const { TaskBudget, normalizeTaskBudget, BudgetExceededError } = require('../../server/services/agent-budget');
const { ToolRegistry, normalizeToolContract, validateToolInput } = require('../../server/services/agent-contracts');
const { enforceToolPolicy, evaluateToolPolicy, PolicyError } = require('../../server/services/agent-policy');
const { createWorkspaceJail, runSandboxedProcess } = require('../../server/services/agent-sandbox');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('../../server/services/agent-network-policy');
const { diagnoseError } = require('../../server/services/agent-diagnosis');
const { runDesktopWorker, assertWorkerConfiguration } = require('./broker');

module.exports = {
    BudgetExceededError,
    PolicyError,
    TaskBudget,
    ToolRegistry,
    assertNetworkPolicyUrl,
    createWorkspaceJail,
    diagnoseError,
    enforceToolPolicy,
    evaluateToolPolicy,
    normalizeNetworkPolicy,
    normalizeTaskBudget,
    normalizeToolContract,
    runSandboxedProcess,
    runDesktopWorker,
    assertWorkerConfiguration,
    validateToolInput
};
