const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createSessionClientHarness() {
    const pending = [];
    const starts = [];
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
        updateContextUsage() {}
    };
    pivot.window = window;

    const sandbox = {
        window,
        document: {
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
            const id = String(url).split('/sessions/')[1].split('?')[0];
            return new Promise(resolve => pending.push({ id, resolve }));
        },
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
