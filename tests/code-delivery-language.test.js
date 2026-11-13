'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    createInternalAgentScaffoldStreamFilter,
    sanitizeUserVisibleText,
    stripInternalAgentScaffolding
} = require('../server/llm');
const { normalizeCodeFile, normalizeCodeFormat } = require('../server/services/agent-code-renditions');
const { parseAllowedFormats } = require('../desktop/delivery/executor');
const { normalizeLocalAllowedFormats } = require('../desktop/delivery/output-grants');
const { CODE_FORMAT_ALIASES, CODE_MIME_TYPES } = require('../client/common/code-formats');
const { buildDeliveryFilename } = require('../server/services/agent-path-safety');

test('代码文件必须经过安全格式白名单并保留源代码空白', () => {
    const result = normalizeCodeFile({
        filename: '../五子棋.py',
        language: 'python',
        content: '\nprint("黑白棋")\n'
    });
    assert.equal(result.format, 'py');
    assert.equal(result.filename, '五子棋.py');
    assert.equal(result.content, '\nprint("黑白棋")\n');
    assert.equal(normalizeCodeFormat('JavaScript', ''), 'js');
    const mermaid = normalizeCodeFile({ filename: '流程图源码.txt', language: 'mermaid', content: 'flowchart TD\nA-->B\n' });
    assert.equal(mermaid.format, 'txt');
    assert.equal(mermaid.content, 'flowchart TD\nA-->B\n');
    assert.throws(() => normalizeCodeFile({ filename: '流程图.svg', language: 'mermaid', content: 'flowchart TD\nA-->B' }), /扩展名/);
    assert.throws(() => normalizeCodeFile({ filename: '危险.exe', language: 'python', content: 'x' }), /格式|扩展名/);
});

test('旧版默认文档授权升级后继续允许源码格式', () => {
    const formats = parseAllowedFormats(['docx', 'pdf', 'xlsx', 'html', 'md']);
    assert.ok(formats.includes('py'));
    assert.ok(formats.includes('docx'));
    assert.ok(normalizeLocalAllowedFormats(['docx', 'pdf', 'xlsx', 'html', 'md']).includes('py'));
    assert.ok(formats.includes('svg'));
    assert.ok(normalizeLocalAllowedFormats(['docx', 'pdf', 'xlsx', 'html', 'md']).includes('svg'));
    assert.ok(!parseAllowedFormats(['txt']).includes('svg'));
});

