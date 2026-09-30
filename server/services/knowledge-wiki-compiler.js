'use strict';

const crypto = require('crypto');

const PAGE_TYPES = new Set(['overview', 'topic', 'entity', 'concept', 'conflict', 'change_digest']);
const SUPPORT_TYPES = new Set(['supports', 'defines', 'contradicts', 'supersedes', 'background']);

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeText(value, max = 500) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeStatus(value, allowed, fallback) {
    const status = String(value || '').trim().toLowerCase();
    return allowed.has(status) ? status : fallback;
}

function normalizeObjectKey(value = '') {
    return String(value || '').trim().toLowerCase().replace(/[\s_\-.:/]+/gu, '');
}

function pickObjectValue(value, aliases = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(value, alias) && value[alias] !== undefined) return value[alias];
    }
    const keys = new Set(aliases.map(normalizeObjectKey));
    for (const [key, item] of Object.entries(value)) {
        if (keys.has(normalizeObjectKey(key)) && item !== undefined) return item;
    }
    return undefined;
}

function asObjectList(value) {
    if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined);
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function parseLooseJson(value = '') {
    const text = String(value || '').trim();
    if (!text) return null;
    const direct = parseJson(text, null);
    if (direct) return direct;
    const fenced = [...text.matchAll(/```(?:json|jsonc)?\s*([\s\S]*?)```/giu)];
    for (const match of fenced) {
        const parsed = parseJson(match[1], null);
        if (parsed) return parsed;
    }
    // 本地模型有时在 JSON 前后添加解释。只抽取第一个完整 JSON 对象/数组，
    // 不尝试修补字段值或闭合括号，避免把任意文本误当作受控结构。
    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== '{' && text[start] !== '[') continue;
        const stack = [];
        let inString = false;
        let escaped = false;
        for (let cursor = start; cursor < text.length; cursor += 1) {
            const char = text[cursor];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') { inString = true; continue; }
            if (char === '{' || char === '[') stack.push(char);
            else if (char === '}' || char === ']') {
                const opening = stack.pop();
                if (!opening || (opening === '{' && char !== '}') || (opening === '[' && char !== ']')) break;
                if (!stack.length) {
                    const parsed = parseJson(text.slice(start, cursor + 1), null);
                    if (parsed) return parsed;
                    break;
                }
            }
        }
    }
    return null;
}

function normalizeSlug(value = '') {
    const normalized = String(value || '').trim().toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9\-\u4e00-\u9fff]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return normalized.slice(0, 120);
}

