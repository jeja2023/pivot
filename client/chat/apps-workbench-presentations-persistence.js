(function () {
    'use strict';
    function create(state, { requestJson, canEdit, setSaveState, renderIssues, toast }) {
        function same(id, epoch) { return state.active?.id === id && (state.activeEpoch || 0) === epoch; }

        function scheduleSave() {
            if (!state.active?.id || !canEdit()) return;
            clearTimeout(state.saveTimer);
            state.editRevision += 1;
            state.dirty = true;
            setSaveState('待保存', 'dirty');
            const id = state.active.id;
            const epoch = state.activeEpoch || 0;
            state.saveTimer = window.setTimeout(() => {
                state.saveTimer = null;
                if (same(id, epoch)) void saveActive().catch(() => {});
            }, 1200);
        }

        async function saveActive({ force = false, templateApplyMode = '', note = '' } = {}) {
            const id = state.active?.id;
            const epoch = state.activeEpoch || 0;
            if (!id) return false;
            if (!canEdit()) {
                if (state.dirty) throw new Error('当前账号没有保存权限，请保留内容并联系文稿所有者。');
                return true;
            }
            if (state.savePromise) {
                await state.savePromise;
                if (!same(id, epoch)) return false;
                if (state.dirty || force) return saveActive({ force, templateApplyMode, note });
                return true;
            }
            if (!state.dirty && !force) return true;
            const snapshot = JSON.parse(JSON.stringify(state.active.content));
            if (!snapshot) throw new Error('当前文稿内容不可用，请保留页面并重新检查。');
            const revision = state.editRevision;
            const baseVersion = state.active.version;
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
            state.saving = true;
            setSaveState('保存中…', 'saving');
            const task = Promise.resolve().then(async () => {
                const data = await requestJson(`/api/apps/presentations/${encodeURIComponent(id)}/content`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                        baseVersion, title: snapshot.title, templateId: snapshot.template?.id,
                        templateVersion: snapshot.template?.version, templateApplyMode: templateApplyMode || state.pendingTemplateApplyMode || '',
                        content: snapshot, autoSave: !force, isMilestone: force, note: force ? (note || '用户主动保存') : '自动保存'
                    })
                });
                if (!same(id, epoch)) return false;
                if (data.presentation?.id !== id || !Number.isFinite(Number(data.presentation.version))) throw new Error('服务器没有返回有效的保存确认，请重试；当前修改仍保留。');
                const changed = state.editRevision !== revision;
                const current = state.active.content;
                state.active = { ...data.presentation, content: changed ? current : (data.presentation.content || snapshot) };
                state.documents = state.documents.map(item => item.id === id ? { ...item, ...state.active } : item);
                state.dirty = changed;
                state.remoteVersionAvailable = false;
                if (!changed) state.pendingTemplateApplyMode = '';
                setSaveState(changed ? '待保存' : (force ? '版本已保存' : '已保存'), changed ? 'dirty' : 'saved');
                renderIssues();
                return true;
            }).catch(error => {
                if (same(id, epoch)) {
                    state.dirty = true;
                    state.remoteVersionAvailable = error.status === 409 || Boolean(state.remoteVersionAvailable);
                    setSaveState(error.status === 409 ? '版本冲突，修改仍保留' : '保存失败，可重试', 'error');
                    toast(error.status === 409 ? '协作者已保存新版本。当前修改仍保留，请先备份或比较版本，再决定是否同步。' : (error.message || '保存失败，请重试；当前修改仍保留。'), 'error');
                }
                throw error;
            }).finally(() => {
                if (state.savePromise === task) { state.savePromise = null; state.saving = false; }
            });
            state.savePromise = task;
            return task;
        }

        async function flush() {
            const id = state.active?.id;
            const epoch = state.activeEpoch || 0;
            while (id && same(id, epoch) && (state.dirty || state.savePromise)) {
                if (!await saveActive()) return false;
            }
            return !id || same(id, epoch);
        }

        function invalidate() {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
            state.activeEpoch = (state.activeEpoch || 0) + 1;
        }

        function beforeUnload(event) {
            if (state.dirty || state.savePromise) { event.preventDefault(); event.returnValue = ''; }
        }

        return { scheduleSave, saveActive, flush, invalidate, beforeUnload };
    }
    window.Pivot.exposeModule('apps.presentations.persistence', { create });
})();
