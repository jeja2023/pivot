// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    KeyedConcurrencyGuard,
    assert,
    maskSecretString,
    modelRouter,
    redactSecrets,
    streamingTools,
    test
} = require('../security-helpers');

test('KeyedConcurrencyGuard 会跳过重复 key，并在完成后释放', async () => {
    const guard = new KeyedConcurrencyGuard({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const task = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return 'done';
    };
    const [a, b, c] = await Promise.all([
        guard.run('s1', task),
        guard.run('s1', task),
        guard.run('s2', task)
    ]);
    assert.equal(a.skipped, false);
    assert.equal(a.value, 'done');
    assert.equal(b.skipped, true);
    assert.equal(b.reason, 'duplicate');
    assert.equal(c.skipped, false);
    assert.equal(peak <= 2, true);
});

test('redactSecrets 会遮蔽嵌套结构中的 API key 和令牌', () => {
    const input = {
        api_key: 'sk-abc123xyz789secrettoken',
        nested: {
            authorization: 'Bearer eyJraWQiOiJ0ZXN0IiwibmFtZSI6Im1pY2tleSJ9.payload.signature',
            note: 'public field'
        },
        items: [
            { secret_token: 'topsecret-payload-1234567890abcdef' },
            { description: 'no secret here' }
        ]
    };
    const redacted = redactSecrets(input);
    assert.equal(redacted.api_key, '[REDACTED]');
    assert.equal(redacted.nested.authorization, '[REDACTED]');
    assert.equal(redacted.nested.note, 'public field');
    assert.equal(redacted.items[0].secret_token, '[REDACTED]');
    assert.equal(redacted.items[1].description, 'no secret here');
});

test('maskSecretString 会遮蔽行内 sk-* 和 Bearer 令牌', () => {
    const text = 'curl -H "Authorization: Bearer eyJabcdefghij.kkkkkkkkkk.mmmmmmmmmm" https://api.example.com using sk-abcdefghijklmnop1234';
    const masked = maskSecretString(text);
    assert.equal(masked.includes('sk-abcdefghijklmnop1234'), false);
    assert.equal(masked.includes('eyJabcdefghij.kkkkkkkkkk.mmmmmmmmmm'), false);
    assert.equal(masked.includes('[REDACTED]'), true);
});

test('redactSecrets 不会修改原始对象引用', () => {
    const original = { api_key: 'secret', note: 'hi' };
    const redacted = redactSecrets(original);
    assert.notEqual(redacted, original);
    assert.equal(original.api_key, 'secret');
    assert.equal(redacted.api_key, '[REDACTED]');
});

test('estimateMessageTokens 中英文混合按 2:0.5 估算', () => {
    assert.equal(modelRouter.estimateMessageTokens([{ role: 'user', content: '中文测试' }]), Math.ceil(4 * 2));
    const englishTokens = modelRouter.estimateMessageTokens([{ role: 'user', content: 'hello world' }]);
    assert.ok(englishTokens >= 5 && englishTokens <= 8);
    assert.equal(modelRouter.estimateMessageTokens([]), 0);
    assert.equal(modelRouter.estimateMessageTokens([{ role: 'user', content: '' }]), 0);
});

test('hasUsableInputWindow 在窗口未配置时视为足够', () => {
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 0 }, 9999), true);
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 100 }, 50), true);
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 100 }, 150), false);
});

test('modelTotalPrice 累加输入输出单价并对缺失字段安全', () => {
    assert.equal(modelRouter.modelTotalPrice({ input_price_per_million: 3, output_price_per_million: 12 }), 15);
    assert.equal(modelRouter.modelTotalPrice({}), 0);
    assert.equal(modelRouter.modelTotalPrice({ input_price_per_million: 'invalid' }), 0);
});

test('累加器同时记录 content 文本与多个工具调用', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { content: '我先去查一下知识库。' } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'rag.search', arguments: '{"q":"A"}' } }] } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'rag.summary', arguments: '{"docId":1}' } }] } }] });
    acc.ingest({ choices: [{ finish_reason: 'tool_calls' }] });
    const result = acc.finalize();
    assert.equal(result.content, '我先去查一下知识库。');
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'rag.search');
    assert.equal(result.toolCalls[1].name, 'rag.summary');
    assert.deepEqual(result.toolCalls[1].arguments, { docId: 1 });
});

test('累加器对 arguments JSON 解析失败保留原始字符串与 parseError', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'broken', arguments: '{invalid' } }] } }] });
    acc.ingest({ choices: [{ finish_reason: 'tool_calls' }] });
    const result = acc.finalize();
    assert.equal(result.toolCalls[0].arguments, null);
    assert.equal(result.toolCalls[0].argumentsRaw, '{invalid');
    assert.ok(result.toolCalls[0].parseError.length > 0);
});

test('累加器在超过 TOOL_CALL_LIMIT 时记录错误并丢弃新增项', () => {
    const acc = streamingTools.createToolCallAccumulator();
    for (let i = 0; i < streamingTools.TOOL_CALL_LIMIT + 4; i += 1) {
        acc.ingest({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: `t${i}`, arguments: '{}' } }] } }] });
    }
    const result = acc.finalize();
    assert.equal(result.toolCalls.length, streamingTools.TOOL_CALL_LIMIT);
    assert.ok(result.errors.length > 0);
});
