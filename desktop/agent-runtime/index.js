// Execution Plane facade.  The same deterministic guards are used by the
// server control plane so desktop and web execution cannot disagree on policy.
const { TaskBudget, normalizeTaskBudget, BudgetExceededError } = require('../../server/services/agent-budget');
const { ToolRegistry, normalizeToolContract, validateToolInput } = require('../../server/services/agent-contracts');
const { enforceToolPolicy, evaluateToolPolicy, PolicyError } = require('../../server/services/agent-policy');
const { createWorkspaceJail, runSandboxedProcess } = require('../../server/services/agent-sandbox');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('../../server/services/agent-network-policy');
const { buildRecoveryPlan, diagnoseError } = require('../../server/services/agent-diagnosis');
const { runDesktopWorker, assertWorkerConfiguration } = require('./broker');
const { DesktopAgentRuntime } = require('./runtime');
const { DesktopAgentStateStore } = require('./state-store');
const { normalizePythonInput, resolvePythonExecutable, runPythonScript } = require('../../server/services/agent-python');
const { detectDataSource, materializeDataSource, queryDataSource } = require('../../server/services/agent-data-adapter');
const { createAgentBrowserContext, createControlledLoginFlow, locateBrowserTarget, clickBrowserTarget } = require('../../server/services/agent-browser');

module.exports = {
    BudgetExceededError,
    PolicyError,
    TaskBudget,
    ToolRegistry,
    assertNetworkPolicyUrl,
    createWorkspaceJail,
    diagnoseError,
    buildRecoveryPlan,
    enforceToolPolicy,
    evaluateToolPolicy,
    normalizeNetworkPolicy,
    normalizeTaskBudget,
    normalizeToolContract,
    runSandboxedProcess,
    runDesktopWorker,
    assertWorkerConfiguration,
    DesktopAgentRuntime,
    DesktopAgentStateStore,
    normalizePythonInput,
    resolvePythonExecutable,
    runPythonScript,
    detectDataSource,
    materializeDataSource,
    queryDataSource,
    createAgentBrowserContext,
    createControlledLoginFlow,
    locateBrowserTarget,
    clickBrowserTarget,
    validateToolInput
};
