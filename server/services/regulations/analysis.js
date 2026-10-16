const {
    query,
    queryOne,
    normalizeRegulationId,
    normalizeRegulationSummary
} = require('./shared');
const {
    getRegulationDocumentById,
    listRegulationVersions
} = require('./catalog');
const { searchRegulationArticlesHybrid } = require('./search');
const { buildRegulationEvidenceExcerpt } = require('./evidence');
const { buildRegulationAiQueryPlan, normalizeArticleIds, regulationAiLimits } = require('./ai-planning');

function computeLineDiff(textA, textB) {
    const linesA = String(textA || '').split('\n');
    const linesB = String(textB || '').split('\n');
    const m = linesA.length;
    const n = linesB.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            dp[i][j] = linesA[i - 1] === linesB[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const segments = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
            segments.unshift({ type: 'eq', text: linesA[i - 1] });
            i -= 1;
            j -= 1;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            segments.unshift({ type: 'add', text: linesB[j - 1] });
            j -= 1;
        } else {
            segments.unshift({ type: 'del', text: linesA[i - 1] });
            i -= 1;
        }
    }
    return segments;
}

function groupArticlesByLabel(articles = []) {
    const groups = new Map();
    for (const article of articles) {
        const label = String(article?.article_label || '').trim() || `条目 ${article?.sort_order || article?.id || 0}`;
        const list = groups.get(label) || [];
        list.push(article);
        groups.set(label, list);
    }
    return groups;
}

async function diffRegulationVersions({ documentId, fromVersionId, toVersionId, includeArchived = false }) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) throw new Error('文档 ID 无效');
    const doc = await getRegulationDocumentById(docId, { includeArchived });
    if (!doc) throw new Error('文档不存在');
    const versions = await listRegulationVersions(docId);
    const fromVer = versions.find(v => Number(v.id) === Number(fromVersionId));
    const toVer = versions.find(v => Number(v.id) === Number(toVersionId));
    if (!fromVer || !toVer) throw new Error('版本不存在');

    const fromArticles = await query('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id', [docId, fromVer.id]);
    const toArticles = await query('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id', [docId, toVer.id]);

    const fromMap = groupArticlesByLabel(fromArticles);
    const toMap = groupArticlesByLabel(toArticles);
    const allLabels = new Set([...fromMap.keys(), ...toMap.keys()]);

    const added = [];
    const removed = [];
    const changed = [];

    allLabels.forEach(label => {
        const fromGroup = fromMap.get(label) || [];
        const toGroup = toMap.get(label) || [];
        const pairs = Math.max(fromGroup.length, toGroup.length);
        for (let index = 0; index < pairs; index += 1) {
            const a = fromGroup[index];
            const b = toGroup[index];
            if (!a && b) {
                added.push({ id: b.id, label: b.article_label, title: b.article_title, content: b.content });
            } else if (a && !b) {
                removed.push({ id: a.id, label: a.article_label, title: a.article_title, content: a.content });
            } else if (a && b && a.content !== b.content) {
                changed.push({
                    id: b.id,
                    label: b.article_label,
                    title: b.article_title,
                    before: a.content,
                    after: b.content,
                    segments: computeLineDiff(a.content, b.content)
                });
            }
        }
    });

    return {
        document: { id: doc.id, title: doc.title },
        from: { id: fromVer.id, version_label: fromVer.version_label, created_at: fromVer.created_at },
        to: { id: toVer.id, version_label: toVer.version_label, created_at: toVer.created_at },
        summary: { added: added.length, removed: removed.length, changed: changed.length },
        added,
        removed,
        changed
    };
}

// 关系类型 → 中文描述
const REGULATION_RELATION_LABELS = {
    cite: '引用',
    depend: '依据',
    apply: '适用',
    supersede: '废止/修订'
};

