'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

function loadVeraPdf(t, execFile) {
    const filename = require.resolve('../server/services/document-processing/pdf/engines/verapdf');
    const previous = require.cache[filename];
    t.mock.method(childProcess, 'execFile', execFile);
    delete require.cache[filename];
    t.after(() => {
        if (previous) require.cache[filename] = previous;
        else delete require.cache[filename];
    });
    return require(filename);
}

function probeTimeout() {
    return Object.assign(new Error('探测进程已超时终止'), { killed: true, signal: 'SIGKILL', code: null });
}

test('veraPDF 冷启动探测保留至少三十秒预算，并合并并发探测与缓存成功结果', async t => {
    let calls = 0;
    let options;
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const engine = loadVeraPdf(t, (_command, args, invocationOptions, callback) => {
        calls++;
        options = invocationOptions;
        assert.equal(args.at(-1), '--version');
        process.nextTick(() => callback(null, 'veraPDF 1.30.3\n', ''));
    });
    const [first, concurrent] = await Promise.all([engine.getVeraPdfHealth(), engine.getVeraPdfHealth()]);
    assert.equal(first.available, true);
    assert.equal(concurrent, first);
    assert.equal(calls, 1);
    assert.ok(options.timeout >= 30000 && options.timeout <= 60000);
    assert.equal(options.killSignal, 'SIGKILL');
    now += 59999;
    assert.equal(await engine.getVeraPdfHealth(), first);
    assert.equal(calls, 1);
    now++;
    assert.equal((await engine.getVeraPdfHealth()).available, true);
    assert.equal(calls, 2);
});

test('veraPDF 探测超时保留独立错误和状态，不误报未安装', async t => {
    const engine = loadVeraPdf(t, (_command, _args, _options, callback) => {
        process.nextTick(() => callback(probeTimeout()));
    });
    const health = await engine.getVeraPdfHealth();
    assert.equal(health.available, false);
    assert.equal(health.code, 'VERAPDF_HEALTH_TIMEOUT');
    assert.match(health.message, /探测超时/);
    assert.doesNotMatch(health.message, /未安装|未找到/);
    await assert.rejects(engine.validatePdfA({ sourcePath: 'input.pdf' }), error => {
        assert.equal(error.code, 'VERAPDF_HEALTH_TIMEOUT');
        assert.equal(error.status, 504);
        assert.equal(error.message, health.message);
        return true;
    });
});

test('veraPDF 瞬时探测失败仅短暂缓存，五秒后允许恢复', async t => {
    let calls = 0;
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const engine = loadVeraPdf(t, (_command, _args, _options, callback) => {
        calls++;
        process.nextTick(() => calls === 1 ? callback(probeTimeout()) : callback(null, 'veraPDF 1.30.3', ''));
    });
    const failed = await engine.getVeraPdfHealth();
    assert.equal(failed.available, false);
    now += 4999;
    assert.equal(await engine.getVeraPdfHealth(), failed);
    assert.equal(calls, 1);
    now++;
    assert.equal((await engine.getVeraPdfHealth()).available, true);
    assert.equal(calls, 2);
});

test('veraPDF 缺少可执行文件时保留部署错误，提示不泄露内部路径', async t => {
    const engine = loadVeraPdf(t, (_command, _args, _options, callback) => {
        const error = Object.assign(new Error('spawn /private/runtime/verapdf ENOENT'), { code: 'ENOENT' });
        process.nextTick(() => callback(error));
    });
    const health = await engine.getVeraPdfHealth();
    assert.equal(health.code, 'VERAPDF_UNAVAILABLE');
    assert.match(health.message, /CLI|Java|JRE/);
    assert.doesNotMatch(health.message, /private|runtime/);
    await assert.rejects(engine.validatePdfA({ sourcePath: 'input.pdf' }), { code: 'VERAPDF_UNAVAILABLE', status: 503 });
});
