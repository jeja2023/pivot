const test = require('node:test');
const assert = require('node:assert/strict');
const { minifyCss, buildAllChatCss } = require('../scripts/build_chat_css');

test('样式压缩保留 calc 中的变量名、负号和运算符间距', () => {
    const output = minifyCss('.sidebar.collapsed { margin-left: calc(var(--sidebar-width) * -1); width: calc(100% - 32px); }');
    assert.match(output, /calc\(var\(--sidebar-width\) \* -1\)/);
    assert.match(output, /calc\(100% - 32px\)/);
    assert.doesNotMatch(output, /var\(\s*-\s+-/);
});

test('嵌套计算与变量回退不因压缩变成非法标识符', () => {
    const output = minifyCss('.panel { width: calc(100% - var(--panel-gap, 16px)); height: min(400px, calc(100vh - 20px)); }');
    assert.match(output, /var\(--panel-gap,16px\)/);
    assert.match(output, /min\(400px,calc\(100vh - 20px\)\)/);
});

test('所有生成样式包保留完整 CSS 变量标识符', () => {
    const bundles = buildAllChatCss();
    assert.equal(Object.keys(bundles).length, 6);
    for (const [name, source] of Object.entries(bundles)) assert.doesNotMatch(source, /var\(\s*-\s+-/, name);
    assert.match(bundles.shell, /\.sidebar\.collapsed\{margin-left:calc\(var\(--sidebar-width\) \* -1\)/);
});
