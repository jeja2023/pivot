const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { assertRegistryArtifacts, readTypedEnv } = require('../server/config/env-registry');

test('类型化配置会收敛异常整数、枚举和语言列表', () => {
    assert.equal(readTypedEnv('PG_ANALYZE_TIMEOUT_MS', { PG_ANALYZE_TIMEOUT_MS: '999999' }), 120_000);
    assert.equal(readTypedEnv('PG_ANALYZE_TOTAL_TIMEOUT_MS', { PG_ANALYZE_TOTAL_TIMEOUT_MS: 'bad' }), 600_000);
    assert.equal(readTypedEnv('LOG_LEVEL', { LOG_LEVEL: 'verbose' }), 'info');
    assert.deepEqual(readTypedEnv('PIVOT_ELECTRON_LOCALES', { PIVOT_ELECTRON_LOCALES: 'fr,invalid locale,zh-CN,fr' }), ['fr', 'zh-CN']);
});

test('类型化配置注册表同步环境模板和说明文档', () => {
    const root = path.resolve(__dirname, '..');
    assert.doesNotThrow(() => assertRegistryArtifacts(root));
    assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /PIVOT_TYPED_CONFIG_REGISTRY/);
    assert.match(fs.readFileSync(path.join(root, 'docs', 'configuration-registry.md'), 'utf8'), /PG_ANALYZE_TOTAL_TIMEOUT_MS/);
});

test('跨租户训练默认必须同时具备命令行意图与数据治理批准', () => {
    assert.equal(readTypedEnv('PIVOT_DECISION_ALLOW_GLOBAL_TRAINING', {}), false);
    assert.equal(readTypedEnv('PIVOT_DECISION_ALLOW_GLOBAL_TRAINING', { PIVOT_DECISION_ALLOW_GLOBAL_TRAINING: 'true' }), true);
    const root = path.resolve(__dirname, '..');
    const denied = spawnSync(process.execPath, ['scripts/train_decision_light_model.js', '--allow-global'], { cwd: root, encoding: 'utf8' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /跨租户训练尚未获得数据治理批准/);
});