function safeMarkdown(value, max = 24000) {
    const markdown = String(value || '').replace(/\u0000/g, '').trim();
    // Wiki 正文是受限 Markdown，不是通用 HTML 容器。超长输出必须整体拒绝而非
    // 截断，以免 claims 与保存后的事实段落失配；链接关系统一从受控 links 字段写入。
    if (!markdown || markdown.length > max) return '';
    if (/<\/?[a-z][^>]*>/iu.test(markdown) || /<!--/u.test(markdown)) return '';
    const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
    for (const match of markdown.matchAll(markdownLink)) {
        const target = String(match[1] || '').trim();
        if (!target || target.startsWith('/') || target.startsWith('\\') || target.includes('..')
            || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return '';
    }
    return markdown;
}

function contentHash(value = '') {
    return 'sha256:' + crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function diffWikiMarkdown(before = '', after = '') {
    const left = String(before || '').split(/\r?\n/);
    const right = String(after || '').split(/\r?\n/);
    const max = Math.max(left.length, right.length);
    const changes = [];
    for (let index = 0; index < max && changes.length < 400; index += 1) {
        if (left[index] === right[index]) continue;
        if (left[index] !== undefined) changes.push({ type: 'removed', line: index + 1, text: left[index] });
        if (right[index] !== undefined) changes.push({ type: 'added', line: index + 1, text: right[index] });
    }
    return { changed: changes.length, truncated: changes.length >= 400, changes };
}

function parseWikiCompilerOutput(value = '') {
    const parsed = parseLooseJson(value);
    const namedPages = pickObjectValue(parsed, ['pages', 'wikiPages', 'items', 'results', '页面', '页面列表', '综合页']);
    const pages = Array.isArray(parsed)
        ? parsed
        : namedPages !== undefined ? asObjectList(namedPages) : (parsed && typeof parsed === 'object' ? [parsed] : []);
    return pages.filter(page => page && typeof page === 'object');
}

function normalizeSupportType(value) {
    const raw = normalizeText(value, 80).toLowerCase();
    const aliases = {
        支持: 'supports', 支撑: 'supports', 依据: 'supports', 引用: 'supports', support: 'supports', supports: 'supports',
        定义: 'defines', 说明: 'defines', define: 'defines', defines: 'defines',
        冲突: 'contradicts', 矛盾: 'contradicts', contradict: 'contradicts', contradicts: 'contradicts',
        更新: 'supersedes', 替代: 'supersedes', supersede: 'supersedes', supersedes: 'supersedes',
        背景: 'background', background: 'background'
    };
    return SUPPORT_TYPES.has(raw) ? raw : (aliases[raw] || 'supports');
}

function parseSourceRefList(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    const text = String(value || '').trim();
    if (!text) return [];
    const parsed = parseLooseJson(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return text.split(/[，,；;\s]+/u).map(item => item.trim()).filter(Boolean);
}

function canonicalizeWikiCandidate(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const pageSourceRefs = parseSourceRefList(pickObjectValue(source, ['sourceRefs', 'source_refs', 'sources', 'citations', 'evidence', '来源', '原始来源', '引用', '依据', '证据']));
    const rawClaims = asObjectList(pickObjectValue(source, ['claims', 'facts', 'statements', 'assertions', '事实', '事实声明', '陈述', '结论', '要点']));
    const claims = rawClaims.map(claim => {
        const item = claim && typeof claim === 'object' ? claim : { statement: claim };
        return {
            sectionAnchor: pickObjectValue(item, ['sectionAnchor', 'section_anchor', 'heading', 'section', 'anchor', '段落', '章节', '小节', '标题']),
            statement: pickObjectValue(item, ['statement', 'claim', 'text', 'content', '事实', '陈述', '结论', '要点']) ?? (typeof claim === 'string' ? claim : ''),
            sourceRefs: parseSourceRefList(pickObjectValue(item, ['sourceRefs', 'source_refs', 'sources', 'citations', 'evidence', '来源', '原始来源', '引用', '依据', '证据']))
        };
    });
    // 某些本地模型把来源放在页面层。仅当它们仍属于本轮受控来源时，服务端才把
    // 其收敛为“综合页正文”声明；不会根据模型文本自行补造任何来源。
    if (!claims.length && pageSourceRefs.length) {
        claims.push({
            sectionAnchor: '综合页正文',
            statement: pickObjectValue(source, ['summary', '摘要', '概述', '简介'])
                || pickObjectValue(source, ['title', '标题', '页面标题', 'name', '名称'])
                || '综合页正文',
            sourceRefs: pageSourceRefs
        });
    }
    return {
        pageType: pickObjectValue(source, ['pageType', 'page_type', 'type', '页面类型', '类型']),
        slug: pickObjectValue(source, ['slug', '页面标识', '标识', '页面路径']),
        title: pickObjectValue(source, ['title', '标题', '页面标题', 'name', '名称']),
        summary: pickObjectValue(source, ['summary', '摘要', '概述', '简介']),
        markdown: pickObjectValue(source, ['markdown', 'content_markdown', 'content', 'body', '正文', '页面内容', '内容']),
        confidence: pickObjectValue(source, ['confidence', '置信度']),
        claims,
        links: asObjectList(pickObjectValue(source, ['links', 'wikiLinks', '关联页面', '链接', '关联'])),
        conflicts: asObjectList(pickObjectValue(source, ['conflicts', '冲突', '矛盾', '待确认事项']))
    };
}

function resolveWikiSourceRef(value, allowedSources = new Map()) {
    const ref = normalizeSourceRef(value);
    const fromHandle = allowedSources.sourceByHandle?.get(ref.sourceId);
    if (fromHandle) {
        return {
            documentId: fromHandle.documentId, versionId: fromHandle.versionId, blockId: fromHandle.blockId,
            chunkId: fromHandle.chunkId || null, supportType: ref.supportType
        };
    }
    const key = `${ref.documentId}:${ref.versionId}:${ref.blockId}:${ref.chunkId || ''}`;
    if (allowedSources.has(key)) return { ...ref, sourceId: '' };
    // 兼容模型省略 chunkId 的常见写法，但要求 document/version/block 三元组精确
    // 命中本轮清单，不能据此扩大任意文档范围。
    if (ref.documentId && ref.versionId && ref.blockId) {
        const matched = [...allowedSources.values()].filter(source => Number(source.documentId) === ref.documentId
            && Number(source.versionId) === ref.versionId && Number(source.blockId) === ref.blockId);
        if (matched.length === 1) return {
            documentId: matched[0].documentId, versionId: matched[0].versionId, blockId: matched[0].blockId,
            chunkId: matched[0].chunkId || null, supportType: ref.supportType
        };
    }
    return null;
}

function recordCandidateRejection(diagnostics, reason) {
    if (!diagnostics) return;
    diagnostics.rejected = diagnostics.rejected || {};
    diagnostics.rejected[reason] = Number(diagnostics.rejected[reason] || 0) + 1;
}

function normalizeSourceRef(value = {}) {
    const source = typeof value === 'string' || typeof value === 'number' ? { sourceId: value } : value;
    return {
        sourceId: normalizeText(pickObjectValue(source, ['sourceId', 'source_id', 'source', 'ref', 'reference', '编号', '来源编号', '来源']), 40).toUpperCase(),
        documentId: normalizeId(pickObjectValue(source, ['documentId', 'document_id', 'docId', 'doc_id', '文档ID', '文档编号'])),
        versionId: normalizeId(pickObjectValue(source, ['versionId', 'version_id', '文档版本ID', '版本ID'])),
        blockId: normalizeId(pickObjectValue(source, ['blockId', 'block_id', '区块ID', '段落ID'])),
        chunkId: normalizeId(pickObjectValue(source, ['chunkId', 'chunk_id', '片段ID', '块ID'])),
        supportType: normalizeSupportType(pickObjectValue(source, ['supportType', 'support_type', 'type', '关系', '支持类型']))
    };
}

function normalizeWikiCandidate(value = {}, allowedSources = new Map(), diagnostics = null) {
    const candidate = canonicalizeWikiCandidate(value);
    const pageType = normalizeStatus(candidate.pageType, PAGE_TYPES, 'topic');
    const slug = normalizeSlug(candidate.slug || candidate.title);
    const title = normalizeText(candidate.title, 255);
    const markdown = safeMarkdown(candidate.markdown);
    if (!slug || !title) {
        recordCandidateRejection(diagnostics, 'missing_title');
        return null;
    }
    if (!markdown) {
        recordCandidateRejection(diagnostics, 'invalid_markdown');
        return null;
    }
    const claims = candidate.claims.map(claim => {
        const refs = parseSourceRefList(claim?.sourceRefs).map(ref => resolveWikiSourceRef(ref, allowedSources)).filter(Boolean);
        return { sectionAnchor: normalizeText(claim?.sectionAnchor, 160), statement: normalizeText(claim?.statement, 2000), refs };
    }).filter(claim => claim.statement && claim.refs.length);
    // 页面正文包含事实时必须至少能给出受控来源；没有来源的候选只作为失败处理。
    if (!claims.length) {
        recordCandidateRejection(diagnostics, 'missing_valid_source_refs');
        return null;
    }
    const links = candidate.links.map(link => {
        const item = link && typeof link === 'object' ? link : { slug: link };
        return {
            slug: normalizeSlug(pickObjectValue(item, ['slug', '页面标识', '目标', '目标页面', '链接']) || item.slug),
            relationType: normalizeText(pickObjectValue(item, ['relationType', 'relation_type', 'type', '关系']) || 'related_to', 80) || 'related_to',
            anchor: normalizeText(pickObjectValue(item, ['anchor', '锚点', '位置']), 160)
        };
    }).filter(link => link.slug).slice(0, 20);
    const conflicts = candidate.conflicts.slice(0, 20).map(item => normalizeText(
        item && typeof item === 'object' ? pickObjectValue(item, ['text', 'content', '说明', '冲突']) : item, 1000
    )).filter(Boolean);
    const sourceRefs = claims.flatMap(claim => claim.refs.map(ref => ({ ...ref, sectionAnchor: claim.sectionAnchor })));
    const uniqueRefs = [...new Map(sourceRefs.map(ref => [`${ref.documentId}:${ref.versionId}:${ref.blockId}:${ref.chunkId || ''}:${ref.sectionAnchor}:${ref.supportType}`, ref])).values()];
    return {
        pageType, slug, title, summary: normalizeText(candidate.summary, 1200), markdown, claims,
        links, conflicts, sourceRefs: uniqueRefs,
        confidence: Math.min(1, Math.max(0, Number(pickObjectValue(candidate, ['confidence', '置信度'])) || (conflicts.length ? 0.45 : 0.7)))
    };
}

module.exports = {
    contentHash,
    diffWikiMarkdown,
    normalizeId,
    normalizeStatus,
    normalizeText,
    normalizeWikiCandidate,
    parseJson,
    parseWikiCompilerOutput
};
