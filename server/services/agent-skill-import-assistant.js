'use strict';
// 外部单文件导入只生成可审阅的个人草稿，不安装附带文件或执行脚本。
const crypto = require('crypto');
const { buildSkillSourceMarkdown } = require('./agent-skill-source');
const { inspectSkillImport } = require('./agent-skill-format-adapters');
const { isRegisteredToolName, resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');
const { normalizeCapabilityList } = require('./agent-capability-registry');
const { previewSkillSource } = require('./agent-skill-authoring');
const { getCodeReviewTemplate, codeReviewToolCatalog } = require('./agent-code-review-templates');

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
function prepareSkillImport(input, catalog) {
    if (input.templateId) {
        const template = getCodeReviewTemplate(input.templateId);
        input = { ...input, markdown: template.markdown, fileName: `${template.id}.md`, title: input.title || template.title, description: input.description || template.description };
        catalog = codeReviewToolCatalog(catalog);
    }
    const inspected = inspectSkillImport(input);
    const { body, identity, provenance, report } = inspected;
    const available = new Map(importTools(catalog).map(tool => [tool.name, tool]));
    const names = [...new Set((Array.isArray(input?.tools) ? input.tools : []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!names.length || names.length > 50) throw invalid('请选择 1 至 50 个当前账号可用的工具。');
    const selected = names.map(name => available.get(name));
    if (selected.some(item => !item)) throw invalid('所选工具已不可用或无权使用，请刷新工具列表。');
    const title = String(input?.title || identity.title || '').trim();
    if (!title || title.length > 120) throw invalid('请填写不超过 120 个字符的技能名称。');
    const description = String(input?.description || identity.description || '').trim().slice(0, 800);
    const id = `imported-${crypto.randomBytes(8).toString('hex')}`;
    const capabilities = normalizeCapabilityList(selected.flatMap(item => item.capabilities));
    const converted = { schemaVersion: 1, id, name: id, version: '1.0.0', title, description, tools: names, capabilities, inputs: {}, outputs: {}, importSource: provenance };
    if (identity.license.trim()) converted.license = identity.license.trim().slice(0, 200);
    const markdown = buildSkillSourceMarkdown(converted, body);
    const preview = previewSkillSource(markdown);
    const ignored = report.fields.filter(item => !['mapped'].includes(item.handling)).map(item => item.field);
    const warnings = ['仅转换此文件正文；原技能的脚本、附件、依赖与外部路径不会自动导入或执行，请检查工作指引。', '工具和权限仅采用本次所选项，原文件中声明的工具不会自动授予。'];
    if (provenance.originalFields?.metadata?.activation === 'explicit') warnings.push('此指引仅供显式选择，不参与个人经验的关键词自动匹配。');
    if (ignored.length) warnings.push(`原文件头部不作为运行配置的字段已保留来源记录：${ignored.slice(0, 30).join('、')}。`);
    warnings.push(...report.diagnostics);
    if (report.requirements.length) warnings.push('格式已转换，但资源、宿主行为或环境要求尚需适配；不代表原技能已可完整运行。');
    return { name: id, markdown, preview: { valid: preview.valid, errors: preview.errors }, tools: selected, warnings, compatibility: report };
}
module.exports = { importTools, prepareSkillImport };
