const {
    query,
    queryOne,
    execute,
    cosineSimilarity,
    generateEmbeddings,
    formatEmbeddingQuery,
    normalizeRegulationField,
    normalizeRegulationId,
    normalizeRegulationAlias,
    normalizeSearchText
} = require('./shared');
const { getSystemEmbeddingConfig, getEmbeddingProfile } = require('../rag-config');
const { rerankCandidates } = require('../rerank-client');

const MAX_REGULATION_SEARCH_RESULTS = 50;
const MAX_REGULATION_RETRIEVAL_CANDIDATES = 300;
const RECIPROCAL_RANK_K = 60;

function normalizeSearchLimit(value, fallback = 8, maximum = MAX_REGULATION_SEARCH_RESULTS) {
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), maximum);
}

function normalizeSearchStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ['active', 'archived'].includes(status) ? status : '';
}

function buildArticleFilters({ documentId = null, category = '', issuingBody = '', jurisdiction = '', status = '', includeArchived = false } = {}) {
    const filters = ['a.version_id = d.current_version_id', 'd.deleted_at IS NULL'];
    const params = [];
    const normalizedDocId = normalizeRegulationId(documentId);
    const normalizedCategory = normalizeRegulationField(category, 120);
    const normalizedIssuingBody = normalizeRegulationField(issuingBody, 120);
    const normalizedJurisdiction = normalizeRegulationField(jurisdiction, 120);
    const normalizedStatus = normalizeSearchStatus(status);
    if (!includeArchived) filters.push("d.status <> 'archived'");
    if (normalizedDocId) {
        filters.push('d.id = ?');
        params.push(normalizedDocId);
    }
    if (normalizedCategory) {
        filters.push('d.category ILIKE ?');
        params.push(`%${normalizedCategory}%`);
    }
    if (normalizedIssuingBody) {
        filters.push('d.issuing_body ILIKE ?');
        params.push(`%${normalizedIssuingBody}%`);
    }
    if (normalizedJurisdiction) {
        filters.push('d.jurisdiction ILIKE ?');
        params.push(`%${normalizedJurisdiction}%`);
    }
    if (normalizedStatus) {
        filters.push('d.status = ?');
        params.push(normalizedStatus);
    }
    return { filters, params };
}

function buildArticleSelect(scoreSql = '0 AS score') {
    return `
        d.id AS document_id,
        d.title AS document_title,
        d.category,
        d.issuing_body,
        d.jurisdiction,
        d.summary AS document_summary,
        d.status AS document_status,
        v.id AS version_id,
        v.version_label,
        a.id AS article_id,
        a.sort_order,
        a.article_label,
        a.article_title,
        a.content,
        ${scoreSql}
    `;
}

function buildRegulationSearchExcerpt(content, searchQuery = '', maxLength = 600) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const limit = Math.max(Number(maxLength) || 600, 80);
    if (text.length <= limit) return text;
    const terms = normalizeSearchText(searchQuery).split(/\s+/).map(term => term.trim()).filter(Boolean);
    const lowerText = text.toLocaleLowerCase();
    let matchIndex = -1;
    for (const term of terms) {
        const index = lowerText.indexOf(term.toLocaleLowerCase());
        if (index !== -1 && (matchIndex === -1 || index < matchIndex)) matchIndex = index;
    }
    if (matchIndex === -1) return `${text.slice(0, limit - 1)}…`;
    const start = Math.max(0, matchIndex - Math.floor(limit * 0.35));
    const end = Math.min(text.length, start + limit);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function formatSearchRows(rows, searchQuery, retrieval = 'keyword') {
    return (Array.isArray(rows) ? rows : []).map(row => ({
        ...row,
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
        vectorScore: Number.isFinite(Number(row.vectorScore ?? row.vector_score)) ? Number(row.vectorScore ?? row.vector_score) : null,
        excerpt: buildRegulationSearchExcerpt(row.content, searchQuery),
        retrieval
    }));
}

