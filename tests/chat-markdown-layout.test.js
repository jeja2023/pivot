/* global window, document, getComputedStyle -- 浏览器验证上下文 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function createPage(width = 390, colorScheme = 'light') {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce' });
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main><div id="message-container" class="message-container"></div></main></body></html>');
    for (const file of ['client/common/styles/theme.css', 'client/chat/chat.shell.css', 'client/common/vendor/katex.min.css']) {
        await page.addStyleTag({ path: path.resolve(__dirname, '..', file) });
    }
    for (const file of [
        'client/common/vendor/marked.min.js', 'client/common/vendor/purify.min.js', 'client/common/vendor/katex.min.js',
        'client/chat/pivot-core.js', 'client/chat/safe-html.js', 'client/chat/render-markdown-emphasis.js',
        'client/chat/render.js', 'client/chat/render-charts.js', 'client/chat/render-messages.js', 'client/chat/engine-streaming.js'
    ]) {
        await page.addScriptTag({ path: path.resolve(__dirname, '..', file) });
    }
    return page;
}

async function appendReply(page, content, role = 'assistant') {
    await page.evaluate(({ content, role }) => {
        window.appendMessage(role, content, 1, {
            modelName: 'Qwen3.6-' + '长模型名称-reasoning-'.repeat(20),
            costTime: 1234.5, tokenCount: 123456, tps: 1234.5
        });
    }, { content, role });
}

test('嵌套任务清单保留普通父项的项目符号，表头和数据列按 Markdown 对齐', async () => {
    const page = await createPage(1440);
    try {
        await appendReply(page, '- 普通父项\n  - [x] 已完成\n  - [ ] 待完成\n- 普通同级项\n\n| 左列 | 中列 | 右列 |\n| :--- | :---: | ---: |\n| 左 | 中 | 100 |');
        const result = await page.evaluate(() => ({
            parent: getComputedStyle(document.querySelector('.text-body > ul > li')).listStyleType,
            task: getComputedStyle(document.querySelector('.text-body > ul ul li')).listStyleType,
            headings: [...document.querySelectorAll('th')].map(cell => getComputedStyle(cell).textAlign),
            values: [...document.querySelectorAll('td')].map(cell => getComputedStyle(cell).textAlign)
        }));
        assert.equal(result.parent, 'disc');
        assert.equal(result.task, 'none');
        assert.deepEqual(result.headings.slice(1), ['center', 'right']);
        assert.deepEqual(result.values.slice(1), ['center', 'right']);
    } finally { await page.close(); }
});

test('长表格单元格换行，多列表格仍可完整横向滚动', async () => {
    for (const width of [1440, 390, 320]) {
        const page = await createPage(width);
        try {
            await appendReply(page, '| 说明 | 内容 | 金额 |\n| --- | --- | ---: |\n| ' + '长中文说明内容。'.repeat(36) + ' | 内容 | 100 |');
            const result = await page.evaluate(() => {
                const wrapper = document.querySelector('.table-wrapper');
                const cell = document.querySelector('td');
                const cellStyle = getComputedStyle(cell);
                const last = document.querySelector('td:last-child');
                wrapper.scrollLeft = wrapper.scrollWidth;
                return {
                    width: window.innerWidth, pageWidth: document.body.scrollWidth,
                    wrapperWidth: wrapper.clientWidth, tableWidth: wrapper.scrollWidth,
                    rowHeight: cell.clientHeight - parseFloat(cellStyle.paddingTop) - parseFloat(cellStyle.paddingBottom),
                    lineHeight: parseFloat(cellStyle.lineHeight),
                    lastRight: last.getBoundingClientRect().right, wrapperRight: wrapper.getBoundingClientRect().right
                };
            });
            assert.ok(result.pageWidth <= result.width);
            assert.ok(result.tableWidth < 1500, JSON.stringify(result));
            assert.ok(result.rowHeight > result.lineHeight * 2, JSON.stringify(result));
            assert.ok(result.lastRight <= result.wrapperRight + 1);
        } finally { await page.close(); }
    }
});

test('窄屏引用中的代码工具栏可操作，长代码和公式的首尾均可访问', async () => {
    for (const width of [390, 320]) {
        const page = await createPage(width);
        try {
            await appendReply(page, '> ```very-long-language-name\n> const text = "' + 'long_code_'.repeat(30) + '";\n> ```\n\n$$' + String.raw`\sum_{i=1}^{n} x_i = ` + Array(40).fill('x_i').join(' + ') + '$$');
            const result = await page.evaluate(() => {
                const toolbar = document.querySelector('.code-toolbar').getBoundingClientRect();
                const buttons = [...document.querySelectorAll('.code-toolbar button')].map(button => {
                    const rect = button.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: button.clientHeight, scroll: button.scrollHeight };
                });
                const pre = document.querySelector('pre');
                const formula = document.querySelector('.math-block');
                const first = formula.querySelector('.katex-html .base').getBoundingClientRect();
                const firstLeft = first.left;
                formula.scrollLeft = formula.scrollWidth;
                return {
                    toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom }, buttons,
                    fontStyle: getComputedStyle(document.querySelector('pre code')).fontStyle,
                    codeWidth: pre.clientWidth, codeScroll: pre.scrollWidth,
                    formulaLeft: formula.getBoundingClientRect().left, firstLeft,
                    formulaRight: formula.getBoundingClientRect().right,
                    lastRight: formula.querySelector('.katex-display').getBoundingClientRect().right
                };
            });
            for (const button of result.buttons) {
                assert.ok(button.left >= result.toolbar.left && button.right <= result.toolbar.right);
                assert.ok(button.top >= result.toolbar.top && button.bottom <= result.toolbar.bottom);
                assert.ok(button.scroll <= button.height + 1);
            }
            assert.equal(result.fontStyle, 'normal');
            assert.ok(result.codeScroll > result.codeWidth);
            assert.ok(result.firstLeft >= result.formulaLeft, JSON.stringify(result));
            assert.ok(result.lastRight <= result.formulaRight + 1, JSON.stringify(result));
            await page.getByTitle('复制代码', { exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.code-copy-btn').classList.contains('copied'));
        } finally { await page.close(); }
    }
});

test('长模型名和实时统计在窄屏完整显示，消息操作按钮保留在气泡内', async () => {
    const page = await createPage(320);
    try {
        await appendReply(page, '短回复');
        for (const mode of ['history', 'streaming', 'final', 'agent']) {
            const result = await page.evaluate(mode => {
                const stats = document.querySelector('.message-stats');
                if (mode === 'streaming') window.renderStreamingAssistantContent(document.querySelector('.text-body'), stats, '短回复', 123456, Date.now() - 1234500);
                if (mode === 'final') window.renderFinalAssistantStats(stats, { tokenCount: 123456, tps: 1234.5, costTime: 1234.5 });
                if (mode === 'agent') window.renderAgentTaskStats(stats, { totalTokens: 123456, inputTokens: 120000, outputTokens: 3456 });
                const actions = document.querySelector('.message-actions');
                const bubble = document.querySelector('.message-content').getBoundingClientRect();
                const model = document.querySelector('.stat-model > span');
                return {
                    statsWidth: stats.clientWidth, statsScroll: stats.scrollWidth,
                    ellipsis: getComputedStyle(model).textOverflow, modelWidth: model.clientWidth, modelScroll: model.scrollWidth,
                    actionsVisible: getComputedStyle(actions).opacity,
                    inside: [...actions.querySelectorAll('button')].every(button => {
                        const rect = button.getBoundingClientRect();
                        return rect.left >= bubble.left && rect.right <= bubble.right;
                    })
                };
            }, mode);
            assert.ok(result.statsScroll <= result.statsWidth + 1, `${mode}: ${JSON.stringify(result)}`);
            assert.equal(result.ellipsis, 'ellipsis');
            assert.ok(result.modelScroll > result.modelWidth);
            assert.equal(result.actionsVisible, '1');
            assert.equal(result.inside, true);
        }
        await page.getByRole('button', { name: '重新回答', exact: true }).hover();
    } finally { await page.close(); }
});

test('深浅主题的回复、表格和思考正文保持可读，减少动态效果偏好生效', async () => {
    const output = path.resolve(__dirname, '..', '.tmp', 'markdown-layout-regression');
    fs.mkdirSync(output, { recursive: true });
    for (const colorScheme of ['light', 'dark']) {
        for (const width of [1440, 390, 320]) {
            const page = await createPage(width, colorScheme);
            try {
                const content = '# 回复排版验证\n\n- 普通父项\n  - [x] 子任务\n\n> 引用 **“重点”**。\n\n| 说明 | 金额 |\n| :--- | ---: |\n| 长文本自动换行 | 123.45 |\n\n```javascript\nconst value = 1;\n```\n\n<thought>思考过程中的正文</thought>\n\n正文与[**参考资料**](https://example.com)。';
                await appendReply(page, content);
                await appendReply(page, '| 列 | 内容 |\n| --- | --- |\n| 链接 | [资料](https://example.com)与`代码` |', 'user');
                const result = await page.evaluate(() => {
                    document.querySelector('.thought-block').classList.add('thinking', 'is-open');
                    const style = selector => getComputedStyle(document.querySelector(selector));
                    const readable = ['.message.assistant .message-content', '.message.assistant th', '.thought-content', '.message.user table', '.message.user table code'].map(selector => {
                        const element = document.querySelector(selector);
                        const current = getComputedStyle(element);
                        let parent = element;
                        let background;
                        while (parent) {
                            const parentStyle = getComputedStyle(parent);
                            background = parentStyle.backgroundImage.match(/rgb\([^)]*\)/)?.[0] || parentStyle.backgroundColor;
                            if (background !== 'rgba(0, 0, 0, 0)') break;
                            parent = parent.parentElement;
                        }
                        return { selector, foreground: current.color, background };
                    });
                    return {
                        readable, slide: style('.message.assistant .message-content').animationName,
                        pulse: style('.thought-block').animationName, bulb: getComputedStyle(document.querySelector('.thought-summary'), '::before').animationName,
                        transition: style('.thought-content-wrapper').transitionDuration
                    };
                });
                const luminance = value => {
                    const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
                        const scaled = channel / 255;
                        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
                    });
                    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
                };
                for (const item of result.readable) {
                    const values = [luminance(item.foreground), luminance(item.background)].sort((a, b) => a - b);
                    assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, `${colorScheme}: ${JSON.stringify(item)}`);
                }
                assert.equal(result.slide, 'none');
                assert.equal(result.pulse, 'none');
                assert.equal(result.bulb, 'none');
                assert.equal(result.transition, '0s');
                await page.screenshot({ path: path.join(output, `${colorScheme}-${width}.png`), fullPage: true });
            } finally { await page.close(); }
        }
    }
});
