'use strict';

// 图谱关系必须落在受控词表中。规则抽取、模型扩展和人工校准共用本体，避免
// 任意字符串关系让检索、统计和跨域治理失去语义。
const GENERAL_RELATIONS = new Set([
    'related_to', 'responsible_for', 'belongs_to', 'depends_on', 'contains', 'affects'
]);
const LEGAL_RELATIONS = new Set([
    ...GENERAL_RELATIONS, 'applies_to', 'references', 'supersedes', 'prohibits', 'requires'
]);
const SYSTEM_RELATIONS = new Set([
    ...GENERAL_RELATIONS, 'calls', 'integrates_with', 'implements', 'owned_by'
]);
const PROJECT_RELATIONS = new Set([
    ...GENERAL_RELATIONS, 'has_milestone', 'delivered_by', 'depends_on'
]);
const RELATION_ALIASES = Object.freeze({
    相关: 'related_to', 负责: 'responsible_for', 归属: 'belongs_to', 依赖: 'depends_on',
    包含: 'contains', 影响: 'affects', 适用: 'applies_to', 引用: 'references',
    废止: 'supersedes', 禁止: 'prohibits', 要求: 'requires'
});

function allowedRelationsForDocumentType(docType = 'prose') {
    if (docType === 'legal') return LEGAL_RELATIONS;
    if (docType === 'system') return SYSTEM_RELATIONS;
    if (docType === 'project') return PROJECT_RELATIONS;
    return GENERAL_RELATIONS;
}

function normalizeGraphRelationType(value, { docType = '', fallback = 'related_to' } = {}) {
    const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_').slice(0, 80);
    const normalized = RELATION_ALIASES[raw] || raw;
    const allowed = docType ? allowedRelationsForDocumentType(docType) : new Set([...LEGAL_RELATIONS, ...SYSTEM_RELATIONS, ...PROJECT_RELATIONS]);
    return allowed.has(normalized) ? normalized : fallback;
}

function getKnowledgeGraphOntology() {
    return {
        general: [...GENERAL_RELATIONS],
        legal: [...LEGAL_RELATIONS],
        system: [...SYSTEM_RELATIONS],
        project: [...PROJECT_RELATIONS]
    };
}

module.exports = {
    getKnowledgeGraphOntology,
    normalizeGraphRelationType
};
