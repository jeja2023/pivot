const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { WorkflowTemplateService } = require('../../../server/services/agent/workflowTemplateService');
const { queryOne, execute } = require('../../../server/db/client');

describe('WorkflowTemplateService Tests', () => {
  it('should list builtin workflow templates with pagination', async () => {
    const result = await WorkflowTemplateService.listTemplates({
      isBuiltin: true,
      limit: 10,
      page: 1
    });

    assert.ok(result, 'Result should exist');
    assert.ok(Array.isArray(result.templates), 'templates should be an array');
    assert.strictEqual(typeof result.pagination.total, 'number', 'total should be a number');
  });

  it('should resolve variable substitution correctly in templates', () => {
    const spec = {
      nodes: [
        { id: 'node_1', config: { query: '{{var.database_table}}' } }
      ]
    };
    const variables = { database_table: 'users' };
    const replaced = WorkflowTemplateService._replaceVariables(spec, variables);
    assert.strictEqual(replaced.nodes[0].config.query, 'users');
  });
  it('私有模板仅创建者可查阅，变量验证阻止缺失必填值', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const owner = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_owner_${suffix}`, 'hash']);
    const other = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_other_${suffix}`, 'hash']);
    try {
      const template = await WorkflowTemplateService.createTemplate({
        name: `私有模板 ${suffix}`, slug: `private-${suffix}`, isPublic: false,
        dagSpecTemplate: { nodes: [{ id: 'one', value: '{{var.name}}' }] },
        variables: [{ name: 'name', type: 'string', required: true }]
      }, Number(owner.id));
      const ownerList = await WorkflowTemplateService.listTemplates({ includePrivate: true, userId: Number(owner.id), search: suffix });
      assert.equal(ownerList.templates.some(item => item.id === template.id), true);
      const otherList = await WorkflowTemplateService.listTemplates({ includePrivate: true, userId: Number(other.id), search: suffix });
      assert.equal(otherList.templates.some(item => item.id === template.id), false);
      assert.equal((await WorkflowTemplateService.getTemplateDetail(template.id, Number(owner.id))).id, template.id);
      await assert.rejects(WorkflowTemplateService.getTemplateDetail(template.id, Number(other.id)), error => error.status === 403);
      await assert.rejects(WorkflowTemplateService.applyTemplate(template.id, {}, Number(owner.id)), /必填/);
    } finally {
      await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
  });

});
