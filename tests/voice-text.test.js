const assert = require('node:assert/strict');
const test = require('node:test');
const { isExitCommand, isPlaybackEcho, joinTranscript, speechSegments } = require('../client/chat/voice-text');

test('长回答分段保留全文、英文词界和辅助平面字符，不在 2000 字处截断', () => {
    const text = '这是超过两千字的回答，需要全部读完。'.repeat(180) + '𠮷😊结束。';
    const parts = speechSegments(text);
    assert.equal(parts.join(''), text);
    assert.ok(parts.length > 20);
    assert.ok(parts.every(part => part.length <= 120 && !/[\uD800-\uDBFF]$/u.test(part)));
    assert.equal(joinTranscript('第一句', '第二句'), '第一句第二句');
    assert.equal(joinTranscript('hello', 'world'), 'hello world');
});

test('回声比对容忍同音错字、漏字和跨分段结果，但保留不同问题及控制口令', () => {
    const played = ['这个问题需要结合具体场景分析。', '我们可以先看看数据，再讨论结论。'];
    for (const heard of ['具体场景分析', '这个问题须要结合具体场景分析', '我们可以先看数据再讨论结论',
        '具体场景分析，我们可以先看看数据']) assert.equal(isPlaybackEcho(heard, played), true, heard);
    for (const heard of ['换个角度再解释一下', '退出', '先暂停任务', '我问的是另外一个问题', '这个问题不需要结合具体场景分析']) {
        assert.equal(isPlaybackEcho(heard, played), false, heard);
    }
});

test('退出命令仅接受完整指令，不把讨论退出功能的普通问题当成命令', () => {
    for (const text of ['退出。', '请退出实时语音', '结束实时语音吧', '关闭语音，谢谢', '停止语音']) {
        assert.equal(isExitCommand(text), true, text);
    }
    for (const text of ['如何退出登录', '退出是什么意思', '请解释退出机制', '不要退出', '任务退出了吗']) {
        assert.equal(isExitCommand(text), false, text);
    }
});
