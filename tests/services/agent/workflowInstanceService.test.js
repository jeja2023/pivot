const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { workflowInstanceService } = require('../../../server/services/agent/workflowInstanceService');
const { WorkflowTemplateService } = require('../../../server/services/agent/workflowTemplateService');

describe('WorkflowInstanceService Tests', () => {
  it('should list template instances with pagination', async () => {
    const result = await workflowInstanceService.listInstances({
      page: 1,
      pageSize: 5
    });

    assert.ok(result, 'Result should exist');
    assert.ok(Array.isArray(result.instances), 'instances should be an array');
    assert.strictEqual(typeof result.total, 'number', 'total should be a number');
  });
  it('实例创建将模板和变量交给当前模板服务', async () => {
    const original = WorkflowTemplateService.applyTemplate;
    let actual;
    WorkflowTemplateService.applyTemplate = async (...args) => { actual = args; return { id: 42 }; };
    try {
      const result = await workflowInstanceService.createInstance({ template_id: 7, variables: { name: '测试' }, created_by: 3, name: '流程' });
      assert.equal(result.id, 42);
      assert.deepEqual(actual, [7, { name: '测试' }, 3, '流程']);
    } finally { WorkflowTemplateService.applyTemplate = original; }
  });

});
