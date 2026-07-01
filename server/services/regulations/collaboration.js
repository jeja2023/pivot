const {
    db,
    getBeijingTimestamp,
    normalizeRegulationField,
    normalizeRegulationId
} = require('./shared');

function createRegulationAnnotation({ articleId, userId, content }) {
    const aid = normalizeRegulationId(articleId);
    const uid = normalizeRegulationId(userId);
    if (!aid || !uid) return null;
    const safeContent = normalizeRegulationField(content, 5000);
    if (!safeContent) return null;
    const result = db.prepare('INSERT INTO regulation_article_annotations (article_id, user_id, content) VALUES (?, ?, ?)')
        .run(aid, uid, safeContent);
    return db.prepare('SELECT * FROM regulation_article_annotations WHERE id = ?').get(result.lastInsertRowid);
}

function listRegulationAnnotations({ articleId }) {
    const aid = normalizeRegulationId(articleId);
    if (!aid) return [];
    return db.prepare(`
        SELECT a.*, u.name as user_name, u.email as user_email
        FROM regulation_article_annotations a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.article_id = ?
        ORDER BY a.created_at DESC
    `).all(aid);
}

function updateRegulationAnnotation({ annotationId, userId, content }) {
    const id = normalizeRegulationId(annotationId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return null;
    const safeContent = normalizeRegulationField(content, 5000);
    if (!safeContent) return null;
    const existing = db.prepare('SELECT user_id FROM regulation_article_annotations WHERE id = ?').get(id);
    if (!existing || Number(existing.user_id) !== Number(uid)) return null; // 只能编辑自己的批注
    db.prepare('UPDATE regulation_article_annotations SET content = ?, updated_at = datetime(\'now\', \'+8 hours\') WHERE id = ?')
        .run(safeContent, id);
    return db.prepare('SELECT * FROM regulation_article_annotations WHERE id = ?').get(id);
}

function deleteRegulationAnnotation({ annotationId, userId }) {
    const id = normalizeRegulationId(annotationId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return false;
    const existing = db.prepare('SELECT user_id FROM regulation_article_annotations WHERE id = ?').get(id);
    if (!existing || Number(existing.user_id) !== Number(uid)) return false;
    db.prepare('DELETE FROM regulation_article_annotations WHERE id = ?').run(id);
    return true;
}

// #12 查阅审计：记录查阅/检索/下载/问答行为
function recordRegulationAccess({ userId, documentId = null, action, detail = '' }) {
    const uid = normalizeRegulationId(userId);
    if (!uid || !action) return;
    try {
        db.prepare('INSERT INTO regulation_access_logs (user_id, document_id, action, detail) VALUES (?, ?, ?, ?)')
            .run(uid, normalizeRegulationId(documentId), String(action).slice(0, 40), String(detail || '').slice(0, 500));
    } catch (_err) {
        // 审计失败不影响主流程
    }
}

function listRegulationAccessLogs({ documentId = null, userId = null, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    const did = normalizeRegulationId(documentId);
    const uid = normalizeRegulationId(userId);
    if (did) { clauses.push('l.document_id = ?'); params.push(did); }
    if (uid) { clauses.push('l.user_id = ?'); params.push(uid); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const rows = db.prepare(`
        SELECT l.*, u.name as user_name, d.title as document_title
        FROM regulation_access_logs l
        LEFT JOIN users u ON l.user_id = u.id
        LEFT JOIN regulation_documents d ON l.document_id = d.id
        ${where}
        ORDER BY l.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) as count FROM regulation_access_logs l ${where}`).get(...params).count;
    return { data: rows, total, limit: safeLimit, offset: safeOffset };
}

// #11 生成合规报告（Markdown）：把 AI 问答的问题、回答、依据条文、引用关系汇总
function buildRegulationQaReport({ question, answer, sources = [] }) {
    const lines = [];
    lines.push('# 法规查询合规报告');
    lines.push('');
    lines.push(`**生成时间**：${getBeijingTimestamp()}`);
    lines.push('');
    lines.push('## 咨询问题');
    lines.push('');
    lines.push(String(question || '').trim() || '（未提供问题）');
    lines.push('');
    lines.push('## AI 回答');
    lines.push('');
    lines.push(String(answer || '').trim() || '（无回答内容）');
    lines.push('');
    const direct = sources.filter(s => !s.viaLink);
    const related = sources.filter(s => s.viaLink);
    if (direct.length) {
        lines.push('## 依据法条（直接命中）');
        lines.push('');
        direct.forEach((s, i) => {
            lines.push(`${i + 1}. **${String(s.label || '相关条文').trim()}**`);
            if (s.excerpt) lines.push(`   > ${String(s.excerpt).trim()}`);
        });
        lines.push('');
    }
    if (related.length) {
        lines.push('## 关联法条（经引用关联）');
        lines.push('');
        related.forEach((s, i) => {
            lines.push(`${i + 1}. **${String(s.label || '相关条文').trim()}**${s.relation ? ` _(${s.relation})_` : ''}`);
            if (s.excerpt) lines.push(`   > ${String(s.excerpt).trim()}`);
        });
        lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('> 本报告由法规查询 AI 自动生成，仅供解释与检索辅助，不应替代正式法务意见。');
    return lines.join('\n');
}

module.exports = {
    buildRegulationQaReport,
    createRegulationAnnotation,
    deleteRegulationAnnotation,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    recordRegulationAccess,
    updateRegulationAnnotation
};
