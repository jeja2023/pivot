'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importTools, prepareSkillImport } = require('../server/services/agent-skill-import-assistant');
const catalog = [
    { name: 'rag.search', title: '知识库检索', capabilities: ['knowledge.search'], risk_level: 'low' },
    { name: 'mcp.8.browser.click', title: '点击网页', capabilities: ['network.browser_visit'], approval_required: true },
    { name: 'workspace.read', title: '不可直接调用' }
];

test('外部技能转换保留正文，明确忽略原始工具和额外字段，只使用用户选择的工具', () => {
    const input = { title: '制度摘要', tools: ['rag.search'], markdown: '---\nname: external-skill\ndescription: 查询制度\nallowed-tools: dangerous\nmetadata:\n  version: 2\n---\n\n# 步骤\n按资料回答。' };
    const result = prepareSkillImport(input, catalog);
    assert.equal(result.preview.valid, true);
    assert.match(result.markdown, /按资料回答/);
    assert.doesNotMatch(result.markdown, /allowed-tools|dangerous|metadata:/);
    assert.match(result.markdown, /knowledge.search/);
    assert.match(result.warnings.join(' '), /脚本、附件、依赖/);
    assert.match(result.warnings.join(' '), /allowed-tools/);
    assert.deepEqual(result.tools.map(tool => tool.name), ['rag.search']);
});

test('导入工具只能来自当前目录，并覆盖声明式工具权限', () => {
    assert.equal(importTools(catalog).some(tool => tool.name === 'workspace.read'), false);
    const result = prepareSkillImport({ title: '网页', markdown: '# 浏览网页', tools: ['mcp.8.browser.click'] }, catalog);
    assert.equal(result.preview.valid, true);
    assert.equal(result.tools[0].approvalRequired, true);
    assert.match(result.markdown, /network.browser_visit/);
    assert.throws(() => prepareSkillImport({ title: '测试', markdown: '# 内容', tools: ['mcp.99.unknown'] }, catalog), /不可用或无权/);
    assert.throws(() => prepareSkillImport({ title: '测试', markdown: '# 内容', tools: [] }, catalog), /请选择/);
});

test('拒绝空正文、重复键、别名和过大输入', () => {
    for (const markdown of ['---\nname: one\nname: two\n---\n内容', '---\nname: &value hello\n---\n内容', '---\nname: test\n---\n']) {
        assert.throws(() => prepareSkillImport({ title: '测试', markdown, tools: ['rag.search'] }, catalog));
    }
    assert.throws(() => prepareSkillImport({ title: '测试', markdown: 'x'.repeat(300000), tools: ['rag.search'] }, catalog), /过大/);
});
