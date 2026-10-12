'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const [migration] = require('../server/db/migrations/refresh-token-single-ip-binding');

test('单 IP 会话迁移为刷新令牌补齐来源地址和查询索引', async () => {
    const calls = [];
    await migration.upPg({ query: async sql => { calls.push(String(sql)); } });
    const sql = calls.join('\n');
    assert.match(sql, /ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS login_ip TEXT DEFAULT ''/);
    assert.match(sql, /idx_refresh_tokens_user_login_ip/);
});
