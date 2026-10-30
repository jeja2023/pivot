'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { readTypedEnv } = require('../../config/env-registry');
const { readSpeechSetting } = require('./settings');

const { validateAudio, speechError } = require('./audio');
const { createSpeechService } = require('./service');

function createLocalSpeechService({ spawnProcess = spawn, platform = process.platform,
    enabled = () => readSpeechSetting('PIVOT_SERVER_VOICE_ENABLED'), maxConcurrent = 2,
    pythonExecutable = () => readTypedEnv('PIVOT_SERVER_VOICE_PYTHON'),
    loadScript = () => fs.readFile(path.join(__dirname, 'windows-worker.ps1'), 'utf8') } = {}) {
    const activeUsers = new Set();
    let script;
    let cached = null;
    let pendingProbe = null;
    async function run(mode, input, signal) {
        if (signal?.aborted) throw speechError('语音请求已取消。', 'VOICE_ABORTED', 499);
        let encodedScript;
        try { if (platform === 'win32') { script ||= loadScript(); encodedScript = Buffer.from(await script, 'utf16le').toString('base64'); } }
        catch (_) { throw speechError('服务器语音组件文件不可用，请联系管理员。', 'VOICE_ENGINE_UNAVAILABLE', 503); }
        return new Promise((resolve, reject) => {
            const executable = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : pythonExecutable();
            const args = platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript]
                : ['-u', path.join(__dirname, 'vosk-worker.py')];
            const child = spawnProcess(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PIVOT_SERVER_SPEECH_MODE: mode, PIVOT_SERVER_VOICE_MODEL_PATH: readTypedEnv('PIVOT_SERVER_VOICE_MODEL_PATH'),
                    OMP_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' } });
            let output = '';
            let done = false;
            const finish = (error, value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (error) child.kill();
                error ? reject(error) : resolve(value);
            };
            const abort = () => finish(speechError('语音请求已取消。', 'VOICE_ABORTED', 499));
            const timer = setTimeout(() => finish(speechError('服务器语音识别超时，请稍后重试。', 'VOICE_TIMEOUT', 504)), mode === 'probe' ? 8000 : 30000);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                output += chunk;
                if (output.length > 20000) finish(speechError('语音识别返回异常。', 'VOICE_RESULT_INVALID', 502));
            });
            child.stderr.on('data', () => {});
            child.once('error', () => finish(speechError('服务器本地语音组件无法启动，请联系管理员。', 'VOICE_ENGINE_UNAVAILABLE', 503)));
            child.once('close', code => {
                if (done) return;
                let value;
                try {
                    const lines = platform === 'win32' ? output.split(/\r?\n/).filter(line => line.startsWith('PIVOT_SPEECH_RESULT:')) : [output.trim()];
                    if (lines.length === 1) value = JSON.parse(platform === 'win32' ? lines[0].slice('PIVOT_SPEECH_RESULT:'.length) : lines[0]);
                } catch (_) { /* 只返回固定错误，不暴露进程输出。 */ }
                if (code !== 0 || !value || value.error) finish(speechError('服务器本地语音识别失败，请重新录制或联系管理员。', 'VOICE_ENGINE_FAILED', 503));
                else finish(null, value);
            });
            child.stdin.on('error', () => {});
            child.stdin.end(input ? JSON.stringify(input) + '\n' : '');
        });
    }
    async function capabilities() {
        const base = { audioRetention: 'none', thirdPartyForwarding: false, maxSeconds: 20 };
        if (!enabled()) return { ...base, available: false, languages: [], reason: '管理员已关闭服务器语音识别。' };
        if (cached && cached.expires > Date.now()) return { ...base, ...cached.value };
        pendingProbe ||= run('probe').then(result => {
            const languages = (Array.isArray(result.languages) ? result.languages : []).filter(item => typeof item === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(item));
            const value = { available: languages.length > 0, languages, provider: platform === 'win32' ? 'server_windows_speech' : 'server_vosk',
                reason: languages.length ? '' : '服务器尚未安装本地语音识别语言组件。' };
            cached = { value, expires: Date.now() + 60000 };
            return value;
        }).catch(() => ({ available: false, languages: [], reason: platform === 'win32' ? '服务器本地语音组件无法启动，请联系管理员。'
            : '服务器离线中文模型或识别运行环境不可用，请重建包含语音组件的 Docker 镜像。' })).finally(() => { pendingProbe = null; });
        return { ...base, ...(await pendingProbe) };
    }
    async function transcribe(user, input, { signal } = {}) {
        if (!user?.id) throw speechError('语音识别需要登录。', 'VOICE_AUTH_REQUIRED', 401);
        const { audio, language } = validateAudio(input);
        try {
            const status = await capabilities();
            if (!status.available || !status.languages.some(item => item.toLowerCase() === language.toLowerCase())) {
                throw speechError(status.reason || '服务器未安装当前语言的本地识别组件。', 'VOICE_ENGINE_UNAVAILABLE', 503);
            }
            const key = String(user.id);
            if (activeUsers.has(key) || activeUsers.size >= maxConcurrent) throw speechError('语音识别正在处理，请稍后再试。', 'VOICE_BUSY', 429);
            activeUsers.add(key);
            try {
                const result = await run('transcribe', { language, audioBase64: audio.toString('base64') }, signal);
                if (typeof result.text !== 'string') throw speechError('语音识别返回异常。', 'VOICE_RESULT_INVALID', 502);
                return { text: result.text.trim().slice(0, 4000), language, provider: status.provider, audioRetention: 'none' };
            } finally { activeUsers.delete(key); }
        } finally { audio.fill(0); }
    }
    return { capabilities, transcribe };
}

const localSpeechService = createLocalSpeechService();
const speechService = createSpeechService({ localService: localSpeechService });
module.exports = { createLocalSpeechService, speechService, validateAudio };
