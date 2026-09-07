'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    AGENT_MODEL_REQUEST_TIMEOUT_MS,
    resolveAgentPlanningThinking,
    resolveAgentRequestTimeoutMs
} = require('../server/services/agent-model');

test('Agent 模型请求时限独立配置且不再固定为 180 秒', () => {
    assert.ok(AGENT_MODEL_REQUEST_TIMEOUT_MS >= 30_000);
    assert.equal(resolveAgentRequestTimeoutMs({ timeoutMs: 45_000 }), 45_000);
    assert.equal(resolveAgentRequestTimeoutMs({ timeoutMs: 0 }), AGENT_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(resolveAgentRequestTimeoutMs({ timeoutMs: 9_000_000 }), 60 * 60 * 1000);
});

test('工具规划默认关闭思维链，最终回答仍可沿用模型的思考配置', () => {
    const reasoningModel = { model_name: 'Qwen3.5-35B', supports_reasoning: 1, chat_thinking_enabled: 1 };
    assert.equal(resolveAgentPlanningThinking(reasoningModel), false);
    assert.equal(resolveAgentPlanningThinking(reasoningModel, { enableThinking: true }), true);
});

test('聊天 Agent 任务不再将最终提示文本长度伪装为模型吞吐率', () => {
    const root = path.resolve(__dirname, '..');
    const bridge = fs.readFileSync(path.join(root, 'server', 'services', 'chat-agent-bridge.js'), 'utf8');
    const engine = fs.readFileSync(path.join(root, 'client', 'chat', 'engine.js'), 'utf8');
    const streamView = fs.readFileSync(path.join(root, 'client', 'chat', 'engine-streaming.js'), 'utf8');
    assert.match(bridge, /updateAssistantStats\(\{ messageId, costTime, tps: null \}\)/);
    assert.match(engine, /renderAgentTaskStats/);
    assert.match(streamView, /模型未返回可计量输出/);
    assert.match(engine, /调整方向/);
    assert.match(engine, /\/control-messages/);
    const runActions = fs.readFileSync(path.join(root, 'client', 'chat', 'agent-run-actions.js'), 'utf8');
    const runDetail = fs.readFileSync(path.join(root, 'client', 'chat', 'agent-run-detail.js'), 'utf8');
    assert.match(runActions, /steerAgentRun/);
    assert.match(engine, /showInputPrompt/);
    assert.doesNotMatch(engine, /steerChatAgentRun[\s\S]*window\.prompt/);
    assert.match(runActions, /showInputPrompt/);
    assert.doesNotMatch(runActions, /steerAgentRun[\s\S]*window\.prompt/);
    assert.match(runDetail, /data-agent-steer/);
});
