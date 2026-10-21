const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createSessionClientHarness() {
    const pending = [];
    const starts = [];
    const appended = [];
    const controls = [];
    const streamingTargets = [];
    const unregisteredRuns = [];
    const title = { innerText: '' };
    const messageContainer = { innerHTML: '' };

    const pivot = {
        modules: {
            'chat.messageVirtualizer': {
                start(payload) {
                    starts.push(payload);
                }
            }
        },
        exposeModule(name, api, aliases = []) {
            this.modules[name] = { ...(this.modules[name] || {}), ...api };
            aliases.forEach(alias => {
                const exportName = typeof alias === 'string' ? alias : alias.exportName;
                const globalName = typeof alias === 'string' ? alias : alias.globalName;
                if (exportName && globalName) this.legacy[globalName] = this.modules[name][exportName];
            });
        },
        moduleApi(name) {
            return this.modules[name] || {};
        },
        legacy: Object.create(null)
    };
    const window = {
        Pivot: pivot,
        showMainWorkspace() {},
        persistActiveChatSession() {},
        markActiveSessionInList() {},
        updateContextUsage() {},
        attachChatAgentControls(element, runId, status) {
            element.dataset.chatAgentRunId = runId;
            controls.push({ element, runId, status });
        },
        registerChatAgentStreamingTarget(runId, element, sessionId) {
            streamingTargets.push({ runId, element, sessionId });
        },
        unregisterChatAgentStreamingTarget(runId) {
            unregisteredRuns.push(runId);
        }
    };
    Object.assign(pivot.legacy, {
        showMainWorkspace: window.showMainWorkspace,
        persistActiveChatSession: window.persistActiveChatSession,
        markActiveSessionInList: window.markActiveSessionInList,
        updateContextUsage: window.updateContextUsage,
        attachChatAgentControls: window.attachChatAgentControls,
        registerChatAgentStreamingTarget: window.registerChatAgentStreamingTarget,
        unregisterChatAgentStreamingTarget: window.unregisterChatAgentStreamingTarget
    });

    const sandbox = {
        window,
        document: {
            body: { contains: element => appended.includes(element) },
            querySelectorAll: () => appended.filter(element => element.dataset.chatAgentRunId),
            getElementById(id) {
                if (id === 'current-title') return title;
                if (id === 'message-container') return messageContainer;
                return null;
            }
        },
        API_BASE: '/api',
        currentSessionId: null,
        clearPendingAttachments() {},
        PivotSafeHtml: {
            setHtml(element, html) {
                if (element) element.innerHTML = html;
            }
        },
        apiFetch(url) {
            const value = String(url);
            if (value.includes('/agents/runs/chat-active')) {
                return new Promise(resolve => pending.push({ kind: 'active', resolve }));
            }
            if (value.includes('/agents/runs/')) {
                const runId = value.split('/agents/runs/')[1].split('?')[0];
                return new Promise(resolve => pending.push({ kind: 'run', runId, resolve }));
            }
            const id = value.split('/sessions/')[1].split('?')[0];
            return new Promise(resolve => pending.push({ kind: 'session', id, resolve }));
        },
        appendMessage(role, content, messageId, options = {}) {
            const textBody = { innerHTML: '', querySelector: selector => selector === '.text-body' ? textBody : null };
            const element = {
                dataset: {},
                role,
                content,
                messageId,
                options,
                querySelector(selector) {
                    if (selector === '.text-body') return textBody;
                    return null;
                }
            };
            appended.push(element);
            return element;
        },
        escapeChatStatusHtml(value) { return String(value || ''); },
        renderAiMessage(value) { return String(value || ''); },
        setTimeout(fn) { return globalThis.setTimeout(fn, 0); },
        console
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'engine-sessions.js'), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'engine-sessions.js' });

    return {
        pending,
        starts,
        title,
        messageContainer,
        appended,
        controls,
        streamingTargets,
        unregisteredRuns,
        selectSession: window.Pivot.legacy.selectSession,
        attachChatAgentRunsForSession: window.Pivot.legacy.attachChatAgentRunsForSession
    };
}

test('late session responses cannot overwrite the session selected later', async () => {
    const harness = createSessionClientHarness();
    const first = harness.selectSession('session-a', '会话 A');
    const second = harness.selectSession('session-b', '会话 B');

    const requestB = harness.pending.find(request => request.id === 'session-b');
    const requestA = harness.pending.find(request => request.id === 'session-a');
    assert.ok(requestA);
    assert.ok(requestB);

    requestB.resolve({
        ok: true,
        json: async () => ({ session: { title: '会话 B' }, messages: [{ id: 2, role: 'assistant', content: 'B' }], page: {} })
    });
    await second;

    requestA.resolve({
        ok: true,
        json: async () => ({ session: { title: '会话 A' }, messages: [{ id: 1, role: 'assistant', content: 'A' }], page: {} })
    });
    await first;

    assert.deepEqual(harness.starts.map(item => item.sessionId), ['session-b']);
    assert.equal(harness.title.innerText, '会话 B');
});

