const {
    query,
    queryOne,
    execute,
    transaction,
    fs,
    path,
    clearDirSizeCache,
    generateEmbeddings,
    getBeijingTimestamp,
    getSafeRegulationExtension,
    normalizeRegulationDateValue,
    normalizeRegulationField,
    normalizeRegulationId,
    normalizeRegulationStatus,
    normalizeRegulationSummary,
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
    resolveRegulationCrossLinks
} = require('./links');
const {
    getRegulationDocumentById,
    getRegulationVersionById
} = require('./catalog');

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
    const sourceMeta = saveRegulationUploadedFile(file, normalizedDocId);
    const createdAt = getBeijingTimestamp();

    try {
        const extractedText = normalizeRegulationText(preloadedText) || await readRegulationTextFromPath(sourceMeta.absolutePath, file.originalname);
        const articles = parseRegulationArticles(extractedText, { docTitle: title });
        const articleCount = countActualRegulationArticles(articles);
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
                    source_hash, source_format, extracted_text, summary, article_count,
                    uploaded_by_user, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
            `, [
                normalizedDocId,
                versionLabel,
                normalizeUploadedOriginalName(file.originalname),
                sourceMeta.sourcePath,
                sourceMeta.sourceSize,
                sourceMeta.sourceHash,
                sourceFormat,
                extractedText,
                summary,
                articleCount,
                userId || 0,
                createdAt,
                createdAt
            ]);
            const vId = versionInfo?.id;
            const orderToArticleId = new Map();
            for (const article of articles) {
                const articleRow = await trx.queryOne(`
                    INSERT INTO regulation_articles (
                        document_id, version_id, sort_order, article_label,
                        article_title, content, search_content, heading_path, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id
                `, [
                    normalizedDocId,
                    vId,
                    article.sortOrder,
                    article.articleLabel,
                    article.articleTitle,
                    article.content,
                    article.searchContent,
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
                    if (!sourceId) continue;
                    const targetId = link.targetOrder ? orderToArticleId.get(link.targetOrder) || null : null;
                    await trx.execute(`
                        INSERT INTO regulation_article_links (
                            document_id, version_id, source_article_id, target_label,
                            target_article_id, target_document_id, relation_type, confidence, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        normalizedDocId,
                        vId,
                        sourceId,
                        link.targetLabel || '',
                        targetId,
                        targetId ? normalizedDocId : null,
                        link.relationType || 'cite',
                        link.confidence || 0.7,
                        createdAt
                    ]);
                }
            }
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
            await resolveRegulationCrossLinks(versionId);
        } catch (_err) {
            // 别名/跨法回连为增强能力，失败不阻断
        }
        // #2 异步生成条文向量（可选，失败降级为纯 BM25）
        setImmediate(async () => {
            try {
                const insertedArticles = await query('SELECT id, content FROM regulation_articles WHERE version_id = ? ORDER BY sort_order', [versionId]);
                await embedRegulationArticles(insertedArticles, { userId, source: 'regulations_import' });
            } catch (_err) {}
        });
        return {
            document: await getRegulationDocumentById(normalizedDocId, { includeArchived: true }),
            version: await getRegulationVersionById(versionId),
            articles,
            summary
        };
    } catch (error) {
        try { if (file.path && fs.existsSync(file.path)) fs.rmSync(file.path, { force: true }); } catch (_cleanupErr) {}
        try {
            const target = resolveRegulationStoredPath(sourceMeta.sourcePath);
            if (target && fs.existsSync(target)) {
                fs.rmSync(target, { force: true });
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
            title, category, issuing_body, jurisdiction,
            summary, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, deleted_at, deleted_by_user,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'active', NULL, 0, 0, ?, ?, NULL, 0, ?, ?)
        RETURNING id
    `, [
        title,
        normalizeRegulationField(metadata.category, 120),
        normalizeRegulationField(metadata.issuingBody || metadata.issuing_body, 120),
        normalizeRegulationField(metadata.jurisdiction, 120),
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
        issuing_body: normalizeRegulationField(patch.issuingBody ?? patch.issuing_body ?? doc.issuing_body, 120),
        jurisdiction: normalizeRegulationField(patch.jurisdiction ?? doc.jurisdiction, 120),
        summary: normalizeRegulationSummary(patch.summary ?? doc.summary),
        status: normalizeRegulationStatus(patch.status ?? doc.status)
    };
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE regulation_documents
        SET title = ?,
            category = ?,
            issuing_body = ?,
            jurisdiction = ?,
            summary = ?,
            status = ?,
            updated_by_user = ?,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
    `, [
        next.title,
        next.category,
        next.issuing_body,
        next.jurisdiction,
        next.summary,
        next.status,
        userId || 0,
        now,
        normalizedDocId
    ]);
    if (hasVersionLabel && doc.current_version_id) {
        await execute('UPDATE regulation_versions SET version_label = ?, updated_at = ? WHERE id = ?', [nextVersionLabel, now, doc.current_version_id]);
    }
    return await getRegulationDocumentById(normalizedDocId, { includeArchived: true });
}

// #2 为条文生成向量（可选，失败不阻断）
// 复用知识库同一处向量模型配置（getEmbeddingConfig）；与知识库一致按小批发送，
// 避免把整部法律的条文一次性塞进单个请求导致向量服务返回 400。
const REGULATION_EMBED_BATCH_SIZE = 5;
const REGULATION_EMBED_MAX_CHARS = 2000;
async function embedRegulationArticles(articles, { userId = 0, source = 'regulations_import' } = {}) {
    if (!Array.isArray(articles) || !articles.length) return;
    // 仅对有 id、有正文的条文生成向量；单条截断以规避向量模型的最大 token 限制
    const targets = articles
        .filter(a => a && a.id && String(a.content || '').trim())
        .map(a => ({ id: a.id, text: String(a.content).trim().slice(0, REGULATION_EMBED_MAX_CHARS) }));
    if (!targets.length) return;
    for (let i = 0; i < targets.length; i += REGULATION_EMBED_BATCH_SIZE) {
        const batch = targets.slice(i, i + REGULATION_EMBED_BATCH_SIZE);
        try {
            const vectors = await generateEmbeddings(batch.map(t => t.text), null, null, userId, { source, timeoutMs: 30000 });
            for (let idx = 0; idx < batch.length; idx++) {
                if (Array.isArray(vectors?.[idx])) {
                    await execute('UPDATE regulation_articles SET embedding = ? WHERE id = ?', [JSON.stringify(vectors[idx]), batch[idx].id]);
                }
            }
        } catch (err) {
            // 向量生成失败不阻断导入，降级为纯 BM25 检索；服务/配置类错误重试无意义，直接停止
            console.warn('[regulations] 向量生成失败，降级为 BM25 检索:', err.message);
            return;
        }
    }
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
    findRegulationDuplicateByHash,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    setRegulationArticleStatus,
    updateRegulationDocument
};
