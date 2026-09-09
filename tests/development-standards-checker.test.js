const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildBaseRefCandidates,
    extractMessageStringLiterals,
    isSkippableGeneratedFile,
    resolveChangedDiffArgs
} = require('../scripts/check_development_standards');

test('增量规范检查忽略生成的聊天样式包', () => {
    assert.equal(isSkippableGeneratedFile('client/chat/chat.shell.css'), true);
    assert.equal(isSkippableGeneratedFile('client/chat/chat.workspace.agent.css'), true);
    assert.equal(isSkippableGeneratedFile('client/chat/styles/base/chat-shell.css'), false);
});

test('日志文案检查不会把调用前的代码字符串误判为用户文案', () => {
    const literals = extractMessageStringLiterals(
        "if (typeof implementation !== 'function') throw new Error('个人工作台入口未就绪');"
    );
    assert.deepEqual(literals, ['个人工作台入口未就绪']);
    assert.deepEqual(
        extractMessageStringLiterals("console.error('测试日志：' + fs.readFileSync(file, 'utf8'))"),
        ['测试日志：']
    );
});

test('PR 增量范围使用目标分支 merge-base，普通推送回退到上一提交', () => {
    assert.deepEqual(buildBaseRefCandidates('main'), ['origin/main', 'main']);
    assert.deepEqual(
        resolveChangedDiffArgs({ GITHUB_BASE_REF: 'main' }, ref => ref === 'origin/main' ? 'abc123' : '', () => true),
        ['abc123', 'HEAD']
    );
    assert.deepEqual(resolveChangedDiffArgs({}, () => '', () => true), ['HEAD']);
    assert.deepEqual(resolveChangedDiffArgs({}, () => '', () => false), ['HEAD^', 'HEAD']);
});