test('等待输入保留已生成答案并停止轮询，继续同一任务时复用消息气泡', async () => {
    const harness = createSessionClientHarness();
    const selection = harness.selectSession('session-wait', '知识问答');
    harness.pending.find(request => request.kind === 'session').resolve({ ok: true, json: async () => ({ session: { title: '知识问答' }, messages: [], page: {} }) });
    await selection;
    harness.pending.find(request => request.kind === 'active').resolve({ ok: true, json: async () => ({ runs: [{ id: 'run-wait', status: 'needs_input' }] }) });
    await new Promise(resolve => setImmediate(resolve));
    harness.pending.find(request => request.kind === 'run').resolve({ ok: true, json: async () => ({ run: { id: 'run-wait', status: 'needs_input', final_answer: '已找到的知识库答案' } }) });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(harness.appended[0].querySelector('.text-body').innerHTML, /已找到的知识库答案/);
    assert.equal(harness.pending.filter(request => request.kind === 'run').length, 1);
    assert.equal(harness.unregisteredRuns.includes('run-wait'), true);
    const recovery = harness.attachChatAgentRunsForSession('session-wait');
    harness.pending.filter(request => request.kind === 'active').at(-1).resolve({ ok: true, json: async () => ({ runs: [{ id: 'run-wait', status: 'queued' }] }) });
    await recovery;
    assert.equal(harness.appended.length, 1);
    assert.equal(harness.pending.filter(request => request.kind === 'run').length, 2);
    harness.pending.filter(request => request.kind === 'run').at(-1).resolve({ ok: true, json: async () => ({ run: { id: 'run-wait', status: 'needs_input', final_answer: '补充后的答案' } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(harness.appended[0].querySelector('.text-body').innerHTML, /补充后的答案/);
});

test('等待输入与验收状态不再显示成正在规划，答案与具体缺口同时展示', () => {
    const sandbox = { window: { Pivot: { legacy: {}, exposeModule() {} } } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/chat/engine.js'), 'utf8'), sandbox);
    const run = { status: 'needs_input', final_answer: '已有答案', error_message: '缺少量化标准' };
    const detail = { run, steps: [{ type: 'plan', title: '流式最终答案' }] };
    assert.match(sandbox.chatAgentProgressText(detail), /等待补充信息/);
    assert.doesNotMatch(sandbox.chatAgentProgressText(detail), /正在规划/);
    assert.match(sandbox.chatAgentProgressText(detail, 'verifying'), /正在核验/);
    assert.match(sandbox.chatAgentResultText(run), /已有答案[\s\S]*缺少量化标准/);
});

test('多次并发恢复同一任务只创建一个卡片和一条轮询', async () => {
    const harness = createSessionClientHarness();
    const selection = harness.selectSession('session-concurrent');
    harness.pending.find(item => item.kind === 'session').resolve({ ok: true, json: async () => ({ session: {}, messages: [], page: {} }) });
    await selection;
    const second = harness.attachChatAgentRunsForSession('session-concurrent');
    const third = harness.attachChatAgentRunsForSession('session-concurrent');
    const payload = { runs: Array.from({ length: 3 }, () => ({ id: 'run-one', status: 'running' })) };
    for (const request of harness.pending.filter(item => item.kind === 'active')) request.resolve({ ok: true, json: async () => payload });
    await Promise.all([second, third]);
    assert.equal(harness.appended.length, 1);
    assert.equal(harness.pending.filter(item => item.kind === 'run').length, 1);
    harness.pending.find(item => item.kind === 'run').resolve({ ok: true, json: async () => ({ run: { id: 'run-one', status: 'needs_input' } }) });
    await new Promise(resolve => setImmediate(resolve));
});

test('切走再切回同一会话后旧详情响应不能覆盖新卡片或触发多余刷新', async () => {
    const harness = createSessionClientHarness();
    async function open(id) {
        const selection = harness.selectSession(id);
        harness.pending.filter(item => item.kind === 'session').at(-1).resolve({ ok: true, json: async () => ({ session: {}, messages: [], page: {} }) });
        await selection;
        harness.pending.filter(item => item.kind === 'active').at(-1).resolve({ ok: true, json: async () => ({ runs: id === 'session-a' ? [{ id: 'run-a', status: 'running' }] : [] }) });
        await new Promise(resolve => setImmediate(resolve));
    }
    await open('session-a');
    const oldRequest = harness.pending.filter(item => item.kind === 'run').at(-1);
    await open('session-b');
    await open('session-a');
    const freshRequest = harness.pending.filter(item => item.kind === 'run').at(-1);
    assert.notEqual(oldRequest, freshRequest);
    const sessionReads = harness.pending.filter(item => item.kind === 'session').length;
    oldRequest.resolve({ ok: true, json: async () => ({ run: { id: 'run-a', status: 'completed' } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.pending.filter(item => item.kind === 'session').length, sessionReads);
    freshRequest.resolve({ ok: true, json: async () => ({ run: { id: 'run-a', status: 'needs_input', final_answer: '新恢复的答案' } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(harness.appended.at(-1).querySelector('.text-body').innerHTML, /新恢复的答案/);
});

test('任务删除或访问权限撤销后停止轮询，移除可操作按钮', async () => {
    const harness = createSessionClientHarness();
    const selection = harness.selectSession('session-deleted');
    harness.pending.find(item => item.kind === 'session').resolve({ ok: true, json: async () => ({ session: {}, messages: [], page: {} }) });
    await selection;
    harness.pending.find(item => item.kind === 'active').resolve({ ok: true, json: async () => ({ runs: [{ id: 'run-deleted', status: 'running' }] }) });
    await new Promise(resolve => setImmediate(resolve));
    harness.pending.find(item => item.kind === 'run').resolve({ ok: false, status: 404 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.pending.filter(item => item.kind === 'run').length, 1);
    assert.match(harness.appended[0].querySelector('.text-body').innerHTML, /任务已删除/);
    assert.equal(harness.controls.at(-1).status, 'deleted');
});

test('selecting a session reattaches active chat Agents and refreshes on terminal completion', async () => {
    const harness = createSessionClientHarness();
    const selection = harness.selectSession('session-agent', 'Agent 会话');
    const sessionRequest = harness.pending.find(request => request.kind === 'session' && request.id === 'session-agent');
    assert.ok(sessionRequest);
    sessionRequest.resolve({
        ok: true,
        json: async () => ({ session: { title: 'Agent 会话' }, messages: [], page: {} })
    });
    await selection;

    const activeRequest = harness.pending.find(request => request.kind === 'active');
    assert.ok(activeRequest, '选中会话后必须查询未完成的聊天 Agent');
    activeRequest.resolve({
        ok: true,
        json: async () => ({ runs: [{ id: 'run-agent-1', status: 'executing', created_at: '', model_name: '测试模型' }] })
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.appended.filter(item => item.role === 'assistant').length, 1);
    assert.equal(harness.streamingTargets.at(-1).runId, 'run-agent-1');
    assert.equal(harness.controls.at(-1).runId, 'run-agent-1');

    const runRequest = harness.pending.find(request => request.kind === 'run' && request.runId === 'run-agent-1');
    assert.ok(runRequest, '恢复后必须轮询 Agent 详情');
    runRequest.resolve({ ok: true, json: async () => ({ run: { id: 'run-agent-1', status: 'completed' } }) });
    await new Promise(resolve => setImmediate(resolve));

    const refreshRequest = harness.pending.filter(request => request.kind === 'session' && request.id === 'session-agent').at(-1);
    assert.ok(refreshRequest, 'Agent 完成后必须刷新会话消息');
    refreshRequest.resolve({
        ok: true,
        json: async () => ({ session: { title: 'Agent 会话' }, messages: [{ id: 1, role: 'assistant', content: '最终答案' }], page: {} })
    });
    await new Promise(resolve => setImmediate(resolve));
    const activeRefresh = harness.pending.filter(request => request.kind === 'active').at(-1);
    activeRefresh?.resolve({ ok: true, json: async () => ({ runs: [] }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(harness.unregisteredRuns.includes('run-agent-1'));
});

test('会话界面消息记录恢复在两侧全宽显示，不强制 920px 居中', () => {
    const layoutRefreshCss = fs.readFileSync(path.join(__dirname, '../client/chat/styles/layout-refresh.css'), 'utf8');
    assert.match(layoutRefreshCss, /\.message-container > \.message\s*\{[\s\S]*?width:\s*100%;/);
    assert.doesNotMatch(layoutRefreshCss, /\.message-container > \.message\s*\{[\s\S]*?margin-inline:\s*auto;/);
    assert.doesNotMatch(layoutRefreshCss, /\.message-container > \.message\s*\{[\s\S]*?width:\s*min\(100%,\s*920px\);/);
});

test('长会话虚拟滚动具备防闪烁保护：增量DOM复用、程序滚动保护与禁用不可控动画', () => {
    const virtualizerJs = fs.readFileSync(path.join(__dirname, '../client/chat/message-virtualizer.js'), 'utf8');
    const shellCss = fs.readFileSync(path.join(__dirname, '../client/chat/styles/base/chat-shell.css'), 'utf8');

    // 1. CSS 不应有 content-visibility: auto，避免尺寸震荡
    assert.doesNotMatch(shellCss, /content-visibility:\s*auto/);
    // 2. 虚拟容器下必须禁用气泡入场动画，防止滑动时每次重新计算透明度导致白闪
    assert.match(shellCss, /\.message-container\.is-virtualized\s+\.message-content\s*\{[\s\S]*?animation:\s*none\s*!important/);
    // 3. 必须具备 isProgrammaticScroll 保护，防止修改 scrollTop 导致递归事件死循环
    assert.match(virtualizerJs, /isProgrammaticScroll/);
    assert.match(virtualizerJs, /setProgrammaticScrollTop/);
    // 4. renderWindow 内部不得使用 setHtml(state.container, '') 全量清空，必须增量复用 DOM
    const renderWindowMatch = virtualizerJs.match(/function renderWindow[\s\S]*?function scheduleRender/);
    assert.ok(renderWindowMatch);
    assert.doesNotMatch(renderWindowMatch[0], /PivotSafeHtml\.setHtml\(state\.container/);
});