async function searchRegulationArticles({
    query: searchQuery,
    documentId = null,
    category = '',
    issuingBody = '',
    jurisdiction = '',
    status = '',
    limit = 8,
    includeArchived = false,
    candidateMode = false
} = {}) {
    const normalizedQuery = normalizeSearchText(searchQuery);
    const safeLimit = normalizeSearchLimit(limit, 8, candidateMode ? MAX_REGULATION_RETRIEVAL_CANDIDATES : MAX_REGULATION_SEARCH_RESULTS);
    const { filters, params } = buildArticleFilters({ documentId, category, issuingBody, jurisdiction, status, includeArchived });
    const whereBase = `WHERE ${filters.join(' AND ')}`;
    if (!normalizedQuery) {
        const rows = await query(`
            SELECT ${buildArticleSelect()}
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase}
            ORDER BY d.updated_at DESC, a.sort_order ASC, a.id ASC
            LIMIT ?
        `, [...params, safeLimit]);
        return formatSearchRows(rows, normalizedQuery, 'metadata');
    }

    const like = `%${normalizedQuery}%`;
    const normalizedAlias = normalizeRegulationAlias(normalizedQuery);
    const aliasLike = `%${normalizedAlias}%`;
    const relevanceSql = `GREATEST(
        similarity(COALESCE(d.title, ''), ?),
        similarity(COALESCE(d.summary, ''), ?),
        similarity(COALESCE(d.issuing_body, ''), ?),
        similarity(COALESCE(a.article_label, ''), ?),
        similarity(COALESCE(a.article_title, ''), ?),
        similarity(COALESCE(a.content, ''), ?)
    )`;
    const relevanceParams = Array(6).fill(normalizedQuery);
    const aliasMatchSql = normalizedAlias ? `
        OR EXISTS (
            SELECT 1 FROM regulation_aliases ra
            WHERE ra.document_id = d.id
              AND (ra.alias ILIKE ? OR ra.normalized_alias = ? OR ra.normalized_alias ILIKE ?)
        )` : '';
    const matchSql = `(
        d.title ILIKE ?
        OR d.summary ILIKE ?
        OR d.issuing_body ILIKE ?
        OR d.category ILIKE ?
        OR d.jurisdiction ILIKE ?
        OR a.article_label ILIKE ?
        OR a.article_title ILIKE ?
        OR a.content ILIKE ?
        ${aliasMatchSql}
    )`;
    const matchParams = [...Array(8).fill(like), ...(normalizedAlias ? [like, normalizedAlias, aliasLike] : [])];
    const titleOrAliasFirstSql = normalizedAlias ? `
        d.title ILIKE ? OR a.article_label ILIKE ? OR EXISTS (
            SELECT 1 FROM regulation_aliases ra
            WHERE ra.document_id = d.id AND (ra.normalized_alias = ? OR ra.normalized_alias ILIKE ?)
        )` : 'd.title ILIKE ? OR a.article_label ILIKE ?';
    const titleOrAliasFirstParams = normalizedAlias ? [like, like, normalizedAlias, aliasLike] : [like, like];
    try {
        const rows = await query(`
            SELECT ${buildArticleSelect(`${relevanceSql} AS score`)}
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase} AND ${matchSql}
            ORDER BY
                CASE WHEN ${titleOrAliasFirstSql} THEN 1 ELSE 0 END DESC,
                score DESC,
                d.updated_at DESC,
                a.sort_order ASC,
                a.id ASC
            LIMIT ?
        `, [...relevanceParams, ...params, ...matchParams, ...titleOrAliasFirstParams, safeLimit]);
        return formatSearchRows(rows, normalizedQuery);
    } catch (error) {
        console.warn('[regulations] 词法相关度排序不可用，回退基础检索:', error.message);
        const rows = await query(`
            SELECT ${buildArticleSelect('0 AS score')}
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase} AND ${matchSql}
            ORDER BY d.updated_at DESC, a.sort_order ASC, a.id ASC
            LIMIT ?
        `, [...params, ...matchParams, safeLimit]);
        return formatSearchRows(rows, normalizedQuery);
    }
}

async function searchRegulationArticlesByVector(queryVector, options = {}) {
    if (!Array.isArray(queryVector) || !queryVector.length) return [];
    const safeLimit = normalizeSearchLimit(options.limit, 48, MAX_REGULATION_RETRIEVAL_CANDIDATES);
    const { filters, params } = buildArticleFilters(options);
    const embeddingProfile = String(options.embeddingProfile || '').trim();
    if (!embeddingProfile) return [];
    try {
        const rows = await query(`
            SELECT ${buildArticleSelect('1 - (a.embedding::vector <=> ?::vector) AS vector_score')}
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            WHERE ${filters.join(' AND ')}
              AND a.embedding IS NOT NULL
              AND a.embedding_profile = ?
              AND vector_dims(a.embedding::vector) = ?
            ORDER BY a.embedding::vector <=> ?::vector ASC, a.id ASC
            LIMIT ?
        `, [JSON.stringify(queryVector), ...params, embeddingProfile, queryVector.length, JSON.stringify(queryVector), safeLimit]);
        return formatSearchRows(rows, options.query, 'semantic');
    } catch (error) {
        console.warn('[regulations] 语义召回不可用，保留词法检索结果:', error.message);
        return [];
    }
}

