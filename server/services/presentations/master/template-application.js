'use strict';

const { createHash } = require('node:crypto');
const { runtimeTemplate } = require('../presentation-template-catalog');
const { error } = require('./runtime');

async function loadTemplateSpec(state, execute) {
    const selected = runtimeTemplate(state.request.template.id);
    if (!selected) throw error('当前运行包没有所选模板，请核对模板版本。');
    const path = selected.path + '/templates/design_spec.md';
    const result = await execute({ action: 'read_runtime', path, length: 60000 });
    if (!result.text?.trim() || result.nextOffset != null) throw error('模板规范未能完整读取，请核对执行服务的模板版本。');
    state.templateSpec = { id: selected.id, path: selected.path, text: result.text,
        digest: createHash('sha256').update(result.text).digest('hex') };
    state.messages.push({ role: 'user', content: JSON.stringify({ selectedTemplateSpec: state.templateSpec }) });
}

function normalizeTemplateUse(state, plan, pages) {
    if (state.request.template?.type !== 'runtime') return undefined;
    const { page, rule, visibleText } = plan.templateUse || {};
    const target = Number.isInteger(page) && pages[page - 1];
    if (!target || typeof rule !== 'string' || rule.trim().length < 12 || rule.length > 350
        || !state.templateSpec?.text.includes(rule) || !(visibleText === target.title || target.values.some(value => !value.chart && value.text === visibleText))) {
        throw error('请用 templateUse 的 rule 逐字引用所选模板的一条设计规范（12 至 350 字符），用 page 和 visibleText 指明落实该规范的页码和清单中的可见标题或数据。', 'PPT_MASTER_ACTION_INVALID', 422);
    }
    return { id: state.templateSpec.id, digest: state.templateSpec.digest, rule, page, visibleText };
}

async function installTemplate(state, project, execute) {
    const result = await execute({ action: 'run', tool: 'apply_template', args: [project, '--root', 'selected-template'], templateSource: state.templateSpec.path });
    if (result.exitCode !== 0 || result.templateSpecDigest !== state.templateSpec.digest) {
        throw error('所选模板未能安装到最终项目，请核对项目目录和模板文件。' + String(result.stderr || '').slice(0, 600), 'PPT_MASTER_ACTION_INVALID', 422);
    }
}

module.exports = { loadTemplateSpec, normalizeTemplateUse, installTemplate };
