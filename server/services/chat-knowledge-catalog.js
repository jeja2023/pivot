'use strict';

const repository = require('../repositories/knowledge');
const { normalizeRetrievalScope } = require('./rag-index/retrieval-scope-builder');
const { attachCitationKeys } = require('./rag-index/citation-keys');
const { logger } = require('../logger');

const CATALOG_LIMIT = 100;

function isKnowledgeCatalogQuestion(value = '') {
    const text = String(value).replace(/(?:^|\s)@[^\s@]+/gu, ' ').replace(/\s+/g, '');
    if (/(?:本机|电脑|本地文件|文件夹|磁盘|路径)/u.test(text)) return false;
    if (!/(?:知识库|专题库|专题|资料库|文档|文件|资料)/u.test(text)) return false;
    return /(?:有哪些|有什么|列出|列举|查看|显示|多少|清单|目录|名称|名字|列表).{0,15}(?:文档|文件|资料)|(?:文档|文件|资料).{0,12}(?:有哪些|有什么|名称|名字|列表|清单|目录|多少)/u.test(text)
        && !/(?:内容|讲了|摘要|概述|总结|详细|条款|规定)/u.test(text);
}

function isKnowledgeOverviewQuestion(value = '') {
    const text = String(value).replace(/(?:^|\s)@[^\s@]+/gu, ' ').replace(/\s+/g, '');
    return /(?:文档|文件|资料|专题库|知识库|专题)(?:里|中|内)?(?:都|主要|大致)?(?:有|包含|包括)?(?:哪些|什么)(?:内容|信息)|(?:文档|文件|资料|专题库|知识库|专题)(?:的|里|中|内)?(?:主要内容|内容概述|内容概要|讲了什么)/u.test(text);
}

function previousUserQuestion(history, current) {
    const users = (Array.isArray(history) ? history : []).filter(item => item?.role === 'user' && typeof item.content === 'string');
    if (users.length && users[users.length - 1].content.trim() === String(current || '').trim()) users.pop();
    return String(users.at(-1)?.content || '').trim();
}

function mentionToken(text) {
    return String(text || '').match(/(?:^|\s)@([^\s@，。！？?,;；]+)/u)?.[1] || '';
}

async function resolveConversationKnowledgeScope({ question = '', history = [], state = {}, user, listCollections = repository.listCollections } = {}) {
    const explicit = normalizeRetrievalScope({ ...(state.ragScope || {}),
        ...(state.routeOverrides?.collections?.length ? { collectionIds: state.routeOverrides.collections } : {}),
        ...(state.routeOverrides?.tagNames?.length ? { tagNames: state.routeOverrides.tagNames } : {}) });
    if (explicit.collectionIds.length || explicit.tagNames.length || state.routeOverrides?.excludeRag || state.routeOverrides?.tools?.length) return { scope: explicit };
    const currentMention = mentionToken(question);
    const refersToPrevious = /(?:这个|该|上述|上面|当前|此)(?:的)?(?:知识库|专题库|专题|资料库)/u.test(question);
    const token = currentMention || (refersToPrevious ? mentionToken(previousUserQuestion(history, question)) : '');
    if (!token) return { scope: explicit, unresolvedReference: refersToPrevious };
    const collections = await listCollections(user);
    const matches = (collections || []).filter(item => String(item.name || '').trim().toLocaleLowerCase() === token.toLocaleLowerCase());
    if (matches.length !== 1) return { scope: explicit, unresolvedReference: true, unresolvedMention: Boolean(currentMention) };
    return { scope: normalizeRetrievalScope({ collectionIds: [matches[0].id] }), inherited: !currentMention, name: matches[0].name };
}

function safeLabel(value) {
    return String(value || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/[\\`*_\[\]<>]/g, '\\$&').trim().slice(0, 200) || '未命名';
}

async function buildKnowledgeCatalogAnswer({ user, scope = {}, deps = repository } = {}) {
    const normalized = normalizeRetrievalScope(scope);
    const visible = await Promise.all(normalized.collectionIds.map(id => deps.getCollectionForUser(id, user)));
    if (visible.some(item => !item)) return '所选专题不存在或当前账号无权访问，请重新选择可访问的专题。';
    const rows = await deps.listChatKnowledgeCatalog(user, normalized, CATALOG_LIMIT + 1);
    const label = visible.length ? visible.map(item => safeLabel(item.name)).join('、') : '当前可访问的知识库';
    if (!rows.length) return `${label}中没有符合当前范围的文档。`;
    const statusLabels = { ready: '就绪', lexical_ready: '关键词就绪', processing: '处理中', error: '索引失败' };
    const items = rows.slice(0, CATALOG_LIMIT).map(row => {
        const status = Number(row.is_enabled ?? 1) === 0 ? '已停用' : statusLabels[row.status] || '状态待确认';
        const collection = visible.length === 1 ? '' : `（${safeLabel(row.collection_name || '未归类')}）`;
        return `- ${safeLabel(row.name)}${collection} — ${status}`;
    });
    const tail = rows.length > CATALOG_LIMIT ? `\n\n仅显示前 ${CATALOG_LIMIT} 份，更多文档请在知识库页面查看。` : '';
    return `${label}中的文档${rows.length > CATALOG_LIMIT ? `（前 ${CATALOG_LIMIT} 份）` : `（${rows.length} 份）`}：\n\n${items.join('\n')}${tail}`;
}

async function buildKnowledgeOverviewContext({ user, scope = {}, deps = repository } = {}) {
    const rows = await deps.listChatKnowledgeOverviewChunks(user, scope, 12);
    const chunks = rows.filter(row => String(row.content || '').trim()).map(row => ({
        chunkId: Number(row.chunk_id), source: String(row.name || '文档').replace(/[\r\n\[\]|]+/g, ' ').slice(0, 200),
        text: String(row.content).slice(0, 1400).replace(/\[(?=引用\s*\d)/gu, '［').replace(/PIVOT_(?:RAG|WIKI)_[A-Z_]+/g, '[文档中的标记]'), chunkIndex: Number(row.chunk_index || 0)
    }));
    if (!chunks.length) return '';
    const withKeys = await attachCitationKeys(chunks, { knowledgeRepository: deps, logger });
    return [
        '【参考内部知识库信息如下】：',
        ...withKeys.map((chunk, i) => `[引用 ${i + 1}${chunk.citationKey ? ` | citation: ${chunk.citationKey}` : ''} | 来源: ${chunk.source} · 片段 ${chunk.chunkIndex + 1}]: ${chunk.text}`),
        '请基于上述参考信息回答我的问题。这些只是有限的开头片段，不代表文档或专题全部内容；应明确说明覆盖范围有限，不得推断未提供的内容。'
    ].join('\n');
}

module.exports = { buildKnowledgeCatalogAnswer, buildKnowledgeOverviewContext, isKnowledgeCatalogQuestion, isKnowledgeOverviewQuestion, resolveConversationKnowledgeScope };
