'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { archiveOlderObservations, readHistory } = require('../server/services/presentations/master/history');
const { phaseMessages } = require('../server/services/presentations/master/phase-context');
const { estimateMessagesTokens } = require('../server/services/context-budget');

test('长任务归档旧观察后保留用户答复、近期动作和原始内容，按页恢复并拒绝损坏', async () => {
    const state = { messages: [{ role: 'system', content: '安全指引' }, { role: 'user', content: '用户要求保留金额与来源' }] };
    for (let i = 0; i < 12; i++) {
        state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read', path: `inputs/${i}.md` }] }) });
        state.messages.push({ role: 'user', content: JSON.stringify([{ action: 'read', result: { path: `inputs/${i}.md`, offset: 0, text: '资料🧭'.repeat(18000), nextOffset: null } }]) });
    }
    const original = JSON.parse(JSON.stringify(state.messages)), index = 3, expected = original[index].content;
    assert.ok(JSON.stringify(state.messages).length > 650000);
    assert.equal(await archiveOlderObservations(state), true);
    assert.ok(JSON.stringify(state.messages).length < 650000);
    assert.equal(state.messages[1].content, original[1].content);
    assert.equal(state.messages.at(-1).content, original.at(-1).content);
    const marker = JSON.parse(state.messages[index].content)[0].result.archived;
    let restored = '', offset = 0;
    do {
        const page = await readHistory(state, { archive: marker.archive, index: marker.index, offset, length: 12000 });
        restored += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(restored, expected);
    assert.ok(estimateMessagesTokens(state.messages) < estimateMessagesTokens(original));
    await assert.rejects(() => readHistory(state, { archive: 99, index: 0 }), /不存在/);
    await assert.rejects(() => readHistory(state, { archive: 0, index: 1 }), /不存在/);
    state.historyArchives[0].sha256 = '0'.repeat(64);
    await assert.rejects(() => readHistory(state, { archive: 0, index }), /摘要/);
});

test('超出旧大小限制的检查点可归档并续跑，模型可通过动作读取历史而不重新执行文件操作', async () => {
    const { drive } = require('../server/services/presentations/master/driver');
    const state = { bootstrapped: true, steps: 12, usedTokens: 1000, request: { operation: 'generate', profile: 'quick',
        inputFiles: [], materials: [], maxSteps: 20, tokenBudget: 1000000 }, messages: [{ role: 'system', content: '安全约束' }] };
    for (let index = 0; index < 12; index++) {
        state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read', path: `inputs/${index}.md` }] }) });
        state.messages.push({ role: 'user', content: JSON.stringify([{ action: 'read', result: { path: `inputs/${index}.md`, text: '关键事实'.repeat(18000) } }]) });
    }
    assert.ok(JSON.stringify(state.messages).length > 650000);
    const snapshots = [], operations = [];
    const hooks = { ensureCurrent: async () => {}, checkpoint: async value => snapshots.push(JSON.parse(JSON.stringify(value))) };
    let calls = 0;
    const result = await drive({ id: 1 }, 'test', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 1000000 }),
        execute: async (_user, _id, action) => { operations.push(action.action); return { packageCheck: { status: 'passed' } }; },
        callModel: async (_model, messages, options) => {
            options.usageRef.usage = { prompt_tokens: 100, completion_tokens: 10 };
            calls++;
            if (calls === 1) {
                assert.ok(snapshots[0].historyArchives.length);
                return { actions: [{ action: 'read_history', archive: 0, index: 2, offset: 0, length: 100 }] };
            }
            assert.match(messages.at(-1).content, /关键事实/);
            return { complete: { path: 'project/exports/final.pptx' } };
        }
    });
    assert.equal(result.receipt.packageCheck.status, 'passed');
    assert.deepEqual(operations, ['deliver']);
    assert.equal(state.usedTokens, 1220);
});

test('已确认且同一项目的设计文件经校验回执后仅收起固定版本前置章节', t => {
    const file = path.join(__dirname, '../artifacts/ppt-master-runtime/skill/workflows/generate-pptx.md');
    if (!fs.existsSync(file)) return t.skip('未准备固定 PPT Master 运行包');
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const write = (name, value) => [{ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path: `project/${name}`, text: value }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', result: { path: `project/${name}`, sha256: crypto.createHash('sha256').update(value).digest('hex') } }]) }];
    const validation = [{ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'run', tool: 'project', args: ['validate', 'project'] }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'run', result: { exitCode: 0 } }]) }];
    const original = [{ role: 'system', content: '安全边界' }, { role: 'user', content: JSON.stringify({ runtimeDocument: 'workflows/generate-pptx.md', text, nextOffset: null }) },
        ...write('design_spec.md', '设计规范'), ...write('spec_lock.md', '锁定内容'), ...validation,
        { role: 'user', content: '用户确认保留原始数据' }];
    const state = { request: { operation: 'generate', profile: 'default' }, confirmedGates: 2, messages: original };
    const result = phaseMessages(original, state), content = JSON.parse(result.messages[1].content).text;
    assert.match(content, /暂收起步骤1至3/);
    assert.match(content, /### Step 4: Strategist Phase/);
    assert.match(content, /### Step 6: Executor Phase/);
    assert.match(content, /### Step 7: Post-processing/);
    assert.equal(result.messages.at(-1).content, original.at(-1).content);
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(original));
    assert.equal(JSON.parse(original[1].content).text, text);
    assert.equal(phaseMessages(original, { ...state, confirmedGates: 1 }).messages[1], original[1]);
    assert.equal(phaseMessages(original, { ...state, request: { operation: 'generate', profile: 'quick' } }).messages[1], original[1]);
    const changed = original.map((message, index) => index === 1 ? { ...message, content: JSON.stringify({ runtimeDocument: 'workflows/generate-pptx.md', text: text + 'x', nextOffset: null }) } : message);
    assert.equal(phaseMessages(changed, state).messages[1], changed[1]);
    const failed = [...original, { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'run', tool: 'finalize', args: ['project'] }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'run', error: '执行状态不明' }]) }];
    assert.equal(phaseMessages(failed, { ...state, messages: failed }).messages[1], failed[1]);
    const wrong = original.map((message, index) => index === 3 ? { ...message, content: JSON.stringify([{ action: 'write', result: { path: 'project/design_spec.md', sha256: '0'.repeat(64) } }]) } : message);
    assert.equal(phaseMessages(wrong, { ...state, messages: wrong }).messages[1], wrong[1]);
    const changedLock = [...original, ...write('spec_lock.md', '修改后的设计')];
    assert.equal(phaseMessages(changedLock, { ...state, messages: changedLock }).messages[1], changedLock[1]);
    const resumed = [...original, { role: 'user', content: '宿主中断后从已保存检查点继续。先核对文件。' }, { role: 'assistant', content: '{}' }];
    assert.equal(phaseMessages(resumed, { ...state, messages: resumed }).messages[1], resumed[1]);
    const answered = [...original, { role: 'user', content: '用户对本次确认问题的实际答复：请调整方案' }];
    assert.equal(phaseMessages(answered, { ...state, messages: answered }).messages[1], answered[1]);
});
