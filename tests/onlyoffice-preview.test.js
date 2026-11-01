'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { configuration, createPreviewConfig, verifyReadTicket } = require('../server/services/onlyoffice-preview');

const secret = 'onlyoffice-test-secret-0123456789abcdef';
const env = { PIVOT_ONLYOFFICE_PATH: '/onlyoffice', PIVOT_ONLYOFFICE_PIVOT_URL: 'http://pivot:3000', PIVOT_ONLYOFFICE_JWT_SECRET: secret };
const rendition = { id: 13, format: 'docx', status: 'ready', content_digest: 'a'.repeat(64) };
const user = { id: 5, token_version: 2 };

test('ONLYOFFICE 未启用时保留本地预览，启用后生成受约束的签名只读配置', () => {
    assert.equal(configuration({}), null);
    const config = configuration(env);
    const preview = createPreviewConfig(rendition, user, { config });
    assert.equal(preview.scriptUrl, '/onlyoffice/web-apps/apps/api/documents/api.js');
    assert.equal(preview.editor.editorConfig.mode, 'view');
    assert.equal(preview.editor.document.permissions.edit, false);
    assert.equal(preview.editor.document.permissions.download, false);
    const decoded = jwt.verify(preview.editor.token, secret, { algorithms: ['HS256'] });
    assert.equal(decoded.document.url, preview.editor.document.url);
    const ticket = new URL(preview.editor.document.url).searchParams.get('token');
    const claims = verifyReadTicket(ticket, { config });
    assert.equal(claims.userId, user.id);
    assert.equal(claims.renditionId, rendition.id);
    assert.equal(claims.tokenVersion, user.token_version);
    assert.ok(claims.exp - claims.iat <= 300);
    assert.throws(() => verifyReadTicket(preview.editor.token, { config }));
    assert.throws(() => verifyReadTicket(ticket + 'x', { config }));
    assert.throws(() => createPreviewConfig({ ...rendition, format: 'pdf' }, user, { config }));
    assert.notEqual(createPreviewConfig({ ...rendition, content_digest: 'b'.repeat(64) }, user, { config }).editor.document.key, preview.editor.document.key);
});

test('禁止外部脚本地址、带凭据的回源和弱密钥', () => {
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_PATH: 'https://example.com' }));
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_PIVOT_URL: 'http://user:pass@pivot:3000' }));
    assert.throws(() => configuration({ ...env, PIVOT_ONLYOFFICE_JWT_SECRET: 'short' }));
});
