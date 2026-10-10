'use strict';

const { query } = require('../db/client');

async function getAccessibleProductDocuments(ids, user, deps = {}) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isSafeInteger))];
    if (!uniqueIds.length) return new Map();
    if (deps.getProductDocumentForUser && !deps.getProductDocumentsForUser) {
        return new Map((await Promise.all(uniqueIds.map(async id => [id, await deps.getProductDocumentForUser(id, user)])))
            .filter(([, document]) => Boolean(document)));
    }
    const getDocuments = deps.getProductDocumentsForUser || require('./knowledge-product-access').getProductDocumentsForUser;
    return await getDocuments(uniqueIds, user);
}

async function filterVisibleWikiPageRows(rows = [], user, deps = {}) {
    const pageRows = Array.isArray(rows) ? rows : [];
    const pageIds = pageRows.map(row => Number(row.id)).filter(Number.isSafeInteger);
    if (!pageIds.length) return [];
    const sourceRows = await (deps.query || query)(`
        SELECT source.wiki_page_id, source.document_id, source.version_id,
               document.current_version_id, document.lifecycle_status, document.verified_status, document.deleted_at
        FROM knowledge_wiki_page_sources source
        LEFT JOIN knowledge_documents document ON document.id = source.document_id
        WHERE source.wiki_page_id IN (${pageIds.map(() => '?').join(',')})
    `, pageIds);
    const byPage = new Map();
    for (const source of sourceRows) {
        const id = Number(source.wiki_page_id);
        if (!byPage.has(id)) byPage.set(id, []);
        byPage.get(id).push(source);
    }
    const documents = await getAccessibleProductDocuments(sourceRows.map(source => source.document_id), user, deps);
    return pageRows.filter(page => {
        const sources = byPage.get(Number(page.id)) || [];
        return sources.length > 0 && sources.every(source => !source.deleted_at
            && Number(source.current_version_id) === Number(source.version_id)
            && source.lifecycle_status === 'published' && source.verified_status !== 'expired'
            && documents.has(Number(source.document_id)));
    });
}

module.exports = { filterVisibleWikiPageRows, getAccessibleProductDocuments };
