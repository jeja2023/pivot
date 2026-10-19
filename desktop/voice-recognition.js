'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function voiceError(code) {
    const messages = {
        'language-not-supported': 'Windows 尚未安装该语言的本地语音识别组件，请在系统语言设置中安装语音功能。',
        'audio-capture': 'Windows 无法打开默认麦克风，请连接输入设备并允许桌面应用使用麦克风。',
        'native-recognition-unavailable': 'Windows 本地语音识别服务不可用，请检查系统语音组件。',
        'native-voice-timeout': 'Windows 本地语音识别启动超时，请检查输入设备后重试。',
        'native-voice-stopped': '语音启动已取消。'
    };
    return Object.assign(new Error(messages[code] || messages['native-recognition-unavailable']), { code });
}

function createDesktopVoiceRecognition({ spawnProcess = spawn, platform = process.platform, readScript = () => fs.readFileSync(path.join(__dirname, 'voice-recognition.ps1'), 'utf8') } = {}) {
    let active = null;
    let pendingStart = null;
    let capabilitiesPromise = null;
    function worker(mode, language) {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        return spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(readScript(), 'utf16le').toString('base64')], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PIVOT_NATIVE_VOICE_MODE: mode, PIVOT_NATIVE_VOICE_LANGUAGE: language }
        });
    }
    function consume(child, onEvent, onClose) {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        child.stdout.on('data', chunk => {
            pending += decoder.write(chunk);
            if (pending.length > 32000) { child.kill(); return; }
            let end;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end).trim();
                pending = pending.slice(end + 1);
                let event;
                try { event = JSON.parse(line); } catch (_) { continue; }
                onEvent(event);
            }
        });
        child.stderr.on('data', () => {});
        child.once('error', () => onClose('native-recognition-unavailable'));
        child.once('close', () => onClose());
    }
    async function capabilities() {
        if (platform !== 'win32') return { supported: false, available: false, languages: [], reason: '当前桌面系统尚未提供原生本地识别，可尝试浏览器设备端识别。' };
        if (!capabilitiesPromise) capabilitiesPromise = new Promise(resolve => {
            const child = worker('probe', 'zh-CN');
            let done = false;
            const finish = value => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(value); };
            const timer = setTimeout(() => finish({ available: false, languages: [], reason: voiceError().message }), 8000);
            consume(child, event => {
                if (event.type === 'capabilities') {
                    const languages = (Array.isArray(event.languages) ? event.languages : []).filter(item => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(item));
                    finish({ supported: true, available: languages.length > 0, languages, provider: 'windows_system_speech' });
                }
            }, () => finish({ available: false, languages: [], reason: voiceError().message }));
        }).catch(() => ({ available: false, languages: [], reason: voiceError().message }));
        return capabilitiesPromise;
    }
    function stop(owner, requestId) {
        let cancelled = false;
        if (pendingStart && (!owner || pendingStart.owner === owner) && (!requestId || pendingStart.id === requestId)) {
            pendingStart = null;
            cancelled = true;
        }
        const session = active;
        if (!session || owner && session.owner !== owner || requestId && session.id !== requestId) return cancelled;
        active = null;
        session.cancel?.();
        session.child.kill();
        session.emit({ type: 'ended', id: session.id });
        return true;
    }
    async function start(owner, input, emit) {
        const id = String(input?.id || '');
        const language = String(input?.language || '');
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id) || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw voiceError();
        stop();
        const request = { id, owner };
        pendingStart = request;
        const status = await capabilities();
        if (pendingStart !== request) throw voiceError('native-voice-stopped');
        if (!status.languages.some(item => item.toLowerCase() === language.toLowerCase())) throw voiceError('language-not-supported');
        pendingStart = null;
        return new Promise((resolve, reject) => {
            const child = worker('recognize', language);
            let started = false;
            let done = false;
            const session = { id, owner, child, emit, cancel: () => fail('native-voice-stopped') };
            const timer = setTimeout(() => fail('native-voice-timeout'), 10000);
            function fail(code) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (active === session) active = null;
                child.kill();
                if (started) emit({ id, type: 'error', error: code, voiceMessage: voiceError(code).message });
                else reject(voiceError(code));
            }
            active = session;
            consume(child, event => {
                if (active !== session) return;
                if (event.type === 'started' && !started) {
                    started = true;
                    clearTimeout(timer);
                    emit({ id, type: 'started' });
                    resolve({ id, language, provider: 'windows_system_speech' });
                } else if (event.type === 'result' && started) emit({ id, type: 'result', text: String(event.text || '').slice(0, 4000) });
                else if (event.type === 'error') fail(event.code);
            }, code => { if (active === session) fail(code || 'native-recognition-unavailable'); });
        });
    }
    return { capabilities, start, stop };
}

function installDesktopVoiceRecognition({ ipcMain, authorize, send, broker = createDesktopVoiceRecognition() }) {
    ipcMain.handle('pivot-voice:capabilities', async event => { authorize(event); return broker.capabilities(); });
    ipcMain.handle('pivot-voice:start', async (event, input) => {
        authorize(event);
        try { return { success: true, ...(await broker.start(event.sender.id, input, payload => send(event.sender, payload))) }; }
        catch (error) {
            const normalized = voiceError(error.code || 'native-recognition-unavailable');
            return { success: false, error: normalized.message, code: normalized.code };
        }
    });
    ipcMain.handle('pivot-voice:stop', async (event, id) => { authorize(event); return broker.stop(event.sender.id, String(id || '')); });
    return broker;
}

module.exports = { createDesktopVoiceRecognition, installDesktopVoiceRecognition };
