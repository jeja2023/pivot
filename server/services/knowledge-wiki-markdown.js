'use strict';

// 外部 LLM Wiki/Obsidian 等只读 Markdown 目录适配。它只解析并投影目录
// 已有页面，不写回源目录，也不将没有原始资料引用的页面升级为 Pivot 正式依据。
const crypto = require('crypto');
const yaml = require('js-yaml');
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');

function normalizeText(value, max = 500) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hash(value = '') {
    return 'sha256:' + crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseMarkdownFrontmatter(markdown = '') {
    const source = String(markdown || '').replace(/^\uFEFF/, '');
    const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
    if (!match) return { frontmatter: {}, body: source };
    let frontmatter = {};
    try {
        const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed;
    } catch (_) {
        // 非法 front matter 不让同步中断；原文仍可作为普通 Markdown 资料，
        // 但不接受其元数据来影响权限、状态或系统行为。
    }
    return { frontmatter, body: source.slice(match[0].length) };
}

function markdownTitle(body = '', fallback = 'Untitled Wiki Page') {
    const heading = String(body || '').match(/^\s{0,3}#\s+(.+)$/m)?.[1];
    return normalizeText(heading || fallback, 255) || 'Untitled Wiki Page';
}

function normalizeLinkTarget(value = '') {
    return String(value || '').trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\.md$/i, '').slice(0, 500);
}

function parseMarkdownLinks(body = '') {
    const links = new Map();
    const add = (target, label, linkType) => {
        const safeTarget = normalizeLinkTarget(target);
        if (!safeTarget || /^https?:\/\//i.test(safeTarget) || safeTarget.startsWith('#')) return;
        const safeLabel = normalizeText(label, 255);
        links.set(`${linkType}:${safeTarget}:${safeLabel}`, { targetPath: safeTarget, targetLabel: safeLabel, linkType });
    };
    for (const match of String(body || '').matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gu)) add(match[1], match[2] || match[1], 'wikilink');
    for (const match of String(body || '').matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)) add(match[2], match[1], 'markdown');
    return [...links.values()].slice(0, 200);
}

function publicExternalPage(row = {}) {
    return {
        id: Number(row.id), sourceId: Number(row.source_id), documentId: Number(row.document_id || 0) || null,
        canonicalUri: row.canonical_uri, title: row.title, frontmatter: typeof row.frontmatter_json === 'object' ? row.frontmatter_json : {},
        status: row.status, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at
    };
}

async function upsertExternalWikiMarkdownPage({ sourceId, documentId = null, canonicalUri, markdown } = {}, deps = {}) {
    const safeSourceId = Number.parseInt(sourceId, 10);
    const safeDocumentId = Number.parseInt(documentId, 10);
    const uri = String(canonicalUri || '').trim().slice(0, 2000);
    if (!Number.isSafeInteger(safeSourceId) || safeSourceId <= 0 || !uri) return null;
    const parsed = parseMarkdownFrontmatter(markdown);
    const title = normalizeText(parsed.frontmatter.title || markdownTitle(parsed.body, uri.split('/').pop() || 'Untitled Wiki Page'), 255);
    const content = String(markdown || '').slice(0, 2_000_000);
    const now = getBeijingTimestamp();
    const transactionFn = deps.transaction || transaction;
    return await transactionFn(async trx => {
        const page = await trx.queryOne(`
            INSERT INTO knowledge_wiki_external_pages (
                source_id, document_id, canonical_uri, title, frontmatter_json, content_markdown, content_hash, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, 'active', ?, ?)
            ON CONFLICT(source_id, canonical_uri) DO UPDATE SET
                document_id = EXCLUDED.document_id, title = EXCLUDED.title, frontmatter_json = EXCLUDED.frontmatter_json,
                content_markdown = EXCLUDED.content_markdown, content_hash = EXCLUDED.content_hash, status = 'active', updated_at = EXCLUDED.updated_at
            RETURNING *
        `, [safeSourceId, Number.isSafeInteger(safeDocumentId) && safeDocumentId > 0 ? safeDocumentId : null, uri, title, JSON.stringify(parsed.frontmatter), content, hash(content), now, now]);
        await trx.execute('DELETE FROM knowledge_wiki_external_page_links WHERE page_id = ?', [page.id]);
        for (const link of parseMarkdownLinks(parsed.body)) {
            await trx.execute(`
                INSERT INTO knowledge_wiki_external_page_links (page_id, target_path, target_label, link_type, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(page_id, target_path, target_label, link_type) DO NOTHING
            `, [page.id, link.targetPath, link.targetLabel, link.linkType, now]);
        }
        return { page: publicExternalPage(page), links: parseMarkdownLinks(parsed.body) };
    });
}

async function archiveMissingExternalWikiPages({ sourceId, seenUris = [] } = {}, deps = {}) {
    const safeSourceId = Number.parseInt(sourceId, 10);
    if (!Number.isSafeInteger(safeSourceId) || safeSourceId <= 0) return 0;
    const seen = [...new Set((Array.isArray(seenUris) ? seenUris : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100000);
    const now = getBeijingTimestamp();
    const sql = `
        UPDATE knowledge_wiki_external_pages SET status = 'archived', updated_at = ?
        WHERE source_id = ? AND status = 'active'
          ${seen.length ? `AND canonical_uri NOT IN (${seen.map(() => '?').join(',')})` : ''}
    `;
    return Number(await (deps.execute || execute)(sql, [now, safeSourceId, ...seen]) || 0);
}

async function listExternalWikiPages({ sourceId, user, limit = 100 } = {}, deps = {}) {
    const safeSourceId = Number.parseInt(sourceId, 10);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 200));
    const source = await (deps.queryOne || queryOne)(`SELECT * FROM knowledge_sources WHERE id = ? AND deleted_at IS NULL`, [safeSourceId]);
    if (!source || (!isSuperAdmin(user) && Number(source.user_id) !== Number(user?.id))) return null;
    const rows = await (deps.query || query)(`
        SELECT * FROM knowledge_wiki_external_pages WHERE source_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
    `, [safeSourceId, safeLimit]);
    return rows.map(publicExternalPage);
}

module.exports = {
    archiveMissingExternalWikiPages,
    listExternalWikiPages,
    parseMarkdownFrontmatter,
    parseMarkdownLinks,
    upsertExternalWikiMarkdownPage
};
