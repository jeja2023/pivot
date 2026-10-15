const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { normalizeRegulationField, normalizeRegulationId, normalizeRegulationReviewStatus } = require('./shared');

async function runSubscriberBatchQuery(trx, statement, params = []) {
    return await trx.query(statement, params);
}

async function runSubscriberBatchExecute(trx, statement, params = []) {
    return await trx.execute(statement, params);
}

function normalizeObligationStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ['draft', 'active', 'completed', 'archived'].includes(status) ? status : 'draft';
}

async function subscribeToRegulation({ userId, documentId, approvedOnly = true }) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    if (!uid || !did) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO regulation_subscriptions (user_id, document_id, status, approved_only, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?)
        ON CONFLICT (user_id, document_id) DO UPDATE
        SET status = 'active', approved_only = EXCLUDED.approved_only, updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [uid, did, approvedOnly !== false, now, now]);
}

async function unsubscribeFromRegulation({ userId, documentId }) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    if (!uid || !did) return false;
    const changed = await execute(`
        UPDATE regulation_subscriptions SET status = 'cancelled', updated_at = ?
        WHERE user_id = ? AND document_id = ? AND status = 'active'
    `, [getBeijingTimestamp(), uid, did]);
    return Number(changed || 0) > 0;
}

async function listRegulationSubscriptions({ userId, documentId = null, includeCancelled = false } = {}) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    if (!uid) return [];
    const clauses = ['s.user_id = ?'];
    const params = [uid];
    if (!includeCancelled) clauses.push("s.status = 'active'");
    if (did) {
        clauses.push('s.document_id = ?');
        params.push(did);
    }
    return await query(`
        SELECT s.*, d.title AS document_title, d.status AS document_status
        FROM regulation_subscriptions s
        JOIN regulation_documents d ON d.id = s.document_id
        WHERE ${clauses.join(' AND ')} AND d.deleted_at IS NULL
        ORDER BY s.updated_at DESC, s.id DESC
    `, params);
}

async function notifyRegulationSubscribers({ document, version }) {
    const documentId = normalizeRegulationId(document?.id || document?.document_id);
    const versionId = normalizeRegulationId(version?.id || version?.version_id);
    if (!documentId || !versionId || version?.effect_status !== 'effective' || version?.review_status !== 'approved') {
        return { notified: 0 };
    }
    const subscriptions = await query(`
        SELECT user_id
        FROM regulation_subscriptions
        WHERE document_id = ? AND status = 'active'
          AND (approved_only = FALSE OR ? = 'approved')
          AND (last_notified_version_id IS NULL OR last_notified_version_id <> ?)
    `, [documentId, version.review_status, versionId]);
    if (!subscriptions.length) return { notified: 0 };
    const now = getBeijingTimestamp();
    const title = String(document?.title || '法规').slice(0, 160);
    const label = String(version?.version_label || `版本 ${versionId}`).slice(0, 100);
    for (const subscription of subscriptions) {
        await execute(`
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            VALUES (?, NULL, 'regulation_update', ?, ?, 'unread', ?)
        `, [subscription.user_id, '关注法规已更新', `${title} 已发布审核通过的${label}。`, now]);
        await execute('UPDATE regulation_subscriptions SET last_notified_version_id = ?, updated_at = ? WHERE user_id = ? AND document_id = ?', [versionId, now, subscription.user_id, documentId]);
    }
    return { notified: subscriptions.length };
}

