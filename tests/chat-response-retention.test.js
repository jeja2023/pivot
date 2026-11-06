'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRetainedChatResponse } = require('../server/services/chat-response-retention');

function fixture(enabled = true) {
    const res = new EventEmitter(); res.writableEnded = false;
    const saved = [];
    const write = createRetainedChatResponse({ res, enabled, options: () => ({ sessionId: 'source', userId: 1 }),
        persist: async options => { saved.push(options); return { assistantMessageId: 12 }; } });
    const emit = event => write.capture(JSON.stringify(event));
    return { res, saved, write, emit };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('用户中止保留已公开正文，标记未完成且不抽取记忆或另调模型生成标题', async () => {
    const h = fixture();
    h.emit({ content: '已生成第一段。' });
    h.emit({ content: '已生成第二段。' });
    h.res.emit('close'); await flush();
    assert.equal(h.saved.length, 1);
    assert.match(h.saved[0].assistantContent, /已生成第一段。已生成第二段。/);
    assert.match(h.saved[0].assistantContent, /生成已中止/);
    assert.equal(h.saved[0].skipMemoryExtraction, true);
    assert.equal(h.saved[0].skipTitleGeneration, true);
    assert.deepEqual(h.saved[0].routeMetadata.generation, { status: 'interrupted', partial: true });
    assert.equal(h.res.listenerCount('finish'), 0);
});

test('正常结束和停止竞争只保存一次，停止先发生不能被迟到结束覆盖', async () => {
    const complete = fixture(); complete.emit({ content: '部分正文' });
    const final = complete.write({ assistantContent: '完整正文' });
    complete.res.emit('close'); await final;
    assert.equal(complete.saved.length, 1); assert.equal(complete.saved[0].assistantContent, '完整正文');
    const stopped = fixture(); stopped.emit({ content: '部分正文' }); stopped.res.emit('close');
    await stopped.write({ assistantContent: '迟到的完整正文' });
    assert.equal(stopped.saved.length, 1); assert.match(stopped.saved[0].assistantContent, /^部分正文/);
    assert.doesNotMatch(stopped.saved[0].assistantContent, /迟到/);
});

test('临时语音、空回复、未公开知识依据及协议元数据不写入中止消息', async () => {
    for (const enabled of [false, true]) {
        const h = fixture(enabled);
        h.emit({ type: 'route', content: '路由内部状态' });
        h.emit({ type: 'agent_handoff', runId: 'run' });
        h.emit({ type: 'chart', data: { secret: true } });
        h.emit({ type: 'assistant_error', content: '已另行保存的错误' });
        if (!enabled) h.emit({ content: '临时语音内容' });
        h.res.emit('close'); await flush();
        assert.equal(h.saved.length, 0);
    }
    const ended = fixture(); ended.emit({ content: '已完成' }); ended.res.writableEnded = true;
    ended.res.emit('finish'); ended.res.emit('close'); await flush();
    assert.equal(ended.saved.length, 0);
    assert.equal(ended.res.listenerCount('close'), 0);
});
