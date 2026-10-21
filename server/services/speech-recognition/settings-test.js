'use strict';

const { validateSpeechSettings } = require('./settings-validation');
const { normalizeHotwords, probeGateway, transcribeWithProvider } = require('./provider');

function silentProbe() {
    const audio = Buffer.alloc(44 + 6400);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(6400, 40);
    return audio;
}

async function testSpeechSettings(patch, { settings, service, probe = probeGateway, transcribe = transcribeWithProvider } = {}) {
    const current = settings.effective();
    const config = await validateSpeechSettings(patch, current);
    if (!config.enabled) return { success: false, state: 'disabled', message: '语音识别已关闭，请先启用。' };
    if (['embedded', 'local'].includes(config.provider)) {
        if (config.provider !== current.provider || !current.enabled) return { success: false, state: 'not_active', message: '请先保存所选识别方式，再检查运行状态。' };
        const status = await service.capabilities();
        return { success: status.available === true, state: status.readiness || (status.available ? 'ready' : 'unavailable'),
            streaming: status.streaming === true, message: status.available ? '语音识别服务已就绪。' : status.reason || '语音服务尚未就绪。' };
    }
    const started = Date.now();
    const provider = { ...config, kind: config.provider, hotwords: normalizeHotwords(config.hotwords), timeoutMs: Math.min(config.timeoutMs, 10000) };
    try {
        if (config.provider === 'gateway') {
            const status = await probe(provider);
            if (config.streamEndpoint && !status.streaming) return { success: false, state: 'streaming_unavailable', message: '转写服务可连接，但服务未提供所配置的双遍流式能力。' };
            return { success: true, state: 'ready', streaming: Boolean(config.streamEndpoint && status.streaming), elapsedMs: Date.now() - started,
                message: config.streamEndpoint ? '内网语音网关已就绪，支持双遍流式识别。' : '内网语音网关已就绪，当前使用句级转写。' };
        }
        const audio = silentProbe();
        try { await transcribe({ audio, language: 'zh-CN', config: provider, signal: AbortSignal.timeout(10000) }); }
        finally { audio.fill(0); }
        return { success: true, state: 'ready', streaming: false, elapsedMs: Date.now() - started, message: '兼容语音 API 协议测试通过；使用静音样本，识别精度仍需实际录音验证。' };
    } catch (_) { return { success: false, state: 'unavailable', message: '无法连接语音服务，请检查地址、密钥、协议和服务器状态。' }; }
}

module.exports = { testSpeechSettings };
