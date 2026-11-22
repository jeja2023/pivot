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
    const spec = state.templateSpec;
    if (!spec || spec.id !== state.request.template.id || !/^[a-f0-9]{64}$/.test(spec.digest || '')) {
        throw error('当前模板规范缺少有效的版本记录，请重新载入所选模板。', 'PPT_MASTER_ACTION_INVALID', 422);
    }
    const binding = { id: spec.id, digest: spec.digest };
    const { page, rule, visibleText } = plan.templateUse || {};
    const target = Number.isInteger(page) && pages[page - 1];
    if (!target || typeof rule !== 'string' || rule.trim() !== rule || rule.length < 12 || rule.length > 350
        || !quotedDesignRule(spec.text, rule)
        || !(visibleText === target.title || target.values.some(value => !value.chart && value.text === visibleText))) {
        return binding;
    }
    return { ...binding, rule, page, visibleText };
}

function quotedDesignRule(spec, rule) {
    let inDesignSection = false;
    const lines = (spec || '').split(/\r?\n/u);
    const divider = line => /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u.test(line || '');
    for (const [index, line] of lines.entries()) {
        if (/^##\s/u.test(line)) inDesignSection = /^##\s+(?:II|III|IV|V|VI|VII)\./u.test(line);
        if (!inDesignSection || !line.trim() || /^\s*(?:#|<!--)/u.test(line) || divider(line) || line.includes('|') && divider(lines[index + 1])) continue;
        const body = line.trim().replace(/^[-*]\s+\*\*[^*]+\*\*:\s*/u, '');
        // 表格中的规则正文可引用单元格，标题、对齐行和字段名不能作为规则。
        if (body.includes('|')) {
            if (body.replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).slice(1).some(cell => cell.includes(rule))) return true;
        } else if (body.includes(rule)) return true;
    }
    return false;
}

async function installTemplate(state, project, execute) {
    const result = await execute({ action: 'run', tool: 'apply_template', args: [project, '--root', 'selected-template'], templateSource: state.templateSpec.path });
    if (result.exitCode !== 0 || result.templateSpecDigest !== state.templateSpec.digest) {
        throw error('所选模板未能安装到最终项目，请核对项目目录和模板文件。' + String(result.stderr || '').slice(0, 600), 'PPT_MASTER_ACTION_INVALID', 422);
    }
}

module.exports = { loadTemplateSpec, normalizeTemplateUse, installTemplate };