function mergeRegulationCandidates(lexical, semantic, limit) {
    const combined = new Map();
    lexical.forEach((item, index) => {
        const key = String(item.article_id);
        const record = combined.get(key) || { ...item, lexicalRank: null, vectorRank: null };
        record.lexicalRank = index + 1;
        record.score = Number(item.score) || 0;
        combined.set(key, record);
    });
    semantic.forEach((item, index) => {
        const key = String(item.article_id);
        const record = combined.get(key) || { ...item, lexicalRank: null, vectorRank: null };
        record.vectorRank = index + 1;
        record.vectorScore = Number(item.vectorScore) || 0;
        combined.set(key, record);
    });
    return [...combined.values()]
        .map(item => {
            const lexicalScore = item.lexicalRank ? 1 / (RECIPROCAL_RANK_K + item.lexicalRank) : 0;
            const semanticScore = item.vectorRank ? 1 / (RECIPROCAL_RANK_K + item.vectorRank) : 0;
            return {
                ...item,
                hybridScore: lexicalScore + semanticScore,
                retrieval: item.lexicalRank && item.vectorRank ? 'hybrid' : (item.lexicalRank ? 'keyword' : 'semantic')
            };
        })
        .sort((left, right) => (
            right.hybridScore - left.hybridScore
            || right.score - left.score
            || (right.vectorScore || 0) - (left.vectorScore || 0)
            || Number(left.article_id) - Number(right.article_id)
        ))
        .slice(0, limit);
}

async function rerankRegulationCandidates(query, candidates) {
    const result = await rerankCandidates(query, candidates, { source: 'regulations_search' });
    if (!result.applied) return result.candidates;
    return result.candidates.map(item => ({
        ...item,
        retrieval: `${item.retrieval || 'hybrid'}_reranked`
    }));
}

// 混合检索采用“词法、向量独立召回 + 倒数排名融合”。词法命中没有向量时仍会保留，
// 语义候选也不要求先通过词面包含匹配，避免长尾别名和同义提问全部落空。
async function searchRegulationArticlesHybrid({ query: searchQuery, documentId = null, category = '', issuingBody = '', jurisdiction = '', status = '', limit = 8, includeArchived = false } = {}) {
    const normalizedQuery = normalizeSearchText(searchQuery);
    const safeLimit = normalizeSearchLimit(limit);
    const sharedOptions = { query: normalizedQuery, documentId, category, issuingBody, jurisdiction, status, includeArchived };

    if (!normalizedQuery) {
        const lexical = await searchRegulationArticles({ ...sharedOptions, limit: safeLimit, candidateMode: false });
        return lexical.slice(0, safeLimit);
    }

    // 并行发起词法检索与查询向量生成；将向量超时严格限制在 4 秒内，
    // 避免远端向量服务异常或排队将整个请求拖延至看门狗超时。
    // 法规库是共享资料：不使用搜索者的个人 Embedding 配置，确保查询向量与
    // 后台写入条文的系统向量 profile 永远一致。
    const embeddingConfig = getSystemEmbeddingConfig();
    const queryEmbeddingInput = formatEmbeddingQuery(normalizedQuery, embeddingConfig);
    const [lexicalResult, vectorResult] = await Promise.allSettled([
        searchRegulationArticles({ ...sharedOptions, limit: MAX_REGULATION_RETRIEVAL_CANDIDATES, candidateMode: true }),
        generateEmbeddings([queryEmbeddingInput], embeddingConfig.mode, embeddingConfig.http, null, { source: 'regulations_search', timeoutMs: 4000 })
    ]);

    const lexical = lexicalResult.status === 'fulfilled' && Array.isArray(lexicalResult.value) ? lexicalResult.value : [];
    if (lexicalResult.status === 'rejected') {
        console.warn('[regulations] 混合检索词法召回异常:', lexicalResult.reason?.message || lexicalResult.reason);
    }

    const queryVector = vectorResult.status === 'fulfilled' ? vectorResult.value?.[0] : null;
    if (vectorResult.status === 'rejected') {
        console.warn('[regulations] 混合检索向量生成不可用，回退词法检索:', vectorResult.reason?.message || vectorResult.reason);
    }

    if (!Array.isArray(queryVector) || !queryVector.length) {
        const ranked = await rerankRegulationCandidates(normalizedQuery, lexical);
        return ranked.slice(0, safeLimit).map(item => ({ ...item, retrieval: item.retrieval || 'keyword' }));
    }

    let semantic = [];
    try {
        semantic = await searchRegulationArticlesByVector(queryVector, {
            ...sharedOptions,
            embeddingProfile: getEmbeddingProfile(embeddingConfig),
            limit: MAX_REGULATION_RETRIEVAL_CANDIDATES
        });
    } catch (semanticError) {
        console.warn('[regulations] 混合检索向量召回失败，回退词法检索:', semanticError.message);
    }

    if (!semantic.length) {
        const ranked = await rerankRegulationCandidates(normalizedQuery, lexical);
        return ranked.slice(0, safeLimit).map(item => ({ ...item, retrieval: item.retrieval || 'keyword' }));
    }

    const rerankWindow = Math.min(MAX_REGULATION_RETRIEVAL_CANDIDATES, Math.max(safeLimit * 5, 30));
    const merged = mergeRegulationCandidates(lexical, semantic, rerankWindow);
    return (await rerankRegulationCandidates(normalizedQuery, merged)).slice(0, safeLimit);
}

