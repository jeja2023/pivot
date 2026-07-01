const {
    db,
    normalizeRegulationAlias,
    normalizeRegulationId
} = require('./shared');

const REGULATION_CITE_ARTICLE_RE = /第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?/g;
const REGULATION_CITE_BOOK_RE = /《([^》]{2,80})》(?:第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?)?/g;
// 引用动词 → 关系类型，用于在引用附近判断关系性质
const REGULATION_RELATION_HINTS = [
    { type: 'supersede', re: /(?:废止|替代|取代|修订)/ },
    { type: 'apply', re: /(?:适用于|适用|参照适用)/ },
    { type: 'depend', re: /(?:依据|根据|依照|按照|参照)/ }
];

function classifyCiteRelation(context) {
    for (const hint of REGULATION_RELATION_HINTS) {
        if (hint.re.test(context)) return hint.type;
    }
    return 'cite';
}

// 从已解析的条文中抽取条文间引用关系（条号引用对齐本库条文，书名号跨法引用仅存文本）
function extractRegulationLinks(articles, { documentId, versionId }) {
    const links = [];
    // 自身条号 → 临时序号映射（落库前 article 还没有真实 id，先记 sortOrder，落库时再换 id）
    const labelToOrder = new Map();
    articles.forEach(article => {
        const m = String(article.articleLabel || '').match(/^第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?/);
        if (m) {
            const key = `第${m[1]}条${m[2] ? `之${m[2]}` : ''}`;
            labelToOrder.set(key, article.sortOrder);
        }
    });

    articles.forEach(article => {
        const content = String(article.content || '');
        if (!content) return;
        const selfLabel = String(article.articleLabel || '');
        const seen = new Set();

        // 跨法引用（带书名号）
        REGULATION_CITE_BOOK_RE.lastIndex = 0;
        let bm;
        while ((bm = REGULATION_CITE_BOOK_RE.exec(content))) {
            const book = bm[1].trim();
            const artPart = bm[2] ? `第${bm[2]}条${bm[3] ? `之${bm[3]}` : ''}` : '';
            const targetLabel = artPart ? `《${book}》${artPart}` : `《${book}》`;
            const dedupeKey = `book:${targetLabel}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const ctx = content.slice(Math.max(0, bm.index - 12), bm.index + 12);
            links.push({
                sourceOrder: article.sortOrder,
                targetLabel,
                targetOrder: null,
                relationType: classifyCiteRelation(ctx),
                confidence: 0.6
            });
        }

        // 同文档内条号引用
        REGULATION_CITE_ARTICLE_RE.lastIndex = 0;
        let am;
        while ((am = REGULATION_CITE_ARTICLE_RE.exec(content))) {
            const label = `第${am[1]}条${am[2] ? `之${am[2]}` : ''}`;
            // 跳过引用自身、跳过紧跟在书名号后已计入的跨法引用
            if (label === selfLabel) continue;
            const before = content.slice(Math.max(0, am.index - 1), am.index);
            if (before === '》') continue; // 已由书名号分支处理
            const targetOrder = labelToOrder.get(label);
            if (!targetOrder) continue; // 引用了本库不存在的条号则忽略（避免噪声）
            const dedupeKey = `art:${label}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const ctx = content.slice(Math.max(0, am.index - 12), am.index + 12);
            links.push({
                sourceOrder: article.sortOrder,
                targetLabel: label,
                targetOrder,
                relationType: classifyCiteRelation(ctx),
                confidence: 0.75
            });
        }
    });

    return links.map(link => ({ ...link, documentId, versionId }));
}

// 解析「《XX法》第N条」中文条号为标准 article_label
function parseCrossLinkLabel(targetLabel) {
    const m = String(targetLabel || '').match(/^《([^》]{2,80})》(?:第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?)?/);
    if (!m) return null;
    return {
        bookName: m[1].trim(),
        articleLabel: m[2] ? `第${m[2]}条${m[3] ? `之${m[3]}` : ''}` : ''
    };
}

// 跨法引用回连：把指定版本中悬空的「《XX法》第N条」外链，匹配库内文档并对齐到目标条文 id
function resolveRegulationCrossLinks(versionId) {
    const vId = normalizeRegulationId(versionId);
    if (!vId) return { resolved: 0 };
    // 取该版本下尚未连上、且 target_label 带书名号的外链
    const pending = db.prepare(`
        SELECT id, target_label
        FROM regulation_article_links
        WHERE version_id = ? AND target_article_id IS NULL AND target_label LIKE '《%'
    `).all(vId);
    if (!pending.length) return { resolved: 0 };

    const updateLink = db.prepare(`
        UPDATE regulation_article_links
        SET target_document_id = ?, target_article_id = ?, confidence = ?
        WHERE id = ?
    `);
    let resolved = 0;
    pending.forEach(row => {
        const parsed = parseCrossLinkLabel(row.target_label);
        if (!parsed?.bookName) return;
        const norm = normalizeRegulationAlias(parsed.bookName);
        // 通过别名表匹配目标文档（在用、未归档）
        const aliasRow = db.prepare(`
            SELECT a.document_id
            FROM regulation_aliases a
            JOIN regulation_documents d ON d.id = a.document_id
            WHERE a.normalized_alias = ? AND d.deleted_at IS NULL
            ORDER BY a.is_primary DESC
            LIMIT 1
        `).get(norm);
        if (!aliasRow) return;
        const targetDocId = aliasRow.document_id;
        let targetArticleId = null;
        if (parsed.articleLabel) {
            // 在目标文档当前版本里按条号对齐
            const art = db.prepare(`
                SELECT a.id
                FROM regulation_articles a
                JOIN regulation_documents d ON d.id = a.document_id
                WHERE a.document_id = ? AND a.version_id = d.current_version_id AND a.article_label = ?
                LIMIT 1
            `).get(targetDocId, parsed.articleLabel);
            targetArticleId = art?.id || null;
        }
        updateLink.run(targetDocId, targetArticleId, targetArticleId ? 0.8 : 0.65, row.id);
        resolved += 1;
    });
    return { resolved };
}

// 重建：对全库（或指定文档）当前版本重新解析跨法引用回连
function rebuildRegulationCrossLinks(documentId = null) {
    const docId = normalizeRegulationId(documentId);
    const versions = docId
        ? db.prepare('SELECT current_version_id AS id FROM regulation_documents WHERE id = ? AND deleted_at IS NULL').all(docId)
        : db.prepare('SELECT current_version_id AS id FROM regulation_documents WHERE deleted_at IS NULL AND current_version_id IS NOT NULL').all();
    let total = 0;
    versions.forEach(v => {
        if (v.id) total += resolveRegulationCrossLinks(v.id).resolved;
    });
    return { resolved: total, versions: versions.length };
}

module.exports = {
    classifyCiteRelation,
    extractRegulationLinks,
    parseCrossLinkLabel,
    rebuildRegulationCrossLinks,
    resolveRegulationCrossLinks
};
