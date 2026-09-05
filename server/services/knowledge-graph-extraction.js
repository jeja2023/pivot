const { normalizeSearchText } = require('./rag-tokenizer');

const MAX_ENTITIES_PER_CHUNK = 12;
const MAX_RELATIONS_PER_CHUNK = 16;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const HAN_RANGE = `${String.fromCharCode(0x4e00)}-${String.fromCharCode(0x9fa5)}`;
const HAN_TOKEN = `[${HAN_RANGE}A-Za-z0-9_.-]{2,40}`;

const ENTITY_SUFFIX_TYPES = [
    ['legal_doc', new RegExp(`(中华人民共和国[${HAN_RANGE}]{2,40}法|[${HAN_RANGE}]{2,40}条例|[${HAN_RANGE}]{2,40}准则)$`)],
    ['clause', /第[一二三四五六七八九十百千零〇两0-9]+(?:条|款|项)$/],
    ['obligation', /(义务|责任)$/],
    ['right', /(权利|权益)$/],
    ['penalty', /(罚则|处罚|罚款|追责)$/],
    ['subject', /(当事人|相对人|权利人|义务人|被申请人)$/],
    ['department', /(部门|中心|小组|团队|委员会|办公室|事业部|分公司|集团|公司)$/],
    ['system', /(系统|平台|服务|数据库|网关|接口|API|模型|知识库|控制台|门户)$/i],
    ['process', /(流程|工单|审批|审核|申请|报销|归档|发布|上线|巡检)$/],
    ['policy', /(制度|规范|办法|规定|指南|手册|预案|标准|条例|细则|政策)$/],
    ['project', /(项目|计划|工程|专项|版本|里程碑)$/],
    ['role', /(管理员|负责人|审批人|申请人|用户|客户|供应商|运维|开发|测试)$/]
];

const GENERIC_RELATION_PATTERNS = [
    { type: 'responsible_for', regex: new RegExp(`(${HAN_TOKEN})(?:负责|管理|维护|承接)(${HAN_TOKEN})`, 'g') },
    { type: 'belongs_to', regex: new RegExp(`(${HAN_TOKEN})(?:属于|隶属于|归口于)(${HAN_TOKEN})`, 'g') },
    { type: 'depends_on', regex: new RegExp(`(${HAN_TOKEN})(?:依赖|调用|接入|连接|使用)(${HAN_TOKEN})`, 'g') },
    { type: 'contains', regex: new RegExp(`(${HAN_TOKEN})(?:包含|包括|覆盖|由)(${HAN_TOKEN})`, 'g') },
    { type: 'affects', regex: new RegExp(`(${HAN_TOKEN})(?:影响|约束|支撑)(${HAN_TOKEN})`, 'g') }
];
const LEGAL_RELATION_PATTERNS = [
    { type: 'applies_to', regex: new RegExp(`(${HAN_TOKEN})(?:适用于|适用)(${HAN_TOKEN})`, 'g') },
    { type: 'references', regex: new RegExp(`(${HAN_TOKEN})(?:依据|根据|引用|参照)(${HAN_TOKEN})`, 'g') },
    { type: 'supersedes', regex: new RegExp(`(${HAN_TOKEN})(?:废止|替代|取代|修订)(${HAN_TOKEN})`, 'g') },
    { type: 'prohibits', regex: new RegExp(`(${HAN_TOKEN})(?:禁止|不得)(${HAN_TOKEN})`, 'g') },
    { type: 'requires', regex: new RegExp(`(${HAN_TOKEN})(?:应当|必须|要求)(${HAN_TOKEN})`, 'g') }
];
const RELATION_PATTERNS = GENERIC_RELATION_PATTERNS;

function relationPatternsForDocType(docType) {
    return docType === 'legal'
        ? GENERIC_RELATION_PATTERNS.concat(LEGAL_RELATION_PATTERNS)
        : GENERIC_RELATION_PATTERNS;
}

function normalizeEntityName(value) {
    return normalizeSearchText(value)
        .replace(/[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff_.-]+/gu, '')
        .trim();
}

function parseEntityAliases(value) {
    if (Array.isArray(value)) return value.map(cleanEntityName).filter(Boolean).slice(0, 20);
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return Array.isArray(parsed) ? parsed.map(cleanEntityName).filter(Boolean).slice(0, 20) : [];
    } catch (_) {
        return String(value || '')
            .split(/[,，;；\n]/)
            .map(cleanEntityName)
            .filter(Boolean)
            .slice(0, 20);
    }
}

function buildAliasList(...values) {
    const aliases = new Set();
    values.flatMap(parseEntityAliases).forEach(alias => aliases.add(alias));
    return [...aliases].slice(0, 20);
}

function relationStatusForConfidence(confidence) {
    return Number(confidence || 0) < LOW_CONFIDENCE_THRESHOLD ? 'pending' : 'active';
}

