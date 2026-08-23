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
                if (exportName && globalName) this.window[globalName] = this.modules[name][exportName];
            });
        },
        moduleApi(name) {
            return this.modules[name] || {};
        },
        window: null
    };
    const window = {
        Pivot: pivot,
        showMainWorkspace() {},
        persistActiveChatSession() {},
        markActiveSessionInList() {},
        updateContextUsage() {},
        attachChatAgentControls(element, runId, status) {
            controls.push({ element, runId, status });
        },
        registerChatAgentStreamingTarget(runId, element, sessionId) {
            streamingTargets.push({ runId, element, sessionId });
        },
        unregisterChatAgentStreamingTarget(runId) {
            unregisteredRuns.push(runId);
        }
    };
    pivot.window = window;

    const sandbox = {
        window,
        document: {
            body: { contains: () => false },
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
        selectSession: window.selectSession
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
