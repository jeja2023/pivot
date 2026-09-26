/* 实时语音只使用浏览器可确认的设备端语音能力，不上传录音或转写。 */
/* global API_BASE, apiFetch, currentSessionId, showToast */
(function () {
    let voice = null;
    let voiceStart = null;

    const VOICE_HEARTBEAT_MS = 30000;

    function button() { return document.getElementById('chat-realtime-voice'); }
    function setButtonState(active, { starting = false } = {}) {
        const element = button();
        element?.setAttribute('aria-pressed', active ? 'true' : 'false');
        element?.setAttribute('aria-busy', starting ? 'true' : 'false');
        element?.classList.toggle('is-recording', active);
        if (element) element.disabled = starting;
        element?.setAttribute('title', active ? '停止实时语音' : '启动实时语音');
    }

    function stopTracks(stream) {
        stream?.getTracks?.().forEach(track => { try { track.stop(); } catch (_) {} });
    }

    function realtimeVoiceErrorMessage(error) {
        const details = [error?.error, error?.name, error?.code, error?.message, error]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        if (/(not-allowed|notallowed|permission-denied|permissiondenied)/.test(details)) {
            return '请在系统或浏览器设置中允许 Pivot 访问麦克风后重试。';
        }
        if (/(requested device not found|not-found|notfound|devicesnotfound)/.test(details)) {
            return '未检测到可用的麦克风。请确认系统已启用输入设备，并允许当前浏览器或桌面客户端访问麦克风后重试。';
        }
        if (/(not-readable|notreadable|trackstarterror|audio-capture)/.test(details)) {
            return '麦克风正在被其他应用占用，或系统无法打开该设备。请关闭占用程序后重试。';
        }
        if (/(overconstrained|constraint)/.test(details)) {
            return '当前麦克风不支持所需音频能力。请在系统中切换默认输入设备后重试。';
        }
        if (/securityerror|secure context|https/.test(details)) {
            return '当前页面不满足浏览器麦克风访问要求，请使用 HTTPS 或受信任的本地地址后重试。';
        }
        return '无法启动实时语音，请检查麦克风和权限后重试。';
    }

    async function recordEvent(voiceSessionId, event, { keepalive = false } = {}) {
        if (!voiceSessionId) return null;
        const response = await apiFetch(`${API_BASE}/chat/voice-sessions/${encodeURIComponent(voiceSessionId)}/events`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }), keepalive
        });
        return response.ok ? response.json().catch(() => null) : null;
    }

    function selectVoice() {
        const voices = globalThis.speechSynthesis?.getVoices?.() || [];
        const locale = navigator.language || 'zh-CN';
        const localVoices = voices.filter(item => item.localService === true);
        return localVoices.find(item => item.lang?.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase())) || localVoices[0] || null;
    }

    async function waitForLocalVoice(timeoutMs = 1500) {
        const available = selectVoice();
        if (available) return available;
        if (!globalThis.speechSynthesis?.addEventListener) return null;
        return await new Promise(resolve => {
            let timer = null;
            const finish = () => {
                if (timer) clearTimeout(timer);
                globalThis.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
                resolve(selectVoice());
            };
            const onVoicesChanged = () => finish();
            globalThis.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true });
            timer = setTimeout(finish, timeoutMs);
        });
    }

    function createDeviceLocalRecognition(Recognition) {
        const recognition = new Recognition();
        if (!('processLocally' in recognition)) {
            throw new Error('当前浏览器无法确认设备端语音识别，实时语音已保持关闭。');
        }
        try { recognition.processLocally = true; } catch (_) {}
        if (recognition.processLocally !== true) {
            throw new Error('当前浏览器未启用设备端语音识别，实时语音已保持关闭。');
        }
        return recognition;
    }

    function speak(text) {
        if (!voice?.active || !text || !globalThis.speechSynthesis) return;
        const session = voice;
        const utterance = new globalThis.SpeechSynthesisUtterance(text);
        utterance.lang = navigator.language || 'zh-CN';
        utterance.rate = 1;
        utterance.voice = session.localVoice || selectVoice();
        if (!utterance.voice) return;
        session.speaking = true;
        session.spokenAny = true;
        utterance.onend = () => {
            if (voice !== session) return;
            session.speaking = false;
            speakNext();
        };
        utterance.onerror = () => {
            if (voice !== session) return;
            session.speaking = false;
            speakNext();
        };
        globalThis.speechSynthesis.speak(utterance);
    }

    function speakNext() {
        if (!voice?.active || voice.speaking || !voice.speechQueue.length) return;
        speak(voice.speechQueue.shift());
    }

    function queueSpeech(text) {
        const value = String(text || '').trim();
        if (!voice?.active || !value) return;
        voice.speechQueue.push(value.slice(0, 2000));
        speakNext();
    }

    function handleAssistantDelta(delta) {
        if (!voice?.active) return;
        voice.speechBuffer += String(delta || '');
        const fragments = voice.speechBuffer.split(/(?<=[。！？!?；;]\s*)/u);
        voice.speechBuffer = fragments.pop() || '';
        fragments.forEach(queueSpeech);
    }

    function flushAssistantSpeech(content = '') {
        if (!voice?.active) return;
        if (content && !voice.spokenAny && !voice.speechBuffer) queueSpeech(content);
        else if (voice.speechBuffer.trim()) queueSpeech(voice.speechBuffer);
        voice.speechBuffer = '';
    }

    async function submitTranscript(text) {
        const session = voice;
        const input = document.getElementById('user-input');
        if (!session?.active || session.submitting || !input || !text) return;
        session.submitting = true;
        if (session.speaking) {
            globalThis.speechSynthesis?.cancel?.();
            session.speaking = false;
            session.speechQueue = [];
            session.speechBuffer = '';
            void recordEvent(session.id, 'barge_in').catch(() => {});
        }
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        void recordEvent(session.id, 'turn_started').catch(() => {});
        try {
            await window.Pivot?.legacy?.sendMessage?.({ ephemeralVoice: true, voiceSessionId: session.id });
            if (voice === session && session.active) {
                void recordEvent(session.id, 'turn_completed').catch(() => {});
                flushAssistantSpeech();
            }
        } catch (_) {
            if (voice === session && session.active) void recordEvent(session.id, 'failed').catch(() => {});
        } finally {
            if (voice === session) session.submitting = false;
        }
    }

    function startRecognition(session = voice) {
        if (!session?.active || voice !== session || !session.recognition) return;
        try { session.recognition.start(); } catch (_) {}
    }

    function release({ event = 'ended', abort = true } = {}) {
        const current = voice;
        const starting = voiceStart;
        if (!current && !starting) return;
        if (starting) {
            starting.cancelled = true;
            voiceStart = null;
            if (starting.id) {
                starting.terminalEventSent = true;
                void recordEvent(starting.id, event, { keepalive: true }).catch(() => {});
            }
        }
        voice = null;
        globalThis.speechSynthesis?.cancel?.();
        if (current?.heartbeatTimer) clearInterval(current.heartbeatTimer);
        if (current?.recognition) {
            current.recognition.onresult = null;
            current.recognition.onerror = null;
            current.recognition.onend = null;
            if (abort) { try { current.recognition.abort?.(); } catch (_) {} }
        }
        stopTracks(current?.stream);
        setButtonState(false);
        if (current?.id) void recordEvent(current.id, event, { keepalive: true }).catch(() => {});
    }

    async function startRealtimeVoice() {
        if (voice?.active) { release(); return null; }
        if (voiceStart?.promise) return voiceStart.promise;
        const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        if (!Recognition || !getUserMedia || !globalThis.speechSynthesis) {
            showToast('当前浏览器不支持设备端实时语音，请使用支持本地识别和本地语音的浏览器。', 'warning');
            return null;
        }
        const start = { id: '', cancelled: false, terminalEventSent: false, promise: null };
        voiceStart = start;
        setButtonState(false, { starting: true });
        start.promise = (async () => {
            let stream;
            try {
            if (!currentSessionId) {
                const created = await window.Pivot?.moduleApi?.('chat.sessions')?.createSession?.('临时语音会话');
                if (!created?.id) throw new Error('无法创建临时语音会话。');
                currentSessionId = created.id;
                document.getElementById('current-title')?.replaceChildren(document.createTextNode(created.title || '临时语音会话'));
                window.Pivot.legacy.loadSessions?.();
            }
            const recognition = createDeviceLocalRecognition(Recognition);
            // 先请求浏览器的默认音频输入。此前将降噪、回声消除和自动增益直接作为
            // 首个约束，部分驱动会把它误判为不存在的设备，导致 “Requested device not found”。
            // 实时语音本身不依赖这些增强项，基础音频采集的兼容性更高。
            stream = await getUserMedia({ audio: true });
            if (start.cancelled) {
                stopTracks(stream);
                return null;
            }
            const localVoice = await waitForLocalVoice();
            if (!localVoice) throw new Error('当前浏览器没有可用的本地语音，实时语音已保持关闭。');
            const response = await apiFetch(`${API_BASE}/chat/voice-sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: currentSessionId || null, transport: 'browser_native', language: navigator.language || 'zh-CN' })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '无法启动实时语音会话。');
            start.id = String(data.voiceSession?.id || '');
            if (!start.id) throw new Error('语音会话未返回有效标识。');
            if (start.cancelled) {
                stopTracks(stream);
                if (!start.terminalEventSent) void recordEvent(start.id, 'ended', { keepalive: true }).catch(() => {});
                return null;
            }
            recognition.lang = navigator.language || 'zh-CN';
            recognition.continuous = true;
            recognition.interimResults = true;
            const session = { id: start.id, active: true, stream, recognition, localVoice, speaking: false, spokenAny: false, submitting: false, speechBuffer: '', speechQueue: [], heartbeatTimer: null };
            voice = session;
            recognition.onresult = event => {
                let finalText = '';
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    if (event.results[index].isFinal) finalText += String(event.results[index]?.[0]?.transcript || '');
                }
                const text = finalText.trim();
                if (text) void submitTranscript(text);
            };
            recognition.onerror = event => {
                if (!voice || voice !== session) return;
                if (!['aborted', 'no-speech'].includes(String(event.error || '').toLowerCase())) {
                    showToast('实时语音识别失败，已结束本次语音会话。', 'error');
                    release({ event: 'failed', abort: false });
                }
            };
            recognition.onend = () => { if (voice === session && session.active) setTimeout(() => startRecognition(session), 120); };
            session.heartbeatTimer = setInterval(() => { if (voice === session && session.active) void recordEvent(session.id, 'heartbeat').catch(() => {}); }, VOICE_HEARTBEAT_MS);
            startRecognition(session);
            showToast('实时语音已启动。Pivot 不上传录音；识别文本只用于当前模型请求，不保存为聊天消息或语音转写。', 'success');
            return session;
        } catch (error) {
            stopTracks(stream);
            if (start.id && !start.terminalEventSent) void recordEvent(start.id, start.cancelled ? 'ended' : 'failed', { keepalive: true }).catch(() => {});
            if (!start.cancelled) showToast(realtimeVoiceErrorMessage(error), 'error');
            return null;
        } finally {
            if (voiceStart === start) voiceStart = null;
            if (!voice?.active) setButtonState(false);
        }
        })();
        return start.promise;
    }

    globalThis.addEventListener('pagehide', () => release(), { capture: true });
    globalThis.addEventListener('beforeunload', () => release(), { capture: true });
    window.Pivot?.exposeModule?.('chat.realtimeVoice', { flushAssistantSpeech, handleAssistantDelta, startRealtimeVoice, stopRealtimeVoice: release });
})();