// 批量更新版本治理信息时，不能逐文档、逐订阅者发送 SQL；2,000 份法规会把一个
// 元数据请求放大为数千次往返。此处以集合 SQL 写入通知并更新订阅水位。
async function notifyRegulationSubscribersBulk({ candidates = [] } = {}) {
    const normalized = (Array.isArray(candidates) ? candidates : []).map(candidate => {
        const documentId = normalizeRegulationId(candidate?.document?.id || candidate?.document?.document_id);
        const versionId = normalizeRegulationId(candidate?.version?.id || candidate?.version?.version_id);
        const effective = candidate?.version?.effect_status === 'effective';
        const approved = candidate?.version?.review_status === 'approved';
        if (!documentId || !versionId || !effective || !approved) return null;
        return {
            documentId,
            versionId,
            title: String(candidate?.document?.title || '法规').slice(0, 160),
            versionLabel: String(candidate?.version?.version_label || `版本 ${versionId}`).slice(0, 100)
        };
    }).filter(Boolean);
    if (!normalized.length) return { notified: 0 };

    const now = getBeijingTimestamp();
    return await transaction(async trx => {
        const subscriptions = await runSubscriberBatchQuery(trx, `
            WITH candidates AS (
                SELECT *
                FROM jsonb_to_recordset(?::jsonb) AS item(document_id BIGINT, version_id BIGINT, title TEXT, version_label TEXT)
            )
            SELECT s.user_id, s.document_id, c.version_id, c.title, c.version_label
            FROM regulation_subscriptions s
            JOIN candidates c ON c.document_id = s.document_id
            WHERE s.status = 'active'
              AND (s.last_notified_version_id IS NULL OR s.last_notified_version_id <> c.version_id)
        `, [JSON.stringify(normalized.map(item => ({
            document_id: item.documentId,
            version_id: item.versionId,
            title: item.title,
            version_label: item.versionLabel
        })))]);
        if (!subscriptions.length) return { notified: 0 };
        await runSubscriberBatchExecute(trx, `
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            SELECT item.user_id, NULL, 'regulation_update', '关注法规已更新',
                   item.title || ' 已发布审核通过的' || item.version_label || '。', 'unread', ?
            FROM jsonb_to_recordset(?::jsonb) AS item(user_id BIGINT, document_id BIGINT, version_id BIGINT, title TEXT, version_label TEXT)
        `, [now, JSON.stringify(subscriptions)]);
        await runSubscriberBatchExecute(trx, `
            UPDATE regulation_subscriptions s
            SET last_notified_version_id = item.version_id, updated_at = ?
            FROM jsonb_to_recordset(?::jsonb) AS item(user_id BIGINT, document_id BIGINT, version_id BIGINT)
            WHERE s.user_id = item.user_id AND s.document_id = item.document_id
        `, [now, JSON.stringify(subscriptions.map(item => ({
            user_id: item.user_id,
            document_id: item.document_id,
            version_id: item.version_id
        })))]);
        return { notified: subscriptions.length };
    });
}

async function listRegulationQualitySummary() {
    const [documents, versions, links, locations, obligations] = await Promise.all([
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE COALESCE(legal_level, '') = '' OR COALESCE(official_source_url, '') = '' OR COALESCE(metadata_review_status, 'unreviewed') <> 'approved') AS metadata_needs_review,
                   COUNT(*) FILTER (WHERE COALESCE(legal_level, '') = '') AS missing_legal_level,
                   COUNT(*) FILTER (WHERE COALESCE(official_source_url, '') = '') AS missing_official_source_url,
                   COUNT(*) FILTER (WHERE COALESCE(metadata_review_status, 'unreviewed') <> 'approved') AS metadata_review_not_approved,
                   COUNT(*) FILTER (WHERE maintainer_user_id IS NULL) AS missing_maintainer
            FROM regulation_documents WHERE deleted_at IS NULL AND status <> 'archived'
        `),
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE v.id IS NULL OR v.effect_status = 'unverified' OR COALESCE(v.review_status, 'pending') <> 'approved') AS governance_needs_review,
                   COUNT(*) FILTER (WHERE v.id IS NULL OR COALESCE(v.index_status, '') <> 'vector_ready') AS indexing_incomplete,
                   COUNT(*) FILTER (WHERE v.id IS NULL OR COALESCE(v.parse_status, '') <> 'ready') AS parsing_incomplete
            FROM regulation_documents d
            LEFT JOIN regulation_versions v ON v.id = d.current_version_id
            WHERE d.deleted_at IS NULL AND d.status <> 'archived'
        `),
        queryOne(`
            SELECT COUNT(*) FILTER (
                       WHERE l.target_label LIKE '《%'
                         AND l.target_article_id IS NULL
                         AND COALESCE(l.review_status, 'auto') <> 'rejected'
                   ) AS unresolved,
                   COUNT(*) FILTER (
                       WHERE l.target_article_id IS NOT NULL
                         AND COALESCE(l.review_status, 'auto') NOT IN ('approved', 'rejected')
                   ) AS relation_needs_review
            FROM regulation_article_links l
            JOIN regulation_documents d ON d.id = l.document_id
            WHERE d.deleted_at IS NULL AND d.status <> 'archived' AND l.version_id = d.current_version_id
        `),
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT a.id) FILTER (WHERE l.id IS NULL) AS articles_without_location
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND d.deleted_at IS NULL AND d.status <> 'archived'
            LEFT JOIN regulation_article_locations l ON l.article_id = a.id
            WHERE a.version_id = d.current_version_id
        `),
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE review_status <> 'approved') AS needs_review
            FROM regulation_obligations
        `)
    ]);
    return {
        documents: {
            total: Number(documents?.total || 0),
            metadataNeedsReview: Number(documents?.metadata_needs_review || 0),
            missingLegalLevel: Number(documents?.missing_legal_level || 0),
            missingOfficialSourceUrl: Number(documents?.missing_official_source_url || 0),
            metadataReviewNotApproved: Number(documents?.metadata_review_not_approved || 0),
            missingMaintainer: Number(documents?.missing_maintainer || 0)
        },
        versions: {
            total: Number(versions?.total || 0),
            governanceNeedsReview: Number(versions?.governance_needs_review || 0),
            indexingIncomplete: Number(versions?.indexing_incomplete || 0),
            parsingIncomplete: Number(versions?.parsing_incomplete || 0)
        },
        links: {
            unresolved: Number(links?.unresolved || 0),
            needsReview: Number(links?.relation_needs_review || 0)
        },
        locations: {
            total: Number(locations?.total || 0),
            articlesWithoutLocation: Number(locations?.articles_without_location || 0)
        },
        obligations: {
            total: Number(obligations?.total || 0),
            needsReview: Number(obligations?.needs_review || 0)
        }
    };
}