test('SVG 源码保存为矢量图片并拒绝脚本、外链和扩展名冒充', () => {
    const result = normalizeCodeFile({ filename: '小白兔.svg', language: 'SVG', content: '<svg width="400" height="400"><title>小白兔</title><circle cx="200" cy="200" r="80" fill="white"/></svg>' });
    assert.equal(result.format, 'svg');
    assert.equal(result.filename, '小白兔.svg');
    assert.equal(result.mimeType, 'image/svg+xml; charset=utf-8');
    assert.equal(result.bytes, Buffer.byteLength(result.content));
    assert.match(result.content, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    for (const content of [
        '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"></svg>',
        '<svg><image href="https://example.com/a.png"/></svg>',
        '<svg><use href="https://example.com/a.svg#x"/></svg>',
        '<svg><style>@import "https://example.com/a.css";</style></svg>',
        '<!DOCTYPE svg [<!ENTITY x "危险内容">]><svg>&x;</svg>'
    ]) {
        assert.throws(() => normalizeCodeFile({ filename: '图形.svg', language: 'svg', content }), error => error.code === 'CODE_SVG_INVALID' && error.status === 400);
    }
    assert.throws(() => normalizeCodeFile({ filename: '图形.xml', language: 'svg', content: '<svg/>' }), /扩展名/);
});

test('所有声明的源码语言、MIME 和桌面白名单保持一致，常见格式可往返保存', () => {
    for (const [language, extension] of Object.entries(CODE_FORMAT_ALIASES)) {
        const content = extension === 'svg' ? '<svg width="10" height="10"/>' : '\n内容原样保留\n';
        const result = normalizeCodeFile({ language, filename: `结果.${extension}`, content });
        assert.equal(result.format, extension, language);
        assert.equal(result.mimeType, CODE_MIME_TYPES[extension], language);
        assert.equal(buildDeliveryFilename(result.filename, extension), result.filename);
        assert.ok(parseAllowedFormats([extension]).includes(extension), language);
        assert.ok(normalizeLocalAllowedFormats([extension]).includes(extension), language);
        if (extension !== 'svg') assert.equal(result.content, content);
    }
    for (const [language, extension] of [['HTML5', 'html'], ['PYTHON3', 'py'], ['csharp', 'cs'], ['plaintext', 'txt'], ['csv', 'csv'], ['tsv', 'tsv'], ['toml', 'toml'], ['ini', 'ini'], ['ndjson', 'jsonl']]) {
        assert.equal(normalizeCodeFormat(language), extension);
    }
    for (const [filename, canonical] of [['页面.htm', '页面.html'], ['说明.markdown', '说明.md'], ['记录.ndjson', '记录.jsonl']]) {
        assert.equal(normalizeCodeFile({ filename, content: '内容' }).filename, canonical);
    }
});

test('未知和未标注语言只能回退 TXT，拒绝冒充文件格式、空白和错误参数类型', () => {
    for (const language of ['', 'code', 'powershell', 'constructor', '__proto__', 'unknown-language']) {
        assert.equal(normalizeCodeFile({ language, filename: '源码.txt', content: '原始源码' }).format, 'txt');
        assert.throws(() => normalizeCodeFile({ language: language || 'unknown', filename: '源码.exe', content: '原始源码' }), /扩展名|格式/);
    }
    assert.throws(() => normalizeCodeFile({ language: 'unknown', filename: '源码.js', content: '原始源码' }), /扩展名/);
    assert.throws(() => normalizeCodeFile({ language: 'json', filename: '源码.html', content: '{}' }), /扩展名/);
    for (const input of [{ content: '   \n' }, { content: {} }, { content: '内容', language: [] }, { content: '内容', filename: {} }, { content: '\0' }]) {
        assert.throws(() => normalizeCodeFile(input), error => error.status === 400);
    }
});

test('用户可见文本会移除 WorldState 和工具结果内部区块', () => {
    const source = '前置说明\nPIVOT_WORLD_STATE_BEGIN\n{"secret":"不要展示"}\nPIVOT_WORLD_STATE_END\n最终结论';
    assert.equal(stripInternalAgentScaffolding(source), '前置说明\n最终结论');
    assert.equal(sanitizeUserVisibleText(source), '前置说明\n最终结论');
    assert.equal(sanitizeUserVisibleText('正常内容\nPIVOT_MCP_TOOL_RESULT_BEGIN\n未完成的内部数据'), '正常内容');
});

test('内部 Agent 区块跨流式分片时不会泄漏', () => {
    const filter = createInternalAgentScaffoldStreamFilter();
    assert.equal(filter.push('结论\nPIVOT_WORLD_'), '');
    assert.equal(filter.push('STATE_BEGIN\n{"x":1}\nPIVOT_WORLD_STATE_END\n后'), '结论\n');
    assert.equal(filter.finish(), '后');
});

test('聊天代码块提供受控本机保存入口并加载对应交付模块', () => {
    const root = path.resolve(__dirname, '..');
    const render = fs.readFileSync(path.join(root, 'client', 'chat', 'render.js'), 'utf8');
    const scripts = fs.readFileSync(path.join(root, 'client', 'chat', 'partials', 'scripts.html'), 'utf8');
    assert.match(render, /code-save-local-btn/);
    assert.match(scripts, /code-delivery\.js/);
});
