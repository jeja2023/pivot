/**
 * server/services/agent-skill-source.js
 * SKILL.md 单文件技能配方导入器
 *
 * 落地方案 v1.2 §5.1、阶段 4.1：
 * 开发者只维护一个 Markdown 文件。导入器提取 Frontmatter，按服务端白名单与 JSON Schema
 * 规范化后作为 manifest 事实来源，正文存为 instructions_md，原始文件仅用于溯源与再编辑。
 *
 * 导入硬性规则：
 * 1. Frontmatter 仅允许白名单字段；未知字段、重复键、YAML 锚点与别名、超长文本一律拒绝；
 * 2. js-yaml 保持 { json: false }，使重复 Mapping Key 直接解析报错（json: true 会让后一个键静默覆盖前一个）；
 * 3. manifest.scope 不再被接受，作用域由发布动作决定；
 * 4. capabilities 与 tools 为空即没有任何工具调用权，并与服务器允许清单求交集。
 */
const path = require('path');
const yaml = require('js-yaml');
const { normalizeCapabilityList } = require('./agent-capability-registry');

const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

/** Frontmatter 允许字段白名单。新增字段必须同时更新校验与文档。 */
const ALLOWED_FRONTMATTER_FIELDS = Object.freeze(new Set([
    'schemaVersion', 'id', 'name', 'version', 'title', 'description', 'publisher',
    'tools', 'capabilities', 'inputs', 'outputs', 'qualityGates',
    'dependencies', 'files', 'digest', 'package_digest', 'signature', 'keyId', 'license', 'tags'
]));

/** 明确拒绝的历史字段：scope 由发布动作决定，tests[].script 属包内脚本执行。 */
const REJECTED_FRONTMATTER_FIELDS = Object.freeze({
    scope: 'manifest.scope 不再被接受，作用域由发布动作决定。',
    permissions: 'manifest.permissions 已收敛为 capabilities，请改用真实 capability 标识。',
    tests: 'manifest.tests 中的可执行脚本已被禁止，验证改由平台声明式测试执行。',
    regressionTests: 'manifest.regressionTests 中的可执行脚本已被禁止。'
});

function sourceError(message, code = 'AGENT_SKILL_SOURCE_INVALID') {
    const error = new Error(message);
    error.status = 422;
    error.statusCode = 422;
    error.code = code;
    error.expose = true;
    return error;
}

function isSkillSourceMarkdown(fileName) {
    const base = path.posix.basename(String(fileName || '').replace(/\\/g, '/')).toLowerCase();
    return base === 'skill.md';
}

/** 拒绝 YAML 锚点、别名、合并键与自定义标签：它们会让同一份文本产生多种展开结果。 */
function assertNoYamlIndirection(text) {
    if (/(^|\s)&[A-Za-z0-9_-]+/.test(text)) throw sourceError('SKILL.md Frontmatter 不允许使用 YAML 锚点。');
    if (/(^|\s)\*[A-Za-z0-9_-]+/.test(text)) throw sourceError('SKILL.md Frontmatter 不允许使用 YAML 别名。');
    if (/(^|\s)<<\s*:/.test(text)) throw sourceError('SKILL.md Frontmatter 不允许使用 YAML 合并键。');
    if (/!!/.test(text)) throw sourceError('SKILL.md Frontmatter 不允许使用自定义 YAML 标签。');
}

/**
 * 拆分 Frontmatter 与正文。
 * 只接受文件开头的 --- 分隔块，避免正文中的分隔线被误当作 Frontmatter。
 */
function splitFrontmatter(text) {
    const source = String(text ?? '').replace(/^﻿/, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
    if (!match) throw sourceError('SKILL.md 必须以 --- 包裹的 Frontmatter 开头。');
    return { frontmatter: match[1], body: match[2] ?? '' };
}

function assertSizeLimits(frontmatter, body) {
    if (Buffer.byteLength(frontmatter, 'utf8') > MAX_FRONTMATTER_BYTES) {
        throw sourceError(`SKILL.md Frontmatter 超过 ${MAX_FRONTMATTER_BYTES / 1024}KB 上限。`);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
        throw sourceError(`SKILL.md 正文超过 ${MAX_INSTRUCTIONS_BYTES / 1024}KB 上限。`);
    }
}

function assertFieldWhitelist(manifest) {
    const unknown = [];
    Object.keys(manifest).forEach(key => {
        const rejection = REJECTED_FRONTMATTER_FIELDS[key];
        if (rejection) throw sourceError(rejection);
        if (!ALLOWED_FRONTMATTER_FIELDS.has(key)) unknown.push(key);
    });
    if (unknown.length) throw sourceError(`SKILL.md Frontmatter 含未知字段：${unknown.join('、')}`);
}

/**
 * 解析 SKILL.md，返回规范化 manifest 与正文。
 * 不在此处做业务语义校验（必填、能力登记、允许清单），那些由 validateSkillManifest 统一执行，
 * 避免出现第二套校验语义。
 */
function parseSkillSourceMarkdown(text) {
    const { frontmatter, body } = splitFrontmatter(text);
    assertSizeLimits(frontmatter, body);
    assertNoYamlIndirection(frontmatter);
    let parsed;
    try {
        parsed = yaml.load(frontmatter, { json: false });
    } catch (error) {
        throw sourceError(`SKILL.md Frontmatter 解析失败：${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw sourceError('SKILL.md Frontmatter 必须是键值对象。');
    }
    assertFieldWhitelist(parsed);
    const manifest = { ...parsed };
    if (manifest.capabilities !== undefined) manifest.capabilities = normalizeCapabilityList(manifest.capabilities);
    if (Array.isArray(manifest.tools)) {
        manifest.tools = [...new Set(manifest.tools.map(item => String(item || '').trim()).filter(Boolean))];
    }
    manifest.schemaVersion = Number.parseInt(manifest.schemaVersion, 10) || manifest.schemaVersion;
    return { manifest, instructions: body.trim() ? `${body.trim()}\n` : '' };
}

/** 生成 SKILL.md 文本：用于技能编辑与版本导出，保证导入导出可往返（阶段 4.2）。 */
function buildSkillSourceMarkdown(manifest = {}, instructions = '') {
    const ordered = {};
    ['schemaVersion', 'id', 'name', 'version', 'title', 'description', 'publisher',
        'tools', 'capabilities', 'inputs', 'outputs', 'qualityGates', 'dependencies', 'files', 'license', 'tags']
        .forEach(key => {
            if (manifest[key] !== undefined && manifest[key] !== null && manifest[key] !== '') ordered[key] = manifest[key];
        });
    const frontmatter = yaml.dump(ordered, { lineWidth: 120, noRefs: true, sortKeys: false }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${String(instructions || '').trim()}\n`;
}

module.exports = {
    ALLOWED_FRONTMATTER_FIELDS,
    MAX_FRONTMATTER_BYTES,
    MAX_INSTRUCTIONS_BYTES,
    REJECTED_FRONTMATTER_FIELDS,
    buildSkillSourceMarkdown,
    isSkillSourceMarkdown,
    parseSkillSourceMarkdown,
    splitFrontmatter
};
