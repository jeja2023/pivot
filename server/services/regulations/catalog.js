const {
    query,
    queryOne,
    normalizeRegulationField,
    normalizeRegulationId,
    normalizeRegulationStatus,
    normalizeSearchText
} = require('./shared');
const { countActualRegulationArticles } = require('./parser');

async function getRegulationSupersedeNotices(...args) {
    return await require('./analysis').getRegulationSupersedeNotices(...args);
}

async function getRegulationDocumentById(docId, { includeArchived = false } = {}) {
    const normalizedId = normalizeRegulationId(docId);
    if (!normalizedId) return null;
    const archivedFilter = includeArchived ? '' : ' AND deleted_at IS NULL';
    return await queryOne(`
        SELECT *
        FROM regulation_documents
        WHERE id = ?${archivedFilter}
    `, [normalizedId]);
}

async function getRegulationVersionById(versionId) {
    const normalizedId = normalizeRegulationId(versionId);
    if (!normalizedId) return null;
    const row = await queryOne('SELECT * FROM regulation_versions WHERE id = ?', [normalizedId]);
    if (!row) return null;
    const articleCount = await countRegulationArticlesByVersionId(row.id);
    return { ...row, article_count: articleCount };
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
        SELECT *
        FROM regulation_versions
        WHERE document_id = ?
        ORDER BY id DESC
    `, [normalizedId]);
    return await Promise.all(rows.map(async row => ({
        ...row,
        article_count: await countRegulationArticlesByVersionId(row.id),
        source_size: Number(row.source_size || 0)
    })));
}

async function listRegulationDocuments({
    query: searchQuery = '',
    category = '',
    jurisdiction = '',
    status = '',
    includeArchived = false,
    limit = 50,
    offset = 0
} = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const clauses = [];
    const params = [];

    if (!includeArchived) {
        clauses.push('d.deleted_at IS NULL');
    }
    if (status) {
        clauses.push('d.status = ?');
        params.push(normalizeRegulationStatus(status));
    }
    if (category) {
        clauses.push('LOWER(d.category) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(category, 255)}%`);
    }
    if (jurisdiction) {
        clauses.push('LOWER(d.jurisdiction) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(jurisdiction, 255)}%`);
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
        ${whereSql}
    `, params);
    const total = Number(totalRow?.count || 0);

    const data = await Promise.all(rows.map(async row => ({
        ...row,
        version_count: Number(row.version_count || 0),
        article_count: await countRegulationArticlesByVersionId(row.current_version_id),
        source_size: Number(row.current_source_size || 0)
    })));

    return {
        data,
        total,
        limit: safeLimit,
        offset: safeOffset
    };
}

// 返回库中已有的分类、适用范围去重候选，供前端下拉联想
async function listRegulationFacets({ includeArchived = false } = {}) {
    const archivedFilter = includeArchived ? '' : ' AND deleted_at IS NULL';
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
    return {
        categories: await pick('category'),
        jurisdictions: await pick('jurisdiction')
    };
}

async function getRegulationDocumentDetail(docId, { versionId = null, includeArchived = false } = {}) {
    const normalizedDocId = normalizeRegulationId(docId);
    if (!normalizedDocId) return null;
    const doc = await getRegulationDocumentById(normalizedDocId, { includeArchived });
    if (!doc) return null;

    const versions = await listRegulationVersions(normalizedDocId);
    if (versions.length === 0) {
        const articleCount = await countRegulationArticlesByVersionId(doc.current_version_id);
        return {
            document: {
                ...doc,
                current_version_label: '',
                article_count: articleCount
            },
            versions: [],
            currentVersion: null,
            articles: [],
            download: null
        };
    }

    const selectedVersionId = normalizeRegulationId(versionId) || doc.current_version_id || versions[0].id;
    const selectedVersion = versions.find(row => Number(row.id) === Number(selectedVersionId)) || versions[0];
    const rawArticles = await query(`
        SELECT *
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order ASC, id ASC
    `, [normalizedDocId, selectedVersion.id]);
    const articles = rawArticles.map(row => ({
        ...row,
        sort_order: Number(row.sort_order || 0)
    }));

    // #5 附加废止/修订提醒：标记被其它法律 supersede 的条文
    const supersedeNotices = await getRegulationSupersedeNotices(normalizedDocId, { versionId: selectedVersion.id });
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

    const currentDocArticleCount = await countRegulationArticlesByVersionId(doc.current_version_id);
    return {
        document: {
            ...doc,
            current_version_label: versions.find(version => Number(version.id) === Number(doc.current_version_id))?.version_label || '',
            article_count: currentDocArticleCount
        },
        versions: versions.map(version => ({
            ...version,
            is_current: Number(version.id) === Number(doc.current_version_id)
        })),
        currentVersion: selectedVersion,
        articles: articlesWithNotice,
        download: selectedVersion.source_path ? {
            fileName: selectedVersion.source_name,
            sourcePath: selectedVersion.source_path
        } : null
    };
}

module.exports = {
    countRegulationArticlesByVersionId,
    getRegulationDocumentById,
    getRegulationDocumentDetail,
    getRegulationVersionById,
    listRegulationDocuments,
    listRegulationFacets,
    listRegulationVersions
};
