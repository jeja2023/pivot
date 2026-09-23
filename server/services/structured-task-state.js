'use strict';

const crypto = require('crypto');

const TASK_STATE_SCHEMA_VERSION = 1;
const MAX_QUERY_LENGTH = 4000;
const MAX_GOAL_LENGTH = 1000;
const MAX_ITEMS = 16;

function text(value, max) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values, max = MAX_ITEMS) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map(value => text(value, 240))
        .filter(Boolean))].slice(0, max);
}

function inferToolIntent(query) {
    const value = text(query, MAX_QUERY_LENGTH);
    const capabilities = [];
    if (/(?:本机|本地|电脑|目录|文件|文档|报表|文件夹)/iu.test(value)) capabilities.push('filesystem.read_workspace');
    if (/(?:数据库|SQL|表格|数据表|查询|统计|汇总)/iu.test(value)) capabilities.push('data.query');
    if (/(?:浏览器|网页|网址|URL|打开网站)/iu.test(value)) capabilities.push('browser.inspect');
    if (/(?:发送|通知|写入|保存|导出)/iu.test(value)) capabilities.push('side_effect');
    return {
        requiresTool: capabilities.length > 0,
        requiresLocalFiles: capabilities.includes('filesystem.read_workspace'),
        requestedCapabilities: unique(capabilities, 8)
    };
}

function inferEvidenceNeeds(query) {
    const value = text(query, MAX_QUERY_LENGTH);
    const needs = [];
    if (/(?:依据|来源|引用|制度|规定|政策|手册|知识库|资料|文档)/iu.test(value)) needs.push('knowledge_base');
    if (/(?:最新|实时|今天|当前|现在|库存|余额)/iu.test(value)) needs.push('realtime');
    if (/(?:本机|本地|电脑|目录|文件|文档|报表)/iu.test(value)) needs.push('local_document');
    return unique(needs, 8);
}

function extractEntities(query) {
    const value = text(query, MAX_QUERY_LENGTH);
    const quoted = [...value.matchAll(/[“”「」『』"']([^“”「」『』"']{2,120})[“”「」『』"']/g)].map(match => match[1]);
    const latin = value.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || [];
    const numbers = value.match(/\b\d{2,}(?:[.,]\d+)?%?\b/g) || [];
    return unique([...quoted, ...latin, ...numbers], 16);
}

function normalizeScope(scope = {}) {
    const source = scope && typeof scope === 'object' ? scope : {};
    const ids = Array.isArray(source.collectionIds) ? source.collectionIds : (source.collectionId ? [source.collectionId] : []);
    return {
        collectionIds: [...new Set(ids.map(item => Number.parseInt(item, 10)).filter(item => Number.isSafeInteger(item) && item > 0))].slice(0, 50),
        tagNames: unique(source.tagNames || source.tagName || source.tag, 20)
    };
}

function buildTaskHash(state) {
    const { hash: _hash, ...body } = state;
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function normalizeTaskState(value = {}, fallback = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const inherited = fallback && typeof fallback === 'object' ? fallback : {};
    const currentQuestion = text(source.currentQuestion || source.question || inherited.currentQuestion || source.retrievalQuery || inherited.retrievalQuery, MAX_QUERY_LENGTH);
    const retrievalQuery = text(source.retrievalQuery || currentQuestion || inherited.retrievalQuery, MAX_QUERY_LENGTH);
    const state = {
        schemaVersion: TASK_STATE_SCHEMA_VERSION,
        status: ['active', 'blocked', 'completed'].includes(String(source.status || '')) ? String(source.status) : 'active',
        source: String(source.source || inherited.source || 'current_prompt').slice(0, 40),
        goal: text(source.goal || inherited.goal || currentQuestion, MAX_GOAL_LENGTH),
        currentQuestion,
        retrievalQuery,
        constraints: unique(source.constraints || inherited.constraints, 16),
        entities: unique(source.entities || inherited.entities, 16),
        evidenceNeeds: unique(source.evidenceNeeds || inherited.evidenceNeeds, 8),
        scope: normalizeScope(source.scope || inherited.scope || {}),
        toolIntent: {
            requiresTool: Boolean(source.toolIntent?.requiresTool ?? inherited.toolIntent?.requiresTool),
            requiresLocalFiles: Boolean(source.toolIntent?.requiresLocalFiles ?? inherited.toolIntent?.requiresLocalFiles),
            requestedCapabilities: unique(source.toolIntent?.requestedCapabilities || inherited.toolIntent?.requestedCapabilities, 8)
        },
        pendingQuestions: unique(source.pendingQuestions || inherited.pendingQuestions, 8)
    };
    state.hash = buildTaskHash(state);
    return state;
}

function buildStructuredTaskState({ prompt = '', previousState = null, scope = {}, routeOverrides = {} } = {}) {
    const currentQuestion = text(prompt, MAX_QUERY_LENGTH);
    const previous = normalizeTaskState(previousState || {});
    const toolIntent = inferToolIntent(currentQuestion);
    const state = normalizeTaskState({
        source: 'current_prompt',
        status: 'active',
        goal: currentQuestion || previous.goal,
        currentQuestion,
        retrievalQuery: currentQuestion,
        constraints: [
            ...((currentQuestion.match(/(?:只要|仅需|仅限|不要|必须|限定|截止|按)[^，。；\n]{1,120}/gu) || [])),
            ...(Array.isArray(routeOverrides?.constraints) ? routeOverrides.constraints : [])
        ],
        entities: extractEntities(currentQuestion),
        evidenceNeeds: inferEvidenceNeeds(currentQuestion),
        scope: scope && Object.keys(scope).length ? scope : previous.scope,
        toolIntent,
        pendingQuestions: []
    }, previous);
    return state;
}

module.exports = {
    buildStructuredTaskState,
    normalizeTaskState
};
