const {
    query,
    queryOne,
    execute,
    transaction,
    fs,
    path,
    clearDirSizeCache,
    buildRagSearchContent,
    generateEmbeddings,
    getBeijingTimestamp,
    getSafeRegulationExtension,
    normalizeRegulationDateValue,
    normalizeRegulationEffectStatus,
    normalizeRegulationField,
    normalizeRegulationId,
    normalizeRegulationIssuingBodies,
    normalizeRegulationReviewStatus,
    normalizeRegulationStatus,
    normalizeRegulationSummary,
    normalizeRegulationTags,
    normalizeRegulationText,
    normalizeUploadedOriginalName,
    readRegulationTextFromPath,
    resolveRegulationStoredPath,
    saveRegulationAliases,
    saveRegulationUploadedFile
} = require('./shared');
const {
    countActualRegulationArticles,
    deriveRegulationSummary,
    deriveRegulationTitleFromText,
    parseRegulationArticles
} = require('./parser');
const {
    extractRegulationLinks,
    rebuildRegulationCrossLinks
} = require('./links');
const {
    getRegulationDocumentById,
    getRegulationVersionById
} = require('./catalog');
const { getEmbeddingConfig, getEmbeddingProfile } = require('../rag-config');
const { notifyRegulationSubscribers } = require('./governance');
const { saveRegulationArticleLocations } = require('./locations');
const { logger: defaultLogger } = require('../../logger');

function normalizeReviewedArticles(value) {
    if (value === undefined || value === null || value === '') return null;
    let source = value;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_error) { source = null; }
    }
    if (!Array.isArray(source) || !source.length || source.length > 20000) {
        const error = new Error('预览校正的条文数据无效，请重新预览后提交');
        error.statusCode = 400;
        throw error;
    }
    const articles = source.map((item, index) => {
        const content = normalizeRegulationText(item?.content || '');
        const articleLabel = normalizeRegulationField(item?.articleLabel ?? item?.article_label, 80) || `第${index + 1}节`;
        const articleTitle = normalizeRegulationField(item?.articleTitle ?? item?.article_title, 120);
        const headingPath = normalizeRegulationField(item?.headingPath ?? item?.heading_path, 255);
        if (!content) {
            const error = new Error('预览校正中存在空条文，请删除或补全后提交');
            error.statusCode = 400;
            throw error;
        }
        return {
            sortOrder: index + 1,
            stableKey: normalizeRegulationField(item?.stableKey ?? item?.stable_key ?? `${headingPath}#${articleLabel}`, 255),
            articleLabel,
            articleTitle,
            content,
            headingPath,
            searchContent: buildRagSearchContent([headingPath, articleLabel, articleTitle, content].filter(Boolean).join(' '))
        };
    });
    return articles;
}

