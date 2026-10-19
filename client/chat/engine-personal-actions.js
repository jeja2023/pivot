/* 聊天记忆管理入口与浏览器语音输入；自动记忆由服务端处理。 */
/* global showToast */
(function () {
    let activeVoiceSession = null;
    let pendingVoiceRequest = null;
    let voiceRequestSequence = 0;

    function setVoiceButtonState(active) {
        const button = document.getElementById('chat-voice-input');
        button?.setAttribute('aria-pressed', active ? 'true' : 'false');
        button?.classList.toggle('is-recording', active);
        if (active) button?.setAttribute('aria-busy', 'true');
        else button?.removeAttribute('aria-busy');
        button?.setAttribute('title', active ? '停止语音输入' : '语音输入：部署内识别，完成后可编辑发送');
    }

    function stopMediaStream(stream) {
        stream?.getTracks?.().forEach(track => {
            try { track.stop(); } catch (_) {}
        });
    }

    function releaseVoiceSession(session, { abortRecognition = false } = {}) {
        if (!session || session.released) return;
        session.released = true;

        if (activeVoiceSession === session) {
            activeVoiceSession = null;
            setVoiceButtonState(false);
        }

        const recognition = session.recognition;
        session.recognition = null;
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            if (abortRecognition) {
                if (typeof recognition.abort === 'function') {
                    try { recognition.abort(); } catch (_) {}
                } else {
                    try { recognition.stop?.(); } catch (_) {}
                }
            }
        }

        const mediaRecorder = session.mediaRecorder;
        session.mediaRecorder = null;
        if (mediaRecorder) {
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onerror = null;
            mediaRecorder.onstop = null;
            if (mediaRecorder.state !== 'inactive') {
                try { mediaRecorder.stop(); } catch (_) {}
            }
        }

        stopMediaStream(session.stream);
        session.stream = null;
        session.chunks.length = 0;
    }

    function stopChatVoiceInput() {
        pendingVoiceRequest = null;
        voiceRequestSequence += 1;
        releaseVoiceSession(activeVoiceSession, { abortRecognition: true });
        setVoiceButtonState(false);
    }

    async function openChatMemoryManagement() {
        await window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true });
        await window.Pivot.legacy.switchTab?.('memories');
    }

    async function startChatVoiceInput() {
        const platform = window.Pivot.moduleApi('chat.voicePlatform');
        const input = document.getElementById('user-input');
        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        const reason = platform?.availability?.() || (!platform ? '语音组件尚未加载，请刷新后重试。' : '');
        if (reason || !getUserMedia && !platform.usesDesktopInput?.()) {
            showToast(reason || '当前浏览器无法访问麦克风。', 'warning');
            return null;
        }
        if (!input) return null;

        if (activeVoiceSession || pendingVoiceRequest !== null) {
            if (activeVoiceSession?.recognition?.usesServerInput) { activeVoiceSession.recognition.stop(); return null; }
            stopChatVoiceInput();
            return null;
        }
        window.Pivot.moduleApi('chat.realtimeVoice')?.stopRealtimeVoice?.();

        const requestId = ++voiceRequestSequence;
        pendingVoiceRequest = requestId;
        setVoiceButtonState(true);
        let stream = null;
        let session = null;

        try {
            const recognition = await platform.prepareRecognition();
            if (pendingVoiceRequest !== requestId) return null;
            // Keep the user activation from the button click while explicitly requesting microphone access.
            stream = recognition.usesDesktopInput ? null : await getUserMedia({ audio: true });
            if (pendingVoiceRequest !== requestId) {
                stopMediaStream(stream);
                return null;
            }
            recognition.attachStream?.(stream);

            session = {
                chunks: [],
                mediaRecorder: null,
                recognition,
                released: false,
                stream
            };
            activeVoiceSession = session;
            pendingVoiceRequest = null;

            const original = String(input.value || '').trim();
            recognition.interimResults = true;
            recognition.continuous = false;
            recognition.onresult = event => {
                let finalTranscript = '';
                let interimTranscript = '';
                for (let index = 0; index < event.results.length; index += 1) {
                    const transcript = String(event.results[index]?.[0]?.transcript || '');
                    if (event.results[index].isFinal) finalTranscript += transcript;
                    else interimTranscript += transcript;
                }
                const prefix = original ? `${original}${/[\s。！？!?]$/.test(original) ? '' : ' '}` : '';
                input.value = `${prefix}${finalTranscript}${interimTranscript}`.trim();
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            recognition.onerror = event => {
                const shouldReport = activeVoiceSession === session;
                releaseVoiceSession(session);
                if (shouldReport && !['aborted', 'no-speech'].includes(String(event.error || '').toLowerCase())) {
                    showToast(platform.errorMessage(event), 'error');
                }
            };
            recognition.onend = () => releaseVoiceSession(session);
            recognition.start();
            return recognition;
        } catch (error) {
            const shouldReport = pendingVoiceRequest === requestId || activeVoiceSession === session;
            if (session) releaseVoiceSession(session, { abortRecognition: true });
            else stopMediaStream(stream);
            if (pendingVoiceRequest === requestId) pendingVoiceRequest = null;
            if (shouldReport) {
                setVoiceButtonState(false);
                showToast(platform.errorMessage(error), 'error');
            }
            return null;
        }
    }

    globalThis.addEventListener('pagehide', stopChatVoiceInput, { capture: true });
    globalThis.addEventListener('beforeunload', stopChatVoiceInput, { capture: true });

    window.Pivot?.exposeModule?.('chat.memoryActions', { openChatMemoryManagement, startChatVoiceInput, stopChatVoiceInput });
})();
