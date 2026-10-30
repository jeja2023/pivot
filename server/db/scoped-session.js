'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const sessions = new AsyncLocalStorage();

function runWithScopedSession(client, run) { return sessions.run(client, run); }
function getScopedSession() { return sessions.getStore() || null; }

module.exports = { getScopedSession, runWithScopedSession };
