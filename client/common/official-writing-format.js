// 用户截图规定的公文版式。浏览器、DOCX、PDF 共享尺寸、字体和层级识别，禁止各自猜测。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Pivot.exposeModule('apps.officialWritingFormat', api);
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const ID = 'screenshot-20261104';
    const PAGE = Object.freeze({ size: 'A4', orientation: 'portrait', margin_mm: Object.freeze({ top: 37, bottom: 35, left: 27, right: 27 }) });
    const HEADER_MM = 15, FOOTER_MM = 30, BODY_PT = 16, TITLE_PT = 22, FOOTER_PT = 14, LINE_PT = 28;
    const COLUMNS = 28, LINES = 22;
    const GAP_LINES = Object.freeze({ afterTitle: 1, beforeAttachment: 1, beforeSignature: 3 });
    const CHAR_PITCH_PT = (210 - 54) / 25.4 * 72 / COLUMNS;
    const FONT = Object.freeze({ title: '方正小标宋_GBK', body: '方正仿宋_GBK', heading1: '方正黑体_GBK', heading2: '方正楷体_GBK', footer: '宋体', ascii: 'Times New Roman' });
    const ALIASES = Object.freeze({
        title: ['方正小标宋_GBK', '方正小标宋GBK', 'FZXiaoBiaoSong-B05', 'FZXBSK--GBK1-0'],
        body: ['方正仿宋_GBK', '方正仿宋GBK', 'FZFangSong-Z02', 'FZFSK--GBK1-0'],
        heading1: ['方正黑体_GBK', '方正黑体GBK', 'FZHei-B01', 'FZHTK--GBK1-0'],
        heading2: ['方正楷体_GBK', '方正楷体GBK', 'FZKai-Z03', 'FZKTK--GBK1-0'],
        footer: ['宋体', 'SimSun'], ascii: ['Times New Roman', 'TimesNewRomanPSMT']
    });
    function headingLevel(text) {
        const value = String(text || '').trim();
        if (/^[一二三四五六七八九十百]+[、．.]/.test(value)) return 1;
        if (/^[（(][一二三四五六七八九十百]+[）)]/.test(value)) return 2;
        if (/^\d+[.．、]/.test(value)) return 3;
        if (/^[（(]\d+[）)]/.test(value)) return 4;
        return 0;
    }
    function normalizeHeading(text, level = headingLevel(text)) {
        const value = String(text || '').trim();
        if (level === 1) return value.replace(/^([一二三四五六七八九十百]+)[、．.]\s*/, '$1、');
        if (level === 2) return value.replace(/^[（(]([一二三四五六七八九十百]+)[）)]\s*/, '（$1）');
        if (level === 3) return value.replace(/^(\d+)[.．、]\s*/, '$1. ');
        if (level === 4) return value.replace(/^[（(](\d+)[）)]\s*/, '（$1）');
        return value;
    }
    function splitScripts(text) {
        const pieces = String(text || '').match(/[\x20-\x7e]+|[^\x20-\x7e]+/g) || [];
        return pieces.map(value => ({ text: value, ascii: /^[\x20-\x7e]+$/.test(value) }));
    }
    function units(text) { return Array.from(String(text || '')).reduce((sum, char) => sum + (/^[\x20-\x7e]$/.test(char) ? 0.5 : 1), 0); }
    function arrangeTitle(text) {
        const value = String(text || '').trim();
        if (!value) return [];
        const explicit = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const capacity = Math.floor(CHAR_PITCH_PT * COLUMNS / TITLE_PT);
        if (explicit.length > 1) {
            if (explicit.some(line => units(line) > capacity)) throw Object.assign(new Error('标题分行过长，请按词意调整换行，使每行不超过版心宽度'), { status: 422 });
            return explicit;
        }
        if (units(value) <= capacity) return [value];
        // 以词边界为候选，优先选语义连接处，再平衡梯形或菱形的行长。
        const tokens = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(value)].map(item => item.segment) : Array.from(value);
        let lineCount = Math.max(2, Math.ceil(units(value) / capacity));
        const weights = count => count === 2 ? [0.46, 0.54] : count === 3 ? [0.29, 0.42, 0.29]
            : Array.from({ length: count }, (_, index) => 0.7 + Math.sin(Math.PI * (index + 0.5) / count));
        let lengths;
        do {
            const selected = weights(lineCount), total = selected.reduce((sum, item) => sum + item, 0);
            lengths = selected.map(item => item / total);
            if (Math.max(...lengths) * units(value) <= capacity) break;
            lineCount++;
        } while (lineCount < 20);
        const lines = []; let cursor = 0;
        const protectedWords = ['专项', '督导', '反馈', '汇总', '编制', '实施', '方案', '办法', '管理', '监督', '安排', '协调', '贯彻', '落实'];
        const insideWord = boundary => protectedWords.some(word => {
            let position = value.indexOf(word);
            while (position !== -1) {
                if (position < boundary && boundary < position + word.length) return true;
                position = value.indexOf(word, position + word.length);
            }
            return false;
        });
        for (let row = 0; row < lineCount - 1; row++) {
            let best = null, content = '';
            const target = units(value) * lengths[row];
            for (let index = cursor; index < tokens.length - 1; index++) {
                content += tokens[index];
                const width = units(content);
                if (width > capacity) break;
                const remaining = tokens.slice(index + 1).join('');
                if (insideWord(tokens.slice(0, index + 1).join('').length)) continue;
                if (units(remaining) > capacity * (lineCount - row - 1)) continue;
                if (lineCount === 2 && Math.min(width, units(remaining)) < units(value) * 0.38) continue;
                if (/^[，。；、：）]/.test(remaining) || /[（《“]$/.test(content)) continue;
                const semantic = /^[和与及、]/.test(remaining) ? -5
                    : /^(关于|的|通知|意见|报告|请示|方案|办法)/.test(remaining) || /关于$/.test(content) ? -1.5 : 0;
                const equalRows = lineCount === 2 && Math.abs(width - units(remaining)) < 0.5 ? 2 : 0;
                const score = Math.abs(width - target) + semantic + equalRows;
                if (!best || score < best.score) best = { end: index + 1, content, score };
            }
            if (!best) break;
            lines.push(best.content); cursor = best.end;
        }
        lines.push(tokens.slice(cursor).join(''));
        if (lines.some(line => units(line) > capacity)) throw Object.assign(new Error('标题存在超出一行宽度的词语，请手动按词意调整标题分行'), { status: 422 });
        return lines;
    }
    function attachmentNotes(attachments) {
        const list = Array.isArray(attachments) ? attachments : [];
        return list.map((attachment, index) => {
            const name = String(attachment.name || '').trim().replace(/[。；;，,：:！？!?]+$/, '');
            const label = list.length > 1 ? `${index + 1}. ` : '';
            const prefix = `${index ? '　　　' : '附件：'}${label}`;
            return { text: `${prefix}${name}`, prefix, index: index + 1, name };
        });
    }
    return { ID, PAGE, HEADER_MM, FOOTER_MM, BODY_PT, TITLE_PT, FOOTER_PT, LINE_PT, COLUMNS, LINES, GAP_LINES, CHAR_PITCH_PT, FONT, ALIASES, headingLevel, normalizeHeading, splitScripts, units, arrangeTitle, attachmentNotes };
});
