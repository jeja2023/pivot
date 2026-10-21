const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createRenderer() {
    const context = vm.createContext({
        window: {
            Pivot: {
                legacy: {
                    PivotSafeHtml: {
                        escapeHtml(v) {
                            return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        },
                        escapeAttr(v) {
                            return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                        }
                    }
                }
            }
        },
        document: { addEventListener() {} }
    });
    for (const file of [
        'client/common/vendor/marked.min.js',
        'client/chat/render-markdown-emphasis.js',
        'client/chat/render.js',
        'client/chat/render-messages.js'
    ]) {
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    return context;
}

test('think、thinking 与 thought 标签均规范渲染为思考折叠卡片', () => {
    const renderer = createRenderer();
    const cases = [
        '<thought>这是思考过程</thought>这是正式回答',
        '<think>这是 DeepSeek 思考过程</think>这是正式回答',
        '<thinking>这是 Qwen 思考过程</thinking>这是正式回答'
    ];
    for (const source of cases) {
        const html = renderer.renderAiMessage(source, false);
        assert.match(html, /class="thought-block"/);
        assert.match(html, /class="thought-summary">模型思考内容<\/div>/);
        assert.match(html, /思考过程/);
        assert.match(html, /这是正式回答/);
    }
});

test('流式未闭合 think、thinking 标签正确识别为正在思考状态', () => {
    const renderer = createRenderer();
    const streamingCases = [
        '<thought>正在思考中...',
        '<think>DeepSeek 正在推导中...',
        '<thinking>Qwen 正在深度思考...'
    ];
    for (const source of streamingCases) {
        const html = renderer.renderAiMessage(source, true);
        assert.match(html, /class="thought-block thinking"/);
        assert.match(html, /class="thought-summary">模型正在思考<\/div>/);
    }
});

test('剪贴板清理 cleanRawMarkdownForClipboard 支持剔除 think 与 thinking 思考块', () => {
    const modules = {};
    const legacy = { resizeUserInput() {} };
    const context = vm.createContext({
        window: {
            Pivot: {
                legacy,
                exposeModule(name, api, aliases = []) {
                    modules[name] = api;
                    aliases.forEach(alias => { legacy[alias] = api[alias]; });
                }
            },
            matchMedia: () => ({ matches: false, addEventListener() {} })
        },
        document: {
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {}
        },
        localStorage: { getItem() { return null; }, setItem() {} },
        navigator: { clipboard: { writeText() {} } },
        showToast() {}
    });
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'client/chat/app/main.js'), 'utf8');
    vm.runInContext(code, context, { filename: 'client/chat/app/main.js' });

    const clean = legacy.cleanRawMarkdownForClipboard;
    assert.equal(typeof clean, 'function');

    const sample = '<think>\n这里是内在推导过程\n</think>\n\n正式回答结论：成功。';
    assert.equal(clean(sample), '正式回答结论：成功。');

    const sampleThinking = '<thinking>\nQwen思考\n</thinking>\n\n分析结果。';
    assert.equal(clean(sampleThinking), '分析结果。');
});

test('自适应流式渲染节流策略按累计字符长度动态放大渲染间隔', () => {
    const modules = {};
    const context = vm.createContext({
        window: {
            Pivot: {
                modules,
                legacy: {},
                exposeModule(name, api) {
                    modules[name] = api;
                }
            }
        },
        document: { addEventListener() {} }
    });
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'client/chat/engine-streaming.js'), 'utf8');
    vm.runInContext(code, context, { filename: 'client/chat/engine-streaming.js' });

    const streamingApi = modules['chat.streaming'];
    assert.ok(streamingApi);
    const resolveInterval = streamingApi.resolveStreamInterval;
    assert.equal(typeof resolveInterval, 'function');

    // 阶梯式阈值：<600 -> 80ms, <2000 -> 140ms, <6000 -> 220ms, >=6000 -> 320ms
    assert.equal(resolveInterval(200), 80);
    assert.equal(resolveInterval(1200), 140);
    assert.equal(resolveInterval(3500), 220);
    assert.equal(resolveInterval(8000), 320);
});
