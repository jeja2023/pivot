// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    LruCache,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    TtlCache,
    WithTimeoutError,
    assert,
    buildComplianceAuditPackage,
    buildSingleEntryZip,
    buildZipArchive,
    calculateUsageCost,
    db,
    normalizePriceCurrency,
    readZipEntries,
    test,
    titleHelpers,
    withTimeoutHelper
} = require('../security-helpers');

test('模型成本辅助函数和合规包会生成可审计导出', () => {
    assert.equal(calculateUsageCost({
        inputTokens: 1000000,
        outputTokens: 500000,
        inputPricePerMillion: 2,
        outputPricePerMillion: 6
    }), 5);
    assert.equal(normalizePriceCurrency('美元'), '美元');
    assert.equal(normalizePriceCurrency('KRW'), '人民币');

    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`compliance_${suffix}`, 'hash', 'Compliance User', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, input_price_per_million, output_price_per_million, price_currency, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now', '+8 hours'))
    `).run(userId, 'Cost Model', 'https://model.example/v1', 'cost-model', 1.5, 4.5, '人民币');
    const modelId = Number(modelInfo.lastInsertRowid);
    const sessionId = `compliance-session-${suffix}`;
    db.prepare('INSERT INTO sessions (id, user_id, title, tags, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionId, userId, 'Compliance Session', 'audit');
    db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(sessionId, userId, 'user', 'hello', 10, modelId);
    db.prepare('INSERT INTO model_usage_events (user_id, model_id, source, token_count, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(userId, modelId, 'api', 30, 10, 20);
    db.prepare('INSERT INTO audit_logs (user_id, action, details, timestamp) VALUES (?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(userId, `COMPLIANCE_${suffix}`, 'export package test');

    try {
        const archive = buildComplianceAuditPackage({
            db,
            escapeCsvCell: value => `"${String(value ?? '').replace(/"/g, '""')}"`,
            generatedAt: '2026-05-16 00:00:00',
            filters: {}
        });
        assert.ok(Buffer.isBuffer(archive));
        assert.equal(archive.readUInt32LE(0), 0x04034b50);
        assert.ok(archive.includes(Buffer.from('manifest.json')));
        assert.ok(archive.includes(Buffer.from('model_costs.csv')));

        const smallZip = buildZipArchive([{ name: 'hello.txt', content: 'world' }]);
        assert.equal(smallZip.readUInt32LE(0), 0x04034b50);
    } finally {
        db.prepare('DELETE FROM audit_logs WHERE action = ?').run(`COMPLIANCE_${suffix}`);
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('readZipEntries 会拒绝声明膨胀过大的条目', () => {
    const zip = buildSingleEntryZip({
        name: 'word/document.xml',
        data: Buffer.from('<w:t>small</w:t>'),
        declaredUncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1
    });
    assert.throws(() => readZipEntries(zip), /too large|too much data/);
});

test('聊天标题辅助函数会净化生成标题并保护自定义标题', () => {
    assert.equal(
        titleHelpers.sanitizeGeneratedTitle('User permission setup flow', 'Permission setup'),
        'User permission setup fl'
    );
    assert.equal(
        titleHelpers.sanitizeGeneratedTitle('untitled', 'Document content analysis'),
        'Document content analysis'
    );
    assert.equal(
        titleHelpers.buildFallbackTitle('Please analyze this quarterly sales spreadsheet and summarize risks.'),
        'Please analyze this quar'
    );
    assert.equal(
        titleHelpers.shouldReplaceAutoTitle('User greets ass...', 'User greets assistant'),
        true
    );
    assert.equal(
        titleHelpers.shouldReplaceAutoTitle('Manually named chat', 'User greets assistant'),
        false
    );
});

test('LruCache 超出容量后淘汰最近最少使用项', () => {
    const cache = new LruCache({ max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('d', 4);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('d'), 4);
});

test('LruCache 遵守 TTL 并在过期后报告未命中', async () => {
    const cache = new LruCache({ max: 8, ttlMs: 30 });
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(cache.get('k'), undefined);
});

test('TtlCache 会惰性清理过期项', async () => {
    const cache = new TtlCache(20);
    cache.set('a', 1);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(cache.get('a'), undefined);
    cache.set('b', 2);
    cache.prune();
    assert.equal(cache.size, 1);
});

test('withTimeout 在任务挂起时以 TimeoutError 拒绝', async () => {
    await assert.rejects(
        withTimeoutHelper(() => new Promise(() => {}), 1000, '测试任务'),
        (err) => err instanceof WithTimeoutError && /测试任务/.test(err.message)
    );
});

test('withTimeout 会在计时器到期前正常解析', async () => {
    const result = await withTimeoutHelper(() => Promise.resolve(42), 1000, '快任务');
    assert.equal(result, 42);
});
