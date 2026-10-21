/* 中文正文中的强调边界兼容；代码、转义和链接地址继续由 Markdown 词法分析器处理。 */
(() => {
    const nativeEmStrong = marked.Tokenizer.prototype.emStrong;
    const cjkText = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const emphasisStart = /\*{2,3}|_{2,3}|[*_](?=$|[“‘「『《（【\p{Script=Han}])/u;

    function createEmphasisToken(tokenizer, raw, text, width) {
        const tokens = tokenizer.lexer.inlineTokens(text);
        if (width === 3) {
            return { type: 'em', raw, text, tokens: [{ type: 'strong', raw: text, text, tokens }] };
        }
        return { type: width === 2 ? 'strong' : 'em', raw, text, tokens };
    }

    function relaxedEmphasis(src, maskedSrc, previousCharacter, standard) {
        const opening = /^(\*{1,3}|_{1,3})(?![*_])/.exec(src);
        if (!opening) return;
        const delimiter = opening[1];
        const width = delimiter.length;
        // maskedSrc 已遮蔽代码、转义字符和链接地址，避免把这些内容里的标记当作闭合符。
        const masked = maskedSrc.slice(-src.length);
        let closing = masked.indexOf(delimiter, width);
        while (closing !== -1) {
            if (masked[closing - 1] !== delimiter[0] && masked[closing + width] !== delimiter[0]) {
                const inner = src.slice(width, closing);
                const text = inner.trim();
                const hasCjkText = cjkText.test(text);
                const paddedText = width >= 2 && inner !== text && /\p{L}{2}/u.test(text);
                const insideIdentifier = /[\p{L}\p{N}]/u.test(previousCharacter || '')
                    || /^[\p{L}\p{N}]/u.test(src.slice(closing + width));
                const raw = src.slice(0, closing + width);
                if (standard && standard.raw.length <= raw.length) return;
                // 普通算式中的乘方符整体保留，避免其后一段中文被误认为新的强调范围。
                if (delimiter === '**' && inner !== text && /^[\d. +*/^=()-]+$/.test(text)
                    && /\d[ \t]+$/.test(maskedSrc.slice(0, -src.length))) {
                    return { type: 'text', raw, text: raw };
                }
                if (text && !/\n[ \t]*\n/.test(inner) && (hasCjkText || (paddedText && !insideIdentifier))) {
                    return createEmphasisToken(this, raw, text, width);
                }
                // 最近一组成对标记不属于正文强调时，不能越过它把后续中文吞入同一范围。
                return;
            }
            closing = masked.indexOf(delimiter, closing + width);
        }

        // 助手正文漏写闭合符时按当前段落恢复；流式渲染仍始终使用完整原始消息。
        // 普通 Markdown 调用只临时修正流式末尾，显式转义和代码不进入此分支。
        const streamingTail = this.options.pivotStreamingTail?.endsWith(src.trimEnd());
        const recoverAssistant = this.options.pivotRecoverEmphasis;
        if (!streamingTail && !recoverAssistant) return;
        const remaining = src.slice(width);
        const pendingMarker = streamingTail || (recoverAssistant && width >= 2 && cjkText.test(previousCharacter || ''));
        if (pendingMarker && !remaining && (!previousCharacter || /[\s\p{P}\p{Script=Han}]/u.test(previousCharacter))) {
            return { type: 'text', raw: src, text: '', escaped: true };
        }
        if (width < 2 || !remaining || /^\s/.test(remaining)) return;
        if (!/\p{L}/u.test(remaining) && !/^[“‘「『《（【]+$/.test(remaining)) return;
        if (/[a-z0-9]/i.test(previousCharacter || '') && !cjkText.test(remaining)) return;
        const text = remaining.replace(new RegExp(`\\${delimiter[0]}{1,${width - 1}}$`), '');
        if (text) return createEmphasisToken(this, src, text, width);
    }

    marked.use({
        tokenizer: {
            emStrong(src, maskedSrc, previousCharacter) {
                if (src[0] !== '*' && src[0] !== '_') return;
                // 数学公式扩展在稍后才解析，先遮蔽公式中的乘方等标记，保持强调边界完整。
                const masked = maskedSrc.replace(/\$(?:\\\$|[^$\n])+?\$/g, value => 'a'.repeat(value.length));
                const standard = nativeEmStrong.call(this, src, masked, previousCharacter);
                const relaxed = relaxedEmphasis.call(this, src, masked, previousCharacter, standard);
                // 两端多空格可能让原生解析跨越下一个加粗片段；优先使用最近的明确闭合符。
                return relaxed && (!standard || relaxed.raw.length < standard.raw.length) ? relaxed : standard || relaxed;
            }
        },
        extensions: [{
            name: 'cjkEmphasisBoundary',
            level: 'inline',
            start(src) { return src.search(emphasisStart); },
            tokenizer() { return undefined; }
        }]
    });
})();
