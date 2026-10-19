'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const worker = fs.readFileSync(path.join(__dirname, '../desktop/voice-recognition.ps1'), 'utf8');

async function recognizeMemoryAudio(finish) {
    // 只替换音频输入；运行真实系统识别循环，测试不打开麦克风也不播放声音。
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$voiceTestRecognizer = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'zh-CN' })
$voiceTestSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceTestVoice = $voiceTestSynth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if (-not $voiceTestRecognizer.Count -or -not $voiceTestVoice) { [Console]::Out.WriteLine('{"type":"skip"}'); exit 0 }
$voiceTestSynth.SelectVoice($voiceTestVoice.VoiceInfo.Name)
$voiceTestWave = New-Object System.IO.MemoryStream
$voiceTestSynth.SetOutputToWaveStream($voiceTestWave)
$voiceTestSynth.Speak('你好，请保留完整的句子，谢谢。')
$voiceTestBytes = $voiceTestWave.ToArray()
$voiceTestSynth.Dispose()
$voiceTestWave.Dispose()
$voiceTestInput = New-Object System.IO.MemoryStream(,$voiceTestBytes)
${worker.replace('$voiceEngine.SetInputToDefaultAudioDevice()', '$voiceEngine.SetInputToWaveStream($voiceTestInput)')}
`;
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
            ...process.env, PIVOT_NATIVE_VOICE_MODE: 'recognize', PIVOT_NATIVE_VOICE_LANGUAGE: 'zh-CN'
        } });
    const events = [];
    let pending = '';
    let finishTimer;
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
        pending += text;
        let boundary;
        while ((boundary = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, boundary).trim();
            pending = pending.slice(boundary + 1);
            let event;
            try { event = JSON.parse(line); } catch (_) { continue; }
            events.push(event);
            if (finish && event.type === 'started') finishTimer = setTimeout(() => child.stdin.write('finish\n'), 100);
        }
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('系统识别循环未及时完成')); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
            clearTimeout(timer); clearTimeout(finishTimer);
            code === 0 ? resolve() : reject(Error(`系统识别工作进程退出码：${code}`));
        });
    });
    return events;
}

test('Windows 真实中文工作进程可同时接收收尾指令并输出尾句，不阻塞在 stdin', {
    skip: process.platform !== 'win32', timeout: 40000
}, async t => {
    for (const finish of [false, true]) {
        const events = await recognizeMemoryAudio(finish);
        if (events.some(event => event.type === 'skip')) { t.skip('系统未安装中文识别器或本地声音'); return; }
        assert.equal(events[0].type, 'started');
        assert.equal(events.at(-1).type, 'ended');
        assert.ok(events.some(event => event.type === 'result' && event.text.trim()), '系统识别应返回已缓存音频的文字');
        assert.equal(events.some(event => event.type === 'error'), false);
    }
});
