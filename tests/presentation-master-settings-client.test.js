'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/ppt-master-settings.js'), 'utf8');

function fixture() {
    const modules = {};
    vm.runInNewContext(source, {
        document: { getElementById: () => null, addEventListener() {} },
        escapeHtml: value => String(value),
        window: { Pivot: { exposeModule: (name, api) => { modules[name] = api; } } }
    });
    return modules['settings.pptMaster'];
}

test('已启用且配置完整的PPT服务在admin和只读账号中均显示绿色，不依赖本机测试记录', () => {
    const api = fixture();
    for (const canManage of [true, false]) {
        const html = api.renderCard({ enabled: true, configured: true, endpoint: canManage ? 'http://ppt-master:8502' : '********', canManage });
        assert.match(html, /retrieval-model-service-card is-ready/);
        assert.doesNotMatch(html, /is-warning/);
        assert.match(html, /已配置，制作时通过内网服务连接/);
        assert.equal(html.includes('data-ppt-service-config-open'), canManage);
        assert.equal(html.includes('data-ppt-service-test-card'), canManage);
        if (!canManage) assert.doesNotMatch(html, /http:\/\/ppt-master/);
    }
});

test('停用、配置缺失及读取失败的PPT服务保持橙色提示', () => {
    const api = fixture();
    for (const config of [{ enabled: false, configured: true }, { enabled: true, configured: false }, { enabled: true, configured: true, error: '配置无法读取' }]) {
        const html = api.renderCard(config);
        assert.match(html, /retrieval-model-service-card is-warning/);
        assert.doesNotMatch(html, /is-ready/);
    }
});
