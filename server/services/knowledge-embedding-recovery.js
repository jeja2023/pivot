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

function createEmbeddingProfileMismatchScheduler({ query, scheduleKnowledgeDocumentIndexing, getEmbeddingConfig, getEmbeddingProfile }) {
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
            const config = getEmbeddingConfig(row.user_id);
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
            const result = await scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id, priority: -20 });
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
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const result = await recover();
            if (Number(result.scheduled || 0) > 0) logger.info(result, '知识库关键词降级文档已加入向量补齐队列');
        } catch (error) {
            logger.warn({ err: error.message }, '知识库向量补齐巡检失败');
        } finally {
            running = false;
        }
    };
    return {
        async start() {
            if (timer) return;
            await tick();
            timer = setIntervalFn(() => { void tick(); }, intervalMs);
            timer?.unref?.();
        },
        stop() {
            if (timer) clearIntervalFn(timer);
            timer = null;
        },
        tick
    };
}

module.exports = { createEmbeddingProfileMismatchScheduler, createKnowledgeEmbeddingRecoveryRunner, createLexicalReadyScheduler };
