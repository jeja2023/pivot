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
    assert.throws(() => normalizeCodeFile({ filename: '危险.exe', language: 'python', content: 'x' }), /格式|扩展名/);
});

test('旧版默认文档授权升级后继续允许源码格式', () => {
    const formats = parseAllowedFormats(['docx', 'pdf', 'xlsx', 'html', 'md']);
    assert.ok(formats.includes('py'));
    assert.ok(formats.includes('docx'));
    assert.ok(normalizeLocalAllowedFormats(['docx', 'pdf', 'xlsx', 'html', 'md']).includes('py'));
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
