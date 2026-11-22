'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { archiveOlderObservations, readHistory } = require('../server/services/presentations/master/history');
const { phaseMessages } = require('../server/services/presentations/master/phase-context');
const { estimateMessagesTokens } = require('../server/services/context-budget');
const { usageDiagnosticsView } = require('../server/services/presentations/master/observations');

test('制稿请求复用全文覆盖的指引与模板分页，未覆盖或不同版本的正文仍可见', async () => {
    const { runModelTurn } = require('../server/services/presentations/master/model-turn');
    const { normalizeRuntimeReads } = require('../server/services/presentations/master/runtime-references');
    const state = referenceCheckpoint(0, 0);
    const path = 'workflows/generate-pptx.md', templatePath = 'templates/styles/academic-research';
    const full = '引导😀首段。' + '制稿第二段。'.repeat(500);
    const templateText = '模板实际规范😀统一使用证据支持结论。';
    const push = (role, value) => state.messages.push({ role, content: JSON.stringify(value) });
    push('user', { runtimeDocument: path, text: full, offset: 0, nextOffset: null });
    push('user', { selectedTemplateSpec: { path: templatePath, text: templateText } });
    const page = (action, path, text, offset = 0) => ({ action, result: { path, text, offset, nextOffset: offset + Array.from(text).length } });
    const batch = [
        page('read_runtime', path, Array.from(full).slice(3, 16).join(''), 3),
        page('read_runtime', path, '回读到不同的版本'),
        page('read', 'selected-template/templates/design_spec.md', templateText),
        page('read_runtime', templatePath + '/templates/design_spec.md', templateText)
    ];
    push('assistant', { actions: batch.map(({ action, result }) => ({ action, path: result.path, offset: result.offset })) });
    push('user', batch);
    Object.assign(state.request, { draftFirst: true, template: { type: 'runtime' } });
    state.managedProject = 'demo';
    state.review = { approvals: {} };
    assert.deepEqual(normalizeRuntimeReads([{ action: 'read_runtime', path: batch[2].result.path, offset: 10 }], state),
        [{ action: 'read', path: batch[2].result.path, offset: 10 }]);
    const requests = [];
    const run = () => runModelTurn({ id: 1 }, 'fixture', state, { context_window_tokens: 256000 },
        { ensureCurrent: async () => {}, checkpoint: async () => {} },
        { callModel: async (_model, messages) => { requests.push(JSON.parse(messages.at(-1).content)); return '{}'; } });
    await run();
    state.review.approvals.design = { plan: { project: 'demo' } };
    await run();
    assert.deepEqual(requests.map(items => items.map(entry => entry.result.text)), [
        [batch[0].result.text, batch[1].result.text, undefined, undefined],
        [undefined, batch[1].result.text, undefined, undefined]
    ]);
    assert.deepEqual(JSON.parse(state.messages.at(-1).content), batch);
});

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

test('归档后普通读取、指引页和历史页都可重新补回，未改变的清单仍判为重复', async () => {
    const { createInspectionProgress } = require('../server/services/presentations/master/inspection-progress');
    const state = referenceCheckpoint(0, 0);
    const record = (action, result) => state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [action] }) },
        { role: 'user', content: JSON.stringify([{ action: action.action, result }]) });
    const material = { action: 'read', path: 'inputs/material-1.md', offset: 0 };
    const runtime = { action: 'read_runtime', path: 'references/authoring.md', offset: 0 };
    const page = action => ({ path: action.path, offset: 0, nextOffset: null, totalChars: 2000, text: '文'.repeat(2000) });
    const list = { action: 'list' }, listing = { files: [{ path: material.path, bytes: 6000 }] };
    record(material, page(material));
    record(list, listing);
    await archiveOlderObservations(state, { force: true, recentTurns: 1 });
    const history = { action: 'read_history', ...JSON.parse(state.messages[3].content)[0].result.archived };
    const historyResult = await readHistory(state, history);
    record(history, historyResult);
    record(runtime, page(runtime));
    record(material, page(material));
    record(list, listing);
    const progress = createInspectionProgress(state.messages);
    const evaluate = (action, result) => progress.evaluate([action], [{ action: action.action, result }]).progressed;
    assert.equal(evaluate(runtime, page(runtime)), false);
    assert.ok(await archiveOlderObservations(state, { force: true, recentTurns: 1 }));
    progress.syncVisibleObservations(state.messages);
    assert.equal(evaluate(list, listing), false);
    assert.equal(evaluate(material, page(material)), true);
    assert.equal(evaluate(runtime, page(runtime)), true);
    assert.equal(evaluate(history, historyResult), true);
    assert.equal(evaluate(history, historyResult), false);
    progress.syncVisibleObservations([...state.messages]);
    assert.equal(evaluate(runtime, page(runtime)), true, '同页第二次补回时仍允许恢复');
    progress.syncVisibleObservations([...state.messages]);
    assert.equal(evaluate(runtime, page(runtime)), false, '同页反复归档不能无限作为新资料');
    assert.equal(evaluate(runtime, { ...page(runtime), nextOffset: 2100 }), true, '扩展到新字符范围可以推进');
});