// 沿引用边扩展命中条文：把直接命中条文所引用、以及引用它们的关联条文补进候选
async function expandRegulationMatchesByLinks(matches, { limit = 4, includeArchived = false } = {}) {
    const baseIds = matches.map(m => Number(m.article_id)).filter(Boolean);
    if (!baseIds.length) return [];
    const seen = new Set(baseIds);
    const placeholders = baseIds.map(() => '?').join(',');
    // 双向：作为 source 引用出去的目标，以及作为 target 被其它条文引用的来源
    const linkRows = await query(`
        SELECT l.source_article_id, l.target_article_id, l.relation_type,
               l.target_version_id, l.binding_mode, l.review_status, l.confidence,
               sa.id AS sa_id, ta.id AS ta_id
        FROM regulation_article_links l
        LEFT JOIN regulation_articles sa ON sa.id = l.source_article_id
        LEFT JOIN regulation_articles ta ON ta.id = l.target_article_id
        WHERE (l.source_article_id IN (${placeholders}) OR l.target_article_id IN (${placeholders}))
          AND l.target_article_id IS NOT NULL
          AND l.version_id = sa.version_id
          AND COALESCE(l.review_status, 'auto') = 'approved'
          AND COALESCE(l.confidence, 0) >= 0.8
    `, [...baseIds, ...baseIds]);

    // 收集关联条文 id 及其与命中条文的关系说明
    const relatedInfo = new Map(); // articleId -> {relation}
    linkRows.forEach(row => {
        const rel = REGULATION_RELATION_LABELS[row.relation_type] || '关联';
        if (baseIds.includes(row.source_article_id) && row.target_article_id && !seen.has(row.target_article_id)) {
            relatedInfo.set(row.target_article_id, { relation: `本条${rel}`, confidence: Number(row.confidence) || 0 });
        }
        if (baseIds.includes(row.target_article_id) && row.source_article_id && !seen.has(row.source_article_id)) {
            relatedInfo.set(row.source_article_id, { relation: `被引用（${rel}）`, confidence: Number(row.confidence) || 0 });
        }
    });

    const relatedIds = [...relatedInfo.keys()].slice(0, Math.max(0, limit));
    if (!relatedIds.length) return [];
    const relPlaceholders = relatedIds.map(() => '?').join(',');
    const rows = await query(`
        SELECT
            d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
            d.jurisdiction, d.summary AS document_summary,
            v.id AS version_id, v.version_label, v.effective_from, v.effective_to, v.effect_status, v.review_status,
            a.id AS article_id, a.sort_order, a.article_label, a.article_title, a.heading_path, a.page_start, a.page_end, a.content,
            substr(replace(a.content, '\n', ' '), 1, 600) AS excerpt
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        JOIN regulation_versions v ON v.id = a.version_id
        WHERE a.id IN (${relPlaceholders}) AND a.version_id = d.current_version_id
          AND d.deleted_at IS NULL${includeArchived ? '' : " AND d.status <> 'archived'"}
    `, relatedIds);

    return rows.map(row => ({
        ...row,
        viaLink: true,
        relation: relatedInfo.get(row.article_id)?.relation || '已核验关联',
        relationConfidence: relatedInfo.get(row.article_id)?.confidence || 0
    }));
}

function mergeAiRetrievalCandidates(resultSets, selectedArticleIds = []) {
    const selected = new Set(selectedArticleIds.map(String));
    const combined = new Map();
    resultSets.forEach((rows, queryIndex) => {
        (Array.isArray(rows) ? rows : []).forEach((row, rank) => {
            const key = String(row?.article_id || '');
            if (!key) return;
            const existing = combined.get(key) || { ...row, aiRetrievalScore: 0, retrievalQueryIndexes: [] };
            existing.aiRetrievalScore += 1 / (20 + rank + 1) + (queryIndex === 0 ? 0.01 : 0);
            if (!existing.retrievalQueryIndexes.includes(queryIndex)) existing.retrievalQueryIndexes.push(queryIndex);
            if (selected.has(key)) existing.aiRetrievalScore += 1;
            combined.set(key, existing);
        });
    });
    return [...combined.values()]
        .sort((left, right) => right.aiRetrievalScore - left.aiRetrievalScore
            || Number(right.rankScore || right.rerankScore || right.hybridScore || 0) - Number(left.rankScore || left.rerankScore || left.hybridScore || 0)
            || Number(left.article_id) - Number(right.article_id));
}

