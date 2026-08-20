const {
    query,
    queryOne,
    execute,
    cosineSimilarity,
    generateEmbeddings,
    normalizeRegulationField,
    normalizeRegulationId,
    normalizeSearchText
} = require('./shared');

async function searchRegulationArticles({ query: searchQuery, documentId = null, limit = 8, includeArchived = false } = {}) {
    const normalizedQuery = normalizeSearchText(searchQuery);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 50);
    const normalizedDocId = normalizeRegulationId(documentId);
    const filters = ['a.version_id = d.current_version_id'];
    const params = [];
    if (!includeArchived) filters.push('d.deleted_at IS NULL');
    if (normalizedDocId) {
        filters.push('d.id = ?');
        params.push(normalizedDocId);
    }

    const whereBase = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    if (!normalizedQuery) {
        return await query(`
            SELECT
                d.id AS document_id,
                d.title AS document_title,
                d.category,
                d.issuing_body,
                d.jurisdiction,
                d.summary AS document_summary,
                v.id AS version_id,
                v.version_label,
                a.id AS article_id,
                a.sort_order,
                a.article_label,
                a.article_title,
                a.content,
                a.embedding,
                substr(replace(a.content, '\n', ' '), 1, 240) AS excerpt,
                0 AS score
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase}
            ORDER BY d.updated_at DESC, a.sort_order ASC
            LIMIT ?
        `, [...params, safeLimit]);
    }

    const like = `%${normalizedQuery}%`;
    return await query(`
        SELECT
            d.id AS document_id,
            d.title AS document_title,
            d.category,
            d.issuing_body,
            d.jurisdiction,
            d.summary AS document_summary,
            v.id AS version_id,
            v.version_label,
            a.id AS article_id,
            a.sort_order,
            a.article_label,
            a.article_title,
            a.content,
            a.embedding,
            substr(replace(a.content, '\n', ' '), 1, 240) AS excerpt,
            999 AS score
        FROM regulation_documents d
        JOIN regulation_versions v ON v.id = d.current_version_id
        JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
        ${whereBase}
          AND (
            LOWER(d.title) LIKE LOWER(?)
            OR LOWER(d.summary) LIKE LOWER(?)
            OR LOWER(a.article_label) LIKE LOWER(?)
            OR LOWER(a.article_title) LIKE LOWER(?)
            OR LOWER(a.content) LIKE LOWER(?)
          )
        ORDER BY d.updated_at DESC, a.sort_order ASC
        LIMIT ?
    `, [...params, like, like, like, like, like, safeLimit]);
}

// #2 混合检索（BM25 + 向量重排）：先用 BM25 召回候选，再用向量相似度重排
async function searchRegulationArticlesHybrid({ query: searchQuery, documentId = null, limit = 8, includeArchived = false, userId = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 50);
    let queryVector;
    try {
        // 尝试生成查询向量
        const vectors = await generateEmbeddings([String(searchQuery || '').trim()], null, null, userId, { source: 'regulations_search', timeoutMs: 10000 });
        queryVector = vectors[0];
    } catch (err) {
        // 向量生成失败，降级为纯 BM25
        console.warn('[regulations] 混合检索降级为 BM25:', err.message);
        return await searchRegulationArticles({ query: searchQuery, documentId, limit, includeArchived });
    }
    if (!queryVector || !Array.isArray(queryVector)) {
        return await searchRegulationArticles({ query: searchQuery, documentId, limit, includeArchived });
    }
    // BM25 召回候选（数量为 limit*6，保证重排后有足够结果）
    const candidateLimit = Math.min(safeLimit * 6, 300);
    const candidates = await searchRegulationArticles({ query: searchQuery, documentId, limit: candidateLimit, includeArchived });
    if (!candidates.length) return [];
    // 筛选有向量的候选，计算相似度并重排
    const withVector = candidates.filter(c => c.embedding && String(c.embedding).trim()).map(c => {
        try {
            const articleVector = JSON.parse(c.embedding);
            const similarity = cosineSimilarity(queryVector, articleVector);
            return { ...c, vectorScore: similarity };
        } catch (_err) {
            return null;
        }
    }).filter(Boolean);
    if (!withVector.length) {
        return candidates.slice(0, safeLimit);
    }
    // 混合打分：向量相似度占 70%，BM25 逆序分占 30%（score 越小 BM25 越好，归一化后取反）
    const maxBM25 = Math.max(...withVector.map(c => c.score || 999), 1);
    withVector.forEach(c => {
        const bm25Normalized = 1 - (c.score || 999) / maxBM25;
        c.hybridScore = (c.vectorScore || 0) * 0.7 + bm25Normalized * 0.3;
    });
    withVector.sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0));
    return withVector.slice(0, safeLimit);
}

