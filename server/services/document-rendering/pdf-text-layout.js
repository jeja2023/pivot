/**
 * server/services/document-rendering/pdf-text-layout.js
 * PDF 渲染的页面几何与中英文混排折行计算
 *
 * 落地方案 v1.2 §7.2、§10.2：
 * 1. pdf-lib 只提供「在坐标 (x, y) 画一段文本」，段落折行、页面几何与对齐必须自己算；
 * 2. 折行规则按中文排版处理：CJK 逐字可断行，ASCII 单词整体不可断，并实现基本的
 *    行首行尾禁则（避头尾），避免出现「行首逗号」这类明显的排版缺陷；
 * 3. 所有计算只依赖字体度量与入参，不引入时间、随机数等非确定因素，保证渲染幂等。
 */

/** 毫米转磅（1 英寸 = 25.4 毫米 = 72 磅）。 */
const MM_TO_PT = 72 / 25.4;

/** 纸张尺寸（纵向，单位磅）。横向由 resolvePageBox 交换宽高。 */
const PAGE_SIZE_PT = Object.freeze({
    A4: Object.freeze({ width: 595.28, height: 841.89 }),
    A3: Object.freeze({ width: 841.89, height: 1190.55 }),
    Letter: Object.freeze({ width: 612, height: 792 })
});

/**
 * CJK 与全角字符区间：这些字符逐字可断行。
 * 覆盖中日韩统一表意文字、扩展 A、兼容表意文字、假名、韩文以及全角标点。
 */
const CJK_PATTERN = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3ffff}]/u;

/** 行首禁则：这些字符不能出现在行首，折行点必须往前挪。 */
const NO_LINE_START = new Set(Array.from('，。、；：？！）］｝〉》」』】〕…‰％℃”’·ˉ,.;:?!)]}%'));

/** 行尾禁则：这些字符不能出现在行尾，必须与后一个字符同行。 */
const NO_LINE_END = new Set(Array.from('（［｛〈《「『【〔“‘([{'));

/** 空白与制表符按一个可断空白 token 处理。 */
const SPACE_PATTERN = /[ \t\u3000]/;

function mmToPt(mm) {
    const value = Number(mm);
    return Number.isFinite(value) ? value * MM_TO_PT : 0;
}

function isCjkChar(char) {
    return CJK_PATTERN.test(char);
}

/** 由 IR 的 meta.page 计算页面几何（单位磅）。规范化后的 IR 保证字段存在。 */
function resolvePageBox(page) {
    const size = PAGE_SIZE_PT[String(page?.size || 'A4')] || PAGE_SIZE_PT.A4;
    const landscape = String(page?.orientation || 'portrait') === 'landscape';
    const width = landscape ? size.height : size.width;
    const height = landscape ? size.width : size.height;
    const source = page?.margin_mm || {};
    const margin = {
        top: mmToPt(source.top),
        bottom: mmToPt(source.bottom),
        left: mmToPt(source.left),
        right: mmToPt(source.right)
    };
    const contentWidth = Math.max(width - margin.left - margin.right, 1);
    const contentHeight = Math.max(height - margin.top - margin.bottom, 1);
    return {
        width,
        height,
        margin,
        contentWidth,
        contentHeight,
        contentLeft: margin.left,
        contentRight: margin.left + contentWidth,
        contentTop: height - margin.top,
        contentBottom: margin.bottom
    };
}

/**
 * 字体度量缓存。
 * fontkit 的 layout() 开销不低，逐字测量会成为长文档的热点，因此按「字号 + 文本」缓存。
 * 缓存只影响性能，不影响结果，超过容量直接清空即可。
 */
const MAX_MEASURE_CACHE = 50000;

function createTextMeasurer(font) {
    const widthCache = new Map();
    const ascentCache = new Map();
    const heightCache = new Map();
    return {
        widthOf(text, size) {
            if (!text) return 0;
            const key = `${size}\u0000${text}`;
            const cached = widthCache.get(key);
            if (cached !== undefined) return cached;
            const width = font.widthOfTextAtSize(text, size);
            if (widthCache.size >= MAX_MEASURE_CACHE) widthCache.clear();
            widthCache.set(key, width);
            return width;
        },
        ascentOf(size) {
            const cached = ascentCache.get(size);
            if (cached !== undefined) return cached;
            const ascent = font.heightAtSize(size, { descender: false });
            ascentCache.set(size, ascent);
            return ascent;
        },
        heightOf(size) {
            const cached = heightCache.get(size);
            if (cached !== undefined) return cached;
            const height = font.heightAtSize(size);
            heightCache.set(size, height);
            return height;
        }
    };
}

