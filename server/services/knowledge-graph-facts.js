'use strict';

// 兼容旧 knowledge_relations 读模型的同时，把每条关系收敛成可多证据支撑的
// claim。图谱问答只使用存在有效证据的关系；人工冻结的 claim 不会被后续抽取覆盖。
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeConfidence(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function claimStatusForConfidence(confidence) {
    return normalizeConfidence(confidence) >= 0.6 ? 'active' : 'pending';
}

function excerptHash(value = '') {
    return 'sha256:' + crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function refreshGraphClaim(claimId, deps = {}) {
    const q = deps.query || query;
    const q1 = deps.queryOne || queryOne;
    const exec = deps.execute || execute;
    const id = normalizeId(claimId);
    if (!id) return null;
    const claim = await q1('SELECT * FROM knowledge_graph_claims WHERE id = ?', [id]);
    if (!claim) return null;
    const rows = await q(`
        SELECT confidence, stance, updated_at
        FROM knowledge_graph_claim_evidence
        WHERE claim_id = ? AND source_state = 'active'
    `, [id]);
    const supports = rows.filter(row => String(row.stance || 'supports') === 'supports');
    const contradicts = rows.filter(row => String(row.stance || 'supports') === 'contradicts');
    const count = supports.length;
    const nowMs = Date.now();
    const weightedConfidence = supports.reduce((total, row) => {
        const ageDays = Math.max(0, (nowMs - Date.parse(row.updated_at || 0)) / 86400000);
        const freshness = Number.isFinite(ageDays) ? Math.max(0.4, Math.exp(-ageDays / 365)) : 0.7;
        return total + normalizeConfidence(row.confidence) * freshness;
    }, 0);
    const supportScore = count ? weightedConfidence / count : 0;
    const corroboration = count ? Math.min(1, 0.72 + Math.log2(count + 1) * 0.16) : 0;
    const contradictionPenalty = contradicts.length
        ? Math.min(0.65, contradicts.reduce((sum, row) => sum + normalizeConfidence(row.confidence), 0) / contradicts.length * 0.65)
        : 0;
    const evidenceConfidence = Math.max(0, Math.min(1, supportScore * corroboration - contradictionPenalty));
    const lastEvidenceAt = rows.reduce((latest, row) => {
        const value = row.updated_at || '';
        return value > latest ? value : latest;
    }, '');
    const confidence = claim.frozen ? normalizeConfidence(claim.confidence) : evidenceConfidence;
    const status = claim.frozen ? claim.status : (count ? (contradicts.length ? 'pending' : claimStatusForConfidence(confidence)) : 'deleted');
    await exec(`
        UPDATE knowledge_graph_claims
        SET evidence_count = ?, last_evidence_at = ?, confidence = ?, status = ?, confidence_reason_json = ?::jsonb, updated_at = ?
        WHERE id = ?
    `, [count, lastEvidenceAt || null, confidence, status, JSON.stringify({
        supportCount: count, contradictionCount: contradicts.length,
        supportScore: Number(supportScore.toFixed(4)), corroboration: Number(corroboration.toFixed(4)),
        contradictionPenalty: Number(contradictionPenalty.toFixed(4)), formula: 'freshness_weighted_support_v1'
    }), getBeijingTimestamp(), id]);
    return await q1('SELECT * FROM knowledge_graph_claims WHERE id = ?', [id]);
}

async function upsertGraphClaimEvidence({
    userId,
    sourceEntityId,
    targetEntityId,
    relationType,
    description = '',
    confidence = 0,
    origin = 'rule',
    legacyRelationId = null,
    sourceDocId = null,
    sourceChunkId = null,
    snippet = '',
    locator = {},
    extractionMethod = 'rule_heuristic',
    extractorVersion = 'rule-heuristic-v1',
    stance = 'supports'
} = {}, deps = {}) {
    const q1 = deps.queryOne || queryOne;
    const exec = deps.execute || execute;
    const safeUserId = normalizeId(userId);
    const sourceId = normalizeId(sourceEntityId);
    const targetId = normalizeId(targetEntityId);
    if (!safeUserId || !sourceId || !targetId || sourceId === targetId || !String(relationType || '').trim()) return null;
    const now = getBeijingTimestamp();
    const normalizedConfidence = normalizeConfidence(confidence);
    const claim = await q1(`
        INSERT INTO knowledge_graph_claims (
            user_id, source_entity_id, target_entity_id, relation_type, description,
            status, confidence, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, source_entity_id, target_entity_id, relation_type) DO UPDATE
        SET description = CASE WHEN knowledge_graph_claims.frozen OR EXCLUDED.description = ''
                THEN knowledge_graph_claims.description ELSE EXCLUDED.description END,
            confidence = CASE WHEN knowledge_graph_claims.frozen THEN knowledge_graph_claims.confidence
                ELSE GREATEST(knowledge_graph_claims.confidence, EXCLUDED.confidence) END,
            origin = CASE WHEN knowledge_graph_claims.origin = 'manual' THEN 'manual' ELSE EXCLUDED.origin END,
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [safeUserId, sourceId, targetId, String(relationType).slice(0, 80), String(description || '').slice(0, 1000),
        claimStatusForConfidence(normalizedConfidence), normalizedConfidence, String(origin || 'rule').slice(0, 40), now, now]);
    if (!claim) return null;
    const safeSourceDocId = normalizeId(sourceDocId);
    const safeSourceChunkId = normalizeId(sourceChunkId);
    if (safeSourceDocId || safeSourceChunkId) {
        await exec(`
            INSERT INTO knowledge_graph_claim_evidence (
                claim_id, user_id, legacy_relation_id, source_doc_id, source_chunk_id, source_state,
                extraction_method, extractor_version, stance, confidence, excerpt_hash, excerpt_text, locator_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
            ON CONFLICT (claim_id, source_doc_id, source_chunk_id) DO UPDATE
            SET legacy_relation_id = COALESCE(EXCLUDED.legacy_relation_id, knowledge_graph_claim_evidence.legacy_relation_id),
                source_state = 'active', extraction_method = EXCLUDED.extraction_method,
                extractor_version = EXCLUDED.extractor_version, stance = EXCLUDED.stance,
                confidence = GREATEST(knowledge_graph_claim_evidence.confidence, EXCLUDED.confidence),
                excerpt_hash = CASE WHEN EXCLUDED.excerpt_hash <> '' THEN EXCLUDED.excerpt_hash ELSE knowledge_graph_claim_evidence.excerpt_hash END,
                excerpt_text = CASE WHEN EXCLUDED.excerpt_text <> '' THEN EXCLUDED.excerpt_text ELSE knowledge_graph_claim_evidence.excerpt_text END,
                locator_json = CASE WHEN EXCLUDED.locator_json <> '{}'::jsonb THEN EXCLUDED.locator_json ELSE knowledge_graph_claim_evidence.locator_json END,
                updated_at = EXCLUDED.updated_at
        `, [claim.id, safeUserId, normalizeId(legacyRelationId), safeSourceDocId, safeSourceChunkId,
            String(extractionMethod || 'rule_heuristic').slice(0, 80), String(extractorVersion || 'rule-heuristic-v1').slice(0, 120),
            String(stance || 'supports') === 'contradicts' ? 'contradicts' : 'supports', normalizedConfidence,
            snippet ? excerptHash(snippet) : '', String(snippet || '').slice(0, 1200), JSON.stringify(locator || {}), now, now]);
    }
    return await refreshGraphClaim(claim.id, deps);
}

async function setGraphClaimManualReview({ legacyRelationId, status = 'active', confidence = null, description = null, frozen = true } = {}, deps = {}) {
    const q = deps.query || query;
    const exec = deps.execute || execute;
    const relationId = normalizeId(legacyRelationId);
    if (!relationId) return [];
    const evidence = await q(`
        SELECT claim_id FROM knowledge_graph_claim_evidence
        WHERE legacy_relation_id = ? AND source_state = 'active'
    `, [relationId]);
    const claimIds = [...new Set(evidence.map(row => normalizeId(row.claim_id)).filter(Boolean))];
    for (const claimId of claimIds) {
        const parts = ["status = ?", "origin = 'manual'", 'frozen = ?', 'updated_at = ?'];
        const params = [String(status || 'active').slice(0, 40), frozen === true, getBeijingTimestamp()];
        if (confidence !== null && confidence !== undefined) { parts.splice(1, 0, 'confidence = ?'); params.splice(1, 0, normalizeConfidence(confidence)); }
        if (description !== null && description !== undefined) { parts.splice(1, 0, 'description = ?'); params.splice(1, 0, String(description).slice(0, 1000)); }
        params.push(claimId);
        await exec(`UPDATE knowledge_graph_claims SET ${parts.join(', ')} WHERE id = ?`, params);
    }
    return claimIds;
}

async function rejectGraphClaimEvidenceByRelation(legacyRelationId, deps = {}) {
    const q = deps.query || query;
    const exec = deps.execute || execute;
    const relationId = normalizeId(legacyRelationId);
    if (!relationId) return [];
    const rows = await q('SELECT claim_id FROM knowledge_graph_claim_evidence WHERE legacy_relation_id = ?', [relationId]);
    await exec(`UPDATE knowledge_graph_claim_evidence SET source_state = 'rejected', updated_at = ? WHERE legacy_relation_id = ?`, [getBeijingTimestamp(), relationId]);
    const claimIds = [...new Set(rows.map(row => normalizeId(row.claim_id)).filter(Boolean))];
    for (const claimId of claimIds) await refreshGraphClaim(claimId, deps);
    return claimIds;
}

async function invalidateGraphClaimEvidenceForDocument({ docId } = {}, deps = {}) {
    const exec = deps.execute || execute;
    const q = deps.query || query;
    const safeDocId = normalizeId(docId);
    if (!safeDocId) return { evidence: 0, claims: 0 };
    const rows = await q('SELECT DISTINCT claim_id FROM knowledge_graph_claim_evidence WHERE source_doc_id = ? AND source_state = \'active\'', [safeDocId]);
    const evidence = await exec(`
        UPDATE knowledge_graph_claim_evidence SET source_state = 'inactive', updated_at = ?
        WHERE source_doc_id = ? AND source_state = 'active'
    `, [getBeijingTimestamp(), safeDocId]);
    for (const row of rows) await refreshGraphClaim(row.claim_id, deps);
    return { evidence: Number(evidence || 0), claims: rows.length };
}

async function mergeGraphClaims({ userId, sourceEntityId, targetEntityId } = {}, deps = {}) {
    const q = deps.query || query;
    const q1 = deps.queryOne || queryOne;
    const exec = deps.execute || execute;
    const sourceId = normalizeId(sourceEntityId);
    const targetId = normalizeId(targetEntityId);
    const safeUserId = normalizeId(userId);
    if (!safeUserId || !sourceId || !targetId || sourceId === targetId) return { merged: 0 };
    const claims = await q(`
        SELECT * FROM knowledge_graph_claims
        WHERE user_id = ? AND (source_entity_id = ? OR target_entity_id = ?)
        ORDER BY id ASC
    `, [safeUserId, sourceId, sourceId]);
    let merged = 0;
    for (const claim of claims) {
        const nextSource = Number(claim.source_entity_id) === sourceId ? targetId : Number(claim.source_entity_id);
        const nextTarget = Number(claim.target_entity_id) === sourceId ? targetId : Number(claim.target_entity_id);
        if (nextSource === nextTarget) {
            await exec('DELETE FROM knowledge_graph_claims WHERE id = ?', [claim.id]);
            merged += 1;
            continue;
        }
        const existing = await q1(`
            SELECT * FROM knowledge_graph_claims
            WHERE user_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ? AND id <> ?
            FOR UPDATE
        `, [safeUserId, nextSource, nextTarget, claim.relation_type, claim.id]);
        if (existing) {
            const evidenceRows = await q('SELECT * FROM knowledge_graph_claim_evidence WHERE claim_id = ?', [claim.id]);
            for (const evidence of evidenceRows) {
                await exec(`
                    INSERT INTO knowledge_graph_claim_evidence (
                        claim_id, user_id, legacy_relation_id, source_doc_id, source_chunk_id, source_state,
                        extraction_method, extractor_version, confidence, excerpt_hash, locator_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
                    ON CONFLICT (claim_id, source_doc_id, source_chunk_id) DO UPDATE
                    SET confidence = GREATEST(knowledge_graph_claim_evidence.confidence, EXCLUDED.confidence),
                        source_state = CASE WHEN knowledge_graph_claim_evidence.source_state = 'active' THEN 'active' ELSE EXCLUDED.source_state END,
                        updated_at = EXCLUDED.updated_at
                `, [existing.id, evidence.user_id, evidence.legacy_relation_id, evidence.source_doc_id, evidence.source_chunk_id,
                    evidence.source_state, evidence.extraction_method, evidence.extractor_version, evidence.confidence,
                    evidence.excerpt_hash, JSON.stringify(evidence.locator_json || {}), evidence.created_at, getBeijingTimestamp()]);
            }
            await exec('DELETE FROM knowledge_graph_claims WHERE id = ?', [claim.id]);
            await refreshGraphClaim(existing.id, deps);
        } else {
            await exec(`UPDATE knowledge_graph_claims SET source_entity_id = ?, target_entity_id = ?, updated_at = ? WHERE id = ?`, [nextSource, nextTarget, getBeijingTimestamp(), claim.id]);
            await refreshGraphClaim(claim.id, deps);
        }
        merged += 1;
    }
    return { merged };
}

module.exports = {
    invalidateGraphClaimEvidenceForDocument,
    mergeGraphClaims,
    rejectGraphClaimEvidenceByRelation,
    setGraphClaimManualReview,
    upsertGraphClaimEvidence
};
