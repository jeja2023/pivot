// 公文正文流不转发思考块。跨网络块保留未完成标签，避免标签被拆开后漏出或吞掉正文。
function createOfficialWritingTextFilter() {
    let buffer = '', dropping = false;
    function push(chunk = '') {
        buffer += String(chunk || '');
        let visible = '';
        while (buffer) {
            if (dropping) {
                const close = /<\/think\s*>/i.exec(buffer);
                if (!close) { buffer = buffer.slice(-32); break; }
                buffer = buffer.slice(close.index + close[0].length);
                dropping = false;
            } else {
                const open = /<think\b[^>]*>/i.exec(buffer);
                if (open) {
                    visible += buffer.slice(0, open.index);
                    buffer = buffer.slice(open.index + open[0].length);
                    dropping = true;
                    continue;
                }
                const lastTag = buffer.lastIndexOf('<');
                if (lastTag !== -1 && /^<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?(?:\s[^>]*)?$/i.test(buffer.slice(lastTag))) {
                    visible += buffer.slice(0, lastTag);
                    buffer = buffer.slice(lastTag);
                    break;
                }
                visible += buffer; buffer = '';
            }
        }
        return visible;
    }
    return { push, finish() { const tail = dropping || /^<t/i.test(buffer) ? '' : buffer; buffer = ''; return tail; } };
}

module.exports = { createOfficialWritingTextFilter };
