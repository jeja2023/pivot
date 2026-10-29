const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { workflowTemplateRatingService } = require('../../../server/services/agent/workflowTemplateRatingService');

describe('WorkflowTemplateRatingService Tests', () => {
  it('should get template ratings list with pagination', async () => {
    const result = await workflowTemplateRatingService.getTemplateRatings(1, {
      page: 1,
      pageSize: 5
    });

    assert.ok(result, 'Result should exist');
    assert.ok(Array.isArray(result.ratings), 'ratings should be an array');
    assert.strictEqual(typeof result.total, 'number', 'total should be a number');
  });
});
