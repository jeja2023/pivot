'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSvg } = require('../server/services/document-rendering/image-renderer');
const { normalizeCodeFile } = require('../server/services/agent-code-renditions');

const animated = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs><path id="track" d="M 0 0 L 100 0"/></defs><g id="rider"><circle r="10"><animate attributeName="cy" values="20;30;20" dur="1s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite"/><set attributeName="fill" to="red" begin="0s"/></circle><animateMotion dur="3s" repeatCount="indefinite"><mpath href="#track"/></animateMotion></g></svg>';

test('声明式 SVG 动画在代码保存入口保留，通用静态图片入口保持拒绝', () => {
    const file = normalizeCodeFile({ filename: '骑行.svg', language: 'svg', content: animated });
    for (const tag of ['animate', 'animateTransform', 'animateMotion', 'mpath', 'set']) assert.ok(file.content.includes('<' + tag), tag);
    assert.match(file.content, /repeatCount="indefinite"/);
    assert.match(file.content, /attributeName="transform"/);
    assert.throws(() => sanitizeSvg(animated), /动画/);
});

test('SVG 动画不能改写链接、事件、样式或命名空间，不能使用外部路径和事件触发', () => {
    for (const inner of [
        '<animate attributeName="href" values="#x;https://example.com"/>',
        '<set attributeName="xlink:href" to="javascript:alert(1)"/>',
        '<set attributeName="onload" to="alert(1)"/>',
        '<set attributeName="style" to="fill:red"/>',
        '<animate attributeName="class" to="anything"/>',
        '<animate attributeName="fill" values="red;url(//example.com/a)"/>',
        '<animate attributeName="x" begin="rider.click" from="0" to="10"/>',
        '<animateTransform attributeName="href" type="rotate" to="360"/>',
        '<animateMotion><mpath href="//example.com/path.svg"/></animateMotion>',
        '<style>svg{background-image:image-set("//example.com/background.png")}</style>',
        '<g xml:base="//example.com/"><use href="#x"/></g>',
        '<g xmlns:k="http://www.w3.org/1999/xlink"><set attributeName="k:href" to="#x"/></g>'
    ]) assert.throws(() => normalizeCodeFile({ filename: '图形.svg', language: 'svg', content: '<svg viewBox="0 0 10 10">' + inner + '</svg>' }), error => error.code === 'CODE_SVG_INVALID', inner);
});
