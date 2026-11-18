'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { archiveOlderObservations, readHistory } = require('../server/services/presentations/master/history');
const { phaseMessages } = require('../server/services/presentations/master/phase-context');
const { estimateMessagesTokens } = require('../server/services/context-budget');

function referenceCheckpoint(turns, pageLength) {
    const messages = [{ role: 'system', content: '原始制作指引' }, { role: 'user', content: '保留材料中的金额和来源' }];
    for (let index = 0; index < turns; index++) {
        const page = { path: `references/${index}.md`, offset: 0, length: pageLength };
        messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read_runtime', ...page }] }) });
        messages.push({ role: 'user', content: JSON.stringify([{ action: 'read_runtime', result: {
            path: page.path, text: '制作流程'.repeat(pageLength / 4), offset: 0, nextOffset: pageLength
        } }]) });
    }
    return { bootstrapped: true, steps: turns, usedTokens: 1184708, confirmedGates: 2, request: { operation: 'generate', profile: 'default',
        inputFiles: [], materials: [], maxSteps: 80, tokenBudget: 10000000 }, messages };
}

test('256K 模型从连续 28 步指引读取后的检查点继续，保留确认和分页并执行文件写入', async t => {
    const directory = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'pivot-ppt-history-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    const { drive } = require('../server/services/presentations/master/driver');
    const { actionSummary } = require('../server/services/presentations/master/observations');
    const state = referenceCheckpoint(28, 5000);
    state.messages.push({ role: 'user', content: '用户对本次确认问题的实际答复：保留原有口径。' });
    const sourcePage = state.messages[3].content, file = path.join(directory, 'page.svg');
    assert.ok(estimateMessagesTokens(state.messages) > 256000);
    assert.ok(JSON.stringify(state.messages).length < 500000);
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    let calls = 0;
    await drive({ id: 1 }, 'fixture', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000, max_tokens: 12000 }),
        callModel: async (_model, messages, options) => {
            assert.ok(estimateMessagesTokens(messages) + options.maxTokens + 256 <= 256000);
            assert.match(messages[0].content, /原始制作指引/);
            assert.ok(messages.some(message => message.content.includes('保留原有口径。')));
            assert.equal(options.maxTokens, 12000);
            calls++;
            if (calls === 1) {
                const page = JSON.parse(messages[3].content)[0].result;
                assert.equal(page.path, 'references/0.md');
                assert.equal(page.nextOffset, 5000);
                assert.equal((await readHistory(state, page.archived)).text, sourcePage);
                return { actions: [{ action: 'write', path: 'project/svg_output/page.svg', text: '<svg/>' }] };
            }
            return { complete: { path: 'project/exports/final.pptx' } };
        },
        execute: async (_user, _id, action) => {
            if (action.action === 'deliver') return { packageCheck: { status: 'passed' } };
            assert.equal(action.action, 'write');
            await fs.promises.writeFile(file, action.text, { flag: 'wx' });
            return { path: action.path, sha256: crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex') };
        }
    });
    assert.equal(calls, 2);
    assert.equal(state.confirmedGates, 2);
    assert.deepEqual(actionSummary(state.messages), { writes: 1, failedWrites: 0, runtimeReads: 28, lastWrittenPath: 'project/svg_output/page.svg', lastActions: [{ action: 'write', failed: false }] });
});

