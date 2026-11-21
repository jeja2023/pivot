'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { drive } = require('../server/services/presentations/master/driver');
const { initialMessages } = require('../server/services/presentations/master/host-protocol');
const { writeExample } = require('../server/services/presentations/master/action-parameters');
const { runModelTurn } = require('../server/services/presentations/master/model-turn');
const { reviewRecoveryGuidance } = require('../server/services/presentations/master/review-plan');
const { usageDiagnosticsView } = require('../server/services/presentations/master/observations');
const stateForTest = () => ({
    steps: 7, usedTokens: 0, bootstrapped: true, request: { operation: 'generate', profile: 'default', maxSteps: 80, tokenBudget: 0, materials: [] },
    messages: [{ role: 'system', content: '测试制作' }], review: { approvals: {} }
});
const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
const model = { context_window_tokens: 256000, max_tokens: 18000 };
const write = { action: 'write', path: 'project/spec_lock.md', text: '完整规范\n第二行' };
const record = (role, value) => ({ role, content: JSON.stringify(value) });

test('写入只接纳含义明确的完整文本和路径，按动作拒绝混用字段与部分写入', async () => {
    const state = stateForTest(), validate = action => validateTurn({ actions: [action] }, state);
    const alias = { action: 'write', filePath: write.path, file_path: write.path, content: write.text, encoding: 'utf8', append: false,
        message: '本轮说明', offset: 0, tool: '', args: [] };
    assert.deepEqual((await validate(alias)).actions, [write]);
    assert.equal(alias.text, undefined);
    for (const [action, key] of [
        [{ ...write, content: '另一份正文' }, 'content'], [{ ...write, file_path: 'project/other.md' }, 'file_path'],
        [{ ...write, encoding: 'utf-16le' }, 'encoding'], [{ ...write, append: true }, 'append'],
        [{ ...write, offset: 1 }, 'offset'], [{ ...write, savedContent: '历史回执' }, 'savedContent'],
        [{ ...write, args: ['写入选项'] }, 'args'], [{ action: 'list', path: 'project' }, 'path'],
        [{ action: 'read', path: 'project/spec_lock.md', text: '正文' }, 'text']
    ]) {
        await assert.rejects(validate(action), error => {
            assert.equal(error.code, 'PPT_MASTER_ACTION_INVALID');
            assert.equal(error.actionIndex, 1);
            assert.deepEqual(error.rejectedFields, [key]);
            return true;
        });
    }
    await assert.rejects(validate({ ...alias, filePath: 'inputs/material-1.md', file_path: 'inputs/material-1.md' }), /不能覆盖输入/);
});

test('错误写入整批拒绝且仅纠正一次，两次诊断可读并可从旧错误续作', async () => {
    const state = stateForTest();
    let executed = 0, calls = 0;
    const privateKey = '客户材料中的名字', privateValue = '测试材料中的私有正文';
    await assert.rejects(drive({ id: 1 }, 'fixture', state, hooks, {
        resolveModel: async () => model, execute: async () => { executed++; return {}; },
        callModel: async (_model, messages) => {
            if (++calls === 2) {
                assert.ok(messages[0].content.includes(writeExample));
                assert.match(messages[0].content, /第 2 项 write.*append.*第5个键/);
                assert.ok(!messages[0].content.includes(privateKey) && !messages[0].content.includes(privateValue));
            }
            return { actions: [{ ...write, path: 'project/design_spec.md' }, { ...write, append: true, [privateKey]: privateValue }] };
        }
    }), { code: 'PPT_MASTER_ACTION_INVALID', actionIndex: 2 });
    assert.deepEqual([calls, executed, state.steps, state.actionRetries], [2, 0, 7, 1]);
    const diagnostics = usageDiagnosticsView(state);
    assert.deepEqual(diagnostics.map(d => d.outcome), ['retry', 'failed']);
    for (const item of diagnostics) {
        assert.deepEqual(item.rejectedFields, ['append', '第5个键']);
        assert.match(item.fieldMessage, /append.*第5个键.*action、path、text/);
    }
    assert.ok(!JSON.stringify(state).includes(privateKey) && !JSON.stringify(state).includes(privateValue));
    assert.ok(reviewRecoveryGuidance(state, 'PPT_MASTER_ACTION_INVALID', '同批第 1 项 write 含不支持的参数。请仅提交 action、path、text。').includes(writeExample));
    const legacy = { usageDiagnostics: [{ call: 1, step: 1, turnSummary: {
        outcome: 'failed', correctionKind: 'action_fields', actionIndex: 1, actionType: 'write'
    } }] };
    assert.equal(usageDiagnosticsView(legacy)[0].fieldMessage, undefined);
});

test('新任务和旧检查点向模型提供独立的写入示例，已确认回执脱离可执行动作', async () => {
    const state = stateForTest();
    const legacyExample = '{"message":"简短中文进度","actions":[{"action":"read_runtime|read_history|read_images|list|read|write|run|copy|copy_template|validate_template","path":"相对路径","offset":0,"text":"完整文本","tool":"已登记工具ID","args":["参数"]}]}';
    const current = initialMessages(state.request)[0].content;
    assert.ok(current.includes(writeExample) && !current.includes(legacyExample));
    const receipt = { action: 'write', result: { path: write.path, sha256: createHash('sha256').update(write.text).digest('hex') } };
    const mixed = { action: 'run', tool: 'project', args: ['validate', 'project'] };
    state.messages = [
        { role: 'system', content: '原检查点约束。只返回一个JSON对象：' + legacyExample },
        record('assistant', { actions: [write, mixed] }), record('user', [receipt, { action: 'run', result: { exitCode: 1 } }]),
        record('assistant', { actions: [{ action: 'write', path: write.path, savedContent: '已成功写入；历史原文可调用 read_history，archive=2、index=9；当前文件可使用 read 读取。' }] }),
        record('user', [receipt]), record('assistant', { actions: [write] }), record('user', [receipt])
    ];
    const before = JSON.stringify(state.messages);
    await runModelTurn({ id: 1 }, 'fixture', state, model, hooks, { callModel: async (_model, messages) => {
        assert.match(messages[0].content, /原检查点约束/);
        assert.ok(messages[0].content.includes(writeExample) && !messages[0].content.includes(legacyExample));
        assert.deepEqual(JSON.parse(messages[1].content).actions, [mixed]);
        assert.match(messages[1].content, /第 1 项 project\/spec_lock.md/);
        assert.equal(messages[2].content, state.messages[2].content);
        assert.equal(messages[3].role, 'user');
        assert.match(messages[3].content, /archive=2、index=9/);
        assert.doesNotMatch(JSON.stringify(messages), /savedSha256|savedContent/);
        assert.deepEqual(JSON.parse(messages[5].content).actions, [write]);
        return '{}';
    } });
    assert.equal(JSON.stringify(state.messages), before);
});
