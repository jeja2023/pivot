const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isPublicRemoteHostname,
    isLocalModelHost,
    isLocalModelHostAsync,
    shouldResolveHostAlias,
    normalizeHostAlias
} = require('../server/services/host-classifier');

test('主机分类器能准确判定公共远端域名并跳过 DNS 解析', async () => {
    assert.equal(isPublicRemoteHostname('api.openai.com'), true);
    assert.equal(isPublicRemoteHostname('dashscope.aliyuncs.com'), true);
    assert.equal(isPublicRemoteHostname('api.deepseek.com'), true);
    assert.equal(isPublicRemoteHostname('api.siliconflow.cn'), true);
    assert.equal(isPublicRemoteHostname('openrouter.ai'), true);
    assert.equal(isPublicRemoteHostname('api.groq.com'), true);
    assert.equal(isPublicRemoteHostname('models.mycompany.org'), true);

    // 本地主机名不是公共远端
    assert.equal(isPublicRemoteHostname('localhost'), false);
    assert.equal(isPublicRemoteHostname('127.0.0.1'), false);
    assert.equal(isPublicRemoteHostname('192.168.1.50'), false);
    assert.equal(isPublicRemoteHostname('host.docker.internal'), false);
    assert.equal(isPublicRemoteHostname('ollama-service'), false);

    // shouldResolveHostAlias 对于公网域名返回 false（避免在内网或离线环境中发起阻塞的 DNS 查询）
    assert.equal(shouldResolveHostAlias('api.openai.com'), false);
    assert.equal(shouldResolveHostAlias('api.deepseek.com'), false);
    assert.equal(shouldResolveHostAlias('localhost'), false);
    assert.equal(shouldResolveHostAlias('127.0.0.1'), false);

    const localNames = new Set(['localhost', '127.0.0.1', '192.168.1.100']);
    assert.equal(isLocalModelHost('api.openai.com', localNames), false);
    assert.equal(isLocalModelHost('localhost', localNames), true);
    const isLocal1 = await isLocalModelHostAsync('api.openai.com', localNames);
    assert.equal(isLocal1, false);

    const isLocal2 = await isLocalModelHostAsync('localhost', localNames);
    assert.equal(isLocal2, true);

    const isLocal3 = await isLocalModelHostAsync('127.0.0.1', localNames);
    assert.equal(isLocal3, true);

    const isLocal4 = await isLocalModelHostAsync('192.168.1.100', localNames);
    assert.equal(isLocal4, true);
});

test('主机规范化正确处理多种格式', () => {
    assert.equal(normalizeHostAlias('http://api.deepseek.com:8080/v1'), 'api.deepseek.com');
    assert.equal(normalizeHostAlias('https://[::1]:8000/'), '::1');
    assert.equal(normalizeHostAlias('192.168.1.200:11434'), '192.168.1.200');
    assert.equal(normalizeHostAlias('localhost'), 'localhost');
});
