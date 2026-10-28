'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listWebdavFiles, normalizeWebdavConfig, webdavScopeFingerprint, isWithinWebdavScope } = require('../server/services/knowledge-webdav');

test('WebDAV 使用深度一清单，只接受同目录文件并限制数量', async () => {
    let called;
    const result = await listWebdavFiles({ url: 'https://intranet.test/policies/', credentialRef: 'TOKEN', maxFiles: 1 }, { id: 7 }, {
        resolveCredentialSecret: async () => ({ value: 'fixture-secret' }),
        request: async options => {
            called = options;
            return { status: 207, data: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
                <d:response><d:href>/policies/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
                <d:response><d:href>/policies/a.pdf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
                <d:response><d:href>/policies/b.pdf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
            </d:multistatus>` };
        }
    });
    assert.equal(called.headers.Depth, '1');
    assert.equal(called.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].canonicalUri, 'https://intranet.test/policies/a.pdf');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    assert.equal(result.complete, false);
});

test('WebDAV 禁止内嵌凭据、外部地址和 XML 实体', async () => {
    assert.throws(() => normalizeWebdavConfig({ url: 'https://user:pass@example.test/' }), /地址/);
    const request = async () => ({ status: 207, data: '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:" />' });
    await assert.rejects(() => listWebdavFiles({ url: 'https://example.test/' }, { id: 1 }, { request }), /无效/);
    const outside = await listWebdavFiles({ url: 'https://example.test/docs/' }, { id: 1 }, { request: async () => ({ status: 207, data: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://evil.test/x.pdf</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>' }) });
    assert.equal(outside.items.length, 0);
    assert.equal(outside.complete, false);
});

test('WebDAV 仅在开启递归时遍历同根子目录并执行深度上限', async () => {
    const calls = [];
    const request = async ({ url }) => {
        calls.push(url);
        const href = url.endsWith('/root/') ? '/root/sub/' : '/root/sub/deep/';
        return { status: 207, data: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>${url.endsWith('/root/') ? '/root/a.pdf' : '/root/sub/b.pdf'}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>` };
    };
    const result = await listWebdavFiles({ url: 'https://host.test/root/', recursive: true, maxDepth: 1 }, { id: 1 }, { request });
    assert.deepEqual(calls, ['https://host.test/root/', 'https://host.test/root/sub/']);
    assert.equal(result.items.length, 2);
    assert.equal(result.complete, false);
});

test('WebDAV 删除同步必须显式开启，默认关闭', () => {
    assert.equal(normalizeWebdavConfig({ url: 'https://example.test/' }).syncDeletes, false);
    assert.equal(normalizeWebdavConfig({ url: 'https://example.test/', syncDeletes: true }).syncDeletes, true);
});

test('WebDAV 只有确认当前目录成功时才能将空清单视为完整', async () => {
    const list = data => listWebdavFiles({ url: 'https://example.test/docs/' }, { id: 1 }, { request: async () => ({ status: 207, data }) });
    const empty = '<d:multistatus xmlns:d="DAV:" />';
    const invalidRoot = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/docs/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>';
    const validRoot = invalidRoot.replace('403 Forbidden', '200 OK');
    assert.equal((await list(empty)).complete, false);
    assert.equal((await list(invalidRoot)).complete, false);
    assert.equal((await list(validRoot)).complete, true);
});

test('WebDAV 范围指纹随目录与遍历策略改变，但不受删除开关影响', () => {
    const base = normalizeWebdavConfig({ url: 'https://example.test/docs/', recursive: false });
    const fingerprint = webdavScopeFingerprint(base);
    assert.equal(webdavScopeFingerprint({ ...base, syncDeletes: true }), fingerprint);
    assert.notEqual(webdavScopeFingerprint({ ...base, recursive: true }), fingerprint);
    assert.notEqual(webdavScopeFingerprint({ ...base, credentialRef: 'OTHER' }), fingerprint);
});

test('WebDAV 不将已离开当前范围的文档作为缺失资料', () => {
    const config = normalizeWebdavConfig({ url: 'https://example.test/docs/', recursive: false });
    assert.equal(isWithinWebdavScope('https://example.test/docs/a.pdf', config), true);
    assert.equal(isWithinWebdavScope('https://example.test/docs/sub/a.pdf', config), false);
    assert.equal(isWithinWebdavScope('https://example.test/other/a.pdf', config), false);
    assert.equal(isWithinWebdavScope('https://example.test/docs/sub/a.pdf', { ...config, recursive: true, maxDepth: 1 }), true);
});