async function saveRegulationDocumentVersion({ documentId, userId, file, metadata = {}, providedTitle = '', preloadedText = '' }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) {
        const error = new Error('法规文档不存在');
        error.statusCode = 404;
        throw error;
    }
    const doc = await getRegulationDocumentById(normalizedDocId, { includeArchived: true });
    if (!doc || doc.deleted_at) {
        const error = new Error('法规文档不存在或已归档');
        error.statusCode = 404;
        throw error;
    }
    if (!file?.path) {
        const error = new Error('请上传法规文档文件');
        error.statusCode = 400;
        throw error;
    }

    const title = normalizeRegulationField(providedTitle || metadata.title || doc.title, 120) || doc.title;
    // 版本标识优先取用户填写值或文件名识别的版本日期；留空时退回 v 序号
    const versionLabel = normalizeRegulationField(metadata.versionLabel || metadata.version_label || '', 80)
        || `v${(Number(doc.version_count || 0) || 0) + 1}`;
    const sourceMeta = await saveRegulationUploadedFile(file, normalizedDocId);
    const createdAt = getBeijingTimestamp();

    try {
        const extractedText = normalizeRegulationText(preloadedText) || await readRegulationTextFromPath(sourceMeta.absolutePath, file.originalname);
        if (!extractedText) {
            const error = new Error('未能从文档中提取可用正文，请检查文件内容或先完成文字识别');
            error.statusCode = 422;
            throw error;
        }
        const articles = normalizeReviewedArticles(metadata.reviewedArticles ?? metadata.reviewed_articles)
            || parseRegulationArticles(extractedText, { docTitle: title });
        const articleCount = countActualRegulationArticles(articles);
        if (!articleCount) {
            const error = new Error('未识别到可用法规条文，请在预览中检查后重试');
            error.statusCode = 422;
            throw error;
        }
        const summary = deriveRegulationSummary({
            title,
            extractedText,
            articles,
            providedSummary: metadata.summary || ''
        });
        const sourceFormat = getSafeRegulationExtension(file.originalname).replace(/^\./, '') || path.extname(file.originalname).replace(/^\./, '');
        const versionId = await transaction(async trx => {
            const versionInfo = await trx.queryOne(`
                INSERT INTO regulation_versions (
                    document_id, version_label, source_name, source_path, source_size,
                    source_hash, source_format, source_url, extracted_text, summary, article_count,
                    published_at, effective_from, effective_to, effect_status, review_status,
                    parse_status, index_status, embedding_profile, uploaded_by_user, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
            `, [
                normalizedDocId,
                versionLabel,
                normalizeUploadedOriginalName(file.originalname),
                sourceMeta.sourcePath,
                sourceMeta.sourceSize,
                sourceMeta.sourceHash,
                sourceFormat,
                normalizeRegulationField(metadata.sourceUrl || metadata.source_url, 1000),
                extractedText,
                summary,
                articleCount,
                normalizeRegulationDateValue(metadata.publishedAt || metadata.published_at) || null,
                normalizeRegulationDateValue(metadata.effectiveFrom || metadata.effective_from) || null,
                normalizeRegulationDateValue(metadata.effectiveTo || metadata.effective_to) || null,
                normalizeRegulationEffectStatus(metadata.effectStatus || metadata.effect_status),
                normalizeRegulationReviewStatus(metadata.reviewStatus || metadata.review_status),
                'ready',
                'indexing',
                normalizeRegulationField(metadata.embeddingProfile || metadata.embedding_profile, 120),
                userId || 0,
                createdAt,
                createdAt
            ]);
            const vId = versionInfo?.id;
            const orderToArticleId = new Map();
            for (const article of articles) {
                const articleRow = await trx.queryOne(`
                    INSERT INTO regulation_articles (
                    document_id, version_id, sort_order, stable_key, article_label,
                    article_title, content, search_content, heading_path, logical_path, created_at
                    )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id
                `, [
                    normalizedDocId,
                    vId,
                    article.sortOrder,
                    normalizeRegulationField(article.stableKey || article.stable_key || `${article.headingPath || ''}#${article.articleLabel || article.sortOrder}`, 255),
                    article.articleLabel,
                    article.articleTitle,
                    article.content,
                    article.searchContent,
                    article.headingPath || '',
                    article.headingPath || '',
                    createdAt
                ]);
                orderToArticleId.set(article.sortOrder, articleRow?.id);
            }
            // 抽取并落库条文间引用关系（条号引用对齐到本版本条文 id）
            const links = extractRegulationLinks(articles, { documentId: normalizedDocId, versionId: vId });
            if (links.length) {
                for (const link of links) {
                    const sourceId = orderToArticleId.get(link.sourceOrder);
                    const sourceArticle = articles.find(article => Number(article.sortOrder) === Number(link.sourceOrder));
                    if (!sourceId) continue;
                    const targetId = link.targetOrder ? orderToArticleId.get(link.targetOrder) || null : null;
                    await trx.execute(`
                        INSERT INTO regulation_article_links (
                            document_id, version_id, source_article_id, target_label,
                            target_article_id, target_document_id, target_version_id, binding_mode,
                            relation_type, evidence_excerpt, review_status, confidence, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        normalizedDocId,
                        vId,
                        sourceId,
                        link.targetLabel || '',
                        targetId,
                        targetId ? normalizedDocId : null,
                        targetId ? vId : null,
                        targetId ? 'fixed' : 'current',
                        link.relationType || 'cite',
                        String(sourceArticle?.content || '').slice(0, 240),
                        'auto',
                        link.confidence || 0.7,
                        createdAt
                    ]);
                }
            }
            await saveRegulationArticleLocations({
                articleIdsBySortOrder: orderToArticleId,
                articles,
                extractedText,
                executor: trx.execute.bind(trx)
            });
            await trx.execute(`
                UPDATE regulation_documents
                SET title = ?,
                    summary = ?,
                    status = 'active',
                    current_version_id = ?,
                    version_count = COALESCE(version_count, 0) + 1,
                    article_count = ?,
                    updated_by_user = ?,
                    updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
            `, [title, summary, vId, articleCount, userId || 0, createdAt, normalizedDocId]);
            return vId;
        });

        // 后置任务：更新别名表，解析跨法引用回连，生成向量（均不在事务内，失败不影响入库）
        try {
            await saveRegulationAliases(normalizedDocId, title);
            await rebuildRegulationCrossLinks();
        } catch (_err) {
            // 别名/跨法回连为增强能力，失败不阻断
        }
        // #2 异步生成条文向量（可选，失败降级为纯 BM25）
        setImmediate(async () => {
            try {
                const insertedArticles = await query('SELECT id, content FROM regulation_articles WHERE version_id = ? ORDER BY sort_order', [versionId]);
                await embedRegulationArticles(insertedArticles, {
                    userId,
                    source: 'regulations_import',
                    versionId,
                    embeddingProfile: normalizeRegulationField(
                        metadata.embeddingProfile || metadata.embedding_profile || getEmbeddingProfile(getEmbeddingConfig(userId)),
                        120
                    )
                });
            } catch (_err) {}
        });
        return {
            document: await getRegulationDocumentById(normalizedDocId, { includeArchived: true }),
            version: await getRegulationVersionById(versionId),
            articles,
            summary
        };
    } catch (error) {
        if (file.path) await fs.promises.rm(file.path, { force: true }).catch(() => {});
        try {
            const target = resolveRegulationStoredPath(sourceMeta.sourcePath);
            if (target) {
                await fs.promises.rm(target, { force: true });
                clearDirSizeCache();
            }
        } catch (_cleanupErr) {}
        throw error;
    }
}

async function createRegulationDocumentFromUpload({ userId, file, metadata = {}, preloadedText = '' }) {
    const now = getBeijingTimestamp();
    const title = normalizeRegulationField(
        metadata.title || deriveRegulationTitleFromText(preloadedText || '', file?.originalname || ''),
        120
    ) || '法规文档';
    const info = await queryOne(`
        INSERT INTO regulation_documents (
            title, category, legal_level, issuing_body, jurisdiction, official_source_url, subject_tags,
            summary, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, deleted_at, deleted_by_user,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, 'active', NULL, 0, 0, ?, ?, NULL, 0, ?, ?)
        RETURNING id
    `, [
        title,
        normalizeRegulationField(metadata.category, 120),
        normalizeRegulationField(metadata.legalLevel || metadata.legal_level, 80),
        normalizeRegulationIssuingBodies(metadata.issuingBody || metadata.issuing_body),
        normalizeRegulationField(metadata.jurisdiction, 120),
        normalizeRegulationField(metadata.officialSourceUrl || metadata.official_source_url, 1000),
        JSON.stringify(normalizeRegulationTags(metadata.subjectTags || metadata.subject_tags)),
        normalizeRegulationSummary(metadata.summary),
        userId || 0,
        userId || 0,
        now,
        now
    ]);
    const documentId = info?.id;
    try {
        return await saveRegulationDocumentVersion({
            documentId,
            userId,
            file,
            metadata,
            providedTitle: title,
            preloadedText
        });
    } catch (error) {
        await execute('DELETE FROM regulation_documents WHERE id = ?', [documentId]);
        throw error;
    }
}

async function updateRegulationDocument({ documentId, userId, patch = {} }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) return null;
    const doc = await getRegulationDocumentById(normalizedDocId, { includeArchived: true });
    if (!doc || doc.deleted_at) return null;
    const hasVersionLabel = Object.prototype.hasOwnProperty.call(patch, 'versionLabel')
        || Object.prototype.hasOwnProperty.call(patch, 'version_label');
    const nextVersionLabel = hasVersionLabel
        ? normalizeRegulationField(patch.versionLabel ?? patch.version_label ?? '', 80)
        : '';
    const next = {
        title: normalizeRegulationField(patch.title ?? doc.title, 120) || doc.title,
        category: normalizeRegulationField(patch.category ?? doc.category, 120),
        legal_level: normalizeRegulationField(patch.legalLevel ?? patch.legal_level ?? doc.legal_level, 80),
        issuing_body: normalizeRegulationIssuingBodies(patch.issuingBody ?? patch.issuing_body ?? doc.issuing_body),
        jurisdiction: normalizeRegulationField(patch.jurisdiction ?? doc.jurisdiction, 120),
        official_source_url: normalizeRegulationField(patch.officialSourceUrl ?? patch.official_source_url ?? doc.official_source_url, 1000),
        subject_tags: normalizeRegulationTags(patch.subjectTags ?? patch.subject_tags ?? doc.subject_tags),
        summary: normalizeRegulationSummary(patch.summary ?? doc.summary),
        status: normalizeRegulationStatus(patch.status ?? doc.status),
        metadata_review_status: normalizeRegulationReviewStatus(patch.metadataReviewStatus ?? patch.metadata_review_status ?? doc.metadata_review_status, 'unreviewed')
    };
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE regulation_documents
        SET title = ?,
            category = ?,
            legal_level = ?,
            issuing_body = ?,
            jurisdiction = ?,
            official_source_url = ?,
            subject_tags = ?::jsonb,
            summary = ?,
            status = ?,
            metadata_review_status = ?,
            metadata_reviewed_by_user = CASE WHEN ? = 'approved' THEN ? ELSE metadata_reviewed_by_user END,
            metadata_reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE metadata_reviewed_at END,
            updated_by_user = ?,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
    `, [
        next.title,
        next.category,
        next.legal_level,
        next.issuing_body,
        next.jurisdiction,
        next.official_source_url,
        JSON.stringify(next.subject_tags),
        next.summary,
        next.status,
        next.metadata_review_status,
        next.metadata_review_status,
        userId || 0,
        next.metadata_review_status,
        now,
        userId || 0,
        now,
        normalizedDocId
    ]);
    if (hasVersionLabel && doc.current_version_id) {
        await execute('UPDATE regulation_versions SET version_label = ?, updated_at = ? WHERE id = ?', [nextVersionLabel, now, doc.current_version_id]);
    }
    return await getRegulationDocumentById(normalizedDocId, { includeArchived: true });
}

async function updateRegulationVersionGovernance({ documentId, versionId, userId, patch = {} }) {
    const normalizedDocumentId = normalizeRegulationId(documentId);
    const normalizedVersionId = normalizeRegulationId(versionId);
    if (!normalizedDocumentId || !normalizedVersionId) return null;
    const doc = await getRegulationDocumentById(normalizedDocumentId, { includeArchived: true });
    if (!doc || doc.deleted_at) return null;
    const version = await queryOne('SELECT * FROM regulation_versions WHERE id = ? AND document_id = ?', [normalizedVersionId, normalizedDocumentId]);
    if (!version) return null;
    const effectiveFrom = normalizeRegulationDateValue(patch.effectiveFrom ?? patch.effective_from ?? version.effective_from) || null;
    const effectiveTo = normalizeRegulationDateValue(patch.effectiveTo ?? patch.effective_to ?? version.effective_to) || null;
    if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
        const error = new Error('失效日期不能早于生效日期');
        error.statusCode = 400;
        throw error;
    }
    const next = {
        version_label: normalizeRegulationField(patch.versionLabel ?? patch.version_label ?? version.version_label, 80),
        source_url: normalizeRegulationField(patch.sourceUrl ?? patch.source_url ?? version.source_url, 1000),
        published_at: normalizeRegulationDateValue(patch.publishedAt ?? patch.published_at ?? version.published_at) || null,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        effect_status: normalizeRegulationEffectStatus(patch.effectStatus ?? patch.effect_status ?? version.effect_status),
        review_status: normalizeRegulationReviewStatus(patch.reviewStatus ?? patch.review_status ?? version.review_status),
        embedding_profile: normalizeRegulationField(patch.embeddingProfile ?? patch.embedding_profile ?? version.embedding_profile, 120)
    };
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE regulation_versions
        SET version_label = ?, source_url = ?, published_at = ?, effective_from = ?, effective_to = ?,
            effect_status = ?, review_status = ?,
            reviewed_by_user = CASE WHEN ? = 'approved' THEN ? ELSE reviewed_by_user END,
            reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE reviewed_at END,
            embedding_profile = ?, updated_at = ?
        WHERE id = ? AND document_id = ?
    `, [
        next.version_label,
        next.source_url,
        next.published_at,
        next.effective_from,
        next.effective_to,
        next.effect_status,
        next.review_status,
        next.review_status,
        userId || 0,
        next.review_status,
        now,
        next.embedding_profile,
        now,
        normalizedVersionId,
        normalizedDocumentId
    ]);
    const updated = await getRegulationVersionById(normalizedVersionId);
    await notifyRegulationSubscribers({ document: doc, version: updated });
    return updated;
}

// #2 为条文生成向量（可选，失败不阻断）
// 复用知识库同一处向量模型配置（getEmbeddingConfig）；与知识库一致按小批发送，
// 避免把整部法律的条文一次性塞进单个请求导致向量服务返回 400。
const REGULATION_EMBED_BATCH_SIZE = 5;
const REGULATION_EMBED_MAX_CHARS = 2000;
const REGULATION_INDEX_MAX_ATTEMPTS = 5;

function isRegulationEmbeddingErrorRetryable(error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    // 配置、凭据、参数或网络安全策略问题不会自行恢复，避免每次启动都无效请求。
    return !/(未配置|api.?key|密钥|出站 url|forbidden|unauthori[sz]ed|\b(?:400|401|403)\b|invalid|参数)/i.test(`${code} ${message}`);
}

function getRegulationIndexRetryDelayMs(attempts) {
    const safeAttempts = Math.max(Number.parseInt(attempts, 10) || 1, 1);
    return Math.min(60 * 60 * 1000, Math.pow(2, safeAttempts - 1) * 60 * 1000);
}

function getRegulationIndexRetryAt(attempts, now = new Date()) {
    return getBeijingTimestamp(new Date(now.getTime() + getRegulationIndexRetryDelayMs(attempts)));
}

async function beginRegulationEmbeddingAttempt(versionId) {
    if (!versionId) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        UPDATE regulation_versions
        SET index_status = 'indexing', index_attempts = COALESCE(index_attempts, 0) + 1,
            index_last_attempt_at = ?, index_next_retry_at = NULL, updated_at = ?
        WHERE id = ?
        RETURNING index_attempts, index_max_attempts
    `, [now, now, versionId]);
}

async function embedRegulationArticles(articles, { userId = 0, source = 'regulations_import', versionId = null, embeddingProfile = '' } = {}) {
    if (!Array.isArray(articles) || !articles.length) return;
    // 仅对有 id、有正文的条文生成向量；单条截断以规避向量模型的最大 token 限制
    const targets = articles
        .filter(a => a && a.id && String(a.content || '').trim())
        .map(a => ({ id: a.id, text: String(a.content).trim().slice(0, REGULATION_EMBED_MAX_CHARS) }));
    if (!targets.length) {
        if (versionId) {
            await execute("UPDATE regulation_versions SET index_status = 'lexical_ready', index_error = '没有可用于向量索引的条文正文，已保留关键词检索。', index_next_retry_at = NULL, updated_at = ? WHERE id = ?", [getBeijingTimestamp(), versionId]);
        }
        return;
    }
    const indexAttempt = await beginRegulationEmbeddingAttempt(versionId);
    for (let i = 0; i < targets.length; i += REGULATION_EMBED_BATCH_SIZE) {
        const batch = targets.slice(i, i + REGULATION_EMBED_BATCH_SIZE);
        try {
            const vectors = await generateEmbeddings(batch.map(t => t.text), null, null, userId, { source, timeoutMs: 30000 });
            for (let idx = 0; idx < batch.length; idx++) {
                if (Array.isArray(vectors?.[idx])) {
                    await execute('UPDATE regulation_articles SET embedding = ?, embedding_profile = ? WHERE id = ?', [JSON.stringify(vectors[idx]), embeddingProfile, batch[idx].id]);
                }
            }
        } catch (err) {
            // 向量生成失败不阻断导入。仅临时服务故障按退避策略重试；配置类错误直接
            // 降级为关键词检索，避免应用每次重启后持续解析、持续请求失败服务。
            if (versionId) {
                const attempts = Number(indexAttempt?.index_attempts || 1);
                const maxAttempts = Math.max(Number(indexAttempt?.index_max_attempts || REGULATION_INDEX_MAX_ATTEMPTS), 1);
                const retryable = isRegulationEmbeddingErrorRetryable(err) && attempts < maxAttempts;
                const nextRetryAt = retryable ? getRegulationIndexRetryAt(attempts) : null;
                const status = retryable ? 'retry_wait' : 'lexical_ready';
                const reason = String(err.message || '向量生成失败').slice(0, 900);
                const suffix = retryable
                    ? `（将在 ${nextRetryAt} 重试，第 ${attempts}/${maxAttempts} 次）`
                    : `（已降级为关键词检索；${attempts >= maxAttempts ? '已达到自动重试上限，请人工重建索引。' : '请修复向量配置后人工重建索引。'}）`;
                await execute("UPDATE regulation_versions SET index_status = ?, index_error = ?, index_next_retry_at = ?, updated_at = ? WHERE id = ?", [status, `${reason}${suffix}`.slice(0, 1000), nextRetryAt, getBeijingTimestamp(), versionId]);
            }
            console.warn('[regulations] 向量生成失败，降级为关键词检索:', err.message);
            return;
        }
    }
    if (versionId) {
        await execute("UPDATE regulation_versions SET index_status = 'vector_ready', index_error = '', index_next_retry_at = NULL, updated_at = ? WHERE id = ?", [getBeijingTimestamp(), versionId]);
    }
}

async function recoverRegulationArticleEmbeddings({ limit = 20 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
    const versions = await query(`
        SELECT v.id, v.document_id, v.uploaded_by_user, v.embedding_profile, v.index_attempts, v.index_max_attempts
        FROM regulation_versions v
        JOIN regulation_documents d ON d.id = v.document_id
        WHERE d.deleted_at IS NULL AND d.status <> 'archived'
          AND (v.index_status = 'indexing'
            OR (v.index_status = 'retry_wait' AND (v.index_next_retry_at IS NULL OR v.index_next_retry_at <= (NOW() AT TIME ZONE 'Asia/Shanghai'))))
          AND COALESCE(v.index_attempts, 0) < COALESCE(NULLIF(v.index_max_attempts, 0), ${REGULATION_INDEX_MAX_ATTEMPTS})
        ORDER BY v.updated_at ASC, v.id ASC
        LIMIT ?
    `, [safeLimit]);
    let recovered = 0;
    for (const version of versions) {
        const articles = await query('SELECT id, content FROM regulation_articles WHERE version_id = ? ORDER BY sort_order, id', [version.id]);
        await embedRegulationArticles(articles, {
            userId: Number(version.uploaded_by_user || 0),
            source: 'regulations_recovery',
            versionId: version.id,
            embeddingProfile: normalizeRegulationField(version.embedding_profile || getEmbeddingProfile(getEmbeddingConfig(version.uploaded_by_user)), 120)
        });
        recovered += 1;
    }
    return { scanned: versions.length, recovered };
}

async function requestRegulationVersionReindex({ documentId, versionId, userId: _userId }) {
    const documentIdValue = normalizeRegulationId(documentId);
    const versionIdValue = normalizeRegulationId(versionId);
    if (!documentIdValue || !versionIdValue) return null;
    const document = await getRegulationDocumentById(documentIdValue, { includeArchived: true });
    if (!document || document.deleted_at) return null;
    const now = getBeijingTimestamp();
    const changed = await execute(`
        UPDATE regulation_versions
        SET index_status = 'retry_wait', index_error = '', index_attempts = 0,
            index_next_retry_at = ?, updated_at = ?
        WHERE id = ? AND document_id = ?
    `, [now, now, versionIdValue, documentIdValue]);
    if (!Number(changed || 0)) return null;
    return await getRegulationVersionById(versionIdValue);
}

function createRegulationIndexRecoveryRunner({ intervalMs = 60_000, logger = defaultLogger, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    let started = false;
    let timer = null;
    let running = false;
    async function tick() {
        if (running) return { skipped: true };
        running = true;
        try {
            return await recoverRegulationArticleEmbeddings({ limit: 20 });
        } catch (error) {
            logger.warn({ err: error.message }, '法规向量索引恢复巡检失败');
            return { error: error.message };
        } finally {
            running = false;
        }
    }
    async function start() {
        if (started) return { started, running };
        started = true;
        await tick();
        timer = setIntervalFn(() => { void tick(); }, Math.max(Number(intervalMs) || 60_000, 10_000));
        timer?.unref?.();
        return { started, running };
    }
    function stop() {
        started = false;
        if (timer) clearIntervalFn(timer);
        timer = null;
    }
    return { start, stop, tick, getRuntimeStatus: () => ({ started, running }) };
}

let regulationIndexRecoveryRunner = null;
async function startRegulationIndexRecoveryRunner() {
    if (!regulationIndexRecoveryRunner) regulationIndexRecoveryRunner = createRegulationIndexRecoveryRunner();
    return await regulationIndexRecoveryRunner.start();
}

async function triggerRegulationIndexRecovery() {
    if (!regulationIndexRecoveryRunner) regulationIndexRecoveryRunner = createRegulationIndexRecoveryRunner();
    return await regulationIndexRecoveryRunner.tick();
}

// #8 设置条文级状态（active/amended/repealed）与修订日期
async function setRegulationArticleStatus({ articleId, status, amendedDate = '' }) {
    const id = normalizeRegulationId(articleId);
    if (!id) return null;
    const safeStatus = ['active', 'amended', 'repealed'].includes(String(status)) ? status : 'active';
    const safeDate = normalizeRegulationDateValue(amendedDate) || normalizeRegulationField(amendedDate, 40);
    await execute('UPDATE regulation_articles SET status = ?, amended_date = ? WHERE id = ?', [safeStatus, safeStatus === 'active' ? '' : safeDate, id]);
    return await queryOne('SELECT id, status, amended_date FROM regulation_articles WHERE id = ?', [id]);
}

function deleteRegulationDocument({ documentId, userId }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) return Promise.resolve(false);
    return getRegulationDocumentById(normalizedDocId, { includeArchived: true }).then(async doc => {
        if (!doc || doc.deleted_at) return false;
        const now = getBeijingTimestamp();
        const changes = await execute(`
            UPDATE regulation_documents
            SET status = 'archived',
                deleted_at = ?,
                deleted_by_user = ?,
                updated_by_user = ?,
                updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
        `, [now, userId || 0, userId || 0, now, normalizedDocId]);
        return changes > 0;
    });
}

async function restoreRegulationDocument({ documentId, userId }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) return null;
    const now = getBeijingTimestamp();
    const changed = await execute(`
        UPDATE regulation_documents
        SET status = 'active', deleted_at = NULL, deleted_by_user = 0,
            updated_by_user = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NOT NULL
    `, [userId || 0, now, normalizedDocId]);
    if (!Number(changed || 0)) return null;
    return await getRegulationDocumentById(normalizedDocId, { includeArchived: true });
}

// 按文件 sha256 查已存在的同源文档，用于导入时的重复提醒（非阻断）
async function findRegulationDuplicateByHash(hash) {
    if (!hash) return null;
    const row = await queryOne(`
        SELECT v.document_id, d.title
        FROM regulation_versions v
        JOIN regulation_documents d ON d.id = v.document_id
        WHERE v.source_hash = ? AND d.deleted_at IS NULL
        ORDER BY v.id DESC
        LIMIT 1
    `, [hash]);
    return row ? { documentId: row.document_id, title: row.title } : null;
}

function resolveRegulationVersionDownloadPath(version) {
    if (!version?.source_path) return null;
    return resolveRegulationStoredPath(version.source_path);
}

module.exports = {
    createRegulationDocumentFromUpload,
    deleteRegulationDocument,
    embedRegulationArticles,
    createRegulationIndexRecoveryRunner,
    findRegulationDuplicateByHash,
    getRegulationIndexRetryDelayMs,
    isRegulationEmbeddingErrorRetryable,
    recoverRegulationArticleEmbeddings,
    requestRegulationVersionReindex,
    restoreRegulationDocument,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    startRegulationIndexRecoveryRunner,
    triggerRegulationIndexRecovery,
    setRegulationArticleStatus,
    updateRegulationDocument,
    updateRegulationVersionGovernance,
    normalizeReviewedArticles
};