function cleanEntityName(value) {
    let text = String(value || '')
        .replace(/^[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+|[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+$/g, '')
        .trim();
    // 去掉指代式前缀（该公司/本办法/上述部门→公司/办法/部门），保留双字以上实体名。
    text = text.replace(new RegExp(`^(?:该|本|上述|前述|该等|此)(?=[${HAN_RANGE}]{2,})`), '');
    text = text.split(/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|适用|约束|支撑|依据|引用|参照|废止|替代|取代|修订|禁止|不得|应当|必须|要求)/)[0] || text;
    return text.trim().slice(0, 80);
}

function inferEntityType(name) {
    const text = String(name || '');
    const matched = ENTITY_SUFFIX_TYPES.find(([, regex]) => regex.test(text));
    if (matched) return matched[0];
    if (/^[A-Z][A-Za-z0-9_.-]{1,39}$/.test(text) || /API|SDK|SQL|HTTP|RAG|MCP/i.test(text)) return 'system';
    return 'concept';
}

function isUsefulEntityName(name) {
    const text = cleanEntityName(name);
    if (text.length < 2 || text.length > 80) return false;
    if (/^\d+$/.test(text)) return false;
    if (/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|适用|约束|支撑|依据|引用|参照|废止|替代|取代|修订|禁止|不得|应当|必须|要求)/.test(text)) return false;
    if (/^(以及|或者|如果|因此|同时|需要|可以|进行|通过|相关|当前|必须|不得|应该|问题|该|本|上述|前述|此)$/.test(text)) return false;
    return true;
}

function uniqByNormalized(entities) {
    const seen = new Set();
    const result = [];
    entities.forEach(entity => {
        const normalized = normalizeEntityName(entity.name);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push({ ...entity, normalizedName: normalized });
    });
    return result;
}

function extractEntitiesFromText(text, limit = MAX_ENTITIES_PER_CHUNK) {
    const content = String(text || '').slice(0, 5000);
    const entities = [];
    const push = (name, confidence = 0.68) => {
        const cleaned = cleanEntityName(name);
        if (!isUsefulEntityName(cleaned)) return;
        entities.push({
            name: cleaned,
            type: inferEntityType(cleaned),
            confidence
        });
    };

    const bracketRegex = /[《【“"]([^《》【】“”"]{2,60})[》】”"]/g;
    let match;
    while ((match = bracketRegex.exec(content))) push(match[1], 0.82);

    const suffixRegex = new RegExp(`([${HAN_RANGE}A-Za-z0-9_.-]{2,32}(?:部门|中心|小组|团队|委员会|办公室|事业部|集团|公司|系统|平台|服务|数据库|网关|接口|API|模型|知识库|流程|制度|规范|办法|规定|指南|手册|项目|计划|管理员|负责人))`, 'gi');
    while ((match = suffixRegex.exec(content))) push(match[1], 0.76);

    RELATION_PATTERNS.forEach(({ regex }) => {
        regex.lastIndex = 0;
        while ((match = regex.exec(content))) {
            push(match[1], 0.78);
            push(match[2], 0.78);
        }
    });

    const latinRegex = /\b([A-Z][A-Za-z0-9_.-]{2,39}|[A-Z]{2,12})\b/g;
    while ((match = latinRegex.exec(content))) push(match[1], 0.7);

    return uniqByNormalized(entities)
        .sort((a, b) => b.confidence - a.confidence || b.name.length - a.name.length)
        .slice(0, limit);
}

function extractRelationsFromText(text, entities, options = {}) {
    const patterns = Array.isArray(options.patterns) ? options.patterns : GENERIC_RELATION_PATTERNS;
    const limit = options.limit || MAX_RELATIONS_PER_CHUNK;
    const content = String(text || '').slice(0, 5000);
    const entityByNorm = new Map((entities || []).map(entity => [entity.normalizedName || normalizeEntityName(entity.name), entity]));
    const relations = [];
    const push = (sourceName, targetName, type, confidence, description = '') => {
        // 用与实体相同的清洗（去指代前缀/动词）后再归一，确保关系两端能对齐到实体键。
        const sourceNorm = normalizeEntityName(cleanEntityName(sourceName));
        const targetNorm = normalizeEntityName(cleanEntityName(targetName));
        const source = entityByNorm.get(sourceNorm);
        const target = entityByNorm.get(targetNorm);
        if (!source || !target || sourceNorm === targetNorm) return;
        relations.push({
            sourceName: source.name,
            targetName: target.name,
            relationType: type,
            description: description || `${source.name} ${type} ${target.name}`,
            confidence
        });
    };

    patterns.forEach(({ type, regex }) => {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(content))) {
            push(match[1], match[2], type, 0.78, match[0].slice(0, 160));
        }
    });

    for (let i = 0; i < entities.length; i += 1) {
        for (let j = i + 1; j < entities.length && relations.length < limit; j += 1) {
            const a = entities[i];
            const b = entities[j];
            const aIndex = content.indexOf(a.name);
            const bIndex = content.indexOf(b.name);
            if (aIndex < 0 || bIndex < 0 || Math.abs(aIndex - bIndex) > 220) continue;
            push(a.name, b.name, 'related_to', 0.55, '同一知识分块中共同出现');
        }
    }

    const seen = new Set();
    return relations.filter(item => {
        const key = `${item.sourceName}|${item.relationType}|${item.targetName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, limit);
}

function extractKnowledgeGraph(text, docType = 'prose') {
    const entities = extractEntitiesFromText(text);
    const relations = extractRelationsFromText(text, entities, { patterns: relationPatternsForDocType(docType) });
    return { entities, relations };
}

// 将预编译语句提到逐实体/逐关系的索引循环（indexKnowledgeGraphForChunks）之外：
// 惰性编译一次并跨调用复用，避免每个分块重复编译相同 SQL。db 虽为模块级常量，

module.exports = {
    buildAliasList,
    cleanEntityName,
    extractEntitiesFromText,
    extractKnowledgeGraph,
    extractRelationsFromText,
    inferEntityType,
    isUsefulEntityName,
    normalizeEntityName,
    parseEntityAliases,
    relationPatternsForDocType,
    relationStatusForConfidence,
    uniqByNormalized
};
