/* 语音转写拼接、朗读分段与回声比对；不改写用户识别内容。 */
(function () {
    function comparableText(value) {
        return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    }

    function joinTranscript(left, right) {
        const before = String(left || '');
        const after = String(right || '');
        if (!before || !after) return before + after;
        const space = /[a-z0-9]$/i.test(before) && /^[a-z0-9]/i.test(after) ? ' ' : '';
        return before + space + after;
    }

    function speechSegments(value, limit = 120) {
        let remaining = String(value || '');
        const parts = [];
        while (remaining.length) {
            let end = Math.min(limit, remaining.length);
            if (end < remaining.length) {
                const candidate = remaining.slice(0, end);
                const boundaries = [...candidate.matchAll(/[。！？!?；;，,、：:\n\s]/gu)];
                const boundary = boundaries.filter(item => item.index >= limit / 3).at(-1);
                if (boundary) end = boundary.index + boundary[0].length;
                // 不把辅助平面的字符拆成两个无效代理项。
                if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--;
            }
            parts.push(remaining.slice(0, end));
            remaining = remaining.slice(end);
        }
        return parts;
    }

    function isPlaybackEcho(transcript, playbackTexts = []) {
        const heard = comparableText(transcript).slice(0, 500);
        if (!heard) return true;
        const played = comparableText(playbackTexts.join('')).slice(-8000);
        if (!played) return false;
        if (played.includes(heard)) return true;
        if (heard.length < 5) return false;
        const correction = heard.match(/不对|不是|不要|不用|不需要|等一下|暂停|停止|退出|我说|我问|纠正|改成|换个/u)?.[0];
        if (correction && !played.includes(correction)) return false;
        // 对齐到朗读内容的任意片段，容忍少量同音错字、漏字与重复字。
        const allowance = Math.max(1, Math.floor(heard.length * 0.2));
        let previous = new Uint16Array(played.length + 1);
        for (let row = 1; row <= heard.length; row++) {
            const next = new Uint16Array(played.length + 1);
            next[0] = row;
            for (let column = 1; column <= played.length; column++) {
                next[column] = Math.min(previous[column] + 1, next[column - 1] + 1,
                    previous[column - 1] + (heard[row - 1] === played[column - 1] ? 0 : 1));
            }
            previous = next;
        }
        return previous.some(distance => {
            return distance <= allowance;
        });
    }

    function isExitCommand(transcript) {
        return /^(?:请|请帮我|帮我|我要|我想)?(?:退出|退出语音|退出实时语音|结束语音|结束实时语音|关闭语音|关闭实时语音|停止语音|停止实时语音)(?:吧|了|谢谢)?$/u.test(comparableText(transcript));
    }

    const api = { comparableText, isExitCommand, isPlaybackEcho, joinTranscript, speechSegments };
    if (typeof window !== 'undefined') window.Pivot?.exposeModule?.('chat.voiceText', api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