function makeToken(text, kind, style, measurer) {
    const first = text[0] || '';
    const last = text[text.length - 1] || '';
    return {
        text,
        kind,
        style,
        width: measurer.widthOf(text, style.size),
        breakBefore: !NO_LINE_START.has(first),
        breakAfter: !NO_LINE_END.has(last)
    };
}

/**
 * 把若干带样式的文本片段切成折行用的 token 序列。
 * CJK 单字成 token（逐字可断），连续的非 CJK 非空白字符聚成一个词 token（整体不可断），
 * 连续空白聚成一个空白 token（可断且行首丢弃），换行符单独成 token。
 */
function buildInlineTokens(segments, measurer) {
    const tokens = [];
    (segments || []).forEach(segment => {
        const style = segment.style;
        const chars = Array.from(String(segment.text ?? ''));
        let word = '';
        let space = '';
        const flushWord = () => {
            if (!word) return;
            tokens.push(makeToken(word, 'word', style, measurer));
            word = '';
        };
        const flushSpace = () => {
            if (!space) return;
            tokens.push(makeToken(space, 'space', style, measurer));
            space = '';
        };
        chars.forEach(char => {
            if (char === '\n') {
                flushWord();
                flushSpace();
                tokens.push({ text: '', kind: 'newline', style, width: 0, breakBefore: true, breakAfter: true });
                return;
            }
            if (char === '\r') return;
            if (SPACE_PATTERN.test(char)) {
                flushWord();
                space += char;
                return;
            }
            flushSpace();
            if (isCjkChar(char)) {
                flushWord();
                tokens.push(makeToken(char, 'cjk', style, measurer));
                return;
            }
            word += char;
        });
        flushWord();
        flushSpace();
    });
    return tokens;
}

/** 把超长 token（如无空白的长英文串）按字符硬断成能放进当前行宽的两段。 */
function splitOversizedToken(token, limit, measurer) {
    const chars = Array.from(token.text);
    if (chars.length <= 1) return null;
    let head = '';
    for (let index = 0; index < chars.length; index += 1) {
        const candidate = head + chars[index];
        if (measurer.widthOf(candidate, token.style.size) > limit && head) break;
        head = candidate;
    }
    if (!head || head.length >= token.text.length) return null;
    const tail = token.text.slice(head.length);
    return [
        makeToken(head, token.kind, token.style, measurer),
        makeToken(tail, token.kind, token.style, measurer)
    ];
}

/**
 * 折行。返回 [{ tokens, width, indent, forced }]，forced 表示该行由换行符结束。
 * 入参 options：measurer 为字体度量器，maxWidth 为版心宽度，indentPt 为首行缩进。
 */
function wrapTokens(tokens, options) {
    const measurer = options.measurer;
    const maxWidth = Math.max(Number(options.maxWidth) || 0, 1);
    const indentPt = Math.max(Number(options.indentPt) || 0, 0);
    const lines = [];
    let current = [];
    let currentWidth = 0;
    const extra = [];
    let cursor = 0;

    const limitFor = () => (lines.length === 0 ? Math.max(maxWidth - indentPt, 1) : maxWidth);
    const flush = force => {
        const kept = current.slice();
        while (kept.length && kept[kept.length - 1].kind === 'space') kept.pop();
        if (!kept.length && !force) {
            current = [];
            currentWidth = 0;
            return;
        }
        lines.push({
            tokens: kept,
            width: kept.reduce((sum, token) => sum + token.width, 0),
            indent: lines.length === 0 ? indentPt : 0,
            forced: Boolean(force)
        });
        current = [];
        currentWidth = 0;
    };
    // 找可断点：返回把 current[index..] 挪到下一行的下标，0 表示无处可断。
    const findBreakIndex = incoming => {
        for (let index = current.length; index >= 1; index -= 1) {
            const left = current[index - 1];
            const right = index === current.length ? incoming : current[index];
            if (left.breakAfter && right.breakBefore) return index;
        }
        return 0;
    };
    const nextToken = () => {
        if (extra.length) return extra.shift();
        if (cursor < tokens.length) {
            const token = tokens[cursor];
            cursor += 1;
            return token;
        }
        return null;
    };

    let token = nextToken();
    while (token) {
        if (token.kind === 'newline') {
            flush(true);
            token = nextToken();
            continue;
        }
        if (!current.length && token.kind === 'space') {
            token = nextToken();
            continue;
        }
        const limit = limitFor();
        if (currentWidth + token.width <= limit) {
            current.push(token);
            currentWidth += token.width;
            token = nextToken();
            continue;
        }
        if (!current.length) {
            const pieces = splitOversizedToken(token, limit, measurer);
            if (pieces) {
                extra.unshift(pieces[0], pieces[1]);
                token = nextToken();
                continue;
            }
            // 单个字符就比一行还宽（字号大于版心宽度），只能溢出绘制，避免死循环。
            current.push(token);
            currentWidth += token.width;
            flush(false);
            token = nextToken();
            continue;
        }
        const breakIndex = findBreakIndex(token);
        if (!breakIndex) {
            // 禁则无法满足时按溢出处理：宁可略微超出版心，也不把标点甩到行首。
            current.push(token);
            currentWidth += token.width;
            token = nextToken();
            continue;
        }
        const moved = current.slice(breakIndex);
        current = current.slice(0, breakIndex);
        currentWidth = current.reduce((sum, item) => sum + item.width, 0);
        flush(false);
        extra.unshift(...moved, token);
        token = nextToken();
    }
    flush(false);
    return lines;
}

