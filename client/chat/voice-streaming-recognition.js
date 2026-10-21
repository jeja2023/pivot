/* 双遍识别：只显示暂态文字，句末核验后的最终文字才可提交。 */
(function () {
    function create(language, policy = {}) {
        let stream; let socket; let context; let capture; let source; let muted; let gate; let sampleRate = 16000;
        let active = false; let finishing = false; let speaking = false; let awaiting = false; let silence = 0; let voiced = 0;
        let pre = []; let preSize = 0; let pcm = []; let pcmSize = 0; let sequence = 0; let results = []; let timer;
        const api = { lang: language, usesServerInput: true, continuous: false, interimResults: true, finishTimeoutMs: 125000,
            attachStream(value) { stream = value; },
            start() {
                if (active) throw Object.assign(new Error('识别已开始'), { name: 'InvalidStateError' });
                active = true; finishing = false; speaking = false; awaiting = false; results = []; sequence++;
                const current = sequence;
                void start(current).catch(() => { if (current === sequence && active) fail('流式语音连接失败，请检查服务后重试。'); });
            },
            stop() {
                if (!active || finishing) return;
                finishing = true;
                if (capture?.port?.postMessage) { capture.port.postMessage({ type: 'flush' }); timer = setTimeout(endCapture, 250); }
                else endCapture();
            },
            abort() {
                if (!active) return;
                active = false; sequence++; clearTimeout(timer);
                disconnect(); socket?.close(); socket = null;
                for (const part of [...pre, ...pcm]) part.fill(0);
                pre = []; pcm = []; preSize = 0; pcmSize = 0;
                api.onend?.();
            }
        };
        function disconnect() {
            if (capture) capture.port.onmessage = null;
            source?.disconnect(); capture?.disconnect(); muted?.disconnect();
            capture = null; source = null; muted = null;
            if (context) void context.close().catch(() => {});
            context = null;
        }
        function fail(message) { api.onerror?.({ error: 'server-recognition', voiceMessage: message }); api.abort(); }
        function send(value) {
            if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 128000) { fail('语音上传速度不足，请检查网络后重试。'); return; }
            socket.send(typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value);
        }
        function sendPcm(samples, sampleRate, final = false) {
            pcm.push(samples); pcmSize += samples.length;
            if (!final && pcmSize < sampleRate * 0.08) return;
            if (!pcmSize) return;
            const wav = window.Pivot.moduleApi('chat.voiceAudio').encodeWave(pcm, sampleRate);
            const bytes = Uint8Array.from(globalThis.atob(wav), ch => ch.charCodeAt(0));
            send(bytes.buffer.slice(44)); bytes.fill(0);
            for (const part of pcm) part.fill(0);
            pcm = []; pcmSize = 0;
        }
        function endSegment() {
            if (!speaking) return;
            sendPcm(new Float32Array(0), sampleRate, true);
            send({ type: 'end' }); speaking = false; awaiting = true; silence = 0; voiced = 0;
        }
        function endCapture() {
            clearTimeout(timer);
            if (!active) return;
            if (speaking) endSegment();
            disconnect(); stream?.getTracks?.().forEach(track => track.stop());
            if (!socket || socket.readyState !== 1) return;
            if (awaiting) { timer = setTimeout(() => fail('句末识别超时，请重新录制。'), 60000); }
            else { send({ type: 'finish' }); }
        }
        async function start(current) {
            const response = await apiFetch(`${API_BASE}/chat/voice-stream-tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!response.ok) throw new Error('无法创建语音连接');
            const access = await response.json();
            if (!active || sequence !== current) return;
            const url = new URL(access.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new globalThis.WebSocket(url.href);
            const connection = socket;
            timer = setTimeout(() => { if (active && sequence === current) fail('语音连接超时，请重试。'); }, 10000);
            socket.onopen = () => {
                if (!active || sequence !== current || socket !== connection) return connection.close();
                send({ ticket: access.ticket });
            };
            socket.onerror = () => { if (active && sequence === current) fail('语音服务连接中断，请重新开始。'); };
            socket.onclose = () => { if (active && sequence === current) { if (finishing) api.abort(); else fail('语音连接已断开，请重新开始。'); } };
            socket.onmessage = async event => {
                if (!active || sequence !== current) return;
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'ready') { clearTimeout(timer); await captureAudio(current); return; }
                    if (message.type === 'error') { fail(message.message); return; }
                    if (message.type === 'partial') {
                        const preview = [...results, { isFinal: false, 0: { transcript: message.text } }];
                        api.onresult?.({ resultIndex: results.length, results: preview });
                    }
                    if (message.type === 'final') {
                        awaiting = false; clearTimeout(timer);
                        if (message.text) { results.push({ isFinal: true, requiresReview: message.requiresReview === true, 0: { transcript: message.text, confidence: message.confidence } }); api.onresult?.({ resultIndex: results.length - 1, results: results.slice() }); }
                        else api.onresult?.({ resultIndex: results.length, results: results.slice() });
                        const deferred = pre; pre = []; preSize = 0;
                        for (const part of deferred) { if (!active) break; handleSamples(part); }
                        if (finishing) {
                            if (speaking) endSegment();
                            if (!awaiting) send({ type: 'finish' });
                            else timer = setTimeout(() => fail('句末识别超时，请重新录制。'), 60000);
                        }
                        if (!finishing && !api.continuous && message.text) api.abort();
                    }
                } catch (_) { if (active && sequence === current) fail('语音处理异常，请重新开始。'); }
            };
        }
        function handleSamples(samples) {
            const rate = sampleRate;
            if (awaiting) {
                // 句末修正过程中继续保留有界音频，避免把模型响应延迟变成漏字。
                pre.push(samples); preSize += samples.length;
                if (preSize > rate * 5) fail('识别服务响应过慢，请稍后重试。');
                return;
            }
            const detected = gate.analyze(samples).speech;
            if (!speaking) {
                pre.push(samples); preSize += samples.length;
                while (preSize > rate * 0.4 && pre.length > 1) { const old = pre.shift(); preSize -= old.length; old.fill(0); }
                if (!detected) return;
                speaking = true; voiced = 0; silence = 0; send({ type: 'begin' });
                for (const part of pre) sendPcm(part, rate);
                pre = []; preSize = 0;
            } else sendPcm(samples, rate);
            voiced += samples.length;
            silence = detected ? 0 : silence + samples.length;
            const endSilence = Math.max(500, Math.min(2000, Number(policy.capture?.endSilenceMs) || 1000));
            if (silence >= rate * endSilence / 1000 || voiced >= rate * 18.5) endSegment();
        }
        async function captureAudio(current) {
            if (finishing) { send({ type: 'finish' }); return; }
            context = window.Pivot.moduleApi('chat.voiceAudio').createContext();
            const audioContext = context;
            sampleRate = audioContext.sampleRate;
            gate = window.Pivot.moduleApi('chat.voiceSpeechGate').create(context.sampleRate);
            await audioContext.audioWorklet.addModule(`/chat/voice-capture-worklet.js?v=${encodeURIComponent(document.documentElement?.dataset?.appVersion || '')}`);
            if (!active || sequence !== current) return;
            if (finishing) { send({ type: 'finish' }); return; }
            source = context.createMediaStreamSource(stream); capture = new globalThis.AudioWorkletNode(context, 'pivot-voice-capture');
            muted = context.createGain(); muted.gain.value = 0;
            source.connect(capture); capture.connect(muted); muted.connect(context.destination);
            capture.onprocessorerror = () => fail('音频采集中断，请重试。');
            capture.port.onmessage = event => {
                if (!active || sequence !== current) return;
                if (event.data?.type === 'flushed') { endCapture(); return; }
                const samples = event.data;
                if (!samples?.length || !context) return;
                handleSamples(samples);
            };
            await context.resume(); if (active && sequence === current) api.onstart?.();
        }
        return api;
    }
    window.Pivot?.exposeModule?.('chat.voiceStreamingRecognition', { create });
}());