// #14 相似条文推荐（基于向量近邻，降级为同分类/同颁布机构）
async function findSimilarRegulationArticles({ articleId, limit = 5 } = {}) {
    const aid = normalizeRegulationId(articleId);
    if (!aid) return [];
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 5, 1), 20);
    const source = await queryOne('SELECT embedding, document_id, content FROM regulation_articles WHERE id = ?', [aid]);
    if (!source) return [];
    let sourceVector;
    try {
        if (source.embedding && String(source.embedding).trim()) {
            sourceVector = JSON.parse(source.embedding);
        }
    } catch (_err) {
        // 源条文无向量或解析失败，降级为分类推荐
    }
    if (!sourceVector || !Array.isArray(sourceVector)) {
        // 降级：推荐同一文档的其它条文，或同分类/颁布机构的条文
        const doc = await queryOne('SELECT category, issuing_body FROM regulation_documents WHERE id = ?', [source.document_id]);
        const where = doc?.category ? 'AND d.category = ?' : (doc?.issuing_body ? 'AND d.issuing_body = ?' : '');
        const param = doc?.category || doc?.issuing_body || '';
        return await query(`
            SELECT d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
                   a.id AS article_id, a.article_label, a.article_title,
                   substr(replace(a.content, '\n', ' '), 1, 200) AS excerpt
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
            WHERE a.id != ? ${where} AND d.deleted_at IS NULL
            ORDER BY d.updated_at DESC
            LIMIT ?
        `, [aid, ...(param ? [param] : []), safeLimit]);
    }
    // 向量近邻：遍历所有有向量的条文，计算相似度，返回 top-k
    const candidates = await query(`
        SELECT a.id, a.document_id, a.article_label, a.article_title, a.embedding,
               substr(replace(a.content, '\n', ' '), 1, 200) AS excerpt,
               d.title AS document_title, d.category, d.issuing_body
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
        WHERE a.id != ? AND a.embedding IS NOT NULL AND d.deleted_at IS NULL
        LIMIT 1000
    `, [aid]);
    const withScore = candidates.map(c => {
        try {
            const vec = JSON.parse(c.embedding);
            const sim = cosineSimilarity(sourceVector, vec);
            return { ...c, similarity: sim, article_id: c.id };
        } catch (_err) {
            return null;
        }
    }).filter(Boolean);
    withScore.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return withScore.slice(0, safeLimit);
}

// #14 保存检索 CRUD
async function createSavedSearch({ userId, name, query: searchQuery = '', category = '', jurisdiction = '' }) {
    const uid = normalizeRegulationId(userId);
    if (!uid || !String(name || '').trim()) return null;
    return await queryOne(`
        INSERT INTO regulation_saved_searches (user_id, name, query, category, jurisdiction)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
    `, [
        uid,
        normalizeRegulationField(name, 100),
        normalizeRegulationField(searchQuery, 500),
        normalizeRegulationField(category, 50),
        normalizeRegulationField(jurisdiction, 50)
    ]);
}

async function listSavedSearches({ userId }) {
    const uid = normalizeRegulationId(userId);
    if (!uid) return [];
    return await query('SELECT * FROM regulation_saved_searches WHERE user_id = ? ORDER BY created_at DESC', [uid]);
}

async function deleteSavedSearch({ searchId, userId }) {
    const id = normalizeRegulationId(searchId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return false;
    const existing = await queryOne('SELECT user_id FROM regulation_saved_searches WHERE id = ?', [id]);
    if (!existing || Number(existing.user_id) !== Number(uid)) return false;
    await execute('DELETE FROM regulation_saved_searches WHERE id = ?', [id]);
    return true;
}

module.exports = {
    createSavedSearch,
    deleteSavedSearch,
    findSimilarRegulationArticles,
    listSavedSearches,
    searchRegulationArticles,
    searchRegulationArticlesHybrid
};
