'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chooseModel, isRecoverableModelProviderFailure, modelProviderFailureReason, pickAutoQuality, pickEscalationModel, pickFailoverModel } = require('../server/services/model-router');
const { assessModelQualityProfile, inferTaskType } = require('../server/services/agent-model-quality');

test('quality-aware routing selects the best eligible verified profile', () => {
    const choice = pickAutoQuality([
        { id: 1, max_input_tokens: 32000, input_price_per_million: 1, output_price_per_million: 1 },
        { id: 2, max_input_tokens: 32000, input_price_per_million: 2, output_price_per_million: 2 }
    ], [
        { modelId: 1, eligible: true, verifiedRate: 0.8, incompleteRate: 0.2, samples: 12 },
        { modelId: 2, eligible: true, verifiedRate: 0.9, incompleteRate: 0.1, samples: 8 }
    ], 100);
    assert.equal(choice.id, 2);
    assert.equal(pickAutoQuality([{ id: 1 }], [{ modelId: 1, eligible: false }], 1), null);
});

test('task type inference separates research and data analysis from general tasks', () => {
    assert.equal(inferTaskType({ goal: '检索知识库并给出引用' }), 'research');
    assert.equal(inferTaskType({ goal: '分析数据库 SQL 数据' }), 'analysis');
    assert.equal(inferTaskType({ goal: '普通问答' }), 'general');
});

test('quality profiles require sufficient, fresh evidence and a conservative pass bound', () => {
    const now = new Date('2026-10-18T00:00:00.000Z');
    const passing = assessModelQualityProfile({ samples: 60, verified: 55, partial: 3, failed: 2, updatedAt: now.toISOString() }, { now });
    assert.equal(passing.eligible, true);
    assert.equal(passing.status, 'passing');
    assert.ok(passing.verifiedRateLowerBound >= passing.thresholds.verifiedRateLowerBound);

    const insufficient = assessModelQualityProfile({ samples: 12, verified: 12, updatedAt: now.toISOString() }, { now });
    assert.equal(insufficient.eligible, false);
    assert.equal(insufficient.blockers.includes('sample_insufficient'), true);

    const stale = assessModelQualityProfile({ samples: 60, verified: 59, updatedAt: '2026-08-01T00:00:00.000Z' }, { now });
    assert.equal(stale.eligible, false);
    assert.equal(stale.blockers.includes('profile_stale'), true);
});

test('自动模型路由同时满足视觉能力和输入窗口，不因成本选择不兼容模型', async () => {
    const candidates = [
        { id: 1, name: '文本低价', supports_vision: false, max_input_tokens: 8000, input_price_per_million: 1, output_price_per_million: 1 },
        { id: 2, name: '视觉小窗口', supports_vision: true, max_input_tokens: 1000, input_price_per_million: 2, output_price_per_million: 1 },
        { id: 3, name: '视觉大窗口', supports_vision: true, max_input_tokens: 3000, input_price_per_million: 3, output_price_per_million: 1 }
    ];
    const imageMessage = [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }, { type: 'text', text: 'x'.repeat(4000) }]
    }];
    const costChoice = await chooseModel({ user: { id: 7 }, strategy: 'auto-cost', messages: imageMessage, candidateModels: candidates });
    const visionChoice = await chooseModel({ user: { id: 7 }, strategy: 'auto-vision', messages: imageMessage, candidateModels: candidates });
    assert.equal(costChoice.model.id, 3);
    assert.equal(visionChoice.model.id, 3);
});

test('auto-escalate 跳过更贵但更弱的候选，选择实际可升级的模型', async () => {
    const choice = await pickEscalationModel({
        user: { id: 7 },
        currentModel: { id: 1, max_input_tokens: 1000, input_price_per_million: 10, output_price_per_million: 0 },
        messages: [{ role: 'user', content: '请完成任务' }],
        candidateModels: [
            { id: 2, max_input_tokens: 500, input_price_per_million: 12, output_price_per_million: 0 },
            { id: 3, max_input_tokens: 2000, input_price_per_million: 8, output_price_per_million: 0 }
        ]
    });
    assert.equal(choice.id, 3);
});

test('提供方暂时故障只在自动路由下选择兼容候选，不把取消或预算错误伪装成降级', async () => {
    const candidates = [
        { id: 1, max_input_tokens: 8000, input_price_per_million: 1, output_price_per_million: 1 },
        { id: 2, max_input_tokens: 8000, input_price_per_million: 2, output_price_per_million: 2 },
        { id: 3, supports_vision: false, max_input_tokens: 8000, input_price_per_million: 0.5, output_price_per_million: 0.5 }
    ];
    const fallback = await pickFailoverModel({ user: { id: 7 }, currentModel: candidates[0], messages: [{ role: 'user', content: '完成任务' }], candidateModels: candidates });
    assert.equal(fallback.id, 2);
    assert.equal(isRecoverableModelProviderFailure({ code: 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT' }), true);
    assert.equal(isRecoverableModelProviderFailure({ response: { status: 503 } }), true);
    const unsupportedStructuredOutput = {
        response: { status: 400, data: { error: { message: 'response_format json_schema is not supported by this endpoint' } } }
    };
    assert.equal(isRecoverableModelProviderFailure(unsupportedStructuredOutput), true);
    assert.equal(modelProviderFailureReason(unsupportedStructuredOutput), 'structured_output_incompatible');
    assert.equal(isRecoverableModelProviderFailure({ response: { status: 400, data: { error: { message: 'input is invalid' } } } }), false);
    assert.equal(isRecoverableModelProviderFailure({ code: 'AGENT_RUN_CANCELLED' }), false);
    assert.equal(isRecoverableModelProviderFailure({ code: 'AGENT_BUDGET_EXCEEDED' }), false);
});
