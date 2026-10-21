'use strict';

// 增量帧直接追加；结束帧的完整快照仅补齐尚未收到的后缀，不能再次当增量发送。
function createStreamTextReconciler() {
    let output = '';
    let reasoning = '';

    function ingest(frame, extracted = {}) {
        const choice = Array.isArray(frame?.choices) ? frame.choices[0] : null;
        const delta = choice?.delta;
        const hasTextDelta = delta && (delta.content !== undefined || delta.reasoning_content !== undefined || delta.reasoning !== undefined);
        const snapshot = frame?.type === 'response.completed' || Boolean(choice?.message && !hasTextDelta);
        const isThought = extracted.isThought === true;
        let text = typeof extracted.delta === 'string' ? extracted.delta : '';
        const previous = isThought ? reasoning : output;
        if (snapshot && previous) {
            // 不一致的结束快照不能拼到已发送内容后，也不按字面删改正常增量中的重复表达。
            text = text.startsWith(previous) ? text.slice(previous.length) : '';
        }
        if (isThought) reasoning += text;
        else output += text;
        return { ...extracted, delta: text };
    }

    return { ingest };
}

module.exports = { createStreamTextReconciler };
