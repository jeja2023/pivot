'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { readSpeechSetting } = require('./settings');
const { speechError } = require('./audio');
const { resolveSpeechRuntime } = require('./runtime-paths');
const { speechStartupDiagnostic } = require('./diagnostics');

function createEmbeddedSpeech({ read = readSpeechSetting, spawnProcess = spawn, cooldownMs = 15000, stopTimeoutMs = 3500 } = {}) {
    let current = null; let retryAt = 0; let stopped = false; let stopping = null; let diagnostic = null;
    const enabled = () => { try { return read('PIVOT_SERVER_VOICE_ENABLED') && read('PIVOT_VOICE_PROVIDER') === 'embedded'; } catch (_) { return false; } };
    const unavailable = () => speechError(diagnostic?.reason || '内置中文语音尚未就绪，请检查模型目录与 Python 语音依赖。', 'VOICE_EMBEDDED_UNAVAILABLE', 503);
    function launch() {
        const secret = crypto.randomBytes(32).toString('hex');
        const { modelRoot, worker, python } = resolveSpeechRuntime(read);
        diagnostic = null;
        const threads = String(read('PIVOT_EMBEDDED_VOICE_CPU_THREADS'));
        const record = { child: null, connection: null, done: false, buffer: '', promise: null };
        current = record;
        record.promise = new Promise((resolve, reject) => {
            const fail = details => {
                if (record.done) return;
                diagnostic = diagnostic || speechStartupDiagnostic(details);
                record.done = true; clearTimeout(record.timer); retryAt = Date.now() + cooldownMs;
                reject(unavailable());
            };
            record.fail = fail;
            record.timer = setTimeout(() => { fail({ code: 'VOICE_EMBEDDED_STARTUP_TIMEOUT' }); record.child?.kill('SIGKILL'); }, read('PIVOT_EMBEDDED_VOICE_STARTUP_MS'));
            try {
                const child = spawnProcess(python, ['-u', worker], {
                    cwd: path.dirname(worker), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, SPEECH_API_KEY: secret, SPEECH_BACKEND: 'funasr', SPEECH_DEVICE: 'cpu',
                        SPEECH_MODEL_DIR: path.join(modelRoot, 'paraformer'), SPEECH_STREAM_MODEL_DIR: path.join(modelRoot, 'paraformer-streaming'),
                        SPEECH_PUNC_MODEL_DIR: path.join(modelRoot, 'punctuation'), SPEECH_CPU_THREADS: threads,
                        OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads,
                        NUMBA_NUM_THREADS: threads, NUMBA_CACHE_DIR: path.join(os.tmpdir(), 'pivot-speech-numba'),
                        XDG_CACHE_HOME: path.join(os.tmpdir(), 'pivot-speech-cache'),
                        CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', MODELSCOPE_OFFLINE: '1',
                        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
                });
                record.child = child;
                child.once('error', error => { fail({ code: error.code === 'ENOENT' ? 'VOICE_EMBEDDED_PYTHON_MISSING' : 'VOICE_EMBEDDED_LOAD_FAILED' }); if (current === record) current = null; });
                child.once('close', () => {
                    const wasReady = Boolean(record.connection);
                    fail(); record.connection = null;
                    if (wasReady) { retryAt = Date.now() + cooldownMs; diagnostic = speechStartupDiagnostic({ code: 'VOICE_EMBEDDED_LOAD_FAILED' }); }
                    if (current === record) current = null;
                });
                child.stdin?.on('error', () => {});
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', data => {
                    if (record.done || current !== record || stopped) return;
                    record.buffer += data;
                    if (record.buffer.length > 131072) { record.buffer = ''; return; }
                    let end;
                    while ((end = record.buffer.indexOf('\n')) !== -1) {
                        const line = record.buffer.slice(0, end).trim(); record.buffer = record.buffer.slice(end + 1);
                        if (line.startsWith('PIVOT_SPEECH_ERROR ')) {
                            try { fail(JSON.parse(line.slice('PIVOT_SPEECH_ERROR '.length))); } catch (_) { fail(); }
                            child.kill('SIGKILL'); return;
                        }
                        if (!line.startsWith('PIVOT_SPEECH_READY ')) continue;
                        try {
                            const value = JSON.parse(line.slice('PIVOT_SPEECH_READY '.length));
                            if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw unavailable();
                            record.connection = { endpoint: `http://127.0.0.1:${value.port}/transcribe`,
                                streamEndpoint: value.streaming === true ? `ws://127.0.0.1:${value.port}/stream` : '', apiKey: secret };
                            record.done = true; diagnostic = null; clearTimeout(record.timer); resolve(record.connection);
                        } catch (_) { fail(); child.kill('SIGKILL'); }
                    }
                });
                // 不将模型日志、原始音频、转写正文或凭据转发到应用日志。
                child.stderr.on('data', () => {});
            } catch (_) { fail(); if (current === record) current = null; }
        });
        // 能力探测与启动预热可以并行发起，同一个加载失败只产生受控错误。
        record.promise.catch(() => {});
        return record;
    }
    async function ensureReady({ signal } = {}) {
        if (signal?.aborted) throw speechError('语音请求已取消。', 'VOICE_ABORTED', 499);
        if (stopped || !enabled()) throw unavailable();
        if (!current && Date.now() < retryAt) throw unavailable();
        const record = current || launch();
        if (!signal) return record.promise;
        return new Promise((resolve, reject) => {
            const abort = () => reject(speechError('语音请求已取消。', 'VOICE_ABORTED', 499));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            record.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
    async function stopWorker() {
        stopped = true;
        const record = current;
        if (!record) return;
        record.fail(); record.connection = null;
        const child = record.child;
        if (!child || child.exitCode !== null && child.exitCode !== undefined) { current = null; return; }
        await new Promise(resolve => {
            let finalTimer;
            const timer = setTimeout(() => { child.kill('SIGKILL'); finalTimer = setTimeout(resolve, 500); }, stopTimeoutMs);
            child.once('close', () => { clearTimeout(timer); clearTimeout(finalTimer); resolve(); });
            child.stdin.end();
            child.kill('SIGTERM');
        });
        if (current === record) current = null;
    }
    function stop() { return stopping ||= stopWorker(); }
    async function reconfigure() { await stop(); stopped = false; stopping = null; retryAt = 0; diagnostic = null; }
    return { enabled, ensureReady, stop, reconfigure,
        status: () => ({ state: stopped ? 'stopped' : current?.connection ? 'ready' : current && !current.done ? 'starting' : Date.now() < retryAt ? 'unavailable' : 'idle', ...(diagnostic || {}) }) };
}

const embeddedSpeech = createEmbeddedSpeech();
module.exports = { createEmbeddedSpeech, embeddedSpeech };
