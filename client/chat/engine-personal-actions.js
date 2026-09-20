/* 聊天中的显式记忆与浏览器语音输入；不进入消息发送主循环。 */
/* global API_BASE, apiFetch, currentSessionId, showToast */
(function () {
    let activeSpeechRecognition = null;
    let memoryIntentPreview = null;

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

    function startChatVoiceInput() {
        const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
        const button = document.getElementById('chat-voice-input');
        const input = document.getElementById('user-input');
        if (!Recognition) { showToast('当前浏览器未提供本地语音转写接口；可改用支持 Web Speech 的浏览器。', 'warning'); return null; }
        if (!input) return null;
        if (activeSpeechRecognition) { activeSpeechRecognition.stop(); return null; }
        const original = String(input.value || '').trim();
        const recognition = new Recognition();
        recognition.lang = navigator.language || 'zh-CN';
        recognition.interimResults = true;
        recognition.continuous = false;
        let finalTranscript = '';
        const stop = () => {
            if (activeSpeechRecognition !== recognition) return;
            activeSpeechRecognition = null;
            button?.setAttribute('aria-pressed', 'false');
            button?.classList.remove('is-recording');
            button?.removeAttribute('aria-busy');
        };
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
        recognition.onerror = event => { if (!['aborted', 'no-speech'].includes(String(event.error || ''))) showToast(`语音输入失败：${event.error || '浏览器拒绝访问麦克风'}`, 'error'); };
        recognition.onend = stop;
        activeSpeechRecognition = recognition;
        button?.setAttribute('aria-pressed', 'true');
        button?.setAttribute('aria-busy', 'true');
        button?.classList.add('is-recording');
        try { recognition.start(); } catch (error) { stop(); showToast(error.message || '无法启动语音输入。', 'error'); }
        return recognition;
    }

    document.getElementById('chat-memory-intent-close')?.addEventListener('click', closeMemoryIntentModal);
    document.getElementById('chat-memory-intent-preview-btn')?.addEventListener('click', () => previewMemoryIntent().catch(error => showToast(error.message || '无法预览记忆操作', 'error')));
    document.getElementById('chat-memory-intent-apply')?.addEventListener('click', () => applyMemoryIntent().catch(error => showToast(error.message || '记忆操作失败', 'error')));
    document.getElementById('chat-memory-intent-modal')?.addEventListener('click', event => { if (event.target.id === 'chat-memory-intent-modal') closeMemoryIntentModal(); });

    window.Pivot?.exposeModule?.('chat.memoryActions', { applyMemoryIntent, closeMemoryIntentModal, openChatMemoryManagement, openMemoryIntentModal, previewMemoryIntent, rememberCurrentChatInput, setChatMemoryMenuOpen, startChatVoiceInput });
})();
