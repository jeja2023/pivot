'use strict';

const assert = require('node:assert/strict');

async function prepareGoalTestModel(page) {
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const response = await page.request.post('/api/models', {
        headers: { 'x-csrf-token': csrf },
        data: { name: `持续目标测试模型-${Date.now()}`, url: process.env.E2E_MODEL_URL, model_name: 'goal-model-e2e' }
    });
    assert.ok(response.ok(), await response.text());
}

module.exports = { prepareGoalTestModel };
