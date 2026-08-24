const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createWorkerApprovalStore,
    isSecureWorkerRendererUrl,
    normalizeWorkerRequest
} = require('../desktop/worker-security');

function makeWorkerFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-worker-security-'));
    const workspace = path.join(root, 'task-1');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'run.js'), 'process.stdout.write("ok")', 'utf8');
    return { root, workspace };
}

test('desktop worker accepts only an existing relative workspace script', () => {
    const fixture = makeWorkerFixture();
    try {
        const request = normalizeWorkerRequest({ command: 'node', args: ['run.js'], taskId: 'task-1' }, { workspaceRoot: fixture.root });
        assert.equal(request.workspaceRoot, path.resolve(fixture.root));
        assert.equal(request.networkEnabled, false);
        assert.throws(
            () => normalizeWorkerRequest({ command: 'node', args: ['-e', 'process.exit()'], taskId: 'task-1' }, { workspaceRoot: fixture.root }),
            error => error.code === 'AGENT_WORKER_INLINE_CODE_DENIED'
        );
        assert.throws(
            () => normalizeWorkerRequest({ command: 'node', args: ['../outside.js'], taskId: 'task-1' }, { workspaceRoot: fixture.root }),
            error => error.code === 'AGENT_WORKER_SCRIPT_OUTSIDE_WORKSPACE'
        );
        assert.throws(
            () => normalizeWorkerRequest({ command: 'node', args: ['run.js'], taskId: 'task-1', networkEnabled: true }, { workspaceRoot: fixture.root }),
            error => error.code === 'AGENT_WORKER_NETWORK_DENIED'
        );
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('desktop worker approval is one-time and bound to the complete request', () => {
    const fixture = makeWorkerFixture();
    let currentTime = 1000;
    try {
        const request = normalizeWorkerRequest({ command: 'node', args: ['run.js'], taskId: 'task-1', input: 'a' }, { workspaceRoot: fixture.root });
        const store = createWorkerApprovalStore({ ttlMs: 100, now: () => currentTime });
        const first = store.issue(request);
        assert.throws(
            () => store.consume(first.token, { ...request, input: 'changed' }),
            error => error.code === 'AGENT_WORKER_APPROVAL_MISMATCH'
        );
        const second = store.issue(request);
        assert.equal(store.consume(second.token, request), true);
        assert.throws(() => store.consume(second.token, request), /已使用|已过期/);
        const expired = store.issue(request);
        currentTime += 101;
        assert.throws(() => store.consume(expired.token, request), /已过期/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('desktop worker rejects non-loopback HTTP renderer origins', () => {
    assert.equal(isSecureWorkerRendererUrl('https://pivot.example.test/chat'), true);
    assert.equal(isSecureWorkerRendererUrl('http://127.0.0.1:3000/chat'), true);
    assert.equal(isSecureWorkerRendererUrl('http://localhost:3000/chat'), true);
    assert.equal(isSecureWorkerRendererUrl('http://192.168.10.20:3000/chat'), false);
});
