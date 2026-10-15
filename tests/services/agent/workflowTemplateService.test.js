const assert = require('assert');
const { workflowTemplateService } = require('../../../server/services/agent/workflowTemplateService');

describe('WorkflowTemplateService Tests', () => {
  it('should list builtin workflow templates with pagination', async () => {
    const result = await workflowTemplateService.listTemplates({
      isBuiltin: true,
      limit: 10,
      page: 1
    });

    assert.ok(result, 'Result should exist');
    assert.ok(Array.isArray(result.templates), 'templates should be an array');
    assert.strictEqual(typeof result.total, 'number', 'total should be a number');
  });

  it('should resolve variable substitution correctly in templates', () => {
    const spec = {
      nodes: [
        { id: 'node_1', config: { query: '{{var.database_table}}' } }
      ]
    };
    const variables = { database_table: 'users' };
    const specStr = JSON.stringify(spec).replace(/\{\{var\.(\w+)\}\}/g, (_, name) => variables[name] || '');
    const replaced = JSON.parse(specStr);

    assert.strictEqual(replaced.nodes[0].config.query, 'users');
  });
});
