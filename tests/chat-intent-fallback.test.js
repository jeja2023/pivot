'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { applyAutomaticExecutionDecision } = require('../server/services/chat-route-correction');
const { buildIntentFallback, TEXT_ONLY_FALLBACK_INSTRUCTIONS } = require('../server/services/chat-intent-fallback');
const input = { prompt: '', user: { id: 9 }, userMessageId: 11, sessionId: 'fallback', modelCfg: { id: 8 } };
const config = { mode: 'active', timeoutMs: 20, rolloutPercent: 100 };

test('明确的脚本、写作和执行请求遇到意图故障后均只提供文本，不误问处理范围', async () => {
    for (const prompt of ['生成一个贪吃蛇的python脚本', '生成一个python脚本，内容是贪吃蛇游戏', '请分析附件并生成风险报告', '请修改项目代码并部署', '查询昨天订单并发送报告']) {
        const result = await resolveChatIntent({ ...input, prompt }, { config, callModelJson: async () => { throw new Error('上游不可用'); }, recordDecision() {} });
        assert.equal(result.action, 'direct_answer', prompt);
        assert.equal(result.question, ''); assert.equal(result.delegated, false); assert.equal(result.continuationOf, null);
        assert.deepEqual(result.requiredCapabilities, []); assert.equal(result.routing.tools, 'none'); assert.equal(result.routing.knowledge, 'none');
        assert.equal(result.failureCode, 'intent_provider_unavailable'); assert.equal(result.textOnlyFallback, true);
    }
    assert.match(TEXT_ONLY_FALLBACK_INSTRUCTIONS, /代码示例/); assert.match(TEXT_ONLY_FALLBACK_INSTRUCTIONS, /不调用工具/);
});

test('超时与无效契约仍有故障标记，不能恢复历史任务权限或仅规划限制', async () => {
    const result = await resolveChatIntent({ ...input, prompt: '继续修改并运行脚本', history: [{ role: 'user', content: '请修改项目代码' }], tasks: [{ id: 'old', active: true }] }, {
        config, callModelJson: async () => new Promise(() => {}), recordDecision() {}
    });
    assert.equal(result.failureCode, 'intent_timeout'); assert.equal(result.action, 'direct_answer'); assert.equal(result.continuation, false);
    const invalid = await resolveChatIntent({ ...input, prompt: '生成一个脚本' }, { config, callModelJson: async () => '{', recordDecision() {} });
    assert.equal(invalid.failureCode, 'intent_invalid_contract'); assert.equal(invalid.routing.allowAutomaticRead, false);
    const planned = buildIntentFallback({ action: 'plan_only', objective: '仅提供计划' });
    assert.equal(planned.action, 'plan_only'); assert.equal(planned.routing.tools, 'none');
});

test('文本降级显式关闭已启用的工具、强制检索与手动工具覆盖，仅影响当前请求', () => {
    const state = { modelContent: '生成一个脚本', mcpEnabled: true, ragEnabled: true, routeOverrides: { forceRag: true, tools: ['mcp.1.write'] } };
    const result = applyAutomaticExecutionDecision(state, buildIntentFallback({ action: 'agent_run', requiredCapabilities: ['filesystem.write_workspace'] }));
    assert.equal(result.mcpEnabled, false); assert.equal(result.ragEnabled, false);
    assert.equal(state.routeOverrides.excludeTools, true); assert.equal(state.routeOverrides.forceRag, false);
    assert.deepEqual(state.routeOverrides.tools, []); assert.deepEqual(state.automaticReadCapabilities, []);
});

test('上下文读取故障仍保留本轮文本回复路径，诊断日志不包含请求正文', async () => {
    const warnings = [];
    const result = await decideAutomaticChatExecution({ ...input, userId: 9, modelContent: '生成脚本：不可记录的正文', sessionsRepository: { listMessages: async () => { throw new Error('上下文不可用'); } }, log: { warn: (...args) => warnings.push(args) } });
    assert.equal(result.action, 'direct_answer'); assert.equal(result.failureCode, 'intent_context_unavailable');
    assert.doesNotMatch(JSON.stringify(warnings), /不可记录的正文/);
});
