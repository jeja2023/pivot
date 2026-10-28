const {
    query,
    queryOne,
    execute,
    normalizeRegulationField,
    normalizeRegulationDateValue,
    normalizeRegulationId,
    normalizeRegulationStatus,
    normalizeSearchText
} = require('./shared');
const { countActualRegulationArticles } = require('./parser');

async function getRegulationSupersedeNotices(...args) {
    return await require('./analysis').getRegulationSupersedeNotices(...args);
}

const REGULATION_VERSION_COLUMNS = `
    id, document_id, version_label, source_name, source_size, source_format,
    source_url, summary, article_count, published_at, effective_from, effective_to,
    effect_status, review_status, reviewed_by_user, reviewed_at, parse_status, index_status,
    index_error, index_attempts, index_max_attempts, index_next_retry_at, index_last_attempt_at,
    embedding_profile, uploaded_by_user, created_at, updated_at
`;

async function getRegulationDocumentById(docId, { includeArchived = false, includeDeleted = false } = {}) {
    const normalizedId = normalizeRegulationId(docId);
    if (!normalizedId) return null;
    const clauses = ['id = ?'];
    if (!includeDeleted) clauses.push('deleted_at IS NULL');
    if (!includeArchived) clauses.push("status <> 'archived'");
    return await queryOne(`
        SELECT *
        FROM regulation_documents
        WHERE ${clauses.join(' AND ')}
    `, [normalizedId]);
}

async function getRegulationVersionById(versionId) {
    const normalizedId = normalizeRegulationId(versionId);
    if (!normalizedId) return null;
    const row = await queryOne(`SELECT ${REGULATION_VERSION_COLUMNS} FROM regulation_versions WHERE id = ?`, [normalizedId]);
    if (!row) return null;
    return { ...row, article_count: Number(row.article_count || 0), source_size: Number(row.source_size || 0) };
}

async function getRegulationVersionStorageById(versionId, documentId = null) {
    const normalizedVersionId = normalizeRegulationId(versionId);
    const normalizedDocumentId = normalizeRegulationId(documentId);
    if (!normalizedVersionId) return null;
    const clauses = ['id = ?'];
    const params = [normalizedVersionId];
    if (normalizedDocumentId) {
        clauses.push('document_id = ?');
        params.push(normalizedDocumentId);
    }
    return await queryOne(`
        SELECT id, document_id, source_name, source_path
        FROM regulation_versions
        WHERE ${clauses.join(' AND ')}
    `, params);
}

async function findRegulationVersionEffectiveOn(documentId, effectiveAt) {
    const normalizedDocumentId = normalizeRegulationId(documentId);
    const date = normalizeRegulationDateValue(effectiveAt);
    if (!normalizedDocumentId || !date) return null;
    const row = await queryOne(`
        SELECT ${REGULATION_VERSION_COLUMNS}
        FROM regulation_versions
        WHERE document_id = ?
          AND effect_status = 'effective'
          AND COALESCE(review_status, 'pending') = 'approved'
          AND effective_from IS NOT NULL AND effective_from <= ?::date
          AND (effective_to IS NULL OR effective_to >= ?::date)
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
    `, [normalizedDocumentId, date, date]);
    return row ? { ...row, article_count: Number(row.article_count || 0), source_size: Number(row.source_size || 0) } : null;
}

async function countRegulationArticlesByVersionId(versionId) {
    const normalizedId = normalizeRegulationId(versionId);
    if (!normalizedId) return 0;
    const rows = await query(`
        SELECT article_label, heading_path
        FROM regulation_articles
        WHERE version_id = ?
        ORDER BY sort_order ASC, id ASC
    `, [normalizedId]);
    return countActualRegulationArticles(rows);
}

async function listRegulationVersions(docId) {
    const normalizedId = normalizeRegulationId(docId);
    if (!normalizedId) return [];
    const rows = await query(`
        SELECT ${REGULATION_VERSION_COLUMNS}
        FROM regulation_versions
        WHERE document_id = ?
        ORDER BY id DESC
    `, [normalizedId]);
    return rows.map(row => ({
        ...row,
        article_count: Number(row.article_count || 0),
        source_size: Number(row.source_size || 0)
    }));
}

