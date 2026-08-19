const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTriggersRouter(dispatchWebhookTrigger) {
    const filename = path.resolve(__dirname, '../server/routes/triggers.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const routes = new Map();
    const router = {
        post(routePath, ...handlers) {
            routes.set(routePath, handlers);
        }
    };

    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require(request) {
            if (request === 'express') return { Router: () => router };
            if (request === '../http') return { asyncHandler: handler => handler };
            if (request === '../logger') return { logger: { warn() {} } };
            if (request === '../services/agent-triggers') {
                return { dispatchWebhookTrigger, MAX_WEBHOOK_PAYLOAD_BYTES: 1024 };
            }
            if (request === '../services/agent-approval-requests') {
                return { handleImApprovalCallback: async () => null, CALLBACK_TOKEN_PATTERN: /^im_/ };
            }
            throw new Error(`Unexpected require: ${request}`);
        },
        Buffer
    }, { filename });

    return { createTriggersRouter: module.exports.createTriggersRouter, routes };
}

test('workflow webhook waits for asynchronous dispatch before responding', async () => {
    let resolveDispatch;
    const dispatchPromise = new Promise(resolve => { resolveDispatch = resolve; });
    const { createTriggersRouter, routes } = loadTriggersRouter(() => dispatchPromise);
    let loggedResult = null;
    createTriggersRouter({
        triggerLimiter: (_req, _res, next) => next(),
        logAction: (_req, _action, detail) => { loggedResult = detail; }
    });

    const handler = routes.get('/workflow/:token').at(-1);
    const response = {
        statusCode: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
    const pending = handler({
        params: { token: `wht_${'a'.repeat(48)}` },
        body: { message: 'run' },
        ip: '127.0.0.1'
    }, response);

    await Promise.resolve();
    assert.equal(response.statusCode, null);
    assert.equal(loggedResult, null);

    resolveDispatch({ triggerName: 'Nightly workflow', runId: 42 });
    await pending;
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.success, true);
    assert.equal(response.body.runId, 42);
    assert.match(loggedResult, /Nightly workflow/);
});
