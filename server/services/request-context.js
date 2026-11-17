const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithRequestContext(context, callback) {
    const store = {
        requestId: String(context?.requestId || ''),
        userId: context?.userId ?? null
    };
    if (context && Object.hasOwn(context, 'helperBrowserKey')) {
        store.helperBrowserKey = String(context.helperBrowserKey || '');
    }
    return storage.run(store, callback);
}

function getRequestContext() {
    return storage.getStore() || { requestId: '', userId: null };
}

function getRequestId() {
    return String(getRequestContext().requestId || '');
}

module.exports = { getRequestContext, getRequestId, runWithRequestContext };