async function listRegulationDocuments({
    query: searchQuery = '',
    category = '',
    issuingBody = '',
    jurisdiction = '',
    status = '',
    includeArchived = false,
    uncategorized = false,
    governancePending = false,
    governanceScope = '',
    limit = 50,
    offset = 0
} = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const clauses = [];
    const params = [];

    if (includeArchived) clauses.push('d.deleted_at IS NULL');
    else clauses.push("d.deleted_at IS NULL AND d.status <> 'archived'");
    if (status) {
        clauses.push('d.status = ?');
        params.push(normalizeRegulationStatus(status));
    }
    if (uncategorized) {
        clauses.push("COALESCE(TRIM(d.category), '') = ''");
    } else if (category) {
        clauses.push('LOWER(d.category) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(category, 255)}%`);
    }
    if (issuingBody) {
        clauses.push('LOWER(d.issuing_body) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(issuingBody, 255)}%`);
    }
    if (jurisdiction) {
        clauses.push('LOWER(d.jurisdiction) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(jurisdiction, 255)}%`);
    }
    const normalizedGovernanceScope = ['metadata', 'maintainer', 'version', 'index', 'location'].includes(String(governanceScope || '').trim())
        ? String(governanceScope).trim()
        : (governancePending ? 'version' : '');
    if (normalizedGovernanceScope === 'version') {
        // 当前版本缺失、效力尚未核验或审核未通过的法规都需要管理员治理。
        // 用 COALESCE 兼容历史版本的空审核状态，避免遗漏待处理记录。
        clauses.push("(v.id IS NULL OR v.effect_status = 'unverified' OR COALESCE(v.review_status, 'pending') <> 'approved')");
    }
    if (normalizedGovernanceScope === 'metadata') {
        clauses.push("(COALESCE(d.legal_level, '') = '' OR COALESCE(d.official_source_url, '') = '' OR COALESCE(d.metadata_review_status, 'unreviewed') <> 'approved')");
    }
    if (normalizedGovernanceScope === 'maintainer') clauses.push('d.maintainer_user_id IS NULL');
    if (normalizedGovernanceScope === 'index') clauses.push("(v.id IS NULL OR COALESCE(v.index_status, '') <> 'vector_ready')");
    if (normalizedGovernanceScope === 'location') {
        clauses.push(`EXISTS (
            SELECT 1 FROM regulation_articles location_article
            WHERE location_article.document_id = d.id
              AND location_article.version_id = d.current_version_id
              AND NOT EXISTS (
                  SELECT 1 FROM regulation_article_locations location_row
                  WHERE location_row.article_id = location_article.id
              )
        )`);
    }

    const normalizedQuery = normalizeSearchText(searchQuery);
    if (normalizedQuery) {
        const like = `%${normalizedQuery}%`;
        clauses.push(`(
            LOWER(d.title) LIKE LOWER(?)
            OR LOWER(d.category) LIKE LOWER(?)
            OR LOWER(d.issuing_body) LIKE LOWER(?)
            OR LOWER(d.jurisdiction) LIKE LOWER(?)
            OR LOWER(d.summary) LIKE LOWER(?)
        )`);
        params.push(like, like, like, like, like);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderSql = 'ORDER BY COALESCE(d.updated_at, d.created_at) DESC, d.id DESC';
    const rows = await query(`
        SELECT
            d.*,
            v.version_label AS current_version_label,
            v.source_name AS current_source_name,
            v.source_size AS current_source_size,
            v.effect_status AS current_effect_status,
            v.effective_from AS current_effective_from,
            v.effective_to AS current_effective_to,
            v.review_status AS current_review_status,
            v.index_status AS current_index_status,
            v.index_error AS current_index_error,
            v.created_at AS current_version_created_at,
            v.updated_at AS current_version_updated_at,
            (
                SELECT a.article_label
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_label,
            (
                SELECT a.article_title
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_title,
            (
                SELECT substr(replace(a.content, '\n', ' '), 1, 180)
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_excerpt
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, safeOffset]);

    const totalRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        ${whereSql}
    `, params);
    const total = Number(totalRow?.count || 0);

    const data = rows.map(row => ({
        ...row,
        version_count: Number(row.version_count || 0),
        article_count: Number(row.article_count || 0),
        source_size: Number(row.current_source_size || 0)
    }));

    return {
        data,
        total,
        limit: safeLimit,
        offset: safeOffset
    };
}

async function createRegulationCategory({ name = '', description = '', userId = 0 } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        const error = new Error('分类名称不能为空');
        error.statusCode = 400;
        throw error;
    }
    if (trimmed.length > 50) {
        const error = new Error('分类名称不能超过 50 个字符');
        error.statusCode = 400;
        throw error;
    }
    try {
        const existing = await queryOne('SELECT id FROM regulation_categories WHERE name = ?', [trimmed]);
        if (existing) {
            const error = new Error(`分类“${trimmed}”已存在`);
            error.statusCode = 409;
            throw error;
        }
        await execute(`
            INSERT INTO regulation_categories (name, description, created_by_user)
            VALUES (?, ?, ?)
        `, [trimmed, String(description || '').trim(), Number(userId) || 0]);
    } catch (e) {
        if (e.statusCode) throw e;
        if (e.code === '23505' || e.message?.includes('duplicate key') || e.message?.includes('UNIQUE')) {
            const error = new Error(`分类“${trimmed}”已存在`);
            error.statusCode = 409;
            throw error;
        }
        throw e;
    }
    return {
        category: {
            title: trimmed,
            category: trimmed,
            description: String(description || '').trim(),
            documentCount: 0,
            articleCount: 0,
            effectiveCount: 0,
            needsReviewCount: 0,
            isCustom: true
        }
    };
}

async function deleteRegulationCategory({ name = '' } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        const error = new Error('分类名称不能为空');
        error.statusCode = 400;
        throw error;
    }
    const doc = await queryOne('SELECT id, title FROM regulation_documents WHERE category = ? AND deleted_at IS NULL LIMIT 1', [trimmed]);
    if (doc) {
        const error = new Error(`分类“${trimmed}”下仍有法规文档（如《${doc.title}》），请先移除或修改文档分类后再删除`);
        error.statusCode = 409;
        throw error;
    }
    await execute('DELETE FROM regulation_categories WHERE name = ?', [trimmed]);
    return { success: true };
}

async function listRegulationCategoryFolders({ includeArchived = false } = {}) {
    const visibility = includeArchived ? 'd.deleted_at IS NULL' : "d.deleted_at IS NULL AND d.status <> 'archived'";
    const rows = await query(`
        SELECT
            COALESCE(NULLIF(TRIM(d.category), ''), '未分类') AS title,
            COALESCE(NULLIF(TRIM(d.category), ''), '') AS category,
            COUNT(*) AS document_count,
            COALESCE(SUM(d.article_count), 0) AS article_count,
            COUNT(*) FILTER (WHERE v.effect_status = 'effective' AND v.review_status = 'approved') AS effective_count,
            COUNT(*) FILTER (WHERE v.id IS NULL OR v.effect_status = 'unverified' OR COALESCE(v.review_status, 'pending') <> 'approved') AS needs_review_count,
            MAX(COALESCE(d.updated_at, d.created_at)) AS latest_updated_at
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        WHERE ${visibility}
        GROUP BY COALESCE(NULLIF(TRIM(d.category), ''), '未分类'), COALESCE(NULLIF(TRIM(d.category), ''), '')
        ORDER BY CASE WHEN COALESCE(NULLIF(TRIM(d.category), ''), '') = '' THEN 1 ELSE 0 END, title ASC
    `);

    let customCategories = [];
    try {
        customCategories = await query(`
            SELECT name, description, created_at, updated_at
            FROM regulation_categories
            ORDER BY sort_order ASC, name ASC
        `);
    } catch (_e) {
        // 兼容未建表或轻量测试环境
    }

    const folderMap = new Map();
    rows.forEach(row => {
        folderMap.set(row.category, {
            ...row,
            isUncategorized: !row.category,
            documentCount: Number(row.document_count || 0),
            articleCount: Number(row.article_count || 0),
            effectiveCount: Number(row.effective_count || 0),
            needsReviewCount: Number(row.needs_review_count || 0),
            isCustom: false
        });
    });

    customCategories.forEach(custom => {
        const catName = custom.name;
        if (folderMap.has(catName)) {
            const existing = folderMap.get(catName);
            existing.isCustom = true;
            existing.description = custom.description || '';
        } else {
            folderMap.set(catName, {
                title: catName,
                category: catName,
                description: custom.description || '',
                documentCount: 0,
                articleCount: 0,
                effectiveCount: 0,
                needsReviewCount: 0,
                latestUpdatedAt: custom.updated_at || custom.created_at || '',
                isUncategorized: false,
                isCustom: true
            });
        }
    });

    const result = Array.from(folderMap.values());
    result.sort((a, b) => {
        if (a.isUncategorized) return 1;
        if (b.isUncategorized) return -1;
        return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });
    return result;
}

async function listRegulationFolderDocumentSelection({ category = '', uncategorized = false, includeArchived = false, governanceScope = '', limit = 2000 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 2000, 1), 2000);
    const clauses = [includeArchived ? 'd.deleted_at IS NULL' : "d.deleted_at IS NULL AND d.status <> 'archived'"];
    const params = [];
    if (uncategorized) clauses.push("COALESCE(TRIM(d.category), '') = ''");
    else if (String(category || '').trim()) {
        clauses.push('d.category = ?');
        params.push(normalizeRegulationField(category, 255));
    }
    const normalizedGovernanceScope = ['metadata', 'maintainer', 'version', 'index', 'location'].includes(String(governanceScope || '').trim())
        ? String(governanceScope).trim()
        : '';
    if (normalizedGovernanceScope === 'version') {
        clauses.push("(v.id IS NULL OR v.effect_status = 'unverified' OR COALESCE(v.review_status, 'pending') <> 'approved')");
    }
    if (normalizedGovernanceScope === 'metadata') {
        clauses.push("(COALESCE(d.legal_level, '') = '' OR COALESCE(d.official_source_url, '') = '' OR COALESCE(d.metadata_review_status, 'unreviewed') <> 'approved')");
    }
    if (normalizedGovernanceScope === 'maintainer') clauses.push('d.maintainer_user_id IS NULL');
    if (normalizedGovernanceScope === 'index') clauses.push("(v.id IS NULL OR COALESCE(v.index_status, '') <> 'vector_ready')");
    if (normalizedGovernanceScope === 'location') {
        clauses.push(`EXISTS (
            SELECT 1 FROM regulation_articles location_article
            WHERE location_article.document_id = d.id
              AND location_article.version_id = d.current_version_id
              AND NOT EXISTS (
                  SELECT 1 FROM regulation_article_locations location_row
                  WHERE location_row.article_id = location_article.id
              )
        )`);
    }
    const rows = await query(`
        SELECT d.id, d.title
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY d.id ASC
        LIMIT ?
    `, [...params, safeLimit + 1]);
    const truncated = rows.length > safeLimit;
    const data = rows.slice(0, safeLimit).map(row => ({ id: Number(row.id), title: row.title || `文档 ${row.id}` }));
    return { data, total: data.length, truncated, limit: safeLimit };
}

async function listDeletedRegulationDocuments({ limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const total = await queryOne('SELECT COUNT(*) AS count FROM regulation_documents WHERE deleted_at IS NOT NULL');
    const data = await query(`
        SELECT d.id, d.title, d.category, d.issuing_body, d.jurisdiction, d.deleted_at, d.deleted_by_user,
               d.version_count, d.article_count, v.version_label AS current_version_label
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        WHERE d.deleted_at IS NOT NULL
        ORDER BY d.deleted_at DESC, d.id DESC
        LIMIT ? OFFSET ?
    `, [safeLimit, safeOffset]);
    return { data, total: Number(total?.count || 0), limit: safeLimit, offset: safeOffset };
}

// 返回库中已有的分类、适用范围去重候选，供前端下拉联想
async function listRegulationFacets({ includeArchived = false } = {}) {
    const archivedFilter = includeArchived ? ' AND deleted_at IS NULL' : " AND deleted_at IS NULL AND status <> 'archived'";
    const pick = async column => {
        const rows = await query(`
            SELECT DISTINCT ${column} AS value
            FROM regulation_documents
            WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''${archivedFilter}
            ORDER BY value ASC
            LIMIT 200
        `);
        return rows.map(row => row.value).filter(Boolean);
    };
    const categoriesFromDocs = await pick('category');
    let customCatNames = [];
    try {
        const customRows = await query('SELECT name FROM regulation_categories ORDER BY sort_order ASC, name ASC');
        customCatNames = customRows.map(r => r.name).filter(Boolean);
    } catch (_e) {}
    const allCategories = [...new Set([...categoriesFromDocs, ...customCatNames])].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return {
        categories: allCategories,
        legalLevels: await pick('legal_level'),
        issuingBodies: await pick('issuing_body'),
        jurisdictions: await pick('jurisdiction')
    };
}

async function getRegulationDocumentDetail(docId, { versionId = null, effectiveAt = '', includeArchived = false, includeDeleted = false, articleLimit = null, articleOffset = 0 } = {}) {
    const normalizedDocId = normalizeRegulationId(docId);
    if (!normalizedDocId) return null;
    const doc = await getRegulationDocumentById(normalizedDocId, { includeArchived, includeDeleted });
    if (!doc) return null;

    const versions = await listRegulationVersions(normalizedDocId);
    if (versions.length === 0) {
        return {
            document: {
                ...doc,
                current_version_label: '',
                article_count: Number(doc.article_count || 0)
            },
            versions: [],
            currentVersion: null,
            articles: [],
            download: null
        };
    }

    const requestedVersionId = normalizeRegulationId(versionId);
    const normalizedEffectiveAt = normalizeRegulationDateValue(effectiveAt);
    if (!requestedVersionId && effectiveAt && !normalizedEffectiveAt) return null;
    const effectiveVersion = !requestedVersionId && normalizedEffectiveAt
        ? await findRegulationVersionEffectiveOn(normalizedDocId, normalizedEffectiveAt)
        : null;
    if (!requestedVersionId && normalizedEffectiveAt && !effectiveVersion) return null;
    const selectedVersionId = requestedVersionId || effectiveVersion?.id || doc.current_version_id || versions[0].id;
    const selectedVersion = versions.find(row => Number(row.id) === Number(selectedVersionId));
    if (!selectedVersion) return null;
    const hasArticleLimit = Number.isSafeInteger(Number(articleLimit)) && Number(articleLimit) > 0;
    const safeArticleLimit = hasArticleLimit ? Math.min(Number(articleLimit), 500) : null;
    const safeArticleOffset = Math.max(Number.parseInt(articleOffset, 10) || 0, 0);
    const rawArticles = await query(`
        SELECT id, document_id, version_id, sort_order, article_label, article_title,
               content, heading_path, status, amended_date, created_at
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order ASC, id ASC
        ${hasArticleLimit ? 'LIMIT ? OFFSET ?' : ''}
    `, hasArticleLimit ? [normalizedDocId, selectedVersion.id, safeArticleLimit, safeArticleOffset] : [normalizedDocId, selectedVersion.id]);
    const articles = rawArticles.map(row => ({
        ...row,
        sort_order: Number(row.sort_order || 0)
    }));

    // #5 附加废止/修订提醒：标记被其它法律 supersede 的条文
    const supersedeNotices = await getRegulationSupersedeNotices(normalizedDocId, { versionId: selectedVersion.id, includeArchived });
    const supersedeByArticle = new Map();
    supersedeNotices.forEach(n => {
        if (!supersedeByArticle.has(n.article_id)) supersedeByArticle.set(n.article_id, []);
        supersedeByArticle.get(n.article_id).push({
            sourceDocumentId: n.source_document_id,
            sourceDocumentTitle: n.source_document_title,
            sourceArticleLabel: n.source_article_label
        });
    });
    // #10 附加批注数量
    const annotationCounts = new Map();
    if (articles.length) {
        const ids = articles.map(a => a.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = await query(`
            SELECT article_id, COUNT(*) as count
            FROM regulation_article_annotations
            WHERE article_id IN (${placeholders})
            GROUP BY article_id
        `, ids);
        rows.forEach(r => annotationCounts.set(Number(r.article_id), Number(r.count || 0)));
    }
    const articlesWithNotice = articles.map(a => ({
        ...a,
        supersededBy: supersedeByArticle.get(a.id) || [],
        annotationCount: annotationCounts.get(a.id) || 0
    }));

    return {
        document: {
            ...doc,
            current_version_label: versions.find(version => Number(version.id) === Number(doc.current_version_id))?.version_label || '',
            article_count: Number(doc.article_count || 0)
        },
        versions: versions.map(version => ({
            ...version,
            is_current: Number(version.id) === Number(doc.current_version_id)
        })),
        currentVersion: selectedVersion,
        articles: articlesWithNotice,
        ...(hasArticleLimit ? { articleLimit: safeArticleLimit, articleOffset: safeArticleOffset, articlesTruncated: articles.length === safeArticleLimit } : {}),
        download: selectedVersion.source_name ? { fileName: selectedVersion.source_name } : null
    };
}

async function getReadableRegulationArticle(articleId, { includeArchived = false } = {}) {
    const normalizedArticleId = normalizeRegulationId(articleId);
    if (!normalizedArticleId) return null;
    const statusFilter = includeArchived ? '' : " AND d.status <> 'archived'";
    return await queryOne(`
        SELECT a.id, a.document_id, a.version_id, a.article_label, a.article_title, a.content,
               d.title AS document_title, d.status AS document_status
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        WHERE a.id = ? AND d.deleted_at IS NULL${statusFilter}
    `, [normalizedArticleId]);
}

module.exports = {
    countRegulationArticlesByVersionId,
    createRegulationCategory,
    deleteRegulationCategory,
    getRegulationDocumentById,
    getRegulationDocumentDetail,
    getReadableRegulationArticle,
    getRegulationVersionById,
    getRegulationVersionStorageById,
    findRegulationVersionEffectiveOn,
    listRegulationCategoryFolders,
    listRegulationFolderDocumentSelection,
    listRegulationDocuments,
    listDeletedRegulationDocuments,
    listRegulationFacets,
    listRegulationVersions
};
