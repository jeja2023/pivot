'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactAuditDetails } = require('../server/security');
const { scrubUrl } = require('../server/logger');

test('日志 URL 清理覆盖编码参数名、大小写和重复密钥并保留定位参数', () => {
    const input = '/api/files?%74oken=private-one&ACCESS_TOKEN=private-two&password=private-three&token=private-four&page=2';
    const result = scrubUrl(input);
    assert.doesNotMatch(result, /private-/);
    assert.match(result, /page=2/);
    assert.equal((result.match(/\[REDACTED\]/g) || []).length, 4);
    assert.equal(scrubUrl('/api/files?name=%ZZ&page=2'), '/api/files?name=%ZZ&page=2');
});

test('审计深层对象、数组和循环引用不能回传原始密钥且不修改输入', () => {
    const source = { ordinary: '保留内容', branches: [] };
    let node = source;
    for (let depth = 0; depth < 8; depth++) { node.child = {}; node = node.child; }
    node.password = 'synthetic-deep-password';
    source.branches.push({ access_token: 'synthetic-access-token' }, source);
    const result = redactAuditDetails(source);
    assert.doesNotMatch(result, /synthetic-/);
    assert.match(result, /保留内容/);
    assert.equal(node.password, 'synthetic-deep-password');
    assert.equal(source.branches[1], source);
    assert.doesNotThrow(() => JSON.stringify(redactSecrets(Array(1500).fill(source))));
});

test('MCP 失败摘要与输入输出共用脱敏，编码 URL 参数不进入审计', () => {
    const queuePath = require.resolve('../server/services/db-write-queue'), clientPath = require.resolve('../server/services/mcp-client');
    const queue = require(queuePath), oldClient = require.cache[clientPath], logs = [];
    require.cache[queuePath].exports = { ...queue, enqueueMcpCallLog: value => logs.push(value) };
    delete require.cache[clientPath];
    try {
        require(clientPath).recordMcpCallLog({ user: { id: 1 }, toolName: '合成只读工具', status: 'error',
            input: { password: 'synthetic-input-password' }, error: new Error('连接 /api?%74oken=synthetic-error-token&name=示例 失败') });
        assert.equal(logs.length, 1);
        assert.doesNotMatch(JSON.stringify(logs[0]), /synthetic-/);
        assert.match(logs[0].errorMessage, /name=示例/);
    } finally {
        require.cache[queuePath].exports = queue;
        delete require.cache[clientPath]; if (oldClient) require.cache[clientPath] = oldClient;
    }
});
