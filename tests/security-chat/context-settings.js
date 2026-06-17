// 模型上下文设置单测：context_window_tokens 生效、无界判定、Agent 输出上限解析。
// 由 security-chat.test.js 统一加载。
const { assert, test } = require('../security-helpers');
const { getModelContextBudget } = require('../../server/services/context-budget');
const { resolveAgentMaxTokens } = require('../../server/services/agent-model');
const { validateModelTokenSettings, normalizeModelTokenLimit } = require('../../server/services/models');

test('context_window_tokens 直接决定上下文窗口与输入预算', () => {
    const b = getModelContextBudget({ context_window_tokens: 32768, max_tokens: 2000 });
    assert.equal(b.unbounded, false);
    assert.equal(b.contextWindow, 32768);
    // 输入预算 = 窗口 - 预留输出 - 安全余量
    assert.ok(b.inputBudget > 0 && b.inputBudget < 32768);
    assert.ok(b.inputBudget <= 32768 - 2000);
});

test('仅配置 max_input_tokens 时由其推导窗口', () => {
    const b = getModelContextBudget({ max_input_tokens: 8000 });
    assert.equal(b.unbounded, false);
    assert.equal(b.inputBudget, 8000);
    assert.ok(b.contextWindow > 8000);
});

test('context_window_tokens 与 max_input_tokens 同时存在时输入预算取两者较小', () => {
    const b = getModelContextBudget({ context_window_tokens: 32768, max_input_tokens: 4000, max_tokens: 1000 });
    assert.equal(b.contextWindow, 32768);
    assert.equal(b.inputBudget, 4000);
});

test('两个上下文字段都未配置时预算为无界', () => {
    const b = getModelContextBudget({});
    assert.equal(b.unbounded, true);
    assert.equal(b.inputBudget, Number.MAX_SAFE_INTEGER);
});

test('resolveAgentMaxTokens 优先显式值，其次模型配置，最后回退 1200', () => {
    assert.equal(resolveAgentMaxTokens({ max_tokens: 4096 }, { maxTokens: 500 }), 500);
    assert.equal(resolveAgentMaxTokens({ max_tokens: 4096 }, {}), 4096);
    assert.equal(resolveAgentMaxTokens({}, {}), 1200);
    assert.equal(resolveAgentMaxTokens({ max_tokens: null }, {}), 1200);
    assert.equal(resolveAgentMaxTokens({ max_tokens: 0 }, {}), 1200);
});

test('normalizeModelTokenLimit 范围校验：留空/0 为 null，负数与非数字与超限报错', () => {
    assert.deepEqual(normalizeModelTokenLimit('', 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(undefined, 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(0, 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(8000, 'x'), { value: 8000 });
    assert.ok(normalizeModelTokenLimit(-1, '输出').error);
    assert.ok(normalizeModelTokenLimit('abc', '输入').error);
    assert.ok(normalizeModelTokenLimit(99999999, '窗口').error);
});

test('validateModelTokenSettings 拦截负数/非法值，避免异常 token 入库并被转发上游', () => {
    assert.ok(validateModelTokenSettings({ max_tokens: -500 }).error);
    assert.ok(validateModelTokenSettings({ max_input_tokens: 'abc' }).error);
    const ok = validateModelTokenSettings({ max_input_tokens: 8000, max_tokens: 2000, context_window_tokens: 32768 });
    assert.deepEqual(ok.values, { maxInputTokens: 8000, maxTokens: 2000, contextWindowTokens: 32768 });
});

test('validateModelTokenSettings 关系校验：输入/输出上限须小于上下文窗口', () => {
    assert.ok(validateModelTokenSettings({ max_input_tokens: 40000, context_window_tokens: 32768 }).error);
    assert.ok(validateModelTokenSettings({ max_tokens: 40000, context_window_tokens: 32768 }).error);
    // 未设窗口时不做关系校验
    assert.ok(!validateModelTokenSettings({ max_input_tokens: 40000 }).error);
});