function selectDiverseEvidenceCandidates(candidates, { limit = 10, selectedArticleIds = [] } = {}) {
    const selected = new Set(selectedArticleIds.map(String));
    const perDocument = new Map();
    const result = [];
    for (const candidate of candidates) {
        const id = String(candidate?.article_id || '');
        const documentId = String(candidate?.document_id || '');
        const count = perDocument.get(documentId) || 0;
        if (!selected.has(id) && count >= 3) continue;
        result.push(candidate);
        perDocument.set(documentId, count + 1);
        if (result.length >= limit) break;
    }
    return result;
}

async function getSelectedRegulationArticles(articleIds, { documentId = null, versionId = null, includeArchived = false } = {}) {
    const ids = normalizeArticleIds(articleIds);
    if (!ids.length) return [];
    const clauses = [`a.id IN (${ids.map(() => '?').join(',')})`, 'd.deleted_at IS NULL'];
    const params = [...ids];
    const docId = normalizeRegulationId(documentId);
    const version = normalizeRegulationId(versionId);
    if (!includeArchived) clauses.push("d.status <> 'archived'");
    if (docId) {
        clauses.push('d.id = ?');
        params.push(docId);
    }
    if (version) {
        clauses.push('a.version_id = ?');
        params.push(version);
    } else {
        clauses.push('a.version_id = d.current_version_id');
    }
    const rows = await query(`
        SELECT d.id AS document_id, d.title AS document_title, d.category, d.issuing_body, d.jurisdiction,
               d.summary AS document_summary, d.status AS document_status,
               v.id AS version_id, v.version_label, v.effective_from, v.effective_to, v.effect_status, v.review_status,
               a.id AS article_id, a.sort_order, a.article_label, a.article_title, a.heading_path, a.page_start, a.page_end, a.content,
               1 AS ai_selected
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        JOIN regulation_versions v ON v.id = a.version_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY a.sort_order ASC, a.id ASC
    `, params);
    const order = new Map(ids.map((id, index) => [String(id), index]));
    return rows.sort((left, right) => (order.get(String(left.article_id)) ?? 9999) - (order.get(String(right.article_id)) ?? 9999));
}

// #6 变更影响分析：找出两版本间变更的条文，再反查引用了这些条文的其它条文（被影响方）
async function analyzeRegulationChangeImpact({ documentId, fromVersionId, toVersionId, includeArchived = false }) {
    const diff = await diffRegulationVersions({ documentId, fromVersionId, toVersionId, includeArchived });
    // 变更 + 删除的条文标签（这些是可能影响引用方的）
    const impactedLabels = [...diff.changed.map(a => a.label), ...diff.removed.map(a => a.label)];
    if (!impactedLabels.length) {
        return { ...diff, impacts: [] };
    }
    // 在目标版本里找到这些标签对应的 article_id
    const toVerId = normalizeRegulationId(toVersionId);
    const docId = normalizeRegulationId(documentId);
    const impacts = [];
    for (const label of impactedLabels) {
        // 反查：哪些条文引用了「本文档的这个条号」（同文档内引用）
        const referers = await query(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            WHERE l.target_document_id = ? AND l.target_article_id IN (
                SELECT id FROM regulation_articles WHERE document_id = ? AND article_label = ?
            )
        `, [docId, docId, label]);
        // 跨文档：其它法律引用了本文档（通过 target_document_id 对齐）
        const crossReferers = await query(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title,
                   d.id AS document_id, d.title AS document_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            JOIN regulation_documents d ON d.id = sa.document_id
            WHERE l.target_document_id = ? AND d.id != ? AND d.deleted_at IS NULL
              AND l.target_label LIKE ?
        `, [docId, docId, `%${label}%`]);
        if (referers.length || crossReferers.length) {
            impacts.push({ label, internalReferers: referers, crossReferers });
        }
    }
    return { ...diff, impacts, impactVersionId: toVerId };
}

