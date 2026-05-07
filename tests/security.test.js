const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-suite-please-do-not-use';

const {
    resolveUploadUrlPath,
    toProjectRelativePath,
    isPathInsideUploadRoot
} = require('../server/security');
const { buildFtsQuery } = require('../server/search');
const { createSseEventParser, extractStreamPayload } = require('../server/streaming');
const {
    csrfMiddleware,
    CSRF_COOKIE_NAME
} = require('../server/auth');

const uploadRoot = path.resolve(__dirname, '..', 'uploads');

test('resolveUploadUrlPath accepts normal upload URLs', () => {
    const target = resolveUploadUrlPath('/uploads/1/session/file.png?token=abc');
    assert.equal(target, path.resolve(uploadRoot, '1', 'session', 'file.png'));
    assert.equal(toProjectRelativePath(target), 'uploads/1/session/file.png');
});

test('resolveUploadUrlPath rejects traversal and non-upload URLs', () => {
    assert.equal(resolveUploadUrlPath('/api/health'), null);
    assert.equal(resolveUploadUrlPath('/uploads/../data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/%2e%2e/data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/1/../../server/index.js'), null);
    assert.equal(isPathInsideUploadRoot(path.resolve(__dirname, '..', 'server', 'index.js')), false);
});

test('buildFtsQuery escapes user input into phrase terms', () => {
    assert.equal(buildFtsQuery('hello world'), '"hello" AND "world"');
    assert.equal(buildFtsQuery('a"b NEAR c'), '"a""b" AND "NEAR" AND "c"');
    assert.equal(buildFtsQuery('   '), '');
});

test('createSseEventParser parses chunked SSE payloads', () => {
    const payloads = [];
    const parser = createSseEventParser({
        onData: payload => payloads.push(payload)
    });
    parser.write(Buffer.from('data: {"choices":[{"delta":{"content":"he'));
    parser.write(Buffer.from('llo"}}]}\n\ndata: [DONE]\n\n'));
    parser.end();
    assert.equal(payloads.length, 1);
    const extracted = extractStreamPayload(JSON.parse(payloads[0]));
    assert.deepEqual(extracted, { delta: 'hello', isThought: false, usage: null });
});

test('csrfMiddleware requires matching cookie and header for cookie writes', () => {
    let statusCode = 0;
    let body = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(value) {
            body = value;
            return this;
        }
    };

    csrfMiddleware({ method: 'POST', path: '/chat', headers: {}, socket: {} }, res, () => {
        throw new Error('CSRF should not pass without token');
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'CSRF 校验失败');

    let passed = false;
    csrfMiddleware({
        method: 'POST',
        path: '/chat',
        headers: {
            cookie: `${CSRF_COOKIE_NAME}=abc`,
            'x-csrf-token': 'abc'
        },
        socket: {}
    }, res, () => {
        passed = true;
    });
    assert.equal(passed, true);
});
