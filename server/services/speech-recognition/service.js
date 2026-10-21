'use strict';

const { readSpeechSetting } = require('./settings');
const { validateAudio, audioQuality, speechError } = require('./audio');
const { normalizeHotwords, transcribeWithProvider, providerRequestOptions, probeGateway } = require('./provider');
const { speechCapacity } = require('./capacity');
const { embeddedSpeech } = require('./embedded');
const { configuredSpeechProvider, resolveSpeechProvider } = require('./config');

function createSpeechService({ localService, read = readSpeechSetting, transcribeProvider = transcribeWithProvider, checkEndpoint = providerRequestOptions, probe = probeGateway, capacity = speechCapacity, embedded = embeddedSpeech } = {}) {
    let failures = 0; let circuitUntil = 0;
    let probeState = null;
    const activeRequests = new Set();
    const config = () => configuredSpeechProvider(read);

    async function capabilities() {
        let cfg;
        try { cfg = config(); }
        catch (_) { return { available: false, languages: [], provider: 'unavailable', reason: '语音配置无法读取，请联系管理员检查加密配置。' }; }
        const base = { maxSeconds: 20, audioRetention: 'none', serverPreferred: cfg.kind !== 'local', provider: cfg.kind,
            thirdPartyForwarding: false, recognitionMode: 'utterance', capture: { endSilenceMs: read('PIVOT_VOICE_END_SILENCE_MS') } };
        if (!read('PIVOT_SERVER_VOICE_ENABLED')) return { ...base, available: false, languages: [], reason: '管理员已关闭服务器语音识别。' };
        if (cfg.kind === 'local') return { ...base, ...await localService.capabilities() };
        if (cfg.kind === 'embedded') {
            if (embedded.status().state !== 'ready') {
                embedded.ensureReady().catch(() => {});
                const state = embedded.status();
                return { ...base, available: false, languages: [], readiness: state.state, ...(state.code ? { reasonCode: state.code } : {}),
                    reason: state.state === 'starting' ? '内置中文语音模型正在加载，请稍后重试。' : state.reason || '内置中文语音未就绪，请检查模型目录与语音运行依赖。' };
            }
            try { cfg = await resolveSpeechProvider(read, embedded); }
            catch (_) { return { ...base, available: false, languages: [], reason: '内置中文语音未就绪，请检查模型目录与语音运行依赖。' }; }
        }
        if (!cfg.endpoint || (cfg.kind !== 'gateway' && !cfg.model)) return { ...base, available: false, languages: [], reason: '统一语音服务尚未配置完整，请联系管理员。' };
        try {
            const options = await checkEndpoint(cfg.endpoint, cfg.allowExternal);
            options.httpAgent?.destroy(); options.httpsAgent?.destroy();
            let health = null;
            if (cfg.kind === 'gateway') {
                const key = JSON.stringify([cfg.endpoint, cfg.apiKey, cfg.allowExternal]);
                if (!probeState || probeState.key !== key || probeState.until < Date.now()) {
                    probeState = { key, until: Date.now() + 15000, pending: probe(cfg) };
                }
                try { health = await probeState.pending; } catch (error) { probeState = null; throw error; }
            }
            return { ...base, thirdPartyForwarding: !options.internal, available: Date.now() >= circuitUntil, readiness: health ? 'ready' : 'configured', languages: ['zh-CN'],
                streaming: health?.streaming === true && Boolean(cfg.streamEndpoint),
                reason: Date.now() < circuitUntil ? '语音服务暂时熔断，请稍后重试。' : '' };
        } catch (_) { return { ...base, available: false, languages: [], reason: '语音服务尚未就绪，或连接、凭据和地址策略校验失败，请联系管理员。' }; }
    }

    async function transcribe(user, input, { signal } = {}) {
        if (!user?.id) throw speechError('语音识别需要登录。', 'VOICE_AUTH_REQUIRED', 401);
        if (!read('PIVOT_SERVER_VOICE_ENABLED')) throw speechError('管理员已关闭服务器语音识别。', 'VOICE_ENGINE_UNAVAILABLE', 503);
        if (signal?.aborted) throw speechError('语音请求已取消。', 'VOICE_ABORTED', 499);
        const { audio, language } = validateAudio(input);
        const configurationController = new AbortController(); activeRequests.add(configurationController);
        const configurationSignal = signal ? AbortSignal.any([signal, configurationController.signal]) : configurationController.signal;
        let releaseCapacity;
        try {
            releaseCapacity = capacity.claim(user.id, read('PIVOT_VOICE_MAX_CONCURRENT'));
            const selected = config();
            if (selected.kind !== 'local' && language.toLowerCase() !== 'zh-cn') throw speechError('当前统一语音服务仅启用中文识别，请使用中文语言设置。', 'VOICE_LANGUAGE_INVALID');
            const quality = audioQuality(audio);
            if (quality.silent) return { text: '', noSpeech: true, provider: selected.kind, audioRetention: 'none', confidence: null, requiresReview: false };
            if (Date.now() < circuitUntil) throw speechError('语音服务暂时熔断，请稍后重试。', 'VOICE_PROVIDER_UNAVAILABLE', 503);
            const cfg = selected.kind === 'embedded' ? await resolveSpeechProvider(read, embedded, { signal: configurationSignal }) : selected;
            if (configurationSignal.aborted) throw speechError('语音配置已更新或请求已取消，请重新开始录音。', 'VOICE_ABORTED', 499);
            cfg.hotwords = normalizeHotwords(read('PIVOT_VOICE_HOTWORDS'));
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
            const requestSignal = AbortSignal.any([configurationSignal, controller.signal]);
            try {
                if (cfg.kind !== 'local' && (!cfg.endpoint || cfg.kind !== 'gateway' && !cfg.model)) throw speechError('语音服务配置不完整，请联系管理员。', 'VOICE_PROVIDER_CONFIG', 503);
                const result = cfg.kind === 'local' ? await localService.transcribe(user, input, { signal: requestSignal })
                    : await transcribeProvider({ audio, language, config: cfg, signal: requestSignal });
                if (requestSignal.aborted) throw speechError('语音识别已取消或超时，请重新录制。', 'VOICE_ABORTED', 499);
                failures = 0;
                const warnings = [...new Set([...(result.warnings || []), ...quality.warnings])];
                return { ...result, language, provider: cfg.kind === 'local' ? result.provider : selected.kind, audioRetention: 'none',
                    requiresReview: result.requiresReview === true || warnings.includes('clipping'), warnings, durationMs: quality.durationMs };
            } catch (error) {
                if (controller.signal.aborted && !signal?.aborted) throw speechError('语音服务识别超时，请稍后重试。', 'VOICE_TIMEOUT', 504);
                if (!signal?.aborted && ['VOICE_PROVIDER_UNAVAILABLE', 'VOICE_ENGINE_FAILED', 'VOICE_RESULT_INVALID'].includes(error.code) && ++failures >= 3) { circuitUntil = Date.now() + 15000; failures = 0; }
                throw error;
            } finally { clearTimeout(timer); }
        } finally { activeRequests.delete(configurationController); audio.fill(0); releaseCapacity?.(); }
    }
    return { capabilities, transcribe, reset() { for (const controller of activeRequests) controller.abort(); failures = 0; circuitUntil = 0; probeState = null; } };
}

module.exports = { createSpeechService };