/** 行内最大字号。混排行的行高与基线按最大字号计算，避免大字号被上一行压住。 */
function maxSizeOfLine(line, fallbackSize) {
    return line.tokens.reduce((max, token) => Math.max(max, token.style.size), 0) || fallbackSize;
}

/** 相邻同样式 token 合并为一个绘制段，减少 PDF 文本算子数量。 */
function groupSameStyle(tokens) {
    const groups = [];
    tokens.forEach(token => {
        const last = groups[groups.length - 1];
        if (last && last.style === token.style) {
            last.text += token.text;
            last.width += token.width;
            return;
        }
        groups.push({ text: token.text, style: token.style, width: token.width, gapBefore: 0 });
    });
    return groups;
}

/** 两端对齐用：以空白 token 为分隔切段，空白宽度变成段间可拉伸的间隙。 */
function groupForJustify(tokens) {
    const groups = [];
    let pendingGap = 0;
    let stretchable = 0;
    tokens.forEach(token => {
        if (token.kind === 'space') {
            pendingGap += token.width;
            return;
        }
        const last = groups[groups.length - 1];
        if (last && last.style === token.style && !pendingGap) {
            last.text += token.text;
            last.width += token.width;
            return;
        }
        if (pendingGap && groups.length) stretchable += 1;
        groups.push({ text: token.text, style: token.style, width: token.width, gapBefore: pendingGap });
        pendingGap = 0;
    });
    return { groups, stretchable };
}

/**
 * 计算一行内各绘制段的横向位置。返回 [{ text, style, x }]，x 是相对版心左边界的偏移。
 * pdf-lib 未暴露字符间距（Tc）算子，两端对齐只能在文本段之间分配余量；
 * 整行没有可拉伸间隙时（例如纯中文行）回退为左对齐，不做逐字绘制以免文本流被打碎。
 */
function composeLineSegments(line, options) {
    const align = String(options.align || 'left');
    const indent = line.indent || 0;
    const usableWidth = Math.max(Number(options.maxWidth) - indent, 1);
    if (align === 'justify' && !options.isLastLine && !line.forced) {
        const { groups, stretchable } = groupForJustify(line.tokens);
        if (stretchable > 0) {
            const used = groups.reduce((sum, group) => sum + group.width + group.gapBefore, 0);
            const share = Math.max(usableWidth - used, 0) / stretchable;
            let cursor = indent;
            return groups.map((group, index) => {
                cursor += group.gapBefore + (index > 0 && group.gapBefore ? share : 0);
                const item = { text: group.text, style: group.style, x: cursor, width: group.width };
                cursor += group.width;
                return item;
            });
        }
    }
    const groups = groupSameStyle(line.tokens);
    const total = groups.reduce((sum, group) => sum + group.width, 0);
    let cursor = indent;
    if (align === 'center') cursor += Math.max(usableWidth - total, 0) / 2;
    else if (align === 'right') cursor += Math.max(usableWidth - total, 0);
    return groups.map(group => {
        const item = { text: group.text, style: group.style, x: cursor, width: group.width };
        cursor += group.width;
        return item;
    });
}

module.exports = {
    CJK_PATTERN,
    MM_TO_PT,
    NO_LINE_END,
    NO_LINE_START,
    PAGE_SIZE_PT,
    buildInlineTokens,
    composeLineSegments,
    createTextMeasurer,
    isCjkChar,
    maxSizeOfLine,
    mmToPt,
    resolvePageBox,
    wrapTokens
};
