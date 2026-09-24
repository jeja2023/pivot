/* 聊天中的显式记忆与浏览器语音输入；不进入消息发送主循环。 */
/* global API_BASE, apiFetch, currentSessionId, showToast */
(function () {
    let activeVoiceSession = null;
    let pendingVoiceRequest = null;
    let voiceRequestSequence = 0;
    let memoryIntentPreview = null;

    const MICROPHONE_PERMISSION_MESSAGE = '请在系统或浏览器设置中允许本应用访问麦克风后重试';

    function setVoiceButtonState(active) {
        const button = document.getElementById('chat-voice-input');
        button?.setAttribute('aria-pressed', active ? 'true' : 'false');
        button?.classList.toggle('is-recording', active);
        if (active) button?.setAttribute('aria-busy', 'true');
        else button?.removeAttribute('aria-busy');
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

    function voiceInputErrorMessage(error) {
        const details = [error?.error, error?.name, error?.code, error?.message, error]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        if (/(not-allowed|notallowed|permission-denied|permissiondenied)/.test(details)) return MICROPHONE_PERMISSION_MESSAGE;
        if (/(not-found|notfound|devicesnotfound|overconstrained)/.test(details)) return '未检测到可用的麦克风设备，请连接或启用麦克风后重试。';
        if (/(not-readable|notreadable|trackstarterror|audio-capture)/.test(details)) return '麦克风正在被其他应用占用，请关闭占用程序后重试。';
        if (/(not-supported|notsupported|media devices api|speechrecognition)/.test(details)) return '当前浏览器不支持语音输入，请使用支持麦克风访问和语音识别的浏览器。';
        if (/securityerror|secure context|https/.test(details)) return '当前页面不满足浏览器麦克风访问要求，请使用 HTTPS 或受信任的本地地址后重试。';
        return '语音输入失败，请重试。';
    }

    function stopChatVoiceInput() {
        pendingVoiceRequest = null;
        voiceRequestSequence += 1;
        releaseVoiceSession(activeVoiceSession, { abortRecognition: true });
        setVoiceButtonState(false);
    }

    function setChatMemoryMenuOpen(open) {
        const panel = document.getElementById('chat-memory-menu-panel');
        const button = document.getElementById('chat-memory-menu-btn');
        if (!panel || !button) return;
        panel.hidden = !open;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    async function rememberCurrentChatInput() {
        const input = document.getElementById('user-input');
        const content = String(input?.value || '').trim();
        if (content.length < 8) { showToast('请先输入至少 8 个字符的稳定偏好、事实或做法。', 'warning'); return null; }
        const response = await apiFetch(`${API_BASE}/memories/remember`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, type: 'preference', scope: 'user', sourceSessionId: currentSessionId || null, salience: 0.8, confidence: 0.9 })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '保存长期记忆失败');
        setChatMemoryMenuOpen(false);
        showToast(data.merged ? '已合并到现有个人记忆。' : '已记住当前输入；下次相关任务会在策略允许时使用。', 'success');
        globalThis.dispatchEvent(new globalThis.CustomEvent('pivot:memory-changed'));
        return data;
    }

    async function openChatMemoryManagement() {
        setChatMemoryMenuOpen(false);
        await window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'workbench', subview: 'governance' });
        document.querySelector('[data-agent-harness-nav="memory"]')?.click();
    }

    function closeMemoryIntentModal() {
        document.getElementById('chat-memory-intent-modal')?.classList.add('hidden');
        memoryIntentPreview = null;
        document.getElementById('chat-memory-intent-preview')?.classList.add('hidden');
        const apply = document.getElementById('chat-memory-intent-apply');
        if (apply) apply.disabled = true;
    }

    function openMemoryIntentModal() {
        setChatMemoryMenuOpen(false);
        const modal = document.getElementById('chat-memory-intent-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        const text = document.getElementById('chat-memory-intent-text');
        if (text && !text.value.trim()) text.value = String(document.getElementById('user-input')?.value || '').trim();
        setTimeout(() => text?.focus(), 0);
    }

    function renderMemoryIntentPreview(preview = {}) {
        const box = document.getElementById('chat-memory-intent-preview');
        const apply = document.getElementById('chat-memory-intent-apply');
        if (!box) return;
        box.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = preview.actionLabel || '记忆操作预览';
        const summary = document.createElement('p');
        summary.textContent = preview.summary || '请确认操作。';
        box.append(title, summary);
        const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
        if (candidates.length) {
            const select = document.createElement('select');
            select.id = 'chat-memory-intent-candidate';
            select.className = 'form-input';
            candidates.forEach(candidate => {
                const option = document.createElement('option');
                option.value = String(candidate.id);
                option.textContent = `${candidate.content}（${candidate.type || '记忆'}）`;
                select.appendChild(option);
            });
            box.appendChild(select);
        }
        box.classList.remove('hidden');
        if (apply) apply.disabled = preview.canConfirm !== true;
    }

    async function previewMemoryIntent() {
        const text = String(document.getElementById('chat-memory-intent-text')?.value || '').trim();
        if (!text) throw new Error('请输入记住、忘记或更正指令。');
        const response = await apiFetch(`${API_BASE}/memories/intents/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '无法预览记忆操作。');
        memoryIntentPreview = data.preview || null;
        renderMemoryIntentPreview(memoryIntentPreview || {});
        return memoryIntentPreview;
    }

    async function applyMemoryIntent() {
        const text = String(document.getElementById('chat-memory-intent-text')?.value || '').trim();
        if (!memoryIntentPreview || !text) return null;
        const selected = document.getElementById('chat-memory-intent-candidate')?.value || '';
        const response = await apiFetch(`${API_BASE}/memories/intents/apply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, memoryId: selected || null, sourceSessionId: currentSessionId || null })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '记忆操作失败。');
        showToast(data.message || '记忆已更新。', 'success');
        globalThis.dispatchEvent(new globalThis.CustomEvent('pivot:memory-changed'));
        closeMemoryIntentModal();
        return data;
    }

    async function startChatVoiceInput() {
        const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
        const input = document.getElementById('user-input');
        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        if (!Recognition || !getUserMedia) {
            showToast('当前浏览器不支持语音输入，请使用支持麦克风访问和语音识别的浏览器。', 'warning');
            return null;
        }
        if (!input) return null;

        if (activeVoiceSession || pendingVoiceRequest !== null) {
            stopChatVoiceInput();
            return null;
        }

        const requestId = ++voiceRequestSequence;
        pendingVoiceRequest = requestId;
        setVoiceButtonState(true);
        let stream = null;
        let session = null;

        try {
            // Keep the user activation from the button click while explicitly requesting microphone access.
            stream = await getUserMedia({ audio: true });
            if (pendingVoiceRequest !== requestId) {
                stopMediaStream(stream);
                return null;
            }

            const recognition = new Recognition();
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
            let finalTranscript = '';
            recognition.lang = navigator.language || 'zh-CN';
            recognition.interimResults = true;
            recognition.continuous = false;
            recognition.onresult = event => {
                let interimTranscript = '';
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    const transcript = String(event.results[index]?.[0]?.transcript || '');
                    if (event.results[index].isFinal) finalTranscript += transcript;
                    else interimTranscript += transcript;
                }
                const prefix = original ? `${original}${/[\s。！？!?]$/.test(original) ? '' : ' '}` : '';
                input.value = `${prefix}${finalTranscript || interimTranscript}`.trim();
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            recognition.onerror = event => {
                const shouldReport = activeVoiceSession === session;
                releaseVoiceSession(session);
                if (shouldReport && !['aborted', 'no-speech'].includes(String(event.error || '').toLowerCase())) {
                    showToast(voiceInputErrorMessage(event), 'error');
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
                showToast(voiceInputErrorMessage(error), 'error');
            }
            return null;
        }
    }

    document.getElementById('chat-memory-intent-close')?.addEventListener('click', closeMemoryIntentModal);
    document.getElementById('chat-memory-intent-preview-btn')?.addEventListener('click', () => previewMemoryIntent().catch(error => showToast(error.message || '无法预览记忆操作', 'error')));
    document.getElementById('chat-memory-intent-apply')?.addEventListener('click', () => applyMemoryIntent().catch(error => showToast(error.message || '记忆操作失败', 'error')));
    document.getElementById('chat-memory-intent-modal')?.addEventListener('click', event => { if (event.target.id === 'chat-memory-intent-modal') closeMemoryIntentModal(); });
    globalThis.addEventListener('pagehide', stopChatVoiceInput, { capture: true });
    globalThis.addEventListener('beforeunload', stopChatVoiceInput, { capture: true });

    window.Pivot?.exposeModule?.('chat.memoryActions', { applyMemoryIntent, closeMemoryIntentModal, openChatMemoryManagement, openMemoryIntentModal, previewMemoryIntent, rememberCurrentChatInput, setChatMemoryMenuOpen, startChatVoiceInput, stopChatVoiceInput });
})();
