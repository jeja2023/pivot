'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveSpeechRuntime } = require('../server/services/speech-recognition/runtime-paths');
const { speechStartupDiagnostic } = require('../server/services/speech-recognition/diagnostics');

test('语音运行环境优先显式配置，其次镜像环境和项目专用虚拟环境', () => {
    const root = path.resolve('speech-runtime-fixture');
    const development = path.join(root, '.venv-speech', 'Scripts/python.exe');
    const configured = resolveSpeechRuntime(name => name === 'PIVOT_EMBEDDED_VOICE_PYTHON' ? '.venv-custom/Scripts/python.exe' : '', {
        platform: 'win32', root, exists: () => true
    });
    assert.equal(configured.python, path.resolve(root, '.venv-custom/Scripts/python.exe'));
    const packaged = resolveSpeechRuntime(() => '', { root, exists: candidate => candidate === '/opt/pivot-speech/engine-venv/bin/python' });
    assert.equal(packaged.python, '/opt/pivot-speech/engine-venv/bin/python');
    const local = resolveSpeechRuntime(() => '', { platform: 'win32', root, exists: candidate => candidate === development });
    assert.equal(local.python, development);
    assert.equal(local.worker, path.join(root, 'docker/speech-service/embedded_worker.py'));
    assert.equal(local.modelRoot, path.join(root, 'data/speech-models'));
    const fallback = resolveSpeechRuntime(() => '', { platform: 'win32', root, exists: () => false });
    assert.equal(fallback.python, 'python.exe');
});

test('启动诊断仅接受受控代码与依赖名称，不回传进程错误正文和凭据', () => {
    const diagnostic = speechStartupDiagnostic({ code: 'VOICE_EMBEDDED_DEPENDENCY_MISSING', missing: ['funasr', 'silero_vad', 'secret-private-key'], error: 'private traceback' });
    assert.deepEqual(diagnostic.missingDependencies, ['funasr', 'silero_vad']);
    assert.match(diagnostic.reason, /funasr/); assert.match(diagnostic.reason, /silero_vad/);
    assert.ok(!JSON.stringify(diagnostic).includes('private'));
    assert.equal(speechStartupDiagnostic({ code: 'untrusted-secret' }).code, 'VOICE_EMBEDDED_LOAD_FAILED');
});
