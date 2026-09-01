const assert = require('node:assert/strict');
const test = require('node:test');
const { backoff, chunkText, deliveryIdempotencyKey, normalizeAttachments } = require('../server/services/agent-channel-adapters');
const { normalizeRollout } = require('../server/services/agent-releases');
const { normalizeReliabilitySignal } = require('../server/services/agent-tool-reliability');
const { normalizeTriggerSpec } = require('../server/services/agent-goals');

test('channel delivery chunks bounded messages and keeps idempotency stable', () => {
    assert.equal(chunkText('abcdef', 2).length, 3);
    assert.equal(deliveryIdempotencyKey({ idempotencyKey: 'x' }), 'x');
    assert.ok(backoff(2) >= 1000);
    assert.equal(normalizeAttachments([{ name: 'a.txt', url: 'https://example.test/a', bytes: 10 }]).length, 1);
});

test('release rollout is bounded and scoped', () => {
    // 落地方案 v1.2 §6.3：target_units 由 user.unit 字符串迁移为 team_id 引用，
    // 熔断阈值在发布时冻结并随灰度输入一起规范化。
    const rollout = normalizeRollout({ scope: 'team', rolloutPercent: 125, targetUserIds: ['1', 1, 0], targetTeamIds: ['9', 9, 0, 'x'], teamId: '9' });
    assert.equal(rollout.rolloutScope, 'team');
    assert.equal(rollout.rolloutPercent, 100);
    assert.deepEqual(rollout.targetUserIds, [1]);
    assert.deepEqual(rollout.targetUnits, [9]);
    assert.equal(rollout.teamId, 9);
    assert.equal(rollout.breakerThresholds.minSamples > 0, true);
    assert.equal(rollout.breakerThresholds.policyDenyRate <= 1, true);
    // 历史 scope 词汇仍可读入并映射到新枚举。
    assert.equal(normalizeRollout({ scope: 'global' }).rolloutScope, 'organization');
    assert.equal(normalizeRollout({}).rolloutScope, 'personal');
});

test('reliability signals preserve minimum sample confidence', () => {
    assert.equal(normalizeReliabilitySignal({ toolName: 'x', toolVersion: '1', taskType: 'standard', sampleCount: 2 }).confidence, 0);
});

test('goal webhook trigger requires explicit token and supports replay controls', () => {
    assert.throws(() => normalizeTriggerSpec({ type: 'webhook' }), /访问令牌/);
    const spec = normalizeTriggerSpec({ type: 'webhook', token: 'agt_production-token-123456789' });
    assert.equal(spec.replayWindowSeconds, 300);
});

test('file and database goal triggers are normalized as governed read-only sources', () => {
    const { normalizeTriggerSpec } = require('../server/services/agent-goals');
    assert.equal(normalizeTriggerSpec({ type: 'file', directory: 'C:/reports' }).type, 'file');
    assert.throws(() => normalizeTriggerSpec({ type: 'database', query: "DELETE FROM x WHERE updated_at > '{{watermark}}'" }), /只读/);
    assert.equal(normalizeTriggerSpec({ type: 'database', query: "SELECT * FROM x WHERE updated_at > '{{watermark}}'" }).type, 'database');
});
