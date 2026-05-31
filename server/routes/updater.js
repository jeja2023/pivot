const express = require('express');
const { asyncHandler } = require('../http');
const { getAppVersion } = require('../version');
const {
    createUpdateRunId,
    getUpdaterPublicConfig,
    normalizeUpdaterError,
    requestUpdater
} = require('../services/updater-client');
const {
    checkForUpdates,
    getUpdaterMonitorStatus
} = require('../services/updater-monitor');

function createUpdaterRouter({ authMiddleware, adminMiddleware, logAction }) {
    const router = express.Router();
    const superAdminOnly = (req, res, next) => {
        if (req.user?.username !== 'admin') {
            return res.status(403).json({ error: '只有 admin 超级管理员可以执行在线更新。' });
        }
        next();
    };

    router.get('/admin/updater/status', authMiddleware, adminMiddleware, asyncHandler(async (_req, res) => {
        const config = getUpdaterPublicConfig();
        let updater = { available: false };
        if (config.enabled) {
            try {
                updater = await requestUpdater('/status');
            } catch (e) {
                updater = {
                    available: false,
                    error: normalizeUpdaterError(e),
                    rawError: e.message
                };
            }
        }
        res.json({
            currentVersion: getAppVersion(),
            config,
            monitor: getUpdaterMonitorStatus(),
            updater
        });
    }));

    router.post('/admin/updater/check', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const data = req.body?.direct === true
            ? await requestUpdater('/check', {
                method: 'POST',
                body: {
                    currentVersion: getAppVersion(),
                    repository: req.body?.repository,
                    branch: req.body?.branch
                }
            })
            : await checkForUpdates({ manual: true });
        res.json(data);
    }));

    router.post('/admin/updater/start', authMiddleware, adminMiddleware, superAdminOnly, asyncHandler(async (req, res) => {
        const runId = createUpdateRunId();
        const data = await requestUpdater('/update', {
            method: 'POST',
            body: {
                runId,
                currentVersion: getAppVersion(),
                repository: req.body?.repository,
                branch: req.body?.branch
            }
        });
        logAction(req, '启动在线更新', `runId: ${runId}，目标: ${data.targetVersion || data.latestVersion || '-'}`);
        res.json({ runId, ...data });
    }));

    return router;
}

module.exports = { createUpdaterRouter };
