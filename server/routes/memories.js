const express = require('express');
const { asyncHandler } = require('../http');
const {
    MEMORY_STATUS,
    archiveExpiredMemories,
    cleanupMemoryExtractionJobs,
    exportMemories,
    getMemoryQualitySummary,
    getMemoryMergeSuggestions,
    getMemorySummary,
    getMemorySource,
    listMemoryExtractionJobs,
    listMemories,
    mergeMemories,
    processMemoryExtractionJobs,
    retryFailedMemoryExtractionJobs,
    setLongTermMemoryEnabled,
    softDeleteMemory,
    updateMemory,
    updateMemoryStatus,
    updateMemoryStatuses
} = require('../services/long-term-memory');

function normalizeMemoryId(raw) {
    const id = Number.parseInt(raw, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendServiceError(res, err) {
    if (err?.statusCode) {
        return res.status(err.statusCode).json({
            error: err.message,
            code: err.code || 'MEMORY_ERROR'
        });
    }
    throw err;
}

function createMemoriesRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    router.get('/memories', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listMemories(req.user.id, {
            status: req.query.status || MEMORY_STATUS.active,
            type: req.query.type || '',
            search: req.query.search || '',
            limit: req.query.limit,
            offset: req.query.offset
        });
        const summary = await getMemorySummary(req.user.id);
        res.json({
            success: true,
            summary,
            ...result
        });
    }));

    router.get('/memories/merge-suggestions', authMiddleware, asyncHandler(async (req, res) => {
        const suggestions = await getMemoryMergeSuggestions(req.user.id, { limit: req.query.limit });
        res.json({
            success: true,
            suggestions
        });
    }));

    router.get('/memories/quality', authMiddleware, asyncHandler(async (req, res) => {
        const summary = await getMemoryQualitySummary(req.user.id);
        res.json({ success: true, summary });
    }));

    router.get('/memories/export', authMiddleware, asyncHandler(async (req, res) => {
        const exportData = await exportMemories(req.user.id, {
            status: req.query.status || 'all',
            type: req.query.type || '',
            search: req.query.search || ''
        });
        res.json({
            success: true,
            export: exportData
        });
    }));

    router.get('/memories/jobs', authMiddleware, asyncHandler(async (req, res) => {
        const jobsData = await listMemoryExtractionJobs(req.user.id, {
            status: req.query.status || 'all',
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json({
            success: true,
            ...jobsData
        });
    }));

    router.post('/memories/jobs/retry', authMiddleware, asyncHandler(async (req, res) => {
        const result = await retryFailedMemoryExtractionJobs(req.user.id, req.body?.jobIds || req.body?.ids || []);
        if (typeof logAction === 'function') {
            logAction(req, 'retry long-term memory jobs', `queued: ${result.queued}`);
        }
        const jobsData = await listMemoryExtractionJobs(req.user.id, { limit: 20 });
        return res.json({ success: true, ...result, jobs: jobsData });
    }));

    router.post('/memories/jobs/cleanup', authMiddleware, asyncHandler(async (req, res) => {
        const result = await cleanupMemoryExtractionJobs(req.user.id, {
            retentionDays: req.body?.retentionDays,
            limit: req.body?.limit
        });
        if (typeof logAction === 'function') {
            logAction(req, 'cleanup long-term memory jobs', `deleted: ${result.deleted}`);
        }
        const jobsData = await listMemoryExtractionJobs(req.user.id, { limit: 20 });
        return res.json({
            success: true,
            ...result,
            jobs: jobsData
        });
    }));

    router.post('/memories/jobs/process', authMiddleware, asyncHandler(async (req, res) => {
        const result = await processMemoryExtractionJobs({ limit: req.body?.limit || 5 });
        const jobsData = await listMemoryExtractionJobs(req.user.id, { limit: 20 });
        return res.json({ success: true, ...result, jobs: jobsData });
    }));

    router.get('/memories/summary', authMiddleware, asyncHandler(async (req, res) => {
        const summary = await getMemorySummary(req.user.id);
        res.json({ success: true, summary });
    }));

    router.put('/memories/settings', authMiddleware, asyncHandler(async (req, res) => {
        const enabled = req.body?.enabled !== false;
        const finalEnabled = await setLongTermMemoryEnabled(req.user.id, enabled);
        if (typeof logAction === 'function') {
            logAction(req, 'update long-term memory setting', finalEnabled ? 'enabled' : 'disabled');
        }
        const summary = await getMemorySummary(req.user.id);
        res.json({
            success: true,
            enabled: finalEnabled,
            summary
        });
    }));

    router.put('/memories/status/bulk', authMiddleware, asyncHandler(async (req, res) => {
        const status = String(req.body?.status || MEMORY_STATUS.active);
        if (!Object.values(MEMORY_STATUS).includes(status)) {
            return res.status(400).json({ error: 'invalid_memory_status' });
        }
        const result = await updateMemoryStatuses(req.user.id, req.body?.ids || req.body?.memoryIds || [], status);
        if (typeof logAction === 'function') {
            logAction(req, 'bulk update long-term memory status', `status: ${status}; count: ${result.updated}`);
        }
        const summary = await getMemorySummary(req.user.id);
        return res.json({ success: true, ...result, summary });
    }));

    router.post('/memories/maintenance/archive-expired', authMiddleware, asyncHandler(async (req, res) => {
        const result = await archiveExpiredMemories(req.user.id, {
            status: req.body?.status || MEMORY_STATUS.disabled,
            limit: req.body?.limit
        });
        if (typeof logAction === 'function') {
            logAction(req, 'archive expired long-term memories', `archived: ${result.archived}`);
        }
        const summary = await getMemoryQualitySummary(req.user.id);
        return res.json({
            success: true,
            ...result,
            summary
        });
    }));

    router.get('/memories/:id/source', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        const source = await getMemorySource(req.user.id, id);
        if (!source) return res.status(404).json({ error: 'memory_not_found' });
        return res.json({ success: true, ...source });
    }));

    router.put('/memories/:id', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        try {
            const memory = await updateMemory(req.user.id, id, req.body || {}, { user: req.user });
            if (!memory) return res.status(404).json({ error: 'memory_not_found' });
            if (typeof logAction === 'function') {
                logAction(req, 'update long-term memory', `memoryId: ${id}`);
            }
            const summary = await getMemorySummary(req.user.id);
            return res.json({ success: true, memory, summary });
        } catch (err) {
            return sendServiceError(res, err);
        }
    }));

    router.put('/memories/:id/status', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        const status = String(req.body?.status || MEMORY_STATUS.active);
        if (!Object.values(MEMORY_STATUS).includes(status)) {
            return res.status(400).json({ error: 'invalid_memory_status' });
        }
        const changed = await updateMemoryStatus(req.user.id, id, status);
        if (!changed) return res.status(404).json({ error: 'memory_not_found' });
        if (typeof logAction === 'function') {
            logAction(req, 'update long-term memory status', `memoryId: ${id}; status: ${status}`);
        }
        const summary = await getMemorySummary(req.user.id);
        return res.json({ success: true, summary });
    }));

    router.post('/memories/merge', authMiddleware, asyncHandler(async (req, res) => {
        try {
            const result = await mergeMemories(req.user.id, req.body?.targetId, req.body?.sourceId, { user: req.user });
            if (!result) return res.status(404).json({ error: 'memory_not_found' });
            if (typeof logAction === 'function') {
                logAction(req, 'merge long-term memories', `targetId: ${req.body?.targetId}; sourceId: ${req.body?.sourceId}`);
            }
            const summary = await getMemorySummary(req.user.id);
            return res.json({ success: true, ...result, summary });
        } catch (err) {
            return sendServiceError(res, err);
        }
    }));

    router.delete('/memories/:id', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        const changed = await softDeleteMemory(req.user.id, id);
        if (!changed) return res.status(404).json({ error: 'memory_not_found' });
        if (typeof logAction === 'function') {
            logAction(req, 'delete long-term memory', `memoryId: ${id}`);
        }
        const summary = await getMemorySummary(req.user.id);
        return res.json({ success: true, summary });
    }));

    return router;
}

module.exports = {
    createMemoriesRouter
};
