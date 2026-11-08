'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectSkillImport } = require('../server/services/agent-skill-format-adapters');
const { prepareSkillImport } = require('../server/services/agent-skill-import-assistant');
const { parseSkillSourceMarkdown, buildSkillSourceMarkdown } = require('../server/services/agent-skill-source');
const { validateSkillManifest, buildSkillExecutionContext } = require('../server/services/agent-skills');
const { skillInstructionsForRuntime } = require('../server/services/agent-skill-import-provenance');
const catalog = [{ name: 'rag.search', title: '资料检索', capabilities: ['knowledge.search'] }];
const inspect = (markdown, fileName = 'SKILL.md') => inspectSkillImport({ markdown, fileName });
const convert = (markdown, fileName = 'SKILL.md') => prepareSkillImport({ markdown, fileName, title: '兼容技能', tools: ['rag.search'] }, catalog);

test('识别标准元数据和PPT Master式扩展，保留许可证、原版本及来源摘要', () => {
    const source = '---\nname: ppt-master\ndescription: 演示文稿制作\nmetadata:\n  version: "6.8.0"\n  license: MIT\n  official_repository: https://github.com/hugohe3/ppt-master\n  sponsors: [SPONSORS.md, SPONSORS_CN.md]\n---\n\n# 制作步骤\n读取 [设计说明](references/design.md)，再使用 `${SKILL_DIR}/scripts/export.py`。';
    const inspected = inspect(source), result = convert(source);
    assert.equal(inspected.report.format, 'agent-skills'); assert.equal(inspected.identity.version, '6.8.0');
    assert.equal(inspected.report.status, 'adaptation_required');
    assert.ok(inspected.report.requirements.some(item => item.kind === 'resource' && item.name === 'references/design.md'));
    assert.ok(inspected.report.requirements.some(item => item.name === 'scripts/export.py'));
    assert.match(inspected.provenance.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    const native = parseSkillSourceMarkdown(result.markdown);
    assert.equal(native.manifest.license, 'MIT'); assert.equal(native.manifest.version, '1.0.0');
    assert.equal(native.manifest.importSource.originalFields.metadata.version, '6.8.0');
    assert.deepEqual(native.manifest.importSource.originalFields.metadata.sponsors, ['SPONSORS.md', 'SPONSORS_CN.md']);
    assert.match(native.instructions, /设计说明/); assert.equal(result.preview.valid, true);
});

test('宿主扩展、外部权限及签名仅作为来源，绝不扩大当前技能权限', () => {
    const source = '---\nname: deploy\ndescription: 部署指引\ncontext: fork\nagent: general-purpose\nallowed-tools: Bash(git:*) Read\npermissions: [admin.all]\nscope: organization\nsignature: untrusted\nhooks:\n  Stop: run-deploy\n---\n\n!`deploy --all`\n使用 $ARGUMENTS 完成任务。';
    const result = convert(source), native = parseSkillSourceMarkdown(result.markdown).manifest;
    assert.equal(result.compatibility.format, 'claude-code'); assert.equal(result.compatibility.status, 'adaptation_required');
    assert.ok(result.compatibility.declaredCapabilities.includes('admin.all'));
    assert.ok(!result.compatibility.declaredTools.includes('admin.all'));
    for (const key of ['scope', 'permissions', 'signature', 'hooks', 'context', 'allowed-tools']) assert.equal(native[key], undefined, key);
    assert.deepEqual(native.capabilities, ['knowledge.search']); assert.deepEqual(native.tools, ['rag.search']);
    const context = buildSkillExecutionContext(native);
    assert.deepEqual(context.skillTools, ['rag.search']); assert.deepEqual(context.skillCapabilities, ['knowledge.search']);
    assert.equal(native.importSource.originalFields.signature, 'untrusted');
    const runtime = skillInstructionsForRuntime(native, '执行工作指引。');
    assert.match(runtime, /仅转换工作指引|尚未完成运行验证/);
    assert.match(runtime, /执行工作指引/);
    assert.equal(skillInstructionsForRuntime({}, '原生工作指引。'), '原生工作指引。');
    assert.ok(result.compatibility.requirements.some(item => item.name === 'dynamic-command'));
    assert.ok(result.compatibility.requirements.some(item => item.name === 'host-placeholders'));
});

test('未知描述字段保留，原生运行时仍拒绝未知顶层字段，来源信息可以导出往返', () => {
    const result = convert('---\nname: future\ndescription: 未来格式\ncustom-catalog:\n  team: 设计组\n  revision: 4\n---\n执行工作指引。');
    const parsed = parseSkillSourceMarkdown(result.markdown);
    assert.equal(parsed.manifest.importSource.originalFields['custom-catalog'].team, '设计组');
    assert.ok(result.compatibility.fields.some(item => item.field === 'custom-catalog' && item.handling === 'preserved'));
    assert.throws(() => parseSkillSourceMarkdown('---\nid: native\nextraField: true\n---\n指引'), /未知字段/);
    const exported = buildSkillSourceMarkdown(parsed.manifest, parsed.instructions);
    assert.deepEqual(parseSkillSourceMarkdown(exported), parsed);
    const repeated = convert(exported);
    assert.deepEqual(parseSkillSourceMarkdown(repeated.markdown).manifest.importSource, parsed.manifest.importSource);
});

test('JSON和YAML封装统一生成同一种运行时契约，正文必须有明确权威来源', () => {
    const manifest = { name: 'summary', description: '资料摘要', metadata: { version: '2.1' } };
    for (const [source, fileName] of [
        [JSON.stringify({ manifest, instructions: '保留事实与来源。' }), 'skill.json'],
        ['---\nname: summary\ndescription: 资料摘要\nmetadata: {version: "2.1"}\ninstructions: |\n  保留事实与来源。\n', 'skill.yaml'],
        ['manifest:\n  name: summary\n  description: 资料摘要\ninstructions_md: 保留事实与来源。\n', 'skill.yml']
    ]) {
        const result = convert(source, fileName), parsed = parseSkillSourceMarkdown(result.markdown);
        assert.equal(result.preview.valid, true); assert.equal(parsed.instructions.trim(), '保留事实与来源。');
        assert.ok(['json', 'yaml'].includes(result.compatibility.container));
    }
    assert.throws(() => inspect(JSON.stringify({ ...manifest, instructions: '甲', body: '乙' }), 'skill.json'), /冲突/);
    assert.throws(() => inspect(JSON.stringify(manifest), 'skill.json'), /没有工作指引/);
    assert.throws(() => inspect('name: summary\ninstructions: 指引', 'skill.json'), /JSON.*无效/);
});

test('文本中的YAML符号不误判，真实别名、锚点、标签、合并键及重复字段仍拒绝', () => {
    const valid = '---\nname: symbols\ndescription: "说明 &alpha、*beta 与 !! 只是引用文本"\n---\n保留指引。';
    assert.equal(convert(valid).preview.valid, true);
    for (const source of [
        '---\nname: &anchor aliases\ndescription: *anchor\n---\n指引',
        '---\nname: aliases\nmetadata: {value: *unknown}\n---\n指引',
        '---\nname: !!str tags\n---\n指引',
        '---\nname: merges\nmetadata: {<<: {a: b}}\n---\n指引',
        '---\nname: first\nname: second\n---\n指引'
    ]) assert.throws(() => inspect(source));
    assert.throws(() => inspect('{"name":"a","name":"b","instructions":"指引"}', 'skill.json'), /重复字段/);
    assert.throws(() => inspect('name: a\nname: b\ninstructions: 指引', 'skill.yaml'), /重复字段/);
});

test('不支持的版本、二进制、过深元数据、原型字段和伪造来源记录明确拒绝', () => {
    assert.throws(() => inspect('---\nschemaVersion: 99\nname: future\n---\n指引'), /清单版本/);
    assert.throws(() => inspect('PK\u0000data', 'skill.zip'), /无效字符|不支持/);
    assert.throws(() => inspect('指引', 'skill.toml'), /不支持/);
    assert.throws(() => inspect('无法解码\uFFFD'), /UTF-8/);
    assert.throws(() => inspect('{"name":"proto","metadata":{"__proto__":{"admin":true}},"instructions":"指引"}', 'skill.json'), /字段名称/);
    const deep = {}; let current = deep;
    for (let i = 0; i < 20; i++) { current.nested = {}; current = current.nested; }
    assert.throws(() => inspect(JSON.stringify({ metadata: deep, instructions: '指引' }), 'skill.json'), /层级|过深/);
    const parsed = parseSkillSourceMarkdown(convert('# 工作指引').markdown).manifest;
    parsed.importSource.sourceDigest = 'forged';
    assert.equal(validateSkillManifest(parsed, { strictSpec: true }).valid, false);
});

test('无配套资源的普通指引保持兼容；环境要求只登记，不自动安装', () => {
    assert.equal(inspect('# 根据材料输出摘要').report.format, 'markdown');
    assert.equal(inspect('# 根据材料输出摘要').report.status, 'compatible');
    const source = '---\nname: report\ndescription: 生成报告\ncompatibility: Requires Python 3.12 and internet\n---\n生成报告。';
    const result = inspect(source);
    assert.equal(result.report.status, 'adaptation_required');
    assert.equal(result.report.requirements[0].kind, 'environment');
    assert.equal(result.report.requirements[0].status, 'not_verified');
});
