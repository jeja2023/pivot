/* global TextEncoder */
/* 公文状态的浏览器/服务端共享契约；历史材料去重、状态计算与锚点定位共用一套规则。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Pivot.exposeModule('apps.officialWritingDocument', api);
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const TYPES = ['通知', '请示', '报告', '函', '会议纪要', '通报', '意见', '其他公文'];
    const STANDARDS = ['通用公文规范', '党政机关公文格式', '会议纪要规范', '单位内部规范'];
    const META_FIELDS = ['secrecy', 'urgency', 'issuer', 'issueNumber', 'cc', 'printer', 'printDate', 'issuingOrg', 'signoff', 'issuedAt', 'titleBreaks'];
    const STANDARD_VERSION = '2026-11-04';
    const MAX_STATE_BYTES = 4 * 1024 * 1024;
    const HISTORY_BYTES = 2 * 1024 * 1024;
    const summaries = new WeakMap();
    const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const text = value => typeof value === 'string' ? value : '';
    const count = value => Array.from(text(value).replace(/\s/g, '')).length;
    const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
    function digest(value) {
        const input = text(value);
        let first = 2166136261;
        let second = 5381;
        for (let i = 0; i < input.length; i++) {
            first = Math.imul(first ^ input.charCodeAt(i), 16777619);
            second = Math.imul(second, 33) ^ input.charCodeAt(i);
        }
        return `${input.length}-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
    }
    function normalizeMeta(value) {
        const meta = object(value);
        return Object.fromEntries(META_FIELDS.map(key => [key, text(meta[key]).slice(0, 1000)]));
    }
    function isoDate(value) {
        const match = /^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?$/.exec(text(value).trim());
        if (!match) return '';
        const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
        return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    function normalizeHistory(state, source) {
        const oldPool = object(source.materialVersions);
        const pool = {};
        function reference(value) {
            const content = text(value);
            if (!content) return '';
            let key = digest(content);
            while (Object.hasOwn(pool, key) && pool[key] !== content) key += '_';
            pool[key] = content;
            return key;
        }
        const normalizeEntry = value => {
            const entry = object(value);
            const material = typeof entry.source === 'string' ? entry.source : oldPool[text(entry.sourceRef)];
            return { id: text(entry.id), name: text(entry.name).slice(0, 120), stage: text(entry.stage),
                draft: text(entry.draft), sourceRef: reference(material), createdAt: text(entry.createdAt) };
        };
        state.versions = (Array.isArray(source.versions) ? source.versions : []).filter(value => value && typeof value === 'object').slice(0, 20).map(normalizeEntry);
        state.autoSaves = (Array.isArray(source.autoSaves) ? source.autoSaves : []).filter(value => value && typeof value === 'object').slice(0, 8).map(normalizeEntry);
        function prunePool() {
            const used = new Set([...state.versions, ...state.autoSaves].map(entry => entry.sourceRef));
            for (const key of Object.keys(pool)) if (!used.has(key)) delete pool[key];
            state.materialVersions = { ...pool };
        }
        prunePool();
        while (bytes({ versions: state.versions, autoSaves: state.autoSaves, materialVersions: pool }) > HISTORY_BYTES
            && (state.autoSaves.length || state.versions.length)) {
            if (state.autoSaves.length > 1) state.autoSaves.pop();
            else if (state.versions.length) state.versions.pop();
            else state.autoSaves.pop();
            prunePool();
        }
    }
    function normalize(value) {
        const source = object(value);
        const state = {
            schemaVersion: 2,
            docType: TYPES.includes(source.docType) ? source.docType : '通知',
            mode: ['draft', 'polish', 'rewrite_section', 'review'].includes(source.mode) ? source.mode : 'draft',
            standard: STANDARDS.includes(source.standard) ? source.standard : '通用公文规范',
            materialSource: ['粘贴材料', '知识库', '常用模板'].includes(source.materialSource) ? source.materialSource : '粘贴材料',
            requirements: text(source.requirements), source: text(source.source), draft: text(source.draft), meta: normalizeMeta(source.meta),
            artifactId: /^[1-9]\d*$/.test(String(source.artifactId || '')) ? String(source.artifactId) : '',
            attachments: (Array.isArray(source.attachments) ? source.attachments : []).filter(value => value && typeof value === 'object').slice(0, 20).map(value => ({
                id: text(value.id).slice(0, 100), name: text(value.name).trim().slice(0, 250), content: text(value.content)
            })),
            review: { ...object(source.review) },
            imports: (Array.isArray(source.imports) ? source.imports : []).filter(value => value && typeof value === 'object').slice(0, 20).map(value => ({
                id: String(value.id || ''), name: text(value.name).slice(0, 250), status: text(value.status), error: text(value.error).slice(0, 500)
            })),
            references: (Array.isArray(source.references) ? source.references : []).filter(value => value && typeof value === 'object').slice(0, 100).map(value => ({
                id: text(value.id).slice(0, 160), documentId: String(value.documentId || '').slice(0, 160), chunkId: String(value.chunkId || '').slice(0, 160),
                source: text(value.source).slice(0, 250), version: String(value.version || '').slice(0, 100), page: String(value.page || '').slice(0, 50),
                citationKey: text(value.citationKey).slice(0, 180), sourceStatus: text(value.sourceStatus), checkedAt: text(value.checkedAt),
                content: text(value.content), addedAt: text(value.addedAt), digest: digest(text(value.content))
            })),
            comments: (Array.isArray(source.comments) ? source.comments : []).filter(value => value && typeof value === 'object').slice(0, 200).map(value => ({
                id: text(value.id), target: value.target === 'source' ? 'source' : 'draft', anchor: text(value.anchor), text: text(value.text), createdAt: text(value.createdAt)
            })),
            suggestions: (Array.isArray(source.suggestions) ? source.suggestions : []).filter(value => value && typeof value === 'object' && !(value.streaming && !value.replacement)).slice(0, 200).map(value => ({
                ...value, streaming: false, id: text(value.id), target: value.target === 'source' ? 'source' : 'draft', original: text(value.original),
                replacement: text(value.replacement), detail: text(value.detail), title: text(value.title),
                status: ['accepted', 'rejected', 'stale'].includes(value.status) ? value.status : 'pending'
            }))
        };
        normalizeHistory(state, source);
        while (bytes(state) > MAX_STATE_BYTES - 16384 && (state.autoSaves.length || state.versions.length)) {
            if (state.autoSaves.length) state.autoSaves.pop(); else state.versions.pop();
            const used = new Set([...state.autoSaves, ...state.versions].map(entry => entry.sourceRef));
            for (const key of Object.keys(state.materialVersions)) if (!used.has(key)) delete state.materialVersions[key];
        }
        return state;
    }
    function summary(value) {
        const state = object(value);
        const draft = text(state.draft), meta = normalizeMeta(state.meta);
        const pendingSuggestions = (state.suggestions || []).filter(item => item && (!item.status || item.status === 'pending')).length;
        const keys = [draft, state.source, state.docType, meta.issuedAt, pendingSuggestions, state.review?.status, state.review?.digest];
        const cached = summaries.get(state);
        if (cached && keys.every((key, index) => key === cached.keys[index])) return cached.value;
        const draftCount = count(draft), sourceCount = count(state.source);
        const issues = [];
        if (/【[^】]+】/.test(draft)) issues.push('存在待补充内容');
        if (draftCount && !isoDate(meta.issuedAt) && !/\d{4}年\d{1,2}月\d{1,2}日|\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(draft)) issues.push('成文日期待核对');
        const reviewed = state.review?.status === 'complete' && state.review.digest === digest(draft);
        const status = !draftCount ? (sourceCount ? '可起草' : '待起草')
            : issues.length || pendingSuggestions ? '待核对' : reviewed ? '已审校' : '已起草';
        const result = { docType: state.docType || '通知', draftCount, sourceCount, pendingSuggestions, issues, status, reviewed };
        summaries.set(state, { keys, value: result });
        return result;
    }
    function anchor(textValue, start, end) {
        const content = text(textValue);
        return { original: content.slice(start, end), start, end, before: content.slice(Math.max(0, start - 40), start), after: content.slice(end, end + 40), digest: digest(content) };
    }
    function locate(textValue, item) {
        const content = text(textValue), original = text(item.original);
        if (!original) return null;
        const start = Number(item.start), end = Number(item.end);
        if (item.digest === digest(content) && content.slice(start, end) === original) return { start, end };
        const matches = [];
        let index = content.indexOf(original);
        while (index !== -1 && matches.length < 1000) {
            const before = !item.before || content.slice(Math.max(0, index - item.before.length), index) === item.before;
            const after = !item.after || content.slice(index + original.length, index + original.length + item.after.length) === item.after;
            matches.push({ start: index, end: index + original.length, contextual: before && after });
            index = content.indexOf(original, index + Math.max(1, original.length));
        }
        if (matches.length === 1) return matches[0];
        const contextual = matches.filter(match => match.contextual);
        return contextual.length === 1 ? contextual[0] : null;
    }
    return { TYPES, STANDARDS, STANDARD_VERSION, MAX_STATE_BYTES, HISTORY_BYTES, bytes, count, digest, isoDate, normalizeMeta, normalize, summary, anchor, locate };
});