// #4 条文引用网络：聚合一篇文档当前版本（或指定版本）的条文节点与引用边
async function getRegulationCitationGraph(documentId, { versionId = null, includeArchived = false } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return { nodes: [], edges: [] };
    const doc = await getRegulationDocumentById(docId, { includeArchived });
    if (!doc) return { nodes: [], edges: [] };
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return { nodes: [], edges: [] };

    const articles = await query(`
        SELECT id, article_label, article_title, sort_order
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order, id
    `, [docId, vId]);
    const nodes = articles.map(a => ({
        id: a.id,
        label: a.article_label,
        title: a.article_title || '',
        sortOrder: a.sort_order
    }));
    const nodeIds = new Set(nodes.map(n => n.id));

    // 同文档内的引用边（两端都在本版本）
    const rawEdges = await query(`
        SELECT source_article_id AS source, target_article_id AS target, relation_type AS type,
               target_label, confidence
        FROM regulation_article_links
        WHERE version_id = ?
    `, [vId]);
    const edges = rawEdges.map(e => ({
        source: e.source,
        target: e.target,
        type: e.type || 'cite',
        targetLabel: e.target_label || '',
        confidence: e.confidence,
        // 标记跨法外链（target 不在本文档节点集合内）
        external: !e.target || !nodeIds.has(e.target)
    })).filter(e => nodeIds.has(e.source));

    return { document: { id: doc.id, title: doc.title }, nodes, edges };
}

// #5 查文档中被其它法律废止/修订的条文（supersede 关系指向本文档条文）
async function getRegulationSupersedeNotices(documentId, { versionId = null, includeArchived = false } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return [];
    const doc = await getRegulationDocumentById(docId, { includeArchived });
    if (!doc) return [];
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return [];
    // 其它文档里 relation_type=supersede 且 target 指向本文档当前版本条文
    return await query(`
        SELECT ta.id AS article_id, ta.article_label,
               sd.id AS source_document_id, sd.title AS source_document_title,
               sa.article_label AS source_article_label
        FROM regulation_article_links l
        JOIN regulation_articles ta ON ta.id = l.target_article_id
        JOIN regulation_articles sa ON sa.id = l.source_article_id
        JOIN regulation_documents sd ON sd.id = sa.document_id
        WHERE l.relation_type = 'supersede'
          AND ta.document_id = ? AND ta.version_id = ?
          AND sd.deleted_at IS NULL AND sd.id != ?
    `, [docId, vId, docId]);
}

