'use strict';

function createLexicalReadyScheduler({ query, scheduleKnowledgeDocumentIndexing }) {
    return async function scheduleLexicalReadyKnowledgeDocuments({ limit = 50 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 500));
        const rows = await query(`
            SELECT id, user_id
            FROM knowledge_docs
            WHERE status = 'lexical_ready'
              AND deleted_at IS NULL
              AND source_path IS NOT NULL
              AND source_path != ''
            ORDER BY COALESCE(updated_at, processed_at, created_at) ASC
            LIMIT ?
        `, [safeLimit]);
        let scheduled = 0;
        let alreadyProcessing = 0;
        for (const row of rows) {
            const result = await scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id, priority: -10 });
            if (result.started) scheduled += 1;
            if (result.reason === 'already_processing') alreadyProcessing += 1;
        }
        return { total: rows.length, scheduled, alreadyProcessing };
    };
}

function createEmbeddingProfileMismatchScheduler({ query, scheduleKnowledgeDocumentIndexing, getSystemEmbeddingConfig, getEmbeddingProfile }) {
    return async function scheduleEmbeddingProfileMismatchedDocuments({ limit = 50 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 500));
        const rows = await query(`
            SELECT d.id, d.user_id,
                   STRING_AGG(DISTINCT NULLIF(chunk.embedding_profile, ''), CHR(31)) AS embedding_profiles
            FROM knowledge_docs d
            JOIN knowledge_chunks chunk ON chunk.doc_id = d.id AND chunk.embedding IS NOT NULL
            WHERE d.status IN ('ready', 'lexical_ready') AND d.deleted_at IS NULL
              AND d.source_path IS NOT NULL AND d.source_path != ''
            GROUP BY d.id, d.user_id
            ORDER BY d.updated_at ASC, d.id ASC LIMIT ?
        `, [safeLimit]);
        let scheduled = 0;
        let upToDate = 0;
        for (const row of rows) {
            const config = getSystemEmbeddingConfig();
            if (!String(config?.http?.url || '').trim()) {
                upToDate += 1;
                continue;
            }
            const expected = getEmbeddingProfile(config);
            const profiles = String(row.embedding_profiles || '').split(String.fromCharCode(31)).filter(Boolean);
            if (profiles.length === 1 && profiles[0] === expected) {
                upToDate += 1;
                continue;
            }
            const result = await scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id, priority: -20, force: true });
            if (result.started) scheduled += 1;
        }
        return { scanned: rows.length, scheduled, upToDate };
    };
}

function createKnowledgeEmbeddingRecoveryRunner({
    intervalMs = Math.max(60 * 1000, Number.parseInt(process.env.KNOWLEDGE_EMBEDDING_RECOVERY_INTERVAL_MS || '300000', 10) || 300000),
    recover,
    logger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
} = {}) {
    if (typeof recover !== 'function') throw new TypeError('知识库向量补齐巡检必须提供 recover 函数');
    let timer = null;
    let stopped = false;
    let inFlight = null;
    const tick = () => {
        if (stopped || inFlight) return inFlight;
        inFlight = Promise.resolve().then(recover).then(result => {
            if (Number(result.scheduled || 0) > 0) logger.info(result, '知识库关键词降级文档已加入向量补齐队列');
        }).catch(error => logger.warn({ err: error.message }, '知识库向量补齐巡检失败'))
            .finally(() => { inFlight = null; });
        return inFlight;
    };
    return {
        async start() {
            if (timer) return;
            stopped = false;
            await tick();
            if (stopped) return;
            timer = setIntervalFn(() => { void tick(); }, intervalMs);
            timer?.unref?.();
        },
        async stop() {
            stopped = true;
            if (timer) clearIntervalFn(timer);
            timer = null;
            if (inFlight) await inFlight;
        },
        tick
    };
}

function createAllKnowledgeDocumentsReindexScheduler({ query, scheduleKnowledgeDocumentIndexing }) {
    return async function reindexAllKnowledgeDocuments({ limit = 2000 } = {}) {
        const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 2000, 1), 5000);
        const rows = await query(`
            SELECT id, user_id
            FROM knowledge_docs
            WHERE deleted_at IS NULL AND source_path IS NOT NULL AND source_path <> ''
            ORDER BY id ASC
            LIMIT ?
        `, [safeLimit + 1]);
        const truncated = rows.length > safeLimit;
        const selected = rows.slice(0, safeLimit);
        let scheduled = 0;
        let alreadyProcessing = 0;
        for (const row of selected) {
            const result = await scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id, priority: -5, force: true });
            if (result.started) scheduled += 1;
            if (result.reason === 'already_processing') alreadyProcessing += 1;
        }
        return { scanned: selected.length, scheduled, alreadyProcessing, truncated, limit: safeLimit };
    };
}

module.exports = {
    createAllKnowledgeDocumentsReindexScheduler,
    createEmbeddingProfileMismatchScheduler,
    createKnowledgeEmbeddingRecoveryRunner,
    createLexicalReadyScheduler
};
