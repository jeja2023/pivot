const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithRequestContext(context, callback) {
    return storage.run({
        requestId: String(context?.requestId || ''),
        userId: context?.userId ?? null
    }, callback);
}

function getRequestContext() {
    return storage.getStore() || { requestId: '', userId: null };
}

function getRequestId() {
    return String(getRequestContext().requestId || '');
}

module.exports = { getRequestContext, getRequestId, runWithRequestContext };