async function buildRegulationAiContext({
    query: searchQuery,
    documentId = null,
    versionId = null,
    articleIds = [],
    restrictToSelected = false,
    category = '',
    issuingBody = '',
    jurisdiction = '',
    status = '',
    userId = 0,
    limit = 14,
    candidateLimit = 120,
    history = [],
    effectiveAt = '',
    expandLinks = true,
    relatedLimit = 5,
    includeArchived = false
} = {}) {
    const plan = buildRegulationAiQueryPlan({ question: searchQuery, history, effectiveAt });
    const aiLimits = regulationAiLimits();
    const selectedArticleIds = normalizeArticleIds(articleIds);
    let effectiveVersionId = normalizeRegulationId(versionId);
    if (!effectiveVersionId && documentId && plan.effectiveAt) {
        const effectiveVersion = await queryOne(`
            SELECT id
            FROM regulation_versions
            WHERE document_id = ?
              AND effective_from IS NOT NULL
              AND effective_from <= ?
              AND (effective_to IS NULL OR effective_to >= ?)
              AND COALESCE(effect_status, 'unverified') IN ('effective', 'unverified')
            ORDER BY effective_from DESC, id DESC
            LIMIT 1
        `, [normalizeRegulationId(documentId), plan.effectiveAt, plan.effectiveAt]);
        effectiveVersionId = normalizeRegulationId(effectiveVersion?.id);
    }
    const selectedRows = await getSelectedRegulationArticles(selectedArticleIds, { documentId, versionId: effectiveVersionId, includeArchived });
    const retrievalResults = restrictToSelected && selectedRows.length
        ? []
        : await Promise.allSettled(plan.retrievalQueries.map(queryText => searchRegulationArticlesHybrid({
            query: queryText,
            documentId,
            versionId: effectiveVersionId,
            category,
            issuingBody,
            jurisdiction,
            status,
            userId,
            limit: Math.min(Math.max(Number(candidateLimit) || 120, 20), 150),
            includeArchived
        })));
    const retrieved = retrievalResults
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    const candidates = mergeAiRetrievalCandidates([selectedRows, ...retrieved], selectedArticleIds);
    const matches = selectDiverseEvidenceCandidates(candidates, { limit: Math.min(Math.max(Number(limit) || aiLimits.evidenceLimit, 1), 20), selectedArticleIds });
    const related = expandLinks ? await expandRegulationMatchesByLinks(matches, { limit: Math.min(Math.max(Number(relatedLimit) || aiLimits.relatedLimit, 0), 8), includeArchived }) : [];
    const all = [...matches, ...related];

    const sources = all.map((match, index) => ({
        index: index + 1,
        documentId: match.document_id,
        versionId: match.version_id,
        articleId: match.article_id,
        label: `${match.document_title}${match.version_label ? ` / ${match.version_label}` : ''} / ${match.article_label}${match.article_title ? ` ${match.article_title}` : ''}`,
        headingPath: match.heading_path || '',
        pageStart: Number(match.page_start) || null,
        pageEnd: Number(match.page_end) || null,
        effectiveFrom: match.effective_from || '',
        effectiveTo: match.effective_to || '',
        effectStatus: match.effect_status || 'unverified',
        reviewStatus: match.review_status || 'pending',
        excerpt: normalizeRegulationSummary(buildRegulationEvidenceExcerpt(match.content || match.excerpt, plan.retrievalQueries, { maxLength: 800, before: 220 }).excerpt),
        contextExcerpt: normalizeRegulationSummary(buildRegulationEvidenceExcerpt(match.content || match.excerpt, plan.retrievalQueries, { maxLength: 2200, before: 620 }).excerpt),
        evidenceRange: buildRegulationEvidenceExcerpt(match.content || match.excerpt, plan.retrievalQueries, { maxLength: 2200, before: 620 }),
        source: match.document_title,
        viaLink: !!match.viaLink,
        relation: match.relation || '',
        retrieval: match.retrieval || (match.ai_selected ? 'selected' : 'hybrid'),
        selected: selectedArticleIds.includes(Number(match.article_id))
    }));

    // 上下文分两组：检索候选 / 经引用关联候选。候选不是已采纳的结论依据，
    // 最终回答仍须由法规问答的引用核验器确认。
    const directLines = sources.filter(s => !s.viaLink).map(s => `[${s.index}] ${s.label}\n定位：${s.headingPath || s.label}${s.pageStart ? `；来源页 ${s.pageStart}${s.pageEnd && s.pageEnd !== s.pageStart ? `-${s.pageEnd}` : ''}` : ''}\n效力：${s.effectStatus}；审核：${s.reviewStatus}\n证据：${s.contextExcerpt}`);
    const relatedLines = sources.filter(s => s.viaLink).map(s => `[${s.index}] ${s.label}（${s.relation}，已审核关联）\n定位：${s.headingPath || s.label}\n证据：${s.contextExcerpt}`);
    const parts = [];
    if (directLines.length) parts.push(`【直接检索候选】\n${directLines.join('\n\n')}`);
    if (relatedLines.length) parts.push(`【经引用关联的候选】\n${relatedLines.join('\n\n')}`);
    const context = `PIVOT_RAG_CONTEXT_BEGIN\n${parts.join('\n\n')}\nPIVOT_RAG_CONTEXT_END`;
    return {
        matches: all,
        sources,
        context,
        plan,
        diagnostics: {
            retrievalQueries: plan.retrievalQueries,
            retrievalQueryCount: plan.retrievalQueries.length,
            retrievedCandidateCount: candidates.length,
            selectedCandidateCount: selectedRows.length,
            directCandidateCount: sources.filter(source => !source.viaLink).length,
            relatedCandidateCount: sources.filter(source => source.viaLink).length,
            followUpResolved: plan.followUpResolved,
            effectiveAt: plan.effectiveAt || '',
            effectiveVersionId: effectiveVersionId || null
        }
    };
}

module.exports = {
    analyzeRegulationChangeImpact,
    buildRegulationAiContext,
    diffRegulationVersions,
    expandRegulationMatchesByLinks,
    getRegulationCitationGraph,
    getRegulationSupersedeNotices
};
