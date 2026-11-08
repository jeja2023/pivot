'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const yaml = require('js-yaml');
const { assertNoYamlIndirection, splitFrontmatter, MAX_FRONTMATTER_BYTES, MAX_INSTRUCTIONS_BYTES } = require('./agent-skill-source');
const { assertJsonData, normalizeSkillImportProvenance } = require('./agent-skill-import-provenance');

const ADAPTER_VERSION = '1.0.0';
const LABELS = Object.freeze({ 'pivot-v1': 'Pivot 原生技能', 'agent-skills': 'Agent Skills 标准及元数据扩展', 'claude-code': 'Claude Code 扩展技能',
    'generic-frontmatter': '通用头部与 Markdown 指引', markdown: 'Markdown 工作指引', 'generic-manifest': '通用结构化技能清单' });
const STANDARD_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const HOST_FIELDS = new Set(['argument-hint', 'disable-model-invocation', 'user-invocable', 'context', 'agent', 'model', 'hooks', 'shell', 'paths', 'argument-name']);
const AUTHORITY_FIELDS = new Set(['allowed-tools', 'tools', 'capabilities', 'permissions', 'scope', 'ownerKey', 'owner_key', 'signature', 'keyId', 'digest', 'package_digest']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message, code = 'SKILL_IMPORT_INVALID') { return Object.assign(new Error(message), { code, status: 422, statusCode: 422, expose: true }); }
function parseMapping(text, container) {
    assertNoYamlIndirection(text);
    try {
        if (container === 'json') JSON.parse(text);
        // 同时适用于 JSON：json:false 拒绝重复键，JSON_SCHEMA 避免日期或自定义类型隐式展开。
        const parsed = yaml.load(text, { json: false, schema: yaml.JSON_SCHEMA });
        if (!plain(parsed)) throw new Error('技能内容必须为键值映射对象');
        assertJsonData(parsed, { maxBytes: MAX_FRONTMATTER_BYTES + MAX_INSTRUCTIONS_BYTES, label: '技能文件' });
        return parsed;
    } catch (error) {
        if (error.code === 'SKILL_IMPORT_PROVENANCE_INVALID') throw error;
        throw invalid(`技能文件${container === 'json' ? ' JSON' : ' YAML'}格式无效，或包含重复字段，请检查后重试。`);
    }
}
function splitManifest(document) {
    const wrapped = Object.prototype.hasOwnProperty.call(document, 'manifest');
    if (wrapped && !plain(document.manifest)) throw invalid('技能清单 manifest 必须是字段对象。');
    const bodies = ['instructions', 'instructions_md', 'body'].filter(key => document[key] !== undefined).map(key => document[key]);
    if (bodies.some(body => typeof body !== 'string') || bodies.some(body => body.trim() !== bodies[0].trim())) throw invalid('技能文件存在冲突或非文本的工作指引，请保留一个权威正文。');
    const manifest = wrapped ? document.manifest : Object.fromEntries(Object.entries(document).filter(([key]) => !['instructions', 'instructions_md', 'body'].includes(key)));
    if (wrapped && Object.keys(document).some(key => !['manifest', 'instructions', 'instructions_md', 'body'].includes(key))) throw invalid('技能清单外层包含未知字段，请将元数据放入 manifest。');
    return { manifest, body: bodies[0] || '' };
}
function parseExternalSkillSource(value, fileName = '') {
    if (typeof value !== 'string') throw invalid('技能文件内容必须是文本。');
    const source = value.replace(/^\uFEFF/, '');
    if (Buffer.byteLength(source, 'utf8') > MAX_FRONTMATTER_BYTES + MAX_INSTRUCTIONS_BYTES + 16) throw invalid('技能文件过大，请缩减后重试。');
    if (/[\u0000\uFFFD]/.test(source)) throw invalid('技能文件包含无效字符，请保存为 UTF-8 文本。');
    const name = path.posix.basename(String(fileName || 'SKILL.md').replace(/\\/g, '/')).slice(0, 240);
    const extension = path.posix.extname(name).toLowerCase();
    if (extension && !['.md', '.markdown', '.txt', '.json', '.yaml', '.yml'].includes(extension)) throw invalid('暂不支持该技能文件格式，请使用 Markdown、JSON 或 YAML；完整安装包需走独立包校验流程。', 'SKILL_IMPORT_FORMAT_UNSUPPORTED');
    let manifest = {}, body = source, container = 'markdown', hasFrontmatter = false;
    if (/^---(?:\r?\n|$)/.test(source) && !['.json', '.yaml', '.yml'].includes(extension)) {
        const parts = splitFrontmatter(source);
        if (Buffer.byteLength(parts.frontmatter, 'utf8') > MAX_FRONTMATTER_BYTES) throw invalid('技能文件头部超过大小限制。');
        manifest = parseMapping(parts.frontmatter, 'yaml'); body = parts.body; hasFrontmatter = true;
    } else if (extension === '.json' || (!fileName && /^\s*\{/.test(source))) {
        container = 'json'; ({ manifest, body } = splitManifest(parseMapping(source, container)));
    } else if (['.yaml', '.yml'].includes(extension)) {
        container = 'yaml'; ({ manifest, body } = splitManifest(parseMapping(source, container)));
    }
    if (!body.trim()) throw invalid('技能文件没有工作指引，请提供 Markdown 正文或 instructions 字段。');
    if (Buffer.byteLength(body, 'utf8') > MAX_INSTRUCTIONS_BYTES) throw invalid('技能工作指引超过大小限制。');
    assertJsonData(manifest, { maxBytes: MAX_FRONTMATTER_BYTES, label: '技能文件头部' });
    return { source, fileName: name, manifest, body, container, hasFrontmatter };
}

// 按特征依次识别，不执行外部文件提供的适配器、钩子或动态命令。
const ADAPTERS = Object.freeze([
    { id: 'pivot-v1', accepts: source => ['schemaVersion', 'capabilities', 'inputs', 'outputs'].some(key => Object.prototype.hasOwnProperty.call(source.manifest, key)) },
    { id: 'claude-code', accepts: source => Object.keys(source.manifest).some(key => HOST_FIELDS.has(key)) },
    { id: 'agent-skills', accepts: source => typeof source.manifest.name === 'string' && (typeof source.manifest.description === 'string' || ['metadata', 'compatibility', 'allowed-tools'].some(key => key in source.manifest)) },
    { id: 'generic-frontmatter', accepts: source => source.hasFrontmatter },
    { id: 'generic-manifest', accepts: source => source.container !== 'markdown' },
    { id: 'markdown', accepts: () => true }
]);
function sourceIdentity(original) {
    const metadata = plain(original.metadata) ? original.metadata : {};
    return { title: typeof original.title === 'string' ? original.title : typeof original.name === 'string' ? original.name : '',
        description: typeof original.description === 'string' ? original.description : '',
        version: typeof original.version === 'string' || typeof original.version === 'number' ? String(original.version) : typeof metadata.version === 'string' || typeof metadata.version === 'number' ? String(metadata.version) : '',
        license: typeof original.license === 'string' ? original.license : typeof metadata.license === 'string' ? metadata.license : '' };
}
function requestedTools(original) {
    const values = [original['allowed-tools'], original.tools].flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
    return [...new Set(values)].slice(0, 50);
}
function resourceReferences(body) {
    const refs = new Set();
    for (const match of body.matchAll(/\]\(([^\n)]+)\)|(?:\$\{SKILL_DIR\}|skills\/[A-Za-z0-9_-]+)\/([A-Za-z0-9_./-]+)/g)) {
        const value = (match[1] || match[2] || '').trim().replace(/^<|>$/g, '').split('#')[0];
        if (!value || /^(?:https?:|mailto:|#)/i.test(value)) continue;
        if (/^(?:scripts|references|assets|templates|workflows)\/|\.(?:md|py|js|json|yaml|yml|pptx|svg|txt|csv|xlsx)(?:$|[?#])/i.test(value)) refs.add(value.slice(0, 240));
    }
    for (const match of body.matchAll(/(?:^|[\s`"'])(scripts|references|assets|templates|workflows)\/([A-Za-z0-9_.\/-]+)/g)) refs.add((match[1] + '/' + match[2]).slice(0, 240));
    return [...refs].slice(0, 50);
}
function inspectSkillImport(input = {}) {
    const parsed = parseExternalSkillSource(input.markdown ?? input.source, input.fileName || input.filename);
    if (parsed.manifest.schemaVersion !== undefined && String(parsed.manifest.schemaVersion) !== '1') throw invalid('尚不支持该 Pivot 技能清单版本，请使用已支持的版本或转换为通用工作指引。', 'SKILL_IMPORT_VERSION_UNSUPPORTED');
    const adapter = ADAPTERS.find(item => item.accepts(parsed)), identity = sourceIdentity(parsed.manifest), fields = [], requirements = [];
    for (const key of Object.keys(parsed.manifest)) {
        const handling = AUTHORITY_FIELDS.has(key) ? 'permission_review' : HOST_FIELDS.has(key) ? 'unsupported' : ['name', 'title', 'description', 'license'].includes(key) ? 'mapped' : 'preserved';
        fields.push({ field: key, handling, message: handling === 'permission_review' ? '仅保留来源声明；工具和权限由当前账号重新选择并校验。' : handling === 'unsupported' ? '宿主专用行为保留为来源记录，Pivot 不会自动执行。' : handling === 'mapped' ? '用于填写草稿描述，不沿用原技能的身份或信任状态。' : '保留在来源记录中，不参与运行时权限判断。' });
        if (HOST_FIELDS.has(key)) requirements.push({ kind: 'host_feature', name: key, status: 'not_supported' });
    }
    const resources = resourceReferences(parsed.body);
    resources.forEach(name => requirements.push({ kind: 'resource', name, status: 'not_imported' }));
    if (typeof parsed.manifest.compatibility === 'string' && parsed.manifest.compatibility.trim()) requirements.push({ kind: 'environment', name: parsed.manifest.compatibility.slice(0, 500), status: 'not_verified' });
    if (parsed.manifest.dependencies !== undefined) requirements.push({ kind: 'environment', name: 'dependencies', status: 'not_verified' });
    if (/!`|^\s*```!/m.test(parsed.body)) requirements.push({ kind: 'host_feature', name: 'dynamic-command', status: 'not_supported' });
    if (/\$\{(?:CLAUDE_[A-Z_]+|SKILL_DIR)\}|\$ARGUMENTS(?:\b|\[)|\$\d+\b/.test(parsed.body)) requirements.push({ kind: 'host_feature', name: 'host-placeholders', status: 'not_supported' });
    const diagnostics = [];
    for (const field of ['name', 'title', 'description', 'license', 'compatibility']) if (parsed.manifest[field] !== undefined && typeof parsed.manifest[field] !== 'string') {
        diagnostics.push(`${field} 不是文本，未直接填入草稿；原始值已保留在来源记录中。`);
        requirements.push({ kind: 'metadata', name: field, status: 'review_required' });
    }
    if (parsed.manifest.metadata !== undefined && (!plain(parsed.manifest.metadata) || Object.values(parsed.manifest.metadata).some(value => typeof value !== 'string'))) diagnostics.push('metadata 含非标准的结构化值，已作为外部扩展保留，不按权限或宿主配置执行。');
    if (identity.description.length > 800) diagnostics.push('原描述超过 Pivot 草稿的800字范围，完整描述保留在来源记录中。');
    if (adapter.id === 'agent-skills' && Object.keys(parsed.manifest).some(key => !STANDARD_FIELDS.has(key))) diagnostics.push('检测到标准之外的扩展字段，已保留来源并逐项列出处理方式。');
    const inspectedDigest = 'sha256:' + crypto.createHash('sha256').update(parsed.source, 'utf8').digest('hex');
    const report = { schemaVersion: 1, adapterVersion: ADAPTER_VERSION, format: adapter.id, formatLabel: LABELS[adapter.id], container: parsed.container, inspectedSourceDigest: inspectedDigest,
        status: requirements.length ? 'adaptation_required' : 'compatible', fields, requirements, diagnostics,
        declaredTools: requestedTools(parsed.manifest),
        declaredCapabilities: [parsed.manifest.capabilities, parsed.manifest.permissions].flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : []).slice(0, 50),
        readiness: { scope: 'instructions_only', execution: 'not_verified', instructions: 'available', tools: 'review_required', bundledResources: resources.length ? 'not_imported' : 'not_declared', environment: 'not_verified' } };
    const provenance = parsed.manifest.importSource !== undefined ? normalizeSkillImportProvenance(parsed.manifest.importSource)
        : normalizeSkillImportProvenance({ schemaVersion: 1, format: adapter.id, container: parsed.container, adapterVersion: ADAPTER_VERSION,
            sourceDigest: inspectedDigest, fileName: parsed.fileName, originalFields: parsed.manifest });
    return { identity, report, provenance, body: parsed.body, manifest: parsed.manifest };
}

module.exports = { inspectSkillImport };
