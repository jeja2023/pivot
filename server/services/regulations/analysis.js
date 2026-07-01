const {
    db,
    normalizeRegulationId,
    normalizeRegulationSummary
} = require('./shared');
const {
    getRegulationDocumentById,
    listRegulationVersions
} = require('./catalog');
const { searchRegulationArticles } = require('./search');

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

function diffRegulationVersions({ documentId, fromVersionId, toVersionId }) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) throw new Error('文档 ID 无效');
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) throw new Error('文档不存在');
    const versions = listRegulationVersions(docId);
    const fromVer = versions.find(v => Number(v.id) === Number(fromVersionId));
    const toVer = versions.find(v => Number(v.id) === Number(toVersionId));
    if (!fromVer || !toVer) throw new Error('版本不存在');

    const fromArticles = db.prepare('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id').all(docId, fromVer.id);
    const toArticles = db.prepare('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id').all(docId, toVer.id);

    const fromMap = new Map(fromArticles.map(a => [a.article_label, a]));
    const toMap = new Map(toArticles.map(a => [a.article_label, a]));
    const allLabels = new Set([...fromMap.keys(), ...toMap.keys()]);

    const added = [];
    const removed = [];
    const changed = [];

    allLabels.forEach(label => {
        const a = fromMap.get(label);
        const b = toMap.get(label);
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
function expandRegulationMatchesByLinks(matches, { limit = 8 } = {}) {
    const baseIds = matches.map(m => Number(m.article_id)).filter(Boolean);
    if (!baseIds.length) return [];
    const seen = new Set(baseIds);
    const placeholders = baseIds.map(() => '?').join(',');
    // 双向：作为 source 引用出去的目标，以及作为 target 被其它条文引用的来源
    const linkRows = db.prepare(`
        SELECT l.source_article_id, l.target_article_id, l.relation_type,
               sa.id AS sa_id, ta.id AS ta_id
        FROM regulation_article_links l
        LEFT JOIN regulation_articles sa ON sa.id = l.source_article_id
        LEFT JOIN regulation_articles ta ON ta.id = l.target_article_id
        WHERE (l.source_article_id IN (${placeholders}) OR l.target_article_id IN (${placeholders}))
          AND l.target_article_id IS NOT NULL
    `).all(...baseIds, ...baseIds);

    // 收集关联条文 id 及其与命中条文的关系说明
    const relatedInfo = new Map(); // articleId -> {relation}
    linkRows.forEach(row => {
        const rel = REGULATION_RELATION_LABELS[row.relation_type] || '关联';
        if (baseIds.includes(row.source_article_id) && row.target_article_id && !seen.has(row.target_article_id)) {
            relatedInfo.set(row.target_article_id, { relation: `本条${rel}` });
        }
        if (baseIds.includes(row.target_article_id) && row.source_article_id && !seen.has(row.source_article_id)) {
            relatedInfo.set(row.source_article_id, { relation: `被引用（${rel}）` });
        }
    });

    const relatedIds = [...relatedInfo.keys()].slice(0, Math.max(0, limit));
    if (!relatedIds.length) return [];
    const relPlaceholders = relatedIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT
            d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
            d.jurisdiction, d.summary AS document_summary,
            v.id AS version_id, v.version_label,
            a.id AS article_id, a.sort_order, a.article_label, a.article_title, a.content,
            substr(replace(a.content, char(10), ' '), 1, 240) AS excerpt
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        JOIN regulation_versions v ON v.id = a.version_id
        WHERE a.id IN (${relPlaceholders}) AND d.deleted_at IS NULL
    `).all(...relatedIds);

    return rows.map(row => ({ ...row, viaLink: true, relation: relatedInfo.get(row.article_id)?.relation || '关联' }));
}

// #6 变更影响分析：找出两版本间变更的条文，再反查引用了这些条文的其它条文（被影响方）
function analyzeRegulationChangeImpact({ documentId, fromVersionId, toVersionId }) {
    const diff = diffRegulationVersions({ documentId, fromVersionId, toVersionId });
    // 变更 + 删除的条文标签（这些是可能影响引用方的）
    const impactedLabels = [...diff.changed.map(a => a.label), ...diff.removed.map(a => a.label)];
    if (!impactedLabels.length) {
        return { ...diff, impacts: [] };
    }
    // 在目标版本里找到这些标签对应的 article_id
    const toVerId = normalizeRegulationId(toVersionId);
    const docId = normalizeRegulationId(documentId);
    const impacts = [];
    impactedLabels.forEach(label => {
        // 反查：哪些条文引用了「本文档的这个条号」（同文档内引用）
        const referers = db.prepare(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            WHERE l.target_document_id = ? AND l.target_article_id IN (
                SELECT id FROM regulation_articles WHERE document_id = ? AND article_label = ?
            )
        `).all(docId, docId, label);
        // 跨文档：其它法律引用了本文档（通过 target_document_id 对齐）
        const crossReferers = db.prepare(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title,
                   d.id AS document_id, d.title AS document_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            JOIN regulation_documents d ON d.id = sa.document_id
            WHERE l.target_document_id = ? AND d.id != ? AND d.deleted_at IS NULL
              AND l.target_label LIKE ?
        `).all(docId, docId, `%${label}%`);
        if (referers.length || crossReferers.length) {
            impacts.push({ label, internalReferers: referers, crossReferers });
        }
    });
    return { ...diff, impacts, impactVersionId: toVerId };
}

// #4 条文引用网络：聚合一篇文档当前版本（或指定版本）的条文节点与引用边
function getRegulationCitationGraph(documentId, { versionId = null } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return { nodes: [], edges: [] };
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) return { nodes: [], edges: [] };
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return { nodes: [], edges: [] };

    const articles = db.prepare(`
        SELECT id, article_label, article_title, sort_order
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order, id
    `).all(docId, vId);
    const nodes = articles.map(a => ({
        id: a.id,
        label: a.article_label,
        title: a.article_title || '',
        sortOrder: a.sort_order
    }));
    const nodeIds = new Set(nodes.map(n => n.id));

    // 同文档内的引用边（两端都在本版本）
    const edges = db.prepare(`
        SELECT source_article_id AS source, target_article_id AS target, relation_type AS type,
               target_label, confidence
        FROM regulation_article_links
        WHERE version_id = ?
    `).all(vId).map(e => ({
        source: e.source,
        target: e.target,
        type: e.relation_type || 'cite',
        targetLabel: e.target_label || '',
        confidence: e.confidence,
        // 标记跨法外链（target 不在本文档节点集合内）
        external: !e.target || !nodeIds.has(e.target)
    })).filter(e => nodeIds.has(e.source));

    return { document: { id: doc.id, title: doc.title }, nodes, edges };
}

// #5 查文档中被其它法律废止/修订的条文（supersede 关系指向本文档条文）
function getRegulationSupersedeNotices(documentId, { versionId = null } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return [];
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) return [];
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return [];
    // 其它文档里 relation_type=supersede 且 target 指向本文档当前版本条文
    return db.prepare(`
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
    `).all(docId, vId, docId);
}

function buildRegulationAiContext({ query, documentId = null, limit = 12, expandLinks = true, relatedLimit = 8 } = {}) {
    const matches = searchRegulationArticles({ query, documentId, limit });
    const related = expandLinks ? expandRegulationMatchesByLinks(matches, { limit: relatedLimit }) : [];
    const all = [...matches, ...related];

    const sources = all.map((match, index) => ({
        index: index + 1,
        documentId: match.document_id,
        versionId: match.version_id,
        articleId: match.article_id,
        label: `${match.document_title}${match.version_label ? ` / ${match.version_label}` : ''} / ${match.article_label}${match.article_title ? ` ${match.article_title}` : ''}`,
        excerpt: normalizeRegulationSummary(match.excerpt || match.content),
        source: match.document_title,
        viaLink: !!match.viaLink,
        relation: match.relation || ''
    }));

    // 上下文分两组：直接命中 / 经引用关联，便于模型分辨主次
    const directLines = sources.filter(s => !s.viaLink).map(s => `[${s.index}] ${s.label}\n${s.excerpt}`);
    const relatedLines = sources.filter(s => s.viaLink).map(s => `[${s.index}] ${s.label}（${s.relation}）\n${s.excerpt}`);
    const parts = [];
    if (directLines.length) parts.push(`【直接命中条文】\n${directLines.join('\n\n')}`);
    if (relatedLines.length) parts.push(`【经引用关联的条文】\n${relatedLines.join('\n\n')}`);
    const context = parts.join('\n\n');
    return { matches: all, sources, context };
}

module.exports = {
    analyzeRegulationChangeImpact,
    buildRegulationAiContext,
    diffRegulationVersions,
    expandRegulationMatchesByLinks,
    getRegulationCitationGraph,
    getRegulationSupersedeNotices
};