test('供应商拒绝上下文时只在归档确实缩小请求后重试，超时与限流各只调用一次', async () => {
    const { drive } = require('../server/services/presentations/master/driver');
    const { AbortSignal } = globalThis;
    const hooks = { signal: AbortSignal.timeout(10000), ensureCurrent: async () => {}, checkpoint: async () => {} };
    const model = { context_window_tokens: 256000, max_tokens: 12000 };
    const upstream = () => Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { code: 'context_length_exceeded' } } } });
    const state = referenceCheckpoint(5, 4000), estimates = [];
    let executed = 0;
    await drive({ id: 1 }, 'fixture', state, hooks, {
        resolveModel: async () => model,
        callModel: async (_model, messages) => {
            estimates.push(estimateMessagesTokens(messages));
            if (estimates.length === 1) throw upstream();
            return { complete: { path: 'project/exports/final.pptx' } };
        },
        execute: async () => { executed++; return {}; }
    });
    assert.equal(estimates.length, 2);
    assert.ok(estimates[1] < estimates[0]);
    assert.equal(executed, 1);
    assert.equal(state.usageDiagnostics.length, 1);
    for (const [error, code] of [[upstream(), 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT'],
        [Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' }), 'PPT_MASTER_MODEL_TIMEOUT'],
        [Object.assign(new Error('Request failed'), { response: { status: 429 } }), 'PPT_MASTER_MODEL_RATE_LIMIT']]) {
        const checkpoint = referenceCheckpoint(1, 1000);
        let calls = 0;
        await assert.rejects(drive({ id: 1 }, 'fixture', checkpoint, hooks, {
            resolveModel: async () => model,
            callModel: async () => { calls++; throw error; },
            execute: async () => assert.fail('失败后不能执行动作')
        }), { code });
        assert.equal(calls, 1);
        assert.equal(checkpoint.usedTokens, 1184708);
        assert.equal(checkpoint.modelRequest.contextWindow, 256000);
    }
});

test('超时和熔断保留续跑标记，256K 检查点整理后可以继续写入', async () => {
    const { drive } = require('../server/services/presentations/master/driver');
    const { AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS } = require('../server/services/agent-model');
    const current = referenceCheckpoint(7, 4000);
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    const requests = [], operations = [];
    const deps = {
        resolveModel: async () => ({ context_window_tokens: 256000, max_tokens: 12000 }),
        callModel: async (_model, messages, options) => {
            assert.equal(options.timeoutMs, undefined);
            assert.equal(current.modelRequest.timeoutSeconds, Math.ceil(AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS / 1000));
            requests.push(estimateMessagesTokens(messages));
            if (requests.length === 1) throw Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' });
            if (requests.length === 2) throw Object.assign(new Error('模型端点暂时熔断。'), { code: 'AI_ENDPOINT_CIRCUIT_OPEN' });
            if (requests.length === 3) return { actions: [{ action: 'write', path: 'project/spec_lock.md', text: '方案正文' }] };
            return { complete: { path: 'project/exports/final.pptx' } };
        },
        execute: async (_user, _id, action) => { operations.push(action.action); return {}; }
    };
    await assert.rejects(drive({ id: 1 }, 'fixture', current, hooks, deps), { code: 'PPT_MASTER_MODEL_TIMEOUT' });
    assert.equal(current.focusModelHistory, true);
    assert.equal(current.steps, 7);
    await assert.rejects(drive({ id: 1 }, 'fixture', current, hooks, deps), { code: 'AI_ENDPOINT_CIRCUIT_OPEN' });
    assert.equal(current.focusModelHistory, true);
    await drive({ id: 1 }, 'fixture', current, hooks, deps);
    assert.equal(current.focusModelHistory, undefined);
    assert.ok(requests[1] < requests[0]);
    assert.ok(requests[2] < requests[0]);
    assert.deepEqual(operations, ['write', 'deliver']);
});

test('已到归档容量但本轮仍能容纳时继续制作', async () => {
    const { drive } = require('../server/services/presentations/master/driver');
    const state = referenceCheckpoint(28, 2800);
    state.historyArchives = Array.from({ length: 64 }, () => ({ data: '' }));
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    let calls = 0;
    await drive({ id: 1 }, 'fixture', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, messages, options) => {
            const estimate = estimateMessagesTokens(messages);
            assert.ok(estimate >= 256000 * 0.6 && estimate + options.maxTokens + 256 <= 256000);
            calls++;
            return { complete: { path: 'project/exports/final.pptx' } };
        },
        execute: async () => ({})
    });
    assert.equal(calls, 1);
    assert.equal(state.historyArchives.length, 64);
});

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