async function createRegulationObligation({ userId, documentId, versionId, articleId, input = {} }) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    const vid = normalizeRegulationId(versionId);
    const aid = normalizeRegulationId(articleId);
    if (!uid || !did || !vid || !aid) return null;
    const action = normalizeRegulationField(input.requiredAction || input.required_action, 1000);
    if (!action) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO regulation_obligations (
            document_id, version_id, article_id, subject, trigger_condition, required_action,
            due_rule, evidence_requirement, owner_user_id, status, review_status, created_by_user, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
    `, [
        did, vid, aid,
        normalizeRegulationField(input.subject, 240),
        normalizeRegulationField(input.triggerCondition || input.trigger_condition, 1000),
        action,
        normalizeRegulationField(input.dueRule || input.due_rule, 500),
        normalizeRegulationField(input.evidenceRequirement || input.evidence_requirement, 1000),
        normalizeRegulationId(input.ownerUserId || input.owner_user_id),
        normalizeObligationStatus(input.status),
        normalizeRegulationReviewStatus(input.reviewStatus || input.review_status),
        uid, now, now
    ]);
}

// 义务由管理员人工确认后才可以进入 active 状态。这样解析、录入阶段的
// 推测性内容不会被下游当成已确认的合规要求。
async function reviewRegulationObligation({ obligationId, documentId, userId, input = {} }) {
    const oid = normalizeRegulationId(obligationId);
    const did = normalizeRegulationId(documentId);
    const uid = normalizeRegulationId(userId);
    if (!oid || !did || !uid) return null;
    const reviewStatus = normalizeRegulationReviewStatus(input.reviewStatus || input.review_status);
    if (!['approved', 'rejected', 'pending'].includes(reviewStatus)) return null;
    const requestedStatus = normalizeObligationStatus(input.status);
    // 未审核或被驳回的记录不能伪装成已启用义务。
    const status = reviewStatus === 'approved'
        ? (requestedStatus === 'draft' ? 'active' : requestedStatus)
        : 'draft';
    const now = getBeijingTimestamp();
    const obligation = await queryOne(`
        UPDATE regulation_obligations
        SET review_status = ?, status = ?, reviewed_by_user = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND document_id = ?
        RETURNING *
    `, [reviewStatus, status, uid, now, now, oid, did]);
    if (obligation?.owner_user_id && Number(obligation.owner_user_id) !== Number(uid) && reviewStatus === 'approved') {
        await execute(`
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            VALUES (?, NULL, 'regulation_obligation', ?, ?, 'unread', ?)
        `, [
            obligation.owner_user_id,
            '已分派法规合规待办',
            `一项法规义务已审核通过并分派给你：${String(obligation.required_action || '请查看义务详情').slice(0, 500)}`,
            now
        ]);
    }
    return obligation;
}

async function listRegulationAssignees() {
    return await query(`
        SELECT id, username, nickname, unit
        FROM users
        WHERE deleted_at IS NULL AND status = 'active'
        ORDER BY COALESCE(nickname, ''), username, id
        LIMIT 300
    `);
}

async function listRegulationObligations({ documentId = null, articleId = null, includeArchived = false } = {}) {
    const did = normalizeRegulationId(documentId);
    const aid = normalizeRegulationId(articleId);
    const clauses = ['d.deleted_at IS NULL'];
    const params = [];
    if (!includeArchived) clauses.push("d.status <> 'archived'");
    if (did) { clauses.push('o.document_id = ?'); params.push(did); }
    if (aid) { clauses.push('o.article_id = ?'); params.push(aid); }
    return await query(`
        SELECT o.*, d.title AS document_title, a.article_label, a.article_title,
               u.username AS owner_username, u.nickname AS owner_nickname, u.unit AS owner_unit
        FROM regulation_obligations o
        JOIN regulation_documents d ON d.id = o.document_id
        JOIN regulation_articles a ON a.id = o.article_id
        LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY o.updated_at DESC, o.id DESC
    `, params);
}

module.exports = {
    createRegulationObligation,
    listRegulationObligations,
    listRegulationAssignees,
    listRegulationQualitySummary,
    listRegulationSubscriptions,
    notifyRegulationSubscribers,
    notifyRegulationSubscribersBulk,
    reviewRegulationObligation,
    subscribeToRegulation,
    unsubscribeFromRegulation
};
