'use strict';
// 外部单文件导入只生成可审阅的个人草稿，不安装附带文件或执行脚本。
const crypto = require('crypto');
const yaml = require('js-yaml');
const { assertNoYamlIndirection, buildSkillSourceMarkdown, splitFrontmatter, MAX_FRONTMATTER_BYTES, MAX_INSTRUCTIONS_BYTES } = require('./agent-skill-source');
const { isRegisteredToolName, resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');
const { normalizeCapabilityList } = require('./agent-capability-registry');
const { previewSkillSource } = require('./agent-skill-authoring');

function invalid(message) { return Object.assign(new Error(message), { code: 'SKILL_IMPORT_INVALID', status: 422, expose: true }); }
function importTools(catalog) {
    return (Array.isArray(catalog) ? catalog : [])
        .filter(tool => tool?.name && isRegisteredToolName(tool.name))
        .map(tool => ({
            name: String(tool.name), title: String(tool.title || tool.name).slice(0, 160),
            description: String(tool.description || '').slice(0, 400),
            capabilities: normalizeCapabilityList([...resolveRegisteredToolCapabilities(tool.name), ...(Array.isArray(tool.capabilities) ? tool.capabilities : [])]),
            risk: String(tool.risk_level || tool.risk || 'unknown'), approvalRequired: Boolean(tool.approval_required || tool.approvalRequired || tool.requiresApproval)
        }));
}
function parseExternalSource(value) {
    const source = String(value || '').replace(/^\uFEFF/, '');
    if (Buffer.byteLength(source, 'utf8') > MAX_FRONTMATTER_BYTES + MAX_INSTRUCTIONS_BYTES + 16) throw invalid('技能文件过大，请缩减后重试。');
    let manifest = {};
    let body = source;
    if (/^---(?:\r?\n|$)/.test(source)) {
        const parts = splitFrontmatter(source);
        if (Buffer.byteLength(parts.frontmatter, 'utf8') > MAX_FRONTMATTER_BYTES) throw invalid('技能文件头部超过大小限制。');
        assertNoYamlIndirection(parts.frontmatter);
        try { manifest = yaml.load(parts.frontmatter, { json: false }); } catch (_) { throw invalid('技能文件头部格式无效，请检查后重试。'); }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid('技能文件头部必须是字段对象。');
        body = parts.body;
    }
    if (body.includes('\u0000')) throw invalid('技能文件包含无效字符，请选择 UTF-8 文本文件。');
    if (!body.trim()) throw invalid('技能文件没有工作指引，请补充正文。');
    if (Buffer.byteLength(body, 'utf8') > MAX_INSTRUCTIONS_BYTES) throw invalid('技能工作指引超过大小限制。');
    return { manifest, body };
}
function prepareSkillImport(input, catalog) {
    const { manifest: original, body } = parseExternalSource(input?.markdown);
    const available = new Map(importTools(catalog).map(tool => [tool.name, tool]));
    const names = [...new Set((Array.isArray(input?.tools) ? input.tools : []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!names.length || names.length > 50) throw invalid('请选择 1 至 50 个当前账号可用的工具。');
    const selected = names.map(name => available.get(name));
    if (selected.some(item => !item)) throw invalid('所选工具已不可用或无权使用，请刷新工具列表。');
    const title = String(input?.title || original.title || original.name || '').trim();
    if (!title || title.length > 120) throw invalid('请填写不超过 120 个字符的技能名称。');
    const description = String(input?.description || original.description || '').trim().slice(0, 800);
    const id = `imported-${crypto.randomBytes(8).toString('hex')}`;
    const capabilities = normalizeCapabilityList(selected.flatMap(item => item.capabilities));
    const converted = { schemaVersion: 1, id, name: id, version: '1.0.0', title, description, tools: names, capabilities, inputs: {}, outputs: {} };
    if (typeof original.license === 'string' && original.license.trim()) converted.license = original.license.trim().slice(0, 200);
    const markdown = buildSkillSourceMarkdown(converted, body);
    const preview = previewSkillSource(markdown);
    const ignored = Object.keys(original).filter(key => !['name', 'title', 'description', 'license'].includes(key));
    const warnings = ['仅转换此文件正文；原技能的脚本、附件、依赖与外部路径不会自动导入或执行，请检查工作指引。', '工具和权限仅采用本次所选项，原文件中声明的工具不会自动授予。'];
    if (ignored.length) warnings.push(`原文件头部未沿用的字段：${ignored.slice(0, 30).join('、')}。`);
    return { name: id, markdown, preview: { valid: preview.valid, errors: preview.errors }, tools: selected, warnings };
}
module.exports = { importTools, prepareSkillImport };
