'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MAX_BROWSER_OBSERVATION_TEXT = 12_000;

function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

async function captureBrowserVisualObservation(page) {
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const { data, info } = await sharp(screenshot).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const observation = { digest: crypto.createHash('sha256').update(data).digest('hex'), width: info.width, height: info.height };
    Object.defineProperty(observation, 'pixels', { value: data, enumerable: false });
    return observation;
}

function compareBrowserVisualObservations(before, after) {
    if (!before?.pixels || !after?.pixels || before.pixels.length !== after.pixels.length) return null;
    let changed = 0;
    for (let index = 0; index < before.pixels.length; index += 3) {
        const delta = Math.abs(before.pixels[index] - after.pixels[index])
            + Math.abs(before.pixels[index + 1] - after.pixels[index + 1])
            + Math.abs(before.pixels[index + 2] - after.pixels[index + 2]);
        if (delta >= 48) changed += 1;
    }
    return { beforeDigest: before.digest, afterDigest: after.digest, changedPixelRatio: Number((changed / (before.pixels.length / 3)).toFixed(4)) };
}

async function observeBrowserPage(page) {
    const bodyText = String(await page.locator('body').innerText()).slice(0, MAX_BROWSER_OBSERVATION_TEXT);
    const controls = await page.locator('a, button, input, select, textarea, [role="button"], [role="link"]').count();
    return {
        url: String(page.url() || '').slice(0, 4000),
        title: String(await page.title()).slice(0, 500),
        bodyTextDigest: digest(bodyText),
        bodyTextChars: bodyText.length,
        controls: Math.min(Number(controls || 0), 10000)
    };
}

function normalizeOutcome(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const visual = source.visualDiff && typeof source.visualDiff === 'object' ? source.visualDiff : null;
    return {
        method: String(source.method || '').slice(0, 40),
        target: source.target && typeof source.target === 'object' ? source.target : {},
        valueChars: Math.max(0, Number(source.valueChars || 0) || 0),
        visualDiff: visual ? {
            beforeDigest: String(visual.beforeDigest || '').slice(0, 64),
            afterDigest: String(visual.afterDigest || '').slice(0, 64),
            changedPixelRatio: Math.max(0, Math.min(Number(visual.changedPixelRatio || 0) || 0, 1))
        } : null,
        download: source.download && typeof source.download === 'object' ? {
            fileName: String(source.download.fileName || '').slice(0, 180),
            bytes: Math.max(0, Number(source.download.bytes || 0) || 0),
            digest: /^[a-f0-9]{64}$/i.test(String(source.download.digest || '')) ? String(source.download.digest).toLowerCase() : ''
        } : null,
        upload: source.upload && typeof source.upload === 'object' ? {
            renditionId: String(source.upload.renditionId || '').slice(0, 128),
            fileName: String(source.upload.fileName || '').slice(0, 180),
            bytes: Math.max(0, Number(source.upload.bytes || 0) || 0),
            digest: /^[a-f0-9]{64}$/i.test(String(source.upload.digest || '')) ? String(source.upload.digest).toLowerCase() : ''
        } : null
    };
}

async function recordBrowserActionEvidence({ sessionId, runId = null, transactionId = null, user, action, tabId = '', beforeState, afterState, outcome } = {}) {
    if (!sessionId || !user?.id || !beforeState || !afterState) return null;
    // 事务标识必须属于同一用户，避免在浏览器审计入口构造跨用户关联。
    let safeTransactionId = null;
    if (transactionId) {
        const transaction = await queryOne('SELECT id FROM agent_task_transactions WHERE id = ? AND user_id = ?', [String(transactionId), user.id]);
        safeTransactionId = transaction?.id || null;
    }
    return await queryOne(`
        INSERT INTO agent_browser_action_evidence (
            session_id, run_id, transaction_id, user_id, action, tab_id, before_state, after_state, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)
        RETURNING *
    `, [
        String(sessionId), runId ? String(runId) : null, safeTransactionId, user.id, String(action || '').slice(0, 32), String(tabId || '').slice(0, 80),
        JSON.stringify(beforeState), JSON.stringify(afterState), JSON.stringify(normalizeOutcome(outcome)), getBeijingTimestamp()
    ]);
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function serializeBrowserActionEvidence(row = {}) {
    return {
        id: String(row.id || ''), sessionId: String(row.session_id || ''), runId: row.run_id || null, transactionId: row.transaction_id || null,
        action: String(row.action || ''), tabId: String(row.tab_id || ''), before: parseJson(row.before_state, {}),
        after: parseJson(row.after_state, {}), outcome: parseJson(row.outcome, {}), createdAt: row.created_at || null
    };
}

async function listBrowserActionEvidenceForRun(runId, user, { limit = 100 } = {}) {
    if (!runId || !user?.id) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await query(`
        SELECT * FROM agent_browser_action_evidence
        WHERE run_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT ?
    `, [String(runId), user.id, safeLimit]);
    return rows.map(serializeBrowserActionEvidence);
}

module.exports = {
    captureBrowserVisualObservation,
    compareBrowserVisualObservations,
    listBrowserActionEvidenceForRun,
    observeBrowserPage,
    recordBrowserActionEvidence,
    serializeBrowserActionEvidence
};
