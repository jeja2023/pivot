/* 仅将短录音发送到当前部署；服务端本地识别，不保留录音、不调用第三方。 */
/* global API_BASE, apiFetch, showToast */
(function () {
    let statusPromise = null;
    let statusExpiry = 0;
    function supported() { return globalThis.isSecureContext !== false && Boolean(navigator.mediaDevices?.getUserMedia && (globalThis.AudioContext || globalThis.webkitAudioContext) && globalThis.AudioWorkletNode); }
    async function status() {
        if (Date.now() > statusExpiry) statusPromise = null;
        if (!statusPromise) {
            statusExpiry = Date.now() + 30000;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            statusPromise = apiFetch(`${API_BASE}/chat/voice-recognition`, { cache: 'no-store', signal: controller.signal })
            .then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error || '无法检查服务器语音能力。'); return data; })
            .catch(() => { statusPromise = null; throw Object.assign(new Error(), { voiceMessage: '服务器语音能力检查失败，请稍后重试或联系管理员。' }); })
            .finally(() => clearTimeout(timer));
        }
        return statusPromise;
    }
    function createRecognition(language) {
        let generation = 0;
        let active = false;
        let stopping = false;
        let stopTimer = null;
        let stream = null;
        let context = null;
        let source = null;
        let capture = null;
        let muted = null;
        let chunks = [];
        let size = 0;
        let voiced = 0;
        let silence = 0;
        let idle = 0;
        let noiseFloor = 0.0008;
        let results = [];
        let chain = Promise.resolve();
        let queued = 0;
        const requests = new Set();
        const recognition = { lang: language, continuous: false, usesServerInput: true, processLocally: false,
            attachStream(value) { stream = value; },
            start() {
                if (active) throw Object.assign(new Error('识别已开始。'), { name: 'InvalidStateError' });
                if (!stream) throw Error('录音设备尚未就绪。');
                active = true;
                stopping = false;
                const current = ++generation;
                chunks = []; size = 0; voiced = 0; silence = 0; idle = 0; noiseFloor = 0.0008; results = [];
                const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
                const nextContext = new AudioContext();
                context = nextContext;
                void (async () => {
                    try {
                        await nextContext.audioWorklet.addModule(`/chat/voice-capture-worklet.js?v=${encodeURIComponent(document.documentElement?.dataset?.appVersion || '')}`);
                        if (!active || generation !== current) return;
                        source = nextContext.createMediaStreamSource(stream);
                        capture = new globalThis.AudioWorkletNode(nextContext, 'pivot-voice-capture');
                        capture.onprocessorerror = () => { if (active && generation === current) fail('浏览器音频处理已中断，请重新开始语音输入。'); };
                        muted = nextContext.createGain(); muted.gain.value = 0;
                        source.connect(capture); capture.connect(muted); muted.connect(nextContext.destination);
                        capture.port.onmessage = event => {
                            if (!active || generation !== current) return;
                            const samples = event.data;
                            if (samples?.type === 'flushed') { finishCapture(); return; }
                            if (!samples?.length) return;
                            idle += samples.length;
                            const energy = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
                            chunks.push(samples); size += samples.length;
                            // 低音量语音仍能起录，保留句首预录；短停顿不立即截断上下文。
                            const threshold = Math.max(0.0025, Math.min(0.012, noiseFloor * 2.5));
                            if (energy > threshold) { voiced += samples.length; silence = 0; idle = 0; }
                            else {
                                silence += samples.length;
                                if (!voiced) noiseFloor = noiseFloor * 0.95 + energy * 0.05;
                            }
                            while (!voiced && size > nextContext.sampleRate * 0.4) { const old = chunks.shift(); size -= old.length; old.fill(0); }
                            if (voiced > nextContext.sampleRate * 0.15 && (silence > nextContext.sampleRate * 0.95 || size >= nextContext.sampleRate * 19)) flush(current);
                            if (!recognition.continuous && !voiced && idle > nextContext.sampleRate * 15) recognition.abort();
                        };
                        await nextContext.resume();
                        if (active && generation === current) recognition.onstart?.();
                    } catch (_) {
                        if (active && generation === current) fail('无法开始浏览器录音，请检查麦克风权限与安全地址。');
                    }
                })();
            },
            stop() {
                if (!active || stopping) return;
                stopping = true;
                // 取回音频线程尚未凑满一块的句尾，收到确认后再关闭采集。
                if (capture?.port?.postMessage) {
                    stopTimer = setTimeout(finishCapture, 250);
                    capture.port.postMessage({ type: 'flush' });
                } else finishCapture();
            },
            abort() {
                if (!active) return;
                active = false; generation++;
                clearTimeout(stopTimer); stopTimer = null;
                for (const request of requests) request.abort();
                requests.clear();
                disconnect();
                clearAudio();
                recognition.onend?.();
            }
        };
        function finishCapture() {
            if (!active || !stopping || !context) return;
            clearTimeout(stopTimer); stopTimer = null;
            flush(generation);
            disconnect();
            stream?.getTracks?.().forEach(track => track.stop());
            const current = generation;
            void chain.finally(() => { if (active && generation === current) recognition.abort(); });
        }
        function clearAudio() { for (const chunk of chunks) chunk.fill(0); chunks = []; size = 0; voiced = 0; silence = 0; }
        function disconnect() {
            if (capture) capture.port.onmessage = null;
            source?.disconnect(); capture?.disconnect(); muted?.disconnect();
            source = null; capture = null; muted = null;
            if (context) void context.close().catch(() => {});
            context = null;
        }
        function fail(message) { recognition.onerror?.({ error: 'server-recognition', voiceMessage: message }); recognition.abort(); }
        function flush(current) {
            if (!size || !voiced || !context) return;
            if (queued >= 2) { fail('语音识别仍在处理，请放慢语速后重新开始。'); return; }
            const audioBase64 = window.Pivot.moduleApi('chat.voiceAudio').encodeWave(chunks, context.sampleRate);
            clearAudio();
            queued++;
            chain = chain.then(async () => {
                if (!active || current !== generation) { queued--; return; }
                const controller = new AbortController(); requests.add(controller);
                const timer = setTimeout(() => controller.abort(), 35000);
                try {
                    const response = await apiFetch(`${API_BASE}/chat/voice-transcriptions`, { method: 'POST',
                        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                        body: JSON.stringify({ language: recognition.lang, audioBase64 }) });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw Error(data.error || '服务器语音识别失败。');
                    if (!active || current !== generation) return;
                    if (data.text) {
                        results.push({ isFinal: true, 0: { transcript: data.text } });
                        recognition.onresult?.({ resultIndex: results.length - 1, results: results.slice() });
                    }
                    if (!recognition.continuous && !stopping) recognition.abort();
                } catch (error) {
                    if (active && current === generation) fail(error.name === 'AbortError' ? '语音识别超时，请稍后重试。' : error.message);
                } finally { clearTimeout(timer); requests.delete(controller); queued--; }
            });
        }
        return recognition;
    }
    async function prepare(language) {
        if (!supported()) return null;
        const available = await status();
        if (!available.available || !available.languages?.some(value => value.toLowerCase() === language.toLowerCase())) {
            throw Object.assign(new Error(), { voiceMessage: available.reason || '服务器尚未安装当前语言的本地识别组件，请联系管理员。' });
        }
        showToast('语音由当前 Pivot 服务器本地识别，不保存录音、不转发第三方。', 'info');
        return createRecognition(language);
    }
    window.Pivot?.exposeModule?.('chat.serverVoiceRecognition', { supported, prepare });
}());
