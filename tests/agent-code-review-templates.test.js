'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCodeReviewTemplate, listCodeReviewTemplates, codeReviewToolCatalog } = require('../server/services/agent-code-review-templates');
const { prepareSkillImport } = require('../server/services/agent-skill-import-assistant');
const { parseSkillSourceMarkdown, buildSkillSourceMarkdown } = require('../server/services/agent-skill-source');
const { createSkillVersionFromMarkdown } = require('../server/services/agent-skill-authoring');
const { validateSkillVersion, publishSkillVersion } = require('../server/services/agent-releases');
const { findBestPersonalSkill, getAgentSkillExecutionContext } = require('../server/services/agent-skills');
const { queryOne } = require('../server/db/client');

const read = { name: 'mcp.7.workspace.read', title: '读取工作区', capabilities: ['filesystem.read_workspace'], risk: 'high', approvalRequired: true, side_effect: false, localWorkspaceConnector: true };
const catalog = [read,
    { ...read, name: 'mcp.7.workspace.git_diff' },
    { ...read, name: 'workspace.read' },
    { ...read, name: 'mcp.7.workspace.patch' },
    { ...read, name: 'mcp.7.workspace.test' },
    { ...read, name: 'mcp.7.terminal.runtime' },
    { ...read, name: 'mcp.7.workspace.read.fake' },
    { ...read, name: 'mcp.8.workspace.read', side_effect: true },
    { ...read, name: 'mcp.10.workspace.read', localWorkspaceConnector: false },
    { ...read, name: 'mcp.9.workspace.read', capabilities: ['filesystem.write_workspace'] }
];

test('审查模板只允许当前目录的只读连接器动作，保留审批要求', () => {
    assert.deepEqual(codeReviewToolCatalog(catalog).map(item => item.name), ['mcp.7.workspace.read', 'mcp.7.workspace.git_diff']);
    assert.equal(codeReviewToolCatalog([]).length, 0);
    assert.throws(() => getCodeReviewTemplate('../code-review'), /不存在/);
    for (const template of listCodeReviewTemplates()) {
        const result = prepareSkillImport({ templateId: template.id, markdown: '伪造正文', tools: [read.name] }, catalog);
        assert.equal(result.preview.valid, true);
        const { manifest, instructions } = parseSkillSourceMarkdown(result.markdown);
        assert.deepEqual(manifest.tools, [read.name]);
        assert.deepEqual(manifest.capabilities, ['filesystem.read_workspace']);
        assert.equal(manifest.importSource.originalFields.metadata.activation, 'explicit');
        assert.equal(result.tools[0].approvalRequired, true);
        assert.equal(manifest.license, 'MIT');
        assert.match(manifest.importSource.originalFields.metadata['license-notice'], /Copyright \(c\) 2026 DietrichGebert/);
        assert.match(instructions, /不执行代码或测试/);
        assert.doesNotMatch(instructions, /伪造正文/);
        assert.throws(() => prepareSkillImport({ templateId: template.id, tools: ['mcp.7.workspace.patch'] }, catalog), /不可用或无权/);
        assert.throws(() => prepareSkillImport({ templateId: template.id, tools: [read.name] }, []), /不可用或无权/);
    }
});

test('审查指引可经现有验证发布与运行上下文读取，显式标记排除自动匹配', async () => {
    const user = await queryOne('SELECT id, username, role, unit FROM users ORDER BY id LIMIT 1');
    const title = `显式审查${Date.now()}${process.pid}`;
    const proposal = prepareSkillImport({ templateId: 'code-review', title, tools: [read.name] }, catalog);
    const { manifest, instructions } = parseSkillSourceMarkdown(proposal.markdown);
    const automatic = globalThis.structuredClone(manifest);
    automatic.id += '-auto'; automatic.name += '-auto';
    delete automatic.importSource.originalFields.metadata.activation;
    const baseline = await createSkillVersionFromMarkdown(user, { markdown: buildSkillSourceMarkdown(automatic, instructions) });
    assert.equal((await validateSkillVersion(baseline.version.id, user)).passed, true);
    const baselineRelease = await publishSkillVersion(baseline.version.id, user, { scope: 'personal' });
    assert.equal((await findBestPersonalSkill(user, title)).id, baselineRelease.id);
    const result = await createSkillVersionFromMarkdown(user, { markdown: proposal.markdown });
    assert.equal((await validateSkillVersion(result.version.id, user)).passed, true);
    const release = await publishSkillVersion(result.version.id, user, { scope: 'personal' });
    assert.equal((await findBestPersonalSkill(user, title)).id, baselineRelease.id);
    const context = await getAgentSkillExecutionContext(user, release.name);
    assert.match(context.skillInstructions, /代码变更审查/);
    assert.deepEqual(context.skillTools, [read.name]);
    assert.deepEqual(context.skillCapabilities, ['filesystem.read_workspace']);
});