// 相似条文推荐：优先使用 pgvector，在向量不可用时退回同分类或同发布机构。
async function findSimilarRegulationArticles({ articleId, limit = 5, includeArchived = false } = {}) {
    const aid = normalizeRegulationId(articleId);
    if (!aid) return [];
    const safeLimit = normalizeSearchLimit(limit, 5, 20);
    const statusFilter = includeArchived ? '' : " AND d.status <> 'archived'";
    const source = await queryOne(`
        SELECT a.embedding, a.embedding_profile, a.document_id, a.content
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        WHERE a.id = ? AND d.deleted_at IS NULL${statusFilter}
    `, [aid]);
    if (!source) return [];
    let sourceVector;
    try {
        if (source.embedding && String(source.embedding).trim()) sourceVector = JSON.parse(source.embedding);
    } catch (_error) {
        sourceVector = null;
    }
    if (!Array.isArray(sourceVector) || !sourceVector.length) {
        const doc = await queryOne('SELECT category, issuing_body FROM regulation_documents WHERE id = ? AND deleted_at IS NULL', [source.document_id]);
        const clause = doc?.category ? 'AND d.category = ?' : (doc?.issuing_body ? 'AND d.issuing_body = ?' : '');
        const param = doc?.category || doc?.issuing_body || '';
        return await query(`
            SELECT d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
                   a.id AS article_id, a.article_label, a.article_title,
                   substr(replace(a.content, '\n', ' '), 1, 200) AS excerpt
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
            WHERE a.id != ? AND d.deleted_at IS NULL${statusFilter} ${clause}
            ORDER BY d.updated_at DESC, a.sort_order ASC
            LIMIT ?
        `, [aid, ...(param ? [param] : []), safeLimit]);
    }
    let candidates;
    try {
        candidates = await query(`
            SELECT a.id, a.document_id, a.article_label, a.article_title,
                   substr(replace(a.content, '\n', ' '), 1, 200) AS excerpt,
                   d.title AS document_title, d.category, d.issuing_body,
                   1 - (a.embedding::vector <=> ?::vector) AS similarity
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
            WHERE a.id != ? AND a.embedding IS NOT NULL
              AND a.embedding_profile = ?
              AND vector_dims(a.embedding::vector) = ? AND d.deleted_at IS NULL${statusFilter}
            ORDER BY a.embedding::vector <=> ?::vector ASC, a.id ASC
            LIMIT ?
        `, [JSON.stringify(sourceVector), aid, source.embedding_profile || '', sourceVector.length, JSON.stringify(sourceVector), Math.min(1000, Math.max(safeLimit * 20, 100))]);
    } catch (error) {
        console.warn('[regulations] 相似条文向量排序下推失败，回退应用层计算:', error.message);
        candidates = await query(`
            SELECT a.id, a.document_id, a.article_label, a.article_title, a.embedding,
                   substr(replace(a.content, '\n', ' '), 1, 200) AS excerpt,
                   d.title AS document_title, d.category, d.issuing_body
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
            WHERE a.id != ? AND a.embedding IS NOT NULL AND a.embedding_profile = ? AND d.deleted_at IS NULL${statusFilter}
            LIMIT 1000
        `, [aid, source.embedding_profile || '']);
    }
    const withScore = candidates.map(candidate => {
        if (Number.isFinite(Number(candidate.similarity))) {
            return { ...candidate, article_id: candidate.id, similarity: Number(candidate.similarity) };
        }
        try {
            return { ...candidate, article_id: candidate.id, similarity: cosineSimilarity(sourceVector, JSON.parse(candidate.embedding)) };
        } catch (_error) {
            return null;
        }
    }).filter(Boolean);
    withScore.sort((left, right) => (right.similarity || 0) - (left.similarity || 0));
    return withScore.slice(0, safeLimit);
}

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
    buildRegulationSearchExcerpt,
    createSavedSearch,
    deleteSavedSearch,
    findSimilarRegulationArticles,
    listSavedSearches,
    mergeRegulationCandidates,
    searchRegulationArticles,
    searchRegulationArticlesHybrid
};
