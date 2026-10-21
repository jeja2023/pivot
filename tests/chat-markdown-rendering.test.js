const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createRenderer() {
    const context = vm.createContext({
        window: { Pivot: { legacy: {} } },
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

test('截图中的中文法规目录和引号加粗完整渲染且无星号残留', () => {
    const renderer = createRenderer();
    const source = [
        '根据知识库中《中华人民共和国刑法 20201226》文档的检索，**知识库中仅提供了该法典的“前言”及“目录”部分**。',
        '',
        '1. **关于未成年人刑事责任年龄：**',
        '   - 依据目录，相关内容应位于**“第一编 总则” -> “第二章 犯罪” -> “第一节 犯罪和刑事责任”**中（即刑法第十七条）。',
        '',
        '2. **关于贩卖毒品罪的量刑：**',
        '   - 依据目录，相关内容应位于**“第二编 分则” -> “第六章 妨害社会管理秩序罪” -> “第四节 走私、贩卖、运输、制造毒品罪”**中。',
        '',
        '3. **关于刑罚的具体适用：**',
        '   - 依据目录，相关内容应位于**“第一编 总则” -> “第四章 刑罚的具体运用”**，包括量刑、缓刑、减刑等规定。'
    ].join('\n');
    for (const streaming of [false, true]) {
        const html = renderer.renderAiMessage(source, streaming);
        assert.doesNotMatch(html, /\*\*/);
        assert.match(html, /<strong>“第一编 总则” -&gt; “第二章 犯罪” -&gt; “第一节 犯罪和刑事责任”<\/strong>中/);
        assert.match(html, /<strong>“第一编 总则” -&gt; “第四章 刑罚的具体运用”<\/strong>，/);
        assert.match(html, /<ol>/);
        assert.match(html, /<ul>/);
    }
});

test('中文标点和两端多余空格兼容加粗、斜体及嵌套强调', () => {
    const renderer = createRenderer();
    const cases = [
        ['正文**“引用”**内容', '<strong>“引用”</strong>'],
        ['正文**重点：**内容', '<strong>重点：</strong>'],
        ['正文**（补充说明）**内容', '<strong>（补充说明）</strong>'],
        ['正文**《文档》**内容', '<strong>《文档》</strong>'],
        ['正文__“引用”__内容', '<strong>“引用”</strong>'],
        ['正文*“引用”*内容', '<em>“引用”</em>'],
        ['正文_“引用”_内容', '<em>“引用”</em>'],
        ['正文***“引用”***内容', '<em><strong>“引用”</strong></em>'],
        ['正文___“引用”___内容', '<em><strong>“引用”</strong></em>'],
        ['正文** 重点**内容', '<strong>重点</strong>'],
        ['正文**重点 **内容', '<strong>重点</strong>'],
        ['正文**\t重点\t**内容', '<strong>重点</strong>'],
        ['** padded text **', '<strong>padded text</strong>'],
        ['__ padded text __', '<strong>padded text</strong>'],
        ['正文**“重点 *内容*”**说明', '<strong>“重点 <em>内容</em>”</strong>'],
        ['正文**“第一行\n第二行”**说明', '<strong>“第一行<br>第二行”</strong>']
    ];
    for (const [source, expected] of cases) {
        const html = renderer.renderMarkdown(source);
        assert.ok(html.includes(expected), `${source}: ${html}`);
        assert.doesNotMatch(html, /\*\*|__/);
    }
});

test('相邻加粗片段的空格修复不会串联范围或吞入普通数学符号', () => {
    const renderer = createRenderer();
    for (const source of ['正文**重点 **和**另一个**说明', '正文**重点 **和** 第二项**说明']) {
        const html = renderer.renderMarkdown(source);
        assert.match(html, /<strong>重点<\/strong>和<strong>(?:另一个|第二项)<\/strong>说明/);
    }
    const html = renderer.renderMarkdown('2 ** 3 ** 与中文说明 **重点**');
    assert.match(html, /2 \*\* 3 \*\* 与中文说明 <strong>重点<\/strong>/);
});

test('带格式的链接文字渲染内联格式且不改变地址与标题', () => {
    const renderer = createRenderer();
    const html = renderer.renderMarkdown('[**“参考资料”**与`条款`](https://example.com/a__b?q=**value** "原始标题")');
    assert.match(html, /<strong>“参考资料”<\/strong>与<code>条款<\/code><\/a>/);
    assert.match(html, /href="https:\/\/example\.com\/a__b\?q=\*\*value\*\*"/);
    assert.match(html, /title="原始标题"/);
    assert.match(html, /rel="noopener noreferrer"/);
});

test('代码、转义符、标识符及数学表达式中的原始字符保留', () => {
    const renderer = createRenderer();
    const literals = [
        ['`** 中文 **`', '<code>** 中文 **</code>'],
        ['`` `** 中文 **` ``', '<code>`** 中文 **`</code>'],
        ['\\*\\*中文\\*\\*', '**中文**'],
        ['\\_\\_中文\\_\\_', '__中文__'],
        ['foo__bar__baz', 'foo__bar__baz'],
        ['2 ** 3 ** 2', '2 ** 3 ** 2'],
        ['$a ** b ** c$', '$a ** b ** c$']
    ];
    for (const [source, expected] of literals) {
        for (const streaming of [false, true]) {
            const html = renderer.renderAiMessage(source, streaming);
            assert.ok(html.includes(expected), `${source}: ${html}`);
            assert.doesNotMatch(html, /<strong>|<em>/);
        }
    }
    for (const source of [
        '```js\nconst value = "** 中文 **";\n```',
        '```js\nconst value = "** 中文 **";',
        '````js\nconst value = "** 中文 **";\n```\n````',
        '~~~js\nconst value = "** 中文 **";\n~~~',
        '    const value = "** 中文 **";'
    ]) {
        const html = renderer.renderMarkdown(source);
        assert.match(html, /code-block/);
        assert.match(html, /\*\* 中文 \*\*/);
        assert.doesNotMatch(html, /<strong>/);
    }
});

test('强调中的代码或链接地址里的标记不会提前结束加粗范围', () => {
    const renderer = createRenderer();
    const html = renderer.renderMarkdown('正文**“保留 `** 代码 **` 和 [链接](https://example.com/**path**)”**说明');
    assert.match(html, /<strong>“保留 <code>\*\* 代码 \*\*<\/code> 和 <a /);
    assert.match(html, /href="https:\/\/example.com\/\*\*path\*\*"/);
    assert.match(html, /<\/a>”<\/strong>说明/);
    for (const source of ['正文**“计算 $a ** b$ 的结果”**说明', '正文**计算 $a**b$ 的结果**说明']) {
        const mathHtml = renderer.renderMarkdown(source);
        assert.match(mathHtml, /<strong>.*\$a\s*\*\*\s*b\$.*<\/strong>说明/);
        assert.equal((mathHtml.match(/<strong>/g) || []).length, 1);
    }
});

test('逐字符流式输出不暴露未闭合的加粗标记且最终展示一致', () => {
    const renderer = createRenderer();
    for (const source of ['正文**“重点”**说明', '正文__“重点”__说明', '正文***“重点”***说明', '**English text**']) {
        for (let length = 1; length <= source.length; length += 1) {
            const html = renderer.renderAiMessage(source.slice(0, length), true);
            assert.doesNotMatch(html, /[*_]/, `${source.slice(0, length)}: ${html}`);
        }
        assert.equal(renderer.renderAiMessage(source, true), renderer.renderAiMessage(source, false));
    }
    assert.match(renderer.renderAiMessage('正文**未完成', false), /<strong>未完成<\/strong>/);
    assert.match(renderer.renderMarkdown('正文**未完成'), /\*\*未完成/);
    assert.match(renderer.renderAiMessage('word__property', true), /word__property/);
    assert.match(renderer.renderAiMessage('**未闭合\n\n下一段', true), /<strong>未闭合<\/strong><\/p>\n<p>下一段<\/p>/);
});

test('助手漏写闭合符时按段落恢复且思考块沿用同一规则', () => {
    const renderer = createRenderer();
    for (const streaming of [false, true]) {
        const html = renderer.renderAiMessage('**结论：\n\n正文**“关键内容”*\n\n下一段**', streaming);
        assert.doesNotMatch(html, /\*\*/);
        assert.match(html, /<strong>结论：<\/strong><\/p>/);
        assert.match(html, /正文<strong>“关键内容”<\/strong><\/p>/);
        assert.match(html, /<p>下一段<\/p>/);
        const thoughtHtml = renderer.renderAiMessage('<thought>检查**“引用”</thought>\n\n正文**“结论”', streaming);
        assert.doesNotMatch(thoughtHtml, /\*\*/);
        assert.match(thoughtHtml, /thought-content/);
        assert.match(thoughtHtml, /<strong>“引用”<\/strong>/);
        assert.match(thoughtHtml, /<strong>“结论”<\/strong>/);
    }
});

test('列表、引用、表格和完整 Markdown 外层代码围栏共用修正后的渲染', () => {
    const renderer = createRenderer();
    const source = '```markdown\n## 说明\n\n> 正文**“引用”**内容\n\n- 正文**重点：**说明\n\n| 项目 | 内容 |\n| --- | --- |\n| 第一项 | 正文**“重点”**内容 |\n```';
    const html = renderer.renderMarkdown(source);
    assert.match(html, /<h2>说明<\/h2>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<ul>/);
    assert.match(html, /class="table-wrapper"/);
    assert.doesNotMatch(html, /\*\*|code-block/);
});
