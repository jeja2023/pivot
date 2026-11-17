(function () {
    'use strict';
    const pivot = window.Pivot;
    const leaseMs = 30000;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let database;
    let sequence = 0;

    function unavailable() { return new Error('浏览器暂时无法协调登录状态，请稍后重试或重新打开页面。'); }
    function openDatabase() {
        if (!database) database = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(unavailable()); return; }
            const request = window.indexedDB.open('pivot-auth-coordination', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('locks');
            request.onerror = () => reject(unavailable());
            request.onblocked = () => reject(unavailable());
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); database = null; };
                resolve(db);
            };
        }).catch(error => { database = null; throw error; });
        return database;
    }

    // IndexedDB 读写事务跨标签页串行，在内网 HTTP 上也可用；不保存凭据。
    async function changeLease(owner, mode) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('locks', 'readwrite');
            const store = transaction.objectStore('locks');
            const request = store.get('session');
            let acquired = false;
            transaction.oncomplete = () => resolve(acquired);
            transaction.onerror = transaction.onabort = () => reject(unavailable());
            request.onsuccess = () => {
                const current = request.result;
                if (mode === 'release') { if (current?.owner === owner) store.delete('session'); return; }
                if (current?.owner === owner || mode === 'acquire' && (!current || current.expires <= Date.now())) {
                    store.put({ owner, expires: Date.now() + leaseMs }, 'session');
                    acquired = true;
                }
            };
        });
    }

    async function withDatabaseLease(operation) {
        const owner = `${Date.now()}:${Math.random()}:${++sequence}`;
        const deadline = Date.now() + 45000;
        while (!await changeLease(owner, 'acquire')) {
            if (Date.now() >= deadline) throw unavailable();
            await wait(80);
        }
        const controller = new AbortController();
        const renewal = setInterval(() => {
            changeLease(owner, 'renew').then(held => { if (!held) controller.abort(unavailable()); }, () => controller.abort(unavailable()));
        }, 5000);
        try { return await operation(controller.signal); }
        finally { clearInterval(renewal); await changeLease(owner, 'release'); }
    }

    pivot.authSession = {
        run(operation) {
            if (window.navigator?.locks?.request) return window.navigator.locks.request('pivot-auth-session', () => operation());
            return withDatabaseLease(operation);
        }
    };
})();
