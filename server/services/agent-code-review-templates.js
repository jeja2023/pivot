'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');

const TEMPLATES = Object.freeze([
    { id: 'code-review', title: '代码变更审查', description: '只读检查指定变更、调用链、权限及回归风险，按证据输出中文报告。' },
    { id: 'code-audit', title: '代码仓库审计', description: '只读追踪仓库或模块中的高风险流程，明确实际覆盖与未验证范围。' }
].map(item => Object.freeze({ ...item, markdown: fs.readFileSync(path.join(__dirname, '../skills', item.id, 'SKILL.md'), 'utf8') })));

function getCodeReviewTemplate(id) {
    const template = TEMPLATES.find(item => item.id === id);
    if (!template) throw Object.assign(new Error('代码审查模板不存在，请重新选择。'), { status: 422, code: 'SKILL_TEMPLATE_INVALID', expose: true });
    return { ...template };
}

function listCodeReviewTemplates() {
    return TEMPLATES.map(({ id, title, description }) => ({ id, title, description }));
}

function codeReviewToolCatalog(catalog) {
    return (Array.isArray(catalog) ? catalog : []).filter(tool => {
        // 只接受既有连接器的只读动作，裸工作区工具和可执行入口不能成为模板权限。
        if (tool?.localWorkspaceConnector !== true || !/^mcp\.\d+\.workspace\.(inspect|read|search|symbols|definition|references|git_status|git_diff)$/.test(tool?.name || '') || tool.side_effect === true) return false;
        const capabilities = [...resolveRegisteredToolCapabilities(tool.name), ...(Array.isArray(tool.capabilities) ? tool.capabilities : [])];
        return capabilities.every(item => item === 'filesystem.read_workspace');
    });
}

module.exports = { getCodeReviewTemplate, listCodeReviewTemplates, codeReviewToolCatalog };
