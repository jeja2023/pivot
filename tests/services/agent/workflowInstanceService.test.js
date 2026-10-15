const assert = require('assert');
const { workflowInstanceService } = require('../../../server/services/agent/workflowInstanceService');

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
});
