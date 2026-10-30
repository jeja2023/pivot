const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const pg = require('pg');
const { createPivotPgTypes } = require('../server/db/pg-connection');
const { isPrivateHost, isSensitiveOutboundHost } = require('../server/security');
const { isStealthTarget, publicDesktopConfig, stripStealthHeaders } = require('../desktop/stealth-policy');
const { inFlightRequestMiddleware, getInFlightRequestSnapshot } = require('../server/services/runtime-diagnostics');

test('主库解析器隔离，不影响外部 PostgreSQL 的精度和时区', () => {
    const int8 = pg.types.getTypeParser(20);
    const timestamp = pg.types.getTypeParser(1184);
    const pivotTypes = createPivotPgTypes();
    assert.equal(pivotTypes.getTypeParser(20)('42'), 42);
    assert.equal(pivotTypes.getTypeParser(1184)('2026-10-30 09:00:00+00'), '2026-10-30 09:00:00');
    assert.equal(pg.types.getTypeParser(20), int8);
    assert.equal(pg.types.getTypeParser(1184), timestamp);
    assert.equal(int8('9007199254740993'), '9007199254740993');
    assert.equal(timestamp('2026-10-30 09:00:00+00').toISOString(), '2026-10-30T09:00:00.000Z');
});

test('隐身头只发送到当前服务来源，状态配置不暴露密钥', () => {
    assert.equal(isStealthTarget('https://pivot.example/api', 'https://pivot.example/chat'), true);
    for (const url of ['https://other.example/a', 'http://pivot.example/a', 'https://pivot.example:444/a', 'file:///x', 'invalid']) {
        assert.equal(isStealthTarget(url, 'https://pivot.example/chat'), false);
    }
    assert.equal(isStealthTarget('https://pivot.example/a', ''), false);
    const config = { mode: 'remote', stealthSecret: 'secret' };
    assert.deepEqual(publicDesktopConfig(config), { mode: 'remote' });
    assert.equal(config.stealthSecret, 'secret');
    assert.deepEqual(stripStealthHeaders({ 'x-pivot-stealth-token': 'old', 'X-Pivot-Stealth-Time': 'old', Accept: '*/*' }), { Accept: '*/*' });
});

test('出站策略覆盖 CGNAT、NAT64 与兼容 IPv6 地址', () => {
    for (const host of ['100.64.0.1', '100.100.100.200', '100.127.255.255', '64:ff9b::a9fe:a9fe', '::169.254.169.254']) {
        assert.equal(isPrivateHost(host), true, host);
        assert.equal(isSensitiveOutboundHost(host), true, host);
    }
    assert.equal(isPrivateHost('100.128.0.1'), false);
    assert.equal(isSensitiveOutboundHost('192.168.1.1'), false);
});

test('在途请求记录隐藏路径中的凭证', () => {
    const res = new EventEmitter();
    inFlightRequestMiddleware({ method: 'GET', path: '/api/apps/presentations/remote/secret/state' }, res, () => {});
    const routes = getInFlightRequestSnapshot().routes;
    assert.ok(routes.some(item => item.route === 'GET /api/apps/*'));
    assert.ok(routes.every(item => !item.route.includes('secret')));
    res.emit('finish');
});