test('主动归档优先收起旧阶段指引，给当前阶段和源材料保留有界工作集', async () => {
    const state = referenceCheckpoint(4, 4000);
    state.workflowPhaseFrom = 6;
    const source = { action: 'read', path: 'inputs/material-1.md' };
    state.messages.splice(4, 0, { role: 'assistant', content: JSON.stringify({ actions: [source] }) },
        { role: 'user', content: JSON.stringify([{ action: 'read', result: { path: source.path, text: '原材料'.repeat(1000), nextOffset: null } }]) });
    state.workflowPhaseFrom += 2;
    assert.equal(await archiveOlderObservations(state, { force: true, recentTurns: 1, preserveActive: true }), true);
    const old = JSON.parse(state.messages[3].content)[0].result;
    assert.ok(old.archived);
    assert.match((await readHistory(state, old.archived)).text, /制作流程/);
    assert.match(state.messages[5].content, /原材料/);
    assert.match(state.messages[9].content, /制作流程/);
    assert.equal(JSON.parse(state.messages[7].content)[0].result.archived.archive, 0);
});

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
    const savedAttempts = [];
    const hooks = { signal: AbortSignal.timeout(10000), ensureCurrent: async () => {},
        checkpoint: async current => { savedAttempts.push(usageDiagnosticsView(current)); } };
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
    const [failed, retried] = usageDiagnosticsView(state);
    assert.equal(state.usageDiagnostics.length, 2);
    assert.deepEqual([failed.call, retried.call, failed.step, retried.step], [1, 2, 6, 6]);
    assert.equal(failed.outcome, 'model_failed');
    assert.equal(failed.errorCode, 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT');
    assert.equal(failed.inputTokens, null);
    assert.equal(failed.outputTokens, null);
    assert.equal(failed.cumulativeTokens, 1184708);
    assert.ok(savedAttempts.some(attempts => attempts.length === 1 && attempts[0].errorCode === failed.errorCode));
    for (const item of [failed, retried]) {
        assert.match(item.startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        assert.ok(Number.isSafeInteger(item.durationMs) && item.durationMs >= 0);
    }
    for (const [error, code, kind] of [[upstream(), 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT'],
        [Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' }), 'PPT_MASTER_MODEL_TIMEOUT', 'local_timeout'],
        [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' }), 'PPT_MASTER_MODEL_TIMEOUT', 'transport_timeout'],
        [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'PPT_MASTER_MODEL_CONNECTION', 'connection_reset'],
        [Object.assign(new Error('Request failed'), { response: { status: 504 } }), 'PPT_MASTER_MODEL_TIMEOUT', 'upstream_timeout'],
        [Object.assign(new Error('Request failed'), { response: { status: 502 } }), 'PPT_MASTER_MODEL_CONNECTION', 'gateway_error'],
        [Object.assign(new Error('Request failed'), { response: { status: 429 } }), 'PPT_MASTER_MODEL_RATE_LIMIT']]) {
        const checkpoint = referenceCheckpoint(1, 1000);
        let calls = 0;
        await assert.rejects(drive({ id: 1 }, 'fixture', checkpoint, hooks, {
            resolveModel: async () => model,
            callModel: async (_model, _messages, { usageRef }) => {
                calls++;
                Object.assign(usageRef, { providerStartedAt: 10, queueMs: 20, providerMs: 60 });
                throw error;
            },
            execute: async () => assert.fail('失败后不能执行动作')
        }), { code });
        assert.equal(calls, 1);
        assert.equal(checkpoint.usedTokens, 1184708);
        assert.equal(checkpoint.modelRequest.contextWindow, 256000);
        const attempts = usageDiagnosticsView(checkpoint, { code });
        assert.equal(attempts.length, 1);
        const [attempt] = attempts;
        assert.equal(attempt.outcome, 'model_failed');
        assert.equal(attempt.errorCode, code);
        assert.equal(attempt.modelFailureKind, kind);
        assert.deepEqual([attempt.queueMs, attempt.providerMs], [20, 60]);
        if (kind) assert.equal(checkpoint.focusModelHistory, true);
        assert.match(attempt.startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        assert.ok(Number.isSafeInteger(attempt.durationMs) && attempt.durationMs >= 0);
        assert.equal(attempt.inputTokens, null);
        assert.equal(attempt.outputTokens, null);
    }
});

test('PPT 完整制作的非流式请求使用平台完整请求时限，并按实际时限报告超时', async t => {
    const axios = require('axios');
    const { runModelTurn } = require('../server/services/presentations/master/model-turn');
    const { AGENT_MODEL_REQUEST_TIMEOUT_MS } = require('../server/services/agent-model');
    const current = referenceCheckpoint(0, 0);
    const hooks = { signal: new AbortController().signal, ensureCurrent: async () => {}, checkpoint: async () => {} };
    const post = t.mock.method(axios, 'post', async (_url, _body, config) => {
        throw Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: 'ECONNABORTED' });
    });
    const model = { model_name: 'ppt-timeout-fixture', url: 'http://127.0.0.1:1/v1', context_window_tokens: 256000, max_tokens: 12000 };

    const timeoutSeconds = Math.ceil(AGENT_MODEL_REQUEST_TIMEOUT_MS / 1000);
    await assert.rejects(runModelTurn({ id: 1 }, 'fixture', current, model, hooks, {
        messagesForModel: async () => current.messages
    }), { code: 'PPT_MASTER_MODEL_TIMEOUT', message: new RegExp(`${timeoutSeconds} 秒`) });
    assert.equal(post.mock.callCount(), 1);
    const [, body, config] = post.mock.calls[0].arguments;
    assert.equal(body.stream, false);
    assert.equal(config.signal, hooks.signal);
    assert.equal(config.timeout, AGENT_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(current.modelRequest.timeoutSeconds, timeoutSeconds);
    assert.equal(usageDiagnosticsView(current)[0].modelFailureKind, 'local_timeout');
});

test('超时和熔断保留续跑标记，256K 检查点整理后可以继续写入', async () => {
    const { drive } = require('../server/services/presentations/master/driver');
    const current = referenceCheckpoint(7, 4000);
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    const requests = [], operations = [];
    const deps = {
        resolveModel: async () => ({ context_window_tokens: 256000, max_tokens: 12000 }),
        callModel: async (_model, messages) => {
            requests.push(estimateMessagesTokens(messages));
            if (requests.length === 1) throw Object.assign(new Error('模型响应超时。'), { code: 'ECONNABORTED' });
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
    const state = { request: { operation: 'generate', profile: 'default' }, confirmedGates: 1, messages: original,
        review: { approvals: { design: { plan: { project: 'project' } } } } };
    const result = phaseMessages(original, state), content = JSON.parse(result.messages[1].content).text;
    const { fitReferenceMessages } = require('../server/services/presentations/master/reference-context');
    const guide = 'workflows/generate-pptx.md', points = Array.from(text);
    const pages = [0, 24000].map(offset => ({ role: 'user', content: JSON.stringify([{ action: 'read_runtime', result: {
        path: guide, offset, text: points.slice(offset, offset + 24000).join(''), nextOffset: offset === 0 ? 24000 : null
    } }]) }));
    const fitted = fitReferenceMessages([...result.messages, ...pages], Infinity, result.ranges);
    const reads = fitted.slice(-2).map(message => JSON.parse(message.content)[0].result);
    assert.ok(reads.every(page => page.text === undefined));
    assert.equal(reads.flatMap(page => page.uncovered || []).map(part => part.text).join(''),
        text.slice(text.indexOf('### Step 1: Source Content Processing'), text.indexOf('### Step 4: Strategist Phase')));
    assert.match(content, /暂收起步骤1至3/);
    assert.match(content, /### Step 4: Strategist Phase/);
    assert.match(content, /### Step 6: Executor Phase/);
    assert.match(content, /### Step 7: Post-processing/);
    assert.equal(result.messages.at(-1).content, original.at(-1).content);
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(original));
    assert.equal(JSON.parse(original[1].content).text, text);
    const routing = fs.readFileSync(path.join(path.dirname(file), 'routing.md'), 'utf8').replace(/\r\n/g, '\n');
    const messages = [...original, { role: 'user', content: JSON.stringify({ runtimeDocument: 'workflows/routing.md', text: routing }) }];
    const routingView = JSON.parse(phaseMessages(messages, state).messages.at(-1).content).text;
    assert.match(routingView, /暂收起已完成的流程选路表/);
    assert.doesNotMatch(routingView, /Top-Level Route Matrix/);
    assert.match(routingView, /Template Selection Boundary/);
    const calibrated = [...original, { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'run', tool: 'text_measure', args: ['calibrate', 'project', '--outline'] }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'run', result: { exitCode: 0 } }]) }];
    assert.match(JSON.parse(phaseMessages(calibrated, { ...state, messages: calibrated }).messages[1].content).text, /暂收起步骤1至3/);
    assert.equal(phaseMessages(original, { ...state, review: { approvals: { direction: {} } } }).messages[1], original[1]);
    assert.equal(phaseMessages(original, { ...state, review: { approvals: { design: { plan: { project: 'other' } } } } }).messages[1], original[1]);
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
    const managed = { ...state, managedProject: 'project', request: { ...state.request, draftFirst: true },
        messages: resumed, projectPreparation: { validation: { exitCode: 1 } } };
    const recovery = phaseMessages(resumed, managed);
    assert.equal(recovery.phase, 'managed_authoring');
    const focused = fitReferenceMessages(recovery.messages, Infinity, recovery.ranges, true);
    assert.equal(JSON.parse(focused[1].content).text, undefined);
    assert.match(JSON.parse(focused[1].content).note, /read_runtime/);
    assert.equal(JSON.parse(original[1].content).text, text);
    const answered = [...original, { role: 'user', content: '用户对本次确认问题的实际答复：请调整方案' }];
    assert.equal(phaseMessages(answered, { ...state, messages: answered }).messages[1], answered[1]);
});
