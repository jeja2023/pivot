/* 实时语音使用受支持的部署内识别通道，临时文本不持久化。 */
/* global API_BASE, apiFetch, currentSessionId, showToast */
(function () {
    let voice = null;
    let voiceStart = null;

    const VOICE_HEARTBEAT_MS = 30000;
    const voiceText = () => window.Pivot.moduleApi('chat.voiceText');

    function isPlaybackEcho(session, text) {
        session.playbackEchoes = session.playbackEchoes.filter(item => item.expiresAt > Date.now());
        return voiceText().isPlaybackEcho(text, session.playbackEchoes.map(item => item.text));
    }

    function echoDeadline(session) { return Date.now() + (session.recognition.usesServerInput ? 30000 : 1500); }

    function interruptReply(session) {
        if (!session.speaking && (!session.submitting || session.replyInterrupted)) return;
        session.replyInterrupted = true;
        clearTimeout(session.playbackTimer);
        session.playbackTimer = null;
        // 先废弃朗读实例，再取消播放，避免取消回调被当成设备故障。
        session.utterance = null;
        session.speaking = false;
        session.speechQueue = [];
        session.speechBuffer = '';
        session.playbackEchoes.forEach(item => { item.expiresAt = Math.min(item.expiresAt, echoDeadline(session)); });
        globalThis.speechSynthesis?.cancel?.();
        window.Pivot.moduleApi('chat.execution')?.stopVoiceRequest?.(session.id);
        void recordEvent(session.id, 'barge_in').catch(() => {});
    }

    function setStatus(message = '', state = '') {
        const element = document.getElementById('chat-voice-status');
        if (!element) return;
        element.hidden = !message;
        element.textContent = message;
        element.setAttribute('data-state', state);
    }

    function listeningStatus(session) {
        if (voice !== session || !session.active || session.speaking) return;
        if (session.submitting) {
            setStatus('正在等待模型继续回答…', 'thinking');
            return;
        }
        setStatus('正在聆听，请说话；停顿后完成识别，回答会自动朗读。', 'listening');
    }

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
        if (error?.voiceMessage) return error.voiceMessage;
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
        const locale = window.Pivot.moduleApi('chat.voicePlatform')?.language?.() || navigator.language || 'zh-CN';
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
            const onVoicesChanged = () => { if (selectVoice()) finish(); };
            globalThis.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
            timer = setTimeout(finish, timeoutMs);
        });
    }

    function speak(text) {
        if (!voice?.active || !text || !globalThis.speechSynthesis) return;
        const session = voice;
        const utterance = new globalThis.SpeechSynthesisUtterance(text);
        utterance.lang = session.localVoice?.lang || window.Pivot.moduleApi('chat.voicePlatform')?.language?.() || 'zh-CN';
        utterance.rate = 1;
        utterance.voice = session.localVoice || selectVoice();
        if (!utterance.voice) return;
        session.speaking = true;
        session.utterance = utterance;
        setStatus('正在准备朗读…', 'speaking');
        // 朗读时继续识别，用正在播放的文本过滤回声，保留用户插话通道。
        const echo = { text, expiresAt: Infinity };
        session.playbackEchoes = [...session.playbackEchoes.filter(item => item.expiresAt > Date.now()).slice(-63), echo];
        session.spokenAny = true;
        const failPlayback = () => {
            if (voice !== session || session.utterance !== utterance) return;
            showToast('本地朗读未能播放，实时语音已停止。请检查系统音量、默认输出设备和中文语音组件；仍可使用语音输入。', 'error');
            release({ event: 'failed' });
        };
        // 某些本地声音不触发 onstart；引擎已在播放时不能据此结束整场对话。
        session.playbackTimer = setTimeout(() => {
            if (voice !== session || session.utterance !== utterance) return;
            session.playbackTimer = null;
            if (!globalThis.speechSynthesis.speaking && !globalThis.speechSynthesis.pending) failPlayback();
        }, 15000);
        utterance.onstart = () => {
            if (voice !== session || session.utterance !== utterance) return;
            clearTimeout(session.playbackTimer);
            session.playbackTimer = null;
            setStatus('正在朗读，可直接说话打断。', 'speaking');
        };
        utterance.onend = () => {
            if (voice !== session || session.utterance !== utterance) return;
            clearTimeout(session.playbackTimer);
            session.playbackTimer = null;
            echo.expiresAt = echoDeadline(session);
            session.utterance = null;
            session.speaking = false;
            setTimeout(() => { if (voice === session && session.active) speakNext(); }, 0);
            if (!session.speechQueue.length) { startRecognition(session); listeningStatus(session); }
        };
        utterance.onerror = failPlayback;
        try {
            globalThis.speechSynthesis.resume?.();
            globalThis.speechSynthesis.speak(utterance);
        } catch (_) { failPlayback(); }
    }

    function speakNext() {
        if (!voice?.active || voice.speaking || !voice.speechQueue.length) return;
        speak(voice.speechQueue.shift());
    }

    function queueSpeech(text) {
        const value = String(text || '').trim();
        if (!voice?.active || !value) return;
        voice.speechQueue.push(...voiceText().speechSegments(value));
        speakNext();
    }

    function handleAssistantDelta(delta, voiceSessionId) {
        if (!voice?.active || voice.replyInterrupted || voiceSessionId && voice.id !== voiceSessionId) return;
        const value = String(delta || '');
        voice.answerText += value;
        voice.speechBuffer += value;
        const buffer = voice.speechBuffer;
        const sentenceEnd = /[。！？!?；;]\s*/gu;
        let boundary = 0;
        const session = voice;
        while (sentenceEnd.exec(buffer)) {
            queueSpeech(buffer.slice(boundary, sentenceEnd.lastIndex));
            if (voice !== session) return;
            boundary = sentenceEnd.lastIndex;
        }
        session.speechBuffer = buffer.slice(boundary);
    }

    function flushAssistantSpeech(content = '', voiceSessionId) {
        if (!voice?.active || voice.replyInterrupted || voiceSessionId && voice.id !== voiceSessionId) return;
        const session = voice;
        // 最终全文可能包含流式阶段未到达的尾部，只追加差量，重复完成事件不会重读。
        if (content) {
            const fullText = String(content);
            if (fullText.startsWith(session.answerText)) {
                session.speechBuffer += fullText.slice(session.answerText.length);
            } else if (!session.spokenAny) session.speechBuffer = fullText;
            session.answerText = fullText;
        }
        if (session.speechBuffer.trim()) queueSpeech(session.speechBuffer);
        session.speechBuffer = '';
    }

    function voiceTaskControlAction(transcript) {
        const value = String(transcript || '').trim().replace(/[。！!？?]+$/u, '');
        if (/^(暂停|暂停任务|先暂停|等等|等一下)$/u.test(value)) return 'pause';
        if (/^(继续|继续任务|恢复|恢复任务|继续执行)$/u.test(value)) return 'resume';
        if (/^(停止|停止任务|取消|取消任务|终止任务)$/u.test(value)) return 'cancel';
        return '';
    }

    async function controlVoiceTask(session, action) {
        const response = await apiFetch(`${API_BASE}/chat/voice-sessions/${encodeURIComponent(session.id)}/task-control`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error || '语音任务控制失败。'), { code: data.code });
        if (voice !== session || !session.active) return data;
        const message = String(data.message || '').trim();
        if (message) queueSpeech(message);
        showToast(message || '任务控制已执行。', 'success');
        return data;
    }

    async function submitTranscript(text) {
        const session = voice;
        const input = document.getElementById('user-input');
        if (!session?.active || !input || !text) return;
        if (String(currentSessionId || '') !== session.chatSessionId) { release(); return; }
        if (voiceText().isExitCommand(text)) {
            release();
            showToast('已退出实时语音。', 'info');
            return;
        }
        const taskAction = voiceTaskControlAction(text);
        if (taskAction) {
            try { await controlVoiceTask(session, taskAction); }
            catch (error) {
                if (voice !== session || !session.active) return;
                if (session.replyInterrupted && taskAction !== 'resume' && error.code === 'AGENT_VOICE_TASK_TARGET_NOT_FOUND') {
                    showToast('已停止当前回复。', 'info');
                } else showToast(error.message || '语音任务控制失败。', 'error');
            }
            return;
        }
        if (session.submitting) { session.pendingTranscript = voiceText().joinTranscript(session.pendingTranscript, text).slice(0, 4000); return; }
        session.replyInterrupted = false;
        session.submitting = true;
        setStatus('已完成识别，正在等待模型回答…', 'thinking');
        session.spokenAny = false;
        session.answerText = '';
        session.speechBuffer = '';
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        void recordEvent(session.id, 'turn_started').catch(() => {});
        try {
            if (typeof window.Pivot?.legacy?.sendMessage !== 'function') throw new Error('聊天组件尚未就绪，请刷新后重试。');
            await window.Pivot.legacy.sendMessage({ ephemeralVoice: true, voiceSessionId: session.id, voiceHistory: session.history.slice() });
            if (voice === session && session.active) {
                flushAssistantSpeech();
                if (session.answerText) {
                    void recordEvent(session.id, 'turn_completed').catch(() => {});
                    session.history = [...session.history, { role: 'user', content: text.slice(0, 4000) },
                        { role: 'assistant', content: session.answerText.slice(0, 4000) }].slice(-8);
                }
            }
        } catch (error) {
            if (voice === session && session.active && !session.replyInterrupted && error.name !== 'AbortError') {
                showToast(error.message || '语音消息发送失败。', 'error');
                void recordEvent(session.id, 'failed').catch(() => {});
            }
        } finally {
            if (voice === session) {
                session.submitting = false;
                const pending = session.pendingTranscript;
                session.pendingTranscript = '';
                if (pending) void submitTranscript(pending);
                else listeningStatus(session);
            }
        }
    }

    function startRecognition(session = voice) {
        if (!session?.active || voice !== session || !session.recognition) return;
        try { session.recognition.start(); }
        catch (error) {
            if (error.name === 'InvalidStateError') return;
            showToast(window.Pivot.moduleApi('chat.voicePlatform').errorMessage(error), 'error');
            release({ event: 'failed' });
        }
    }

    function release({ event = 'ended', abort = true } = {}) {
        const current = voice;
        const starting = voiceStart;
        if (!current && !starting) return;
        if (starting) {
            starting.cancelled = true;
            voiceStart = null;
            if (starting.id && starting.id !== current?.id) {
                starting.terminalEventSent = true;
                void recordEvent(starting.id, event, { keepalive: true }).catch(() => {});
            }
        }
        voice = null;
        if (current) {
            current.active = false;
            current.history = [];
            current.playbackEchoes = [];
            current.pendingTranscript = '';
            current.speechQueue = [];
            current.speechBuffer = '';
            current.answerText = '';
            clearTimeout(current.playbackTimer);
            current.utterance = null;
            current.cancelStart?.();
            window.Pivot.moduleApi('chat.execution')?.stopVoiceRequest?.(current.id);
        }
        globalThis.speechSynthesis?.cancel?.();
        if (current?.heartbeatTimer) clearInterval(current.heartbeatTimer);
        if (current?.recognition) {
            current.recognition.onresult = null;
            current.recognition.onerror = null;
            current.recognition.onend = null;
            current.recognition.onstart = null;
            if (abort) { try { current.recognition.abort?.(); } catch (_) {} }
        }
        stopTracks(current?.stream);
        setButtonState(false);
        setStatus();
        if (current?.id) void recordEvent(current.id, event, { keepalive: true }).catch(() => {});
    }

    async function startRealtimeVoice() {
        if (voice?.active) { release(); return null; }
        if (voiceStart?.promise) return voiceStart.promise;
        const platform = window.Pivot.moduleApi('chat.voicePlatform');
        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        const reason = platform?.availability?.() || (!platform ? '语音组件尚未加载，请刷新后重试。' : '');
        if (reason || !getUserMedia && !platform.usesDesktopInput?.() || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
            showToast(reason || '当前浏览器不支持本地朗读，实时语音不可用。', 'warning');
            return null;
        }
        if (String(document.getElementById('user-input')?.value || '').trim() || window.Pivot.legacy.pendingAttachments?.length) {
            showToast('请先发送或清空输入框中的草稿及附件，再启动实时语音。', 'warning');
            return null;
        }
        const model = document.getElementById('model-selector');
        if (model && !model.value) { showToast('请先配置或选择可用模型，再启动实时语音。', 'warning'); return null; }
        window.Pivot.moduleApi('chat.memoryActions')?.stopChatVoiceInput?.();
        const start = { id: '', cancelled: false, terminalEventSent: false, promise: null };
        voiceStart = start;
        setButtonState(false, { starting: true });
        setStatus('正在检查麦克风、语音服务与本地朗读…', 'starting');
        start.promise = (async () => {
            let stream;
            try {
            const recognition = await platform.prepareRecognition();
            if (start.cancelled) return null;
            const localVoice = await waitForLocalVoice();
            if (start.cancelled) return null;
            if (!localVoice) throw Object.assign(new Error(), { voiceMessage: '当前浏览器没有可用的本地朗读声音，实时语音无法启动；可使用语音输入。' });
            stream = recognition.usesDesktopInput ? null : await getUserMedia({ audio: true });
            await platform.enhanceStream?.(stream);
            if (start.cancelled) { stopTracks(stream); return null; }
            // 服务器识别直接使用该轨道；默认采集成功后再尝试回声消除，不兼容时沿用原轨道。
            if (start.cancelled) { stopTracks(stream); return null; }
            recognition.attachStream?.(stream);
            if (!currentSessionId) {
                const created = await window.Pivot?.moduleApi?.('chat.sessions')?.createSession?.('临时语音会话');
                if (!created?.id) throw new Error('无法创建临时语音会话。');
                currentSessionId = created.id;
                document.getElementById('current-title')?.replaceChildren(document.createTextNode(created.title || '临时语音会话'));
                window.Pivot.legacy.loadSessions?.();
            }
            // 先请求浏览器的默认音频输入。此前将降噪、回声消除和自动增益直接作为
            // 首个约束，部分驱动会把它误判为不存在的设备，导致 “Requested device not found”。
            // 实时语音本身不依赖这些增强项，基础音频采集的兼容性更高。
            if (start.cancelled) {
                stopTracks(stream);
                return null;
            }
            const chatSessionId = String(currentSessionId);
            const response = await apiFetch(`${API_BASE}/chat/voice-sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: chatSessionId, transport: 'browser_native', language: recognition.lang,
                    inputProvider: recognition.inputProvider || (recognition.usesServerInput ? 'server_local_speech' : recognition.usesDesktopInput ? 'desktop_local_speech' : 'browser_speech_recognition') })
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
            recognition.continuous = true;
            recognition.interimResults = true;
            const session = { id: start.id, chatSessionId, active: true, stream, recognition, localVoice, history: [], answerText: '',
                speaking: false, spokenAny: false, submitting: false, replyInterrupted: false, playbackEchoes: [],
                speechBuffer: '', speechQueue: [], heartbeatTimer: null };
            voice = session;
            recognition.onresult = event => {
                if (voice !== session || !session.active) return;
                let finalText = '';
                let interimText = '';
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    const transcript = String(event.results[index]?.[0]?.transcript || '').trim();
                    const exitCommand = event.results[index].isFinal && voiceText().isExitCommand(transcript);
                    if (!exitCommand && isPlaybackEcho(session, transcript)) continue;
                    if (event.results[index].requiresReview) {
                        const input = document.getElementById('user-input');
                        if (input) { input.value = voiceText().joinTranscript(input.value, transcript); input.dispatchEvent(new Event('input', { bubbles: true })); }
                        showToast('这段语音识别存疑，已保留在输入框，请核对后发送。', 'warning');
                        release({ event: 'paused' });
                        return;
                    }
                    if (event.results[index].isFinal) finalText = voiceText().joinTranscript(finalText, transcript);
                    else interimText = voiceText().joinTranscript(interimText, transcript);
                }
                const text = finalText.trim();
                // 临时结果常含回声或尚未稳定的错字，只用最终识别结果中断回复。
                if (text && !voiceText().isExitCommand(text)) interruptReply(session);
                if (interimText && !session.speaking) setStatus('正在识别，请在一句话说完后稍作停顿…', 'recognizing');
                if (text) void submitTranscript(text);
            };
            recognition.onerror = event => {
                if (!voice || voice !== session) return;
                if (!['aborted', 'no-speech'].includes(String(event.error || '').toLowerCase())) {
                    if (session.rejectStart) session.rejectStart(Object.assign(new Error(), { voiceMessage: platform.errorMessage(event) }));
                    else {
                        showToast(platform.errorMessage(event), 'error');
                        release({ event: 'failed' });
                    }
                }
            };
            recognition.onend = () => { if (voice === session && session.active) setTimeout(() => startRecognition(session), 250); };
            session.heartbeatTimer = setInterval(() => { if (voice === session && session.active) void recordEvent(session.id, 'heartbeat').catch(() => {}); }, VOICE_HEARTBEAT_MS);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Object.assign(new Error(), { voiceMessage: '语音识别服务未响应，实时语音未启动。请检查服务和麦克风。' })), 10000);
                const finish = error => { clearTimeout(timer); session.rejectStart = null; session.cancelStart = null; error ? reject(error) : resolve(); };
                session.rejectStart = finish;
                session.cancelStart = () => finish(Object.assign(new Error(), { name: 'AbortError' }));
                recognition.onstart = () => finish();
                try { recognition.start(); } catch (error) { finish(error); }
            });
            if (start.cancelled || voice !== session) return null;
            setButtonState(true);
            recognition.onstart = () => listeningStatus(session);
            listeningStatus(session);
            showToast('实时语音已启动，请说话并在句末稍作停顿；模型回答后自动朗读。临时上下文仅保留到结束。', 'success');
            return session;
        } catch (error) {
            const cancelled = start.cancelled;
            stopTracks(stream);
            if (voice?.id === start.id) { release({ event: start.cancelled ? 'ended' : 'failed' }); start.terminalEventSent = true; }
            else if (start.id && !start.terminalEventSent) void recordEvent(start.id, start.cancelled ? 'ended' : 'failed', { keepalive: true }).catch(() => {});
            if (!cancelled) showToast(realtimeVoiceErrorMessage(error), 'error');
            return null;
        } finally {
            if (voiceStart === start) voiceStart = null;
            if (!voice?.active) { setButtonState(false); setStatus(); }
        }
        })();
        return start.promise;
    }

    globalThis.addEventListener('pagehide', () => release(), { capture: true });
    globalThis.addEventListener('beforeunload', () => release(), { capture: true });
    window.Pivot?.exposeModule?.('chat.realtimeVoice', { flushAssistantSpeech, handleAssistantDelta, startRealtimeVoice, stopRealtimeVoice: release });
})();
