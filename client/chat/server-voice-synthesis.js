(function () {
    /* global Audio */
    let playback = null;
    async function capabilities() {
        const response = await apiFetch(`${API_BASE}/chat/voice-synthesis`);
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || '统一朗读服务不可用。'), { voiceMessage: data.error || '统一朗读服务不可用。' });
        return data;
    }
    function cancel() {
        if (!playback) return;
        playback.controller.abort(); playback.audio?.pause();
        if (playback.url) URL.revokeObjectURL(playback.url);
        playback = null;
    }
    async function speak(text, { onstart, onend, onerror } = {}) {
        cancel();
        const current = { controller: new AbortController(), audio: null, url: null }; playback = current;
        try {
            const response = await apiFetch(`${API_BASE}/chat/voice-synthesis`, { method: 'POST', signal: current.controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
            if (!response.ok) throw new Error('统一朗读合成失败。');
            const blob = await response.blob(); if (playback !== current) return;
            if (blob.size > 9 * 1024 * 1024 || !blob.type.startsWith('audio/wav')) throw new Error('朗读音频格式或大小不符合限制。');
            current.url = URL.createObjectURL(blob); current.audio = new Audio(current.url);
            current.audio.onended = () => { if (playback === current) { cancel(); onend?.(); } };
            current.audio.onerror = () => { if (playback === current) { cancel(); onerror?.(); } };
            await current.audio.play(); if (playback === current) onstart?.();
        } catch (error) { if (playback === current && !current.controller.signal.aborted) { cancel(); onerror?.(error); } }
    }
    window.Pivot.exposeModule('chat.serverVoiceSynthesis', { capabilities, speak, cancel });
}());
