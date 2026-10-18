'use strict';

const { asyncHandler } = require('../http');
const {
    listAgentLifecycleHooks,
    listAgentLifecycleHookInvocations,
    registerAgentLifecycleHook
} = require('../services/agent-lifecycle-hooks');
const {
    importManagedHookPackage,
    listManagedHookPackages,
    setManagedHookPackageStatus
} = require('../services/agent-lifecycle-hook-packages');

function registerAgentLifecycleHookRoutes(router, { authMiddleware, automationGuard, logAction } = {}) {
    router.get('/agents/lifecycle-hooks', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentLifecycleHooks(req.user, { eventType: req.query.eventType || req.query.event_type }) });
    }));

    router.get('/agents/lifecycle-hooks/audits', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentLifecycleHookInvocations(req.user, {
            hookId: req.query.hookId || req.query.hook_id,
            runId: req.query.runId || req.query.run_id,
            limit: req.query.limit
        }) });
    }));

    router.post('/agents/lifecycle-hooks', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const hook = await registerAgentLifecycleHook(req.user, req.body || {});
        logAction(req, '登记 Agent 生命周期 Hook', `Hook: ${hook.hookName}，事件: ${hook.eventType}/${hook.phase}，状态: ${hook.status}`);
        res.status(201).json({ success: true, hook });
    }));

    router.get('/agents/lifecycle-hook-packages', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listManagedHookPackages(req.user, { limit: req.query.limit }) });
    }));

    router.post('/agents/lifecycle-hook-packages/import', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await importManagedHookPackage(req.user, req.body || {});
        logAction(req, '导入受管生命周期 Hook 包', `包: ${result.package.packageId}@${result.package.packageVersion}，Hook: ${result.hooks.length}`);
        res.status(result.reused ? 200 : 201).json({ success: true, data: result });
    }));

    router.put('/agents/lifecycle-hook-packages/:packageId/:packageVersion/status', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const item = await setManagedHookPackageStatus(req.user, req.params.packageId, req.params.packageVersion, req.body?.status);
        logAction(req, '更新受管生命周期 Hook 包状态', `包: ${item.packageId}@${item.packageVersion}，状态: ${item.status}`);
        res.json({ success: true, data: item });
    }));
}

module.exports = { registerAgentLifecycleHookRoutes };
