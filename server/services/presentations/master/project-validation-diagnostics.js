'use strict';

const { createHash } = require('node:crypto');
const communicationKeys = new Set(['primary_language', 'audience', 'objective', 'core_message', 'consumption_mode']);

function projectErrorBlock(stdout) {
    return /(?:^|\n)\[ERROR\][ \t]*\r?\n([\s\S]*?)(?=\r?\n\s*\[|$)/.exec(stdout || '')?.[1]?.trim() || '';
}

function specDetail(file, message) {
    const marker = file === 'design_spec.md' ? 'design-spec/v1' : 'spec-lock/v1';
    if (/^missing ppt-master-schema marker |^has a malformed ppt-master-schema marker$|^marker '.*' does not match /.test(message)) {
        return '首行应为 <!-- ppt-master-schema: ' + marker + ' -->';
    }
    let match = /^missing section '([\w-]{1,60})'$/.exec(message);
    if (match) return '缺少节 ' + match[1];
    match = /^section '([\w-]{1,60})' appears more than once$/.exec(message);
    if (match) return '重复节 ' + match[1];
    match = /^section '([\w-]{1,60})' is missing field '([\w -]{1,60})'$/.exec(message);
    if (match) return match[1] + ' 中的 ' + match[2] + ' 缺失';
    match = /^section '([\w-]{1,60})' field '([\w -]{1,60})' (must not be empty|has illegal value|does not match)\b.*$/.exec(message);
    if (match) return match[1] + ' 中的 ' + match[2] + (match[3] === 'must not be empty' ? ' 不能为空' : ' 取值或格式不符合规范');
    match = /^'Slide[ \t]+(\d{1,4}|NN)\b.*' is missing field '(Audience move|Relationships)'$/.exec(message);
    if (file === 'design_spec.md' && match) return '的 Slide ' + match[1] + ' 缺少 ' + match[2];
    if (message.startsWith('unknown section ')) return '存在未知节标题，请沿用脚手架的标题';
    if (message.startsWith('unsupported preamble line ')) return '节标题前存在不支持的正文行';
    if (/^contains \d+ unresolved placeholder\(s\)/.test(message)) return '仍有未填写的脚手架占位符';
    return '';
}

function communicationDetail(line) {
    if (line === 'spec_lock.md must contain a ## communication section.' || line === 'missing spec_lock.md with a ## communication section.') {
        return 'spec_lock.md 缺少 ## communication';
    }
    const missing = /^spec_lock\.md ## communication is missing key line\(s\): ([a-z_]+(?:, [a-z_]+)*)\.$/.exec(line);
    if (missing) {
        const keys = missing[1].split(', ').filter(key => communicationKeys.has(key));
        return keys.length ? 'spec_lock.md 的 communication 缺少 ' + keys.join('、') : '';
    }
    if (line === 'design_spec.md must contain ## IX. Content Outline.') return 'design_spec.md 缺少 ## IX. Content Outline';
    if (line === 'design_spec.md §IX contains no Slide blocks.') return 'design_spec.md 的 §IX 缺少 Slide 段落';
    const slides = /^every design_spec\.md §IX Slide block must contain an? (Audience move|Relationships) line; missing on Slide ((?:\d{1,4}|NN)(?:, (?:\d{1,4}|NN))*)\.$/.exec(line);
    return slides ? 'design_spec.md 的 Slide ' + slides[2].split(', ').slice(0, 10).join('、') + ' 缺少 ' + slides[1] : '';
}

function projectValidationDetails(result) {
    if (!Number.isInteger(result?.exitCode) || result.exitCode === 0) return [];
    const details = new Set();
    for (const line of projectErrorBlock(result.stdout).slice(0, 10000).split(/\r?\n/)) {
        const schema = /^\s*-\s+(design_spec\.md|spec_lock\.md) schema: (.+)$/.exec(line);
        const communication = /^\s*-\s+Communication trace: (.+)$/.exec(line);
        const detail = schema ? specDetail(schema[1], schema[2]) : communication && communicationDetail(communication[1]);
        // 仅输出已识别的规范位置与错误类型，工具原文可能带任务正文或业务值。
        if (detail) details.add(schema ? schema[1] + ' ' + detail : detail);
        if (details.size >= 8) break;
    }
    return [...details];
}

function projectErrorKeys(result) {
    if (!Number.isInteger(result?.exitCode) || result.exitCode === 0) return [];
    const keys = [...new Set(projectErrorBlock(result.stdout).split(/^[ \t]*-[ \t]+/mu).map(line => line.trim()).filter(Boolean)
        .map(line => createHash('sha256').update(line).digest('hex')))].sort();
    return keys.length <= 32 ? keys : [createHash('sha256').update(keys.join('')).digest('hex')];
}

module.exports = { projectErrorBlock, projectValidationDetails, projectErrorKeys };
