/* 内存 PCM 编码；录音不写浏览器存储。 */
(function () {
    function encodeWave(chunks, sampleRate) {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const input = new Float32Array(length);
        let offset = 0;
        for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
        const ratio = sampleRate / 16000;
        const count = Math.min(320000, Math.floor(length / ratio));
        const data = new Uint8Array(44 + count * 2);
        const view = new DataView(data.buffer);
        const label = (start, value) => { for (let index = 0; index < value.length; index++) data[start + index] = value.charCodeAt(index); };
        label(0, 'RIFF'); view.setUint32(4, data.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
        view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, count * 2, true);
        for (let index = 0; index < count; index++) {
            const start = Math.floor(index * ratio);
            const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
            let sample = 0;
            for (let next = start; next < Math.min(end, length); next++) sample += input[next];
            sample = Math.max(-1, Math.min(1, sample / (end - start)));
            view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        }
        input.fill(0);
        let binary = '';
        for (let start = 0; start < data.length; start += 8192) binary += String.fromCharCode(...data.subarray(start, start + 8192));
        data.fill(0);
        return globalThis.btoa(binary);
    }
    window.Pivot?.exposeModule?.('chat.voiceAudio', { encodeWave });
}());
