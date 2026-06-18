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
        const result = listMemories(req.user.id, {
            status: req.query.status || MEMORY_STATUS.active,
            type: req.query.type || '',
            search: req.query.search || '',
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json({
            success: true,
            summary: getMemorySummary(req.user.id),
            ...result
        });
    }));

    router.get('/memories/merge-suggestions', authMiddleware, asyncHandler(async (req, res) => {
        res.json({
            success: true,
            suggestions: getMemoryMergeSuggestions(req.user.id, { limit: req.query.limit })
        });
    }));

    router.get('/memories/quality', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, summary: getMemoryQualitySummary(req.user.id) });
    }));

    router.get('/memories/export', authMiddleware, asyncHandler(async (req, res) => {
        res.json({
            success: true,
            export: exportMemories(req.user.id, {
                status: req.query.status || 'all',
                type: req.query.type || '',
                search: req.query.search || ''
            })
        });
    }));

    router.get('/memories/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json({
            success: true,
            ...listMemoryExtractionJobs(req.user.id, {
                status: req.query.status || 'all',
                limit: req.query.limit,
                offset: req.query.offset
            })
        });
    }));

    router.post('/memories/jobs/retry', authMiddleware, asyncHandler(async (req, res) => {
        const result = retryFailedMemoryExtractionJobs(req.user.id, req.body?.jobIds || req.body?.ids || []);
        if (typeof logAction === 'function') {
            logAction(req, 'retry long-term memory jobs', `queued: ${result.queued}`);
        }
        return res.json({ success: true, ...result, jobs: listMemoryExtractionJobs(req.user.id, { limit: 20 }) });
    }));

    router.post('/memories/jobs/cleanup', authMiddleware, asyncHandler(async (req, res) => {
        const result = cleanupMemoryExtractionJobs(req.user.id, {
            retentionDays: req.body?.retentionDays,
            limit: req.body?.limit
        });
        if (typeof logAction === 'function') {
            logAction(req, 'cleanup long-term memory jobs', `deleted: ${result.deleted}`);
        }
        return res.json({
            success: true,
            ...result,
            jobs: listMemoryExtractionJobs(req.user.id, { limit: 20 })
        });
    }));

    router.post('/memories/jobs/process', authMiddleware, asyncHandler(async (req, res) => {
        const result = await processMemoryExtractionJobs({ limit: req.body?.limit || 5 });
        return res.json({ success: true, ...result, jobs: listMemoryExtractionJobs(req.user.id, { limit: 20 }) });
    }));

    router.get('/memories/summary', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, summary: getMemorySummary(req.user.id) });
    }));

    router.put('/memories/settings', authMiddleware, asyncHandler(async (req, res) => {
        const enabled = req.body?.enabled !== false;
        const finalEnabled = setLongTermMemoryEnabled(req.user.id, enabled);
        if (typeof logAction === 'function') {
            logAction(req, 'update long-term memory setting', finalEnabled ? 'enabled' : 'disabled');
        }
        res.json({
            success: true,
            enabled: finalEnabled,
            summary: getMemorySummary(req.user.id)
        });
    }));

    router.put('/memories/status/bulk', authMiddleware, asyncHandler(async (req, res) => {
        const status = String(req.body?.status || MEMORY_STATUS.active);
        if (!Object.values(MEMORY_STATUS).includes(status)) {
            return res.status(400).json({ error: 'invalid_memory_status' });
        }
        const result = updateMemoryStatuses(req.user.id, req.body?.ids || req.body?.memoryIds || [], status);
        if (typeof logAction === 'function') {
            logAction(req, 'bulk update long-term memory status', `status: ${status}; count: ${result.updated}`);
        }
        return res.json({ success: true, ...result, summary: getMemorySummary(req.user.id) });
    }));

    router.post('/memories/maintenance/archive-expired', authMiddleware, asyncHandler(async (req, res) => {
        const result = archiveExpiredMemories(req.user.id, {
            status: req.body?.status || MEMORY_STATUS.disabled,
            limit: req.body?.limit
        });
        if (typeof logAction === 'function') {
            logAction(req, 'archive expired long-term memories', `archived: ${result.archived}`);
        }
        return res.json({
            success: true,
            ...result,
            summary: getMemoryQualitySummary(req.user.id)
        });
    }));

    router.get('/memories/:id/source', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        const source = getMemorySource(req.user.id, id);
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
            return res.json({ success: true, memory, summary: getMemorySummary(req.user.id) });
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
        const changed = updateMemoryStatus(req.user.id, id, status);
        if (!changed) return res.status(404).json({ error: 'memory_not_found' });
        if (typeof logAction === 'function') {
            logAction(req, 'update long-term memory status', `memoryId: ${id}; status: ${status}`);
        }
        return res.json({ success: true, summary: getMemorySummary(req.user.id) });
    }));

    router.post('/memories/merge', authMiddleware, asyncHandler(async (req, res) => {
        try {
            const result = await mergeMemories(req.user.id, req.body?.targetId, req.body?.sourceId, { user: req.user });
            if (!result) return res.status(404).json({ error: 'memory_not_found' });
            if (typeof logAction === 'function') {
                logAction(req, 'merge long-term memories', `targetId: ${req.body?.targetId}; sourceId: ${req.body?.sourceId}`);
            }
            return res.json({ success: true, ...result, summary: getMemorySummary(req.user.id) });
        } catch (err) {
            return sendServiceError(res, err);
        }
    }));

    router.delete('/memories/:id', authMiddleware, asyncHandler(async (req, res) => {
        const id = normalizeMemoryId(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid_memory_id' });
        const changed = softDeleteMemory(req.user.id, id);
        if (!changed) return res.status(404).json({ error: 'memory_not_found' });
        if (typeof logAction === 'function') {
            logAction(req, 'delete long-term memory', `memoryId: ${id}`);
        }
        return res.json({ success: true, summary: getMemorySummary(req.user.id) });
    }));

    return router;
}

module.exports = {
    createMemoriesRouter
};
