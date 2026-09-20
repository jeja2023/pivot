const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const { detectUnsupportedCapability } = require('../server/capabilities');
const {
    executeAgentWebSearch,
    isAgentWebSearchAvailable,
    normalizeSearchResults
} = require('../server/services/agent-web-search');

test('web search provider normalizes evidence only and respects the bounded result count', () => {
    const results = normalizeSearchResults({ results: [
        { title: '可信来源', url: 'https://example.com/a', snippet: '摘要' },
        { title: '无效协议', url: 'file:///secret', snippet: '不应暴露为链接' },
        { title: '第二来源', href: 'https://example.com/b', content: '详细内容' }
    ] }, 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'https://example.com/a');
    assert.equal(results[1].url, '');
    assert.equal(isAgentWebSearchAvailable({}), false);
    assert.equal(detectUnsupportedCapability('请联网搜索今天的新闻')?.code, 'realtime_web');
});

test('web search calls only an explicitly allowlisted provider and never exposes provider credentials', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ headers: req.headers, body: JSON.parse(body) });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ results: [{ title: '结果', url: 'https://evidence.example/result', snippet: '公开摘要', source: 'evidence.example' }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const previous = {
        endpoint: process.env.AGENT_WEB_SEARCH_ENDPOINT,
        key: process.env.AGENT_WEB_SEARCH_API_KEY,
        allow: process.env.ALLOW_SENSITIVE_OUTBOUND_URLS
    };
    process.env.AGENT_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${port}/search`;
    process.env.AGENT_WEB_SEARCH_API_KEY = 'provider-secret-value';
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        const output = await executeAgentWebSearch({ query: '最新项目风险', limit: 3 }, { id: 1, role: 'admin' }, {
            run: {
                network_policy: {
                    allowed_origins: [`http://127.0.0.1:${port}`],
                    allowed_ports: [port],
                    block_loopback: false,
                    block_private_ranges: false,
                    block_link_local: true
                }
            }
        });
        assert.equal(output.resultCount, 1);
        assert.equal(output.results[0].url, 'https://evidence.example/result');
        assert.doesNotMatch(output.text, /provider-secret-value/);
        assert.equal(received.length, 1);
        assert.equal(received[0].body.query, '最新项目风险');
        assert.equal(received[0].headers.authorization, 'Bearer provider-secret-value');
    } finally {
        process.env.AGENT_WEB_SEARCH_ENDPOINT = previous.endpoint;
        process.env.AGENT_WEB_SEARCH_API_KEY = previous.key;
        process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous.allow;
        await new Promise(resolve => server.close(resolve));
    }
});

test('web search is unavailable without provider and rejects missing run network policy', async () => {
    await assert.rejects(
        () => executeAgentWebSearch({ query: '最新新闻' }, { id: 1 }, { run: {} }, { env: {} }),
        error => error.code === 'AGENT_WEB_SEARCH_UNAVAILABLE'
    );
    const env = { AGENT_WEB_SEARCH_ENDPOINT: 'https://search.example.test/api' };
    await assert.rejects(
        () => executeAgentWebSearch({ query: '最新新闻' }, { id: 1 }, { run: {} }, { env }),
        error => error.code === 'AGENT_WEB_SEARCH_NETWORK_POLICY_REQUIRED'
    );
    const signature = crypto.createHash('sha256').update('web-search-contract').digest('hex');
    assert.match(signature, /^[a-f0-9]{64}$/);
});
