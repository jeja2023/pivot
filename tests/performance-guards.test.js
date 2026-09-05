const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeLimit, normalizePage } = require('../server/http');

test('分页输入统一限制正数页码与最大响应条数', () => {
    assert.equal(normalizePage('-2'), 1);
    assert.equal(normalizePage('999'), 999);
    assert.equal(normalizeLimit('-5', 20, 100), 1);
    assert.equal(normalizeLimit('999999', 20, 100), 100);
    assert.equal(normalizeLimit('bad', 20, 100), 20);
});
const { EventEmitter } = require('node:events');

const { sql } = require('../server/db/statements');
const sessionsRepository = require('../server/repositories/sessions');
const {
    buildEmbeddingInputBatches,
    isEmbeddingCapacityError
} = require('../server/services/rag-index/embedding-client');
const {
    buildRagSearchContent,
    buildRagSearchTerms
} = require('../server/services/rag-tokenizer');
const {
    createSseResponseWriter,
    encodeSseComment,
    encodeSseData
} = require('../server/services/sse-response');
const {
    executeDagNodeWithPolicy
} = require('../server/services/agent-dag-runtime');
const { withTimeout } = require('../server/services/agent-runtime/runtime-env');

class FakeSseResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = new Map();
        this.chunks = [];
        this.destroyed = false;
        this.writableEnded = false;
        this.writableNeedDrain = false;
        this.socket = {
            setNoDelay() {},
            setKeepAlive() {}
        };
    }

    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    }

    flushHeaders() {}

    flush() {}

    write(chunk) {
        this.chunks.push(String(chunk));
        return true;
    }
}

test('SSE writer emits an idle comment heartbeat and cleans up its timer', () => {
    const originalNow = Date.now;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let now = 1000;
    let intervalCallback = null;
    let timerCleared = false;
    const timer = { unref() {} };

    Date.now = () => now;
    global.setInterval = callback => {
        intervalCallback = callback;
        return timer;
    };
    global.clearInterval = value => {
        if (value === timer) timerCleared = true;
    };

    try {
        const res = new FakeSseResponse();
        const writer = createSseResponseWriter(res, { heartbeatMs: 1000 });
        assert.equal(res.headers.get('x-accel-buffering'), 'no');
        assert.equal(res.headers.get('content-encoding'), 'identity');

        writer.writeData({ ok: true });
        now = 1500;
        intervalCallback();
        assert.equal(res.chunks.length, 1);
        now = 2101;
        intervalCallback();
        assert.equal(res.chunks.at(-1), ': keep-alive\n\n');

        res.emit('finish');
        assert.equal(timerCleared, true);
        assert.equal(writer.isWritable(), false);
    } finally {
        Date.now = originalNow;
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }
});

test('SSE frame encoders handle multiline values without producing malformed frames', () => {
    assert.equal(encodeSseComment('one\r\ntwo'), ': one\n: two\n\n');
    assert.equal(encodeSseData('one\ntwo', 'delta'), 'event: delta\ndata: one\ndata: two\n\n');
});

test('Embedding batches obey count and byte budgets while preserving input order', () => {
    assert.deepEqual(
        buildEmbeddingInputBatches(['a', 'b', 'c', 'd', 'e'], { maxInputs: 2 }),
        [['a', 'b'], ['c', 'd'], ['e']]
    );
    const largeInputs = ['a'.repeat(3000), 'b'.repeat(3000)];
    assert.deepEqual(
        buildEmbeddingInputBatches(largeInputs, { maxInputs: 10, maxBytes: 4096 }),
        [[largeInputs[0]], [largeInputs[1]]]
    );
    assert.equal(isEmbeddingCapacityError({ response: { status: 413 } }), true);
    assert.equal(isEmbeddingCapacityError(new Error('CUDA out of memory')), true);
    assert.equal(isEmbeddingCapacityError({ response: { status: 401 } }), false);
});

test('RAG tokenizer preserves code identifiers and their symbols as searchable terms', () => {
    const terms = buildRagSearchTerms('调用 foo_bar::run/v2');
    const content = buildRagSearchContent('调用 foo_bar::run/v2');
    assert.ok(terms.some(term => term.includes('zsym5fz') && term.includes('zsym3az')));
    assert.ok(content.includes('zsym2fz'));
});

test('RAG PostgreSQL retrieval pushes vector distance and lexical ranking into the database', () => {
    const root = path.resolve(__dirname, '..');
    const repository = fs.readFileSync(path.join(root, 'server/repositories/knowledge.js'), 'utf8');
    const rag = fs.readFileSync(path.join(root, 'server/services/rag-index/index.js'), 'utf8');
    const regulations = fs.readFileSync(path.join(root, 'server/services/regulations/search.js'), 'utf8');
    assert.match(repository, /vector_dims\(c\.embedding\)\s*=\s*\?/);
    assert.match(repository, /c\.embedding\s*<=>\s*\?::vector/);
    assert.match(rag, /ORDER BY lexical_score DESC/);
    assert.match(regulations, /a\.embedding\s*<=>\s*\?::vector/);
    assert.match(regulations, /ORDER BY score DESC/);
});

