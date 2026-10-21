const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createMainContext() {
    const modules = {};
    const legacy = {
        resizeUserInput() {}
    };
    const context = vm.createContext({
        window: {
            Pivot: {
                legacy,
                exposeModule(name, api, aliases = []) {
                    modules[name] = api;
                    aliases.forEach(alias => {
                        legacy[alias] = api[alias];
                    });
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
    return { context, legacy, modules };
}

test('复制大模型回复正文时段落间消除多余空行且保留单换行', () => {
    const { legacy } = createMainContext();
    const normalize = legacy.normalizeClipboardText;
    assert.equal(typeof normalize, 'function');

    const source = [
        '目前只完成了文档生成工具的查找，**尚未拟定完整攻略，也未生成或保存 Word 文档**。',
        '',
        '已找到支持生成 `.docx` 的工具，但该工具只能提供可下载文件，不能直接写入你的本地磁盘。',
        '',
        '在未提供出发地、人数和预算的情况下，可先按“首次赴广东、中等预算、公共交通为主”制定广州—佛山—深圳路线。',
        '',
        '当前没有可提供的文档下载链接，不能声称文件已保存到本地。'
    ].join('\n');

    const result = normalize(source);
    // 不应存在两个及以上连续换行（即粘贴后不应有空白行）
    assert.doesNotMatch(result, /\n{2,}/);

    const lines = result.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[0], '目前只完成了文档生成工具的查找，**尚未拟定完整攻略，也未生成或保存 Word 文档**。');
    assert.equal(lines[3], '当前没有可提供的文档下载链接，不能声称文件已保存到本地。');
});

test('正文代码块内部空行受控保留，外部正文消除多余空行', () => {
    const { legacy } = createMainContext();
    const normalize = legacy.normalizeClipboardText;

    const source = [
        '前言说明：',
        '',
        '```python',
        'def test():',
        '    a = 1',
        '',
        '    return a',
        '```',
        '',
        '结语说明。'
    ].join('\n');

    const result = normalize(source);
    assert.match(result, /def test\(\):\n    a = 1\n\n    return a/);
    assert.match(result, /^前言说明：\n```python/);
    assert.match(result, /```\n结语说明。$/);
});

test('列表和引用块消除多余空行与孤立引用符号', () => {
    const { legacy } = createMainContext();
    const normalize = legacy.normalizeClipboardText;

    const listSource = '注意事项：\n\n1. 第一条\n\n2. 第二条\n\n- 项目A\n\n- 项目B';
    const listResult = normalize(listSource);
    assert.doesNotMatch(listResult, /\n{2,}/);
    assert.equal(listResult, '注意事项：\n1. 第一条\n2. 第二条\n- 项目A\n- 项目B');

    const quoteSource = '> 引用第一段\n>\n> 引用第二段';
    const quoteResult = normalize(quoteSource);
    assert.equal(quoteResult, '> 引用第一段\n> 引用第二段');
});

test('cleanRawMarkdownForClipboard 剥离思考块与工具标记并消除空行', () => {
    const { legacy } = createMainContext();
    const clean = legacy.cleanRawMarkdownForClipboard;
    assert.equal(typeof clean, 'function');

    const source = [
        '<thought>',
        '思考步骤一',
        '思考步骤二',
        '</thought>',
        '',
        '这是最终给用户的回答第一段。',
        '',
        '这是最终给用户的回答第二段。',
        '',
        'PIVOT_AGENT_CONTROL_BEGIN',
        '{"status":"done"}',
        'PIVOT_AGENT_CONTROL_END'
    ].join('\n');

    const result = clean(source);
    assert.equal(result, '这是最终给用户的回答第一段。\n这是最终给用户的回答第二段。');
});
