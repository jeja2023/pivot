'use strict';

const crypto = require('crypto');
const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MAX_EVIDENCE_ITEMS_PER_TOOL = 20;

function text(value, max = 2000) {
    return String(value ?? '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function sourceUrl(value) {
    const raw = text(value, 4000);
    try {
        const parsed = new URL(raw);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : '';
    } catch (_) { return ''; }
}

function evidenceDigest(item) {
    return crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

function normalizeEvidenceCandidate(value, sourceType = 'tool') {
    const item = value && typeof value === 'object' ? value : {};
    const url = sourceUrl(item.url || item.href || item.link || item.sourceUrl || item.source_url);
    const title = text(item.title || item.name || item.heading || item.source || url, 500);
    const excerpt = text(item.excerpt || item.snippet || item.description || item.text || item.content || '', 4000);
    if (!url && !title && !excerpt) return null;
    return { sourceType: text(item.sourceType || item.source_type || sourceType, 60) || sourceType, title, url, excerpt };
}

function extractEvidenceCandidates(output = {}) {
    const source = output && typeof output === 'object' ? output : {};
    const candidates = [
        ...asArray(source.citations),
        ...asArray(source.sources),
        ...asArray(source.results),
        ...asArray(source.references),
        ...asArray(source.items)
    ];
    if (source.url || source.href || source.link) candidates.push(source);
    const seen = new Set();
    return candidates.map(item => normalizeEvidenceCandidate(item)).filter(Boolean).filter(item => {
        const digest = evidenceDigest(item);
        if (seen.has(digest)) return false;
        seen.add(digest);
        return true;
    }).slice(0, MAX_EVIDENCE_ITEMS_PER_TOOL);
}

async function recordEvidenceFromToolOutput({ run, user, toolName, output } = {}) {
    if (!run?.id || !user?.id) return [];
    const candidates = extractEvidenceCandidates(output);
    if (!candidates.length) return [];
    const now = getBeijingTimestamp();
    const recorded = [];
    for (const candidate of candidates) {
        const digest = evidenceDigest(candidate);
        const row = await queryOne(`
            INSERT INTO agent_evidence_items (
                evidence_id, run_id, user_id, tool_name, source_type, source_title, source_url, excerpt, content_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (run_id, content_digest) DO NOTHING
            RETURNING evidence_id, run_id, tool_name, source_type, source_title, source_url, excerpt, content_digest, created_at
        `, [
            `evidence_${crypto.randomUUID()}`,
            run.id,
            user.id,
            text(toolName, 160),
            candidate.sourceType,
            candidate.title,
            candidate.url,
            candidate.excerpt,
            digest,
            now
        ]);
        if (row) recorded.push(row);
    }
    return recorded;
}

async function listAgentEvidenceForUser(runId, user, { limit = 100 } = {}) {
    if (!runId || !user?.id) return null;
    const owned = await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [String(runId), user.id]);
    if (!owned) return null;
    const rows = await query(`
        SELECT evidence_id, run_id, tool_name, source_type, source_title, source_url, excerpt, content_digest, created_at
        FROM agent_evidence_items
        WHERE run_id = ?
        ORDER BY created_at ASC, evidence_id ASC
        LIMIT ?
    `, [String(runId), Math.max(1, Math.min(Number(limit) || 100, 500))]);
    return rows.map(row => ({
        id: row.evidence_id,
        runId: row.run_id,
        toolName: row.tool_name,
        sourceType: row.source_type,
        title: row.source_title,
        url: row.source_url || '',
        excerpt: row.excerpt || '',
        digest: row.content_digest,
        createdAt: row.created_at
    }));
}

module.exports = {
    extractEvidenceCandidates,
    listAgentEvidenceForUser,
    recordEvidenceFromToolOutput
};