test('DAG node watchdog uses a node-specific timeout and does not retry a timed-out node', async () => {
    const timeout = new Error('slow node timed out');
    timeout.code = 'AGENT_NODE_TIMEOUT';
    let retrySteps = 0;
    let receivedTimeoutCode = '';
    const result = await executeDagNodeWithPolicy({
        run: { id: 'watchdog-run' },
        user: { id: 1 },
        modelCfg: null,
        node: { id: 'slow', title: 'Slow node', tool: 'test.slow' },
        resolvedInput: {},
        toolList: [],
        deadline: Date.now() + 60000,
        policy: { retryLimit: 3, timeoutMs: 1000 }
    }, {
        assertRunNotCancelled() {},
        executeToolByName() {
            throw new Error('unexpected tool execution');
        },
        insertStep() {
            retrySteps += 1;
        },
        async withTimeout(_operation, _timeoutMs, _label, options) {
            receivedTimeoutCode = options.timeoutCode;
            throw timeout;
        }
    });

    assert.equal(receivedTimeoutCode, 'AGENT_NODE_TIMEOUT');
    assert.equal(result.ok, false);
    assert.equal(result.attempt, 1);
    assert.equal(result.error.code, 'AGENT_NODE_TIMEOUT');
    assert.equal(retrySteps, 0);
});

test('withTimeout aborts work with the requested error code', async () => {
    let operationSignal = null;
    await assert.rejects(
        withTimeout(signal => {
            operationSignal = signal;
            return new Promise(() => {});
        }, 1, 'test node', { timeoutCode: 'AGENT_NODE_TIMEOUT' }),
        error => error.code === 'AGENT_NODE_TIMEOUT'
    );
    assert.equal(operationSignal.aborted, true);
});

test('session message pagination returns stable chronological cursor pages', async () => {
    const suffix = Date.now().toString(36);
    const username = `message_page_${suffix}`;
    const sessionId = `message-page-${suffix}`;
    const userId = Number(sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Message Page', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(username).lastInsertRowid);

    try {
        await sessionsRepository.createSession({
            id: sessionId,
            userId,
            title: 'Pagination',
            createdAt: '2026-01-01 00:00:00'
        });
        for (let index = 1; index <= 5; index += 1) {
            await sessionsRepository.insertMessage({
                sessionId,
                userId,
                role: index % 2 ? 'user' : 'assistant',
                content: `message-${index}`,
                tokenCount: index,
                modelId: null,
                createdAt: `2026-01-01 00:00:0${index}`
            });
        }

        const newest = await sessionsRepository.listMessagePage(sessionId, userId, { limit: 2 });
        assert.deepEqual(newest.messages.map(row => row.content), ['message-4', 'message-5']);
        assert.equal(newest.page.hasMore, true);

        const middle = await sessionsRepository.listMessagePage(sessionId, userId, {
            limit: 2,
            beforeId: newest.page.beforeId
        });
        assert.deepEqual(middle.messages.map(row => row.content), ['message-2', 'message-3']);
        assert.equal(middle.page.hasMore, true);

        const oldest = await sessionsRepository.listMessagePage(sessionId, userId, {
            limit: 2,
            beforeId: middle.page.beforeId
        });
        assert.deepEqual(oldest.messages.map(row => row.content), ['message-1']);
        assert.equal(oldest.page.hasMore, false);
    } finally {
        sql('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        sql('DELETE FROM sessions WHERE id = ?').run(sessionId);
        sql('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('chat assets include variable-height virtualization and deferred chart mounting', () => {
    const root = path.resolve(__dirname, '..');
    const virtualizer = fs.readFileSync(path.join(root, 'client/chat/message-virtualizer.js'), 'utf8');
    const chartRenderer = fs.readFileSync(path.join(root, 'client/chat/render-charts.js'), 'utf8');
    const engine = fs.readFileSync(path.join(root, 'client/chat/engine.js'), 'utf8');
    const sessionEngine = fs.readFileSync(path.join(root, 'client/chat/engine-sessions.js'), 'utf8');
    const dagRenderer = fs.readFileSync(path.join(root, 'client/chat/dag-render.js'), 'utf8');
    const scripts = fs.readFileSync(path.join(root, 'client/chat/partials/scripts.html'), 'utf8');

    assert.match(virtualizer, /ResizeObserver/);
    assert.match(virtualizer, /OVERSCAN_PX/);
    assert.match(virtualizer, /beforeMessageId/);
    assert.match(virtualizer, /disableImagePinning/);
    assert.match(virtualizer, /exposeModule\('chat\.messageVirtualizer'/);
    assert.match(engine, /modules\?\.\['chat\.messageVirtualizer'\]/);
    assert.match(sessionEngine, /modules\?\.\['chat\.messageVirtualizer'\]/);
    assert.match(chartRenderer, /isConnected/);
    assert.match(chartRenderer, /getInstanceByDom/);
    assert.match(virtualizer, /teardownPivotCharts/);
    assert.match(dagRenderer, /DAG_CULL_THRESHOLD/);
    assert.match(dagRenderer, /dagViewport/);
    assert.ok(scripts.indexOf('/chat/message-virtualizer.js') > scripts.indexOf('/chat/render-messages.js'));
});
