'use strict';

const { query, execute } = require('../db/client');

async function loadPages(docId, userId, sourceHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ''))) return new Map();
    const rows = await query(`
        SELECT p.page_no, p.content FROM knowledge_pdf_ocr_pages p
        JOIN knowledge_docs d ON d.id = p.doc_id
        WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL AND p.source_hash = ?
        ORDER BY p.page_no
    `, [docId, userId, sourceHash]);
    return new Map(rows.map(row => [Number(row.page_no), String(row.content || '')]));
}

async function savePage(docId, userId, sourceHash, pageNo, content, location = null) {
    if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || '')) || !Number.isSafeInteger(pageNo) || pageNo < 1 || !String(content || '').trim()) return;
    await execute(`
        INSERT INTO knowledge_pdf_ocr_pages (doc_id, source_hash, page_no, content, location_json, updated_at)
        SELECT d.id, ?, ?, ?, ?::jsonb, NOW() FROM knowledge_docs d
        WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL
        ON CONFLICT (doc_id, source_hash, page_no) DO UPDATE SET content = EXCLUDED.content, location_json = EXCLUDED.location_json, updated_at = EXCLUDED.updated_at
    `, [sourceHash, pageNo, String(content).slice(0, 500000), JSON.stringify(location || {}), docId, userId]);
}

async function loadLocation(docId, userId, sourceHash, pageNo) {
    if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ''))) return null;
    const rows = await query(`SELECT p.location_json FROM knowledge_pdf_ocr_pages p JOIN knowledge_docs d ON d.id = p.doc_id
        WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL AND p.source_hash = ? AND p.page_no = ?`, [docId, userId, sourceHash, pageNo]);
    return rows[0]?.location_json || null;
}

async function listPagesWithoutLocations(docId, userId, sourceHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ''))) return [];
    const rows = await query(`
        SELECT p.page_no FROM knowledge_pdf_ocr_pages p
        JOIN knowledge_docs d ON d.id = p.doc_id
        WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL AND p.source_hash = ?
          AND (jsonb_typeof(p.location_json->'blocks') IS DISTINCT FROM 'array'
               OR CASE WHEN jsonb_typeof(p.location_json->'blocks') = 'array'
                  THEN jsonb_array_length(p.location_json->'blocks') = 0 ELSE true END)
        ORDER BY p.page_no
    `, [docId, userId, sourceHash]);
    return rows.map(row => Number(row.page_no));
}

async function clearOtherVersions(docId, userId, sourceHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ''))) return;
    await execute(`
        DELETE FROM knowledge_pdf_ocr_pages p USING knowledge_docs d
        WHERE p.doc_id = d.id AND d.id = ? AND d.user_id = ? AND p.source_hash <> ?
    `, [docId, userId, sourceHash]);
}

module.exports = { loadPages, savePage, loadLocation, listPagesWithoutLocations, clearOtherVersions };
