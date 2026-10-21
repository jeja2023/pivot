'use strict';
const { speechError } = require('./audio');

function createSpeechCapacity() {
    const active = new Set();
    return {
        claim(userId, limit) {
            const key = String(userId);
            if (active.has(key) || active.size >= limit) throw speechError('语音识别正在处理，请稍后重试。', 'VOICE_BUSY', 429);
            active.add(key);
            let released = false;
            return () => { if (!released) { released = true; active.delete(key); } };
        }
    };
}
const speechCapacity = createSpeechCapacity();
module.exports = { speechCapacity };
