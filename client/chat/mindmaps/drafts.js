(function () {
    'use strict';
    let connection;
    let writes = Promise.resolve();
    function open() {
        if (connection) return connection;
        connection = new Promise((resolve, reject) => {
            const request = window.indexedDB.open('pivot-mindmap-drafts', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => { connection = null; reject(new Error('本地草稿不可用，请手动保存并导出备份。')); };
        });
        return connection;
    }
    function key(userId, id) { return `${location.origin}:${userId}:${id}`; }
    async function action(mode, run) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', mode); const result = run(transaction.objectStore('drafts'));
            transaction.oncomplete = () => resolve(result?.result);
            transaction.onerror = () => reject(new Error('本地草稿写入失败，请手动保存或导出备份。'));
        });
    }
    async function writeRecord(userId, id, document, versionId) {
        if (!userId || !id) return;
        const existing = await action('readonly', store => store.getAll());
        const scoped = existing.filter(draft => draft.userId === String(userId)).sort((a, b) => b.savedAt - a.savedAt);
        for (const draft of scoped.filter((draft, index) => index >= 19 || Date.now() - draft.savedAt > 7 * 86400000)) await action('readwrite', store => store.delete(draft.key));
        await action('readwrite', store => store.put({ key: key(userId, id), userId: String(userId), document, versionId, savedAt: Date.now() }));
    }
    function write(userId, id, document, versionId) {
        const snapshot = JSON.parse(JSON.stringify(document));
        writes = writes.catch(() => {}).then(() => writeRecord(userId, id, snapshot, versionId));
        return writes;
    }
    async function read(userId, id) {
        const value = await action('readonly', store => store.get(key(userId, id)));
        if (value && Date.now() - value.savedAt > 7 * 86400000) { await remove(userId, id); return null; }
        return value;
    }
    async function remove(userId, id) { await writes.catch(() => {}); return action('readwrite', store => store.delete(key(userId, id))); }
    async function clear(userId) {
        await writes.catch(() => {});
        await action('readwrite', store => {
            const request = store.openCursor();
            request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (cursor.value.userId === String(userId) || Date.now() - cursor.value.savedAt > 7 * 86400000) cursor.delete(); cursor.continue(); };
        });
    }
    window.Pivot.exposeModule('mindmaps.drafts', { write, read, remove, clear });
})();
