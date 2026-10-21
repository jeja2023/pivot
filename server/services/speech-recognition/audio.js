'use strict';

const MAX_AUDIO_BYTES = 640044;
function speechError(message, code, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }

function validateAudio(input = {}) {
    const language = String(input.language || 'zh-CN').trim();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw speechError('语音语言标识无效。', 'VOICE_LANGUAGE_INVALID');
    const encoded = input.audioBase64;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw speechError('录音格式或大小不符合要求，请分段重试。', 'VOICE_AUDIO_INVALID');
    }
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length < 3244 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF'
        || audio.readUInt32LE(4) !== audio.length - 8 || audio.toString('ascii', 8, 12) !== 'WAVE'
        || audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1
        || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000
        || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 || audio.toString('ascii', 36, 40) !== 'data'
        || audio.readUInt32LE(40) !== audio.length - 44 || (audio.length - 44) % 2) {
        audio.fill(0);
        throw speechError('仅支持最长 20 秒的标准单声道录音，请重新录制。', 'VOICE_WAVE_INVALID');
    }
    return { audio, language };
}

function audioQuality(audio) {
    const count = (audio.length - 44) / 2;
    let sum = 0; let square = 0; let clipped = 0;
    for (let i = 44; i < audio.length; i += 2) {
        const value = audio.readInt16LE(i) / 32768;
        sum += value; square += value * value;
        if (Math.abs(value) > 0.985) clipped += 1;
    }
    const rms = Math.sqrt(Math.max(square / count - (sum / count) ** 2, 0));
    return { durationMs: Math.round(count / 16), rms, clippedRatio: clipped / count,
        silent: rms < 0.00015, warnings: clipped / count > 0.02 ? ['clipping'] : rms < 0.001 ? ['low_volume'] : [] };
}

module.exports = { validateAudio, audioQuality, speechError };
