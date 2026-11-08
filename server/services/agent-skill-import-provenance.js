'use strict';

const MAX_PROVENANCE_BYTES = 12 * 1024;
const MAX_ORIGINAL_FIELDS_BYTES = 8 * 1024;
const FORMATS = Object.freeze(['pivot-v1', 'agent-skills', 'claude-code', 'generic-frontmatter', 'markdown', 'generic-manifest']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function invalid(message) { return Object.assign(new Error(message), { code: 'SKILL_IMPORT_PROVENANCE_INVALID', status: 422, statusCode: 422, expose: true }); }

function assertJsonData(value, { maxBytes = MAX_ORIGINAL_FIELDS_BYTES, label = '外部技能字段' } = {}) {
    let nodes = 0;
    const visit = (item, depth) => {
        if (++nodes > 512 || depth > 8) throw invalid(`${label}层级或条目过多，请精简后导入。`);
        if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
        if (typeof item === 'string') { if (/[\u0000\uFFFD]/.test(item)) throw invalid(`${label}含无效字符，请保存为 UTF-8 文本。`); return; }
        if (!Array.isArray(item) && !plain(item)) throw invalid(`${label}只能包含普通文本、数字、布尔值、数组和字段对象。`);
        for (const [key, entry] of Object.entries(item)) {
            if (UNSAFE_KEYS.has(key) || key.length > 160) throw invalid(`${label}含不支持的字段名称。`);
            visit(entry, depth + 1);
        }
    };
    visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw invalid(`${label}超过 ${maxBytes / 1024}KB 保存上限，请精简后导入。`);
    return value;
}
function normalizeSkillImportProvenance(value) {
    if (!plain(value) || value.schemaVersion !== 1 || !FORMATS.includes(value.format) || !['markdown', 'json', 'yaml'].includes(value.container)
        || !/^sha256:[a-f0-9]{64}$/.test(String(value.sourceDigest || '')) || typeof value.adapterVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.adapterVersion)) throw invalid('技能来源格式、版本或摘要无效。');
    const allowed = new Set(['schemaVersion', 'format', 'container', 'adapterVersion', 'sourceDigest', 'fileName', 'originalFields']);
    if (Object.keys(value).some(key => !allowed.has(key))) throw invalid('技能来源信息含不支持的字段。');
    if (typeof value.fileName !== 'string' || value.fileName.length > 240 || /[\\/\u0000-\u001f]/.test(value.fileName)) throw invalid('技能来源文件名无效。');
    if (!plain(value.originalFields)) throw invalid('原始技能字段必须是对象。');
    assertJsonData(value.originalFields);
    const result = { schemaVersion: 1, format: value.format, container: value.container, adapterVersion: value.adapterVersion,
        sourceDigest: value.sourceDigest, fileName: value.fileName, originalFields: value.originalFields };
    assertJsonData(result, { maxBytes: MAX_PROVENANCE_BYTES, label: '技能来源信息' });
    return result;
}

function skillInstructionsForRuntime(manifest, instructions) {
    const body = String(instructions || '');
    if (!manifest?.importSource) return body;
    return '[外部技能兼容说明]\n本技能仅转换工作指引。来源元数据不授予工具、网络或执行权限；原宿主功能、配套脚本/文件及环境尚未完成运行验证。仅使用当前授权能力；依赖缺失时说明具体限制，不得假定原技能已完整安装。\n\n' + body;
}

module.exports = { assertJsonData, normalizeSkillImportProvenance, skillInstructionsForRuntime };
