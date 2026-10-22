/* 编辑修订只在确认服务器响应后标为已保存；离线副本与线上版本隔离。 */
(function () {
    let active = null;
    let timer = null;
    const pending = new Map();
    const api = () => window.Pivot.moduleApi('agent.workflowExperience');
    const userKey = () => String(window.Pivot.legacy.currentUser?.id || window.Pivot.moduleApi('agent.workflowBridge').userId?.() || '');
    function getStoredDraft(key) {
        const uid = userKey();
        if (uid) {
            try {
                const item = localStorage.getItem(`pivot.workflow.draft.${uid}.${key}`);
                if (item) return JSON.parse(item);
            } catch (_) {}
        }
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('pivot.workflow.draft.') && k.endsWith(`.${key}`)) {
                    const item = localStorage.getItem(k);
                    if (item) return JSON.parse(item);
                }
            }
        } catch (_) {}
        return null;
    }
    const localKey = key => {
        const uid = userKey();
        if (uid) return `pivot.workflow.draft.${uid}.${key}`;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                const m = k && k.match(/^pivot\.workflow\.draft\.([^.]+)\./);
                if (m && m[1]) return `pivot.workflow.draft.${m[1]}.${key}`;
            }
        } catch (_) {}
        return `pivot.workflow.draft..${key}`;
    };
    const same = value => active === value;
    const status = (text, tone = '', error = null) => api().saveStatus?.(text, tone, error);
    function localWrite(value, payload) {
        const key = localKey(value.key);
        if (/"(?:password|passwd|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|private[-_]?key)"\s*:\s*"(?!\{\{)[^"\s]+|[?&](?:token|secret|password|api[-_]?key)=[^&\s"}]+/i.test(payload.specText)) return false;
        try { localStorage.setItem(key, JSON.stringify({ ...payload, revision: value.revision, pending: value.dirty, savedAt: Date.now() })); return true; }
        catch (_) { return false; }
    }
    async function load(key, bridge) {
        clearTimeout(timer);
        if (active?.dirty) void flush(active);
        const value = { key, bridge, revision: 0, dirty: false, blocked: false, loading: true, lastPayload: null };
        let finishLoad; value.loaded = new Promise(resolve => { finishLoad = resolve; });
        active = value;
        let local = null;
        try { local = getStoredDraft(key); } catch (_) { /* 浏览器存储不可用时继续使用服务器修订。 */ }
        try {
            if (pending.has(key)) await pending.get(key);
            const response = await bridge.request(`/agents/workflow-editor/drafts/${encodeURIComponent(key)}`);
            if (!response.ok) throw new Error('无法读取已保存草稿。');
            const data = await response.json();
            if (!same(value)) return;
            value.revision = Number(data.draft?.revision || 0);
            const remote = data.draft;
            if (!value.dirty && (remote || local)) {
                const localChanged = local && (!remote || local.pending || (Number(local.revision) >= value.revision && (local.specText !== remote.spec_text || local.name !== remote.name)));
                const candidate = localChanged ? local : {
                    specText: remote.spec_text, name: remote.name, description: remote.description, baseVersion: remote.base_version
                };
                if (candidate.specText !== bridge.capture().specText || candidate.name !== bridge.capture().name) api().offerRecovery?.(candidate, () => {
                    if (!same(value)) return;
                    value.blocked = Boolean(localChanged && remote && Number(local.revision || 0) !== value.revision);
                    bridge.restore(candidate);
                    changed();
                    if (value.blocked) status('离线修改与服务器修订不同，请先查看冲突', 'error', new Error('本机修改已保留，请比较服务器草稿或另存副本。'));
                });
                else if (localChanged && local.pending) {
                    value.blocked = Boolean(remote && Number(local.revision || 0) !== value.revision && (local.specText !== remote.spec_text || local.name !== remote.name));
                    changed();
                    if (value.blocked) status('离线修改与服务器修订不同，请先查看冲突', 'error', new Error('本机修改已保留，请比较服务器草稿或另存副本。'));
                }
            }
            if (!value.dirty) status(remote ? '服务器草稿已读取' : '草稿尚无修改');
        } catch (error) {
            if (!same(value)) return;
            status(local ? '仅保存在本机' : '无法读取服务器草稿', 'warning', error);
            if (local && !value.dirty) api().offerRecovery?.(local, () => { bridge.restore(local); changed(); });
        } finally {
            value.loading = false;
            finishLoad();
            if (same(value) && value.dirty) timer = setTimeout(() => void flush(value), 1000);
        }
    }
    function changed() {
        if (!active || active.bridge.readOnly()) return;
        active.dirty = true;
        active.lastPayload = active.bridge.capture();
        const stored = localWrite(active, active.lastPayload);
        status(active.blocked ? '存在冲突，当前修改已保留' : stored ? '本机已保留，等待同步' : '等待保存草稿', active.blocked ? 'warning' : '');
        clearTimeout(timer);
        if (!active.blocked) timer = setTimeout(() => void flush(active), 1000);
    }
    async function flush(value = active) {
        if (value?.loading) { await value.loaded; return flush(value); }
        if (!value?.dirty || value.blocked) return;
        if (pending.has(value.key)) { await pending.get(value.key); if (value.dirty && !value.blocked) return flush(value); return; }
        const payload = value.lastPayload || value.bridge.capture();
        value.failed = false;
        value.dirty = false;
        if (same(value)) status('保存中…');
        const task = (async () => {
            try {
                const response = await value.bridge.request(`/agents/workflow-editor/drafts/${encodeURIComponent(value.key)}`, {
                    method: 'PUT', body: JSON.stringify({ ...payload, expectedRevision: value.revision })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw Object.assign(new Error(data.error || '草稿保存失败，可重试或导出副本。'), { conflict: response.status === 409 });
                value.revision = data.draft.revision;
                localWrite(value, { ...(value.dirty ? value.lastPayload : payload), savedAt: Date.now() });
                if (same(value)) status(value.dirty ? '仍有修改等待同步' : '草稿已保存');
            } catch (error) {
                value.dirty = true;
                value.failed = true;
                value.blocked = Boolean(error.conflict);
                if (same(value)) status(error.conflict ? '存在冲突' : '保存失败，修改仍保留', 'error', error);
            }
        })();
        pending.set(value.key, task);
        await task;
        pending.delete(value.key);
        if (value.dirty && !value.blocked && same(value) && !value.failed) timer = setTimeout(() => void flush(value), 1000);
    }
    async function latest() {
        if (!active) return;
        const value = active;
        let response; let data;
        try { response = await value.bridge.request(`/agents/workflow-editor/drafts/${encodeURIComponent(value.key)}`); data = await response.json(); }
        catch (error) { if (same(value)) status('读取服务器草稿失败，可重试', 'error', error); return; }
        if (!response.ok || !same(value)) return;
        api().compareDraft?.(value.bridge.capture(), data.draft, () => {
            value.revision = Number(data.draft?.revision || 0); value.blocked = false; value.dirty = false;
            if (data.draft) value.bridge.restore({ specText: data.draft.spec_text, name: data.draft.name, description: data.draft.description, baseVersion: data.draft.base_version });
            value.lastPayload = value.bridge.capture(); localWrite(value, value.lastPayload);
            status('已载入服务器草稿');
        });
    }
    function detach() { clearTimeout(timer); if (active?.dirty) void flush(active); active = null; }
    function listLocal() {
        const result = [];
        const uid = userKey();
        const prefix = uid ? `pivot.workflow.draft.${uid}.` : 'pivot.workflow.draft.';
        try {
            for (let index = 0; index < localStorage.length; index++) {
                const storageKey = localStorage.key(index);
                if (!storageKey?.startsWith(prefix)) continue;
                const value = JSON.parse(localStorage.getItem(storageKey));
                if (value?.specText) {
                    const keyPart = uid ? storageKey.slice(prefix.length) : storageKey.replace(/^pivot\.workflow\.draft\.[^.]+\./, '');
                    result.push({ ...value, key: keyPart });
                }
            }
        } catch (_) { /* 本机存储不可用不影响服务器草稿。 */ }
        return result.sort((a, b) => b.savedAt - a.savedAt).slice(0, 100);
    }
    globalThis.addEventListener?.('pagehide', () => { if (active?.dirty) void flush(active); });
    globalThis.addEventListener?.('online', () => { if (active?.dirty && !active?.blocked) void flush(active); });
    globalThis.addEventListener?.('beforeunload', event => {
        if (active?.dirty || active?.blocked) { event.preventDefault(); event.returnValue = ''; }
    });
    window.Pivot.registerModule('agent.workflowDrafts', { load, changed, flush, latest, detach, listLocal,
        isSaved: () => Boolean(active && !active.dirty && !active.blocked && !active.loading && !active.failed && !pending.has(active.key) && active.revision > 0),
        current: () => active ? { key: active.key, revision: active.revision, dirty: active.dirty, blocked: active.blocked } : null });
})();
