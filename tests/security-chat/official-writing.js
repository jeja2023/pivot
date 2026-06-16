// 公文写作 AI 服务单测：校验提示词组装、模式/选区校验与审校 JSON 解析。
// 由 security-chat.test.js 统一加载。
const { assert, test } = require('../security-helpers');
const {
    buildOfficialWritingMessages,
    parseOfficialWritingReviewItems,
    OFFICIAL_WRITING_MODE_LABELS
} = require('../../server/services/official-writing');

test('公文写作起草模式组装 system+user 并带入材料与规范库', () => {
    const built = buildOfficialWritingMessages({
        mode: 'draft',
        docType: '通知',
        standard: '党政机关公文格式',
        source: '关于开展安全检查的材料',
        requirements: '简明扼要'
    });
    assert.equal(built.maxTokens, 2600);
    assert.equal(built.messages.length, 2);
    assert.equal(built.messages[0].role, 'system');
    assert.ok(built.messages[0].content.includes('党政机关公文格式'));
    assert.equal(built.messages[1].role, 'user');
    assert.ok(built.messages[1].content.includes('关于开展安全检查的材料'));
    assert.ok(built.messages[1].content.includes('简明扼要'));
});

test('公文写作批注只在全文类模式注入，起草模式不带批注', () => {
    const polish = buildOfficialWritingMessages({ mode: 'polish', draft: '正文内容', comments: '- 批注甲' });
    assert.ok(polish.messages[1].content.includes('批注甲'));
    const draft = buildOfficialWritingMessages({ mode: 'draft', source: '材料', comments: '- 批注甲' });
    assert.ok(!draft.messages[1].content.includes('批注甲'));
});

test('公文写作选区模式按动作注入指令，缺片段或非法动作抛错', () => {
    const sel = buildOfficialWritingMessages({ mode: 'selection', action: 'compress', selection: { text: '一段冗长的话' } });
    assert.ok(sel.messages[1].content.includes('精炼压缩'));
    assert.ok(sel.messages[1].content.includes('一段冗长的话'));
    assert.throws(() => buildOfficialWritingMessages({ mode: 'selection', action: 'unknown', selection: { text: 'x' } }));
    assert.throws(() => buildOfficialWritingMessages({ mode: 'selection', action: 'polish', selection: { text: '' } }));
});

test('公文写作非法模式与全文模式空文本抛错', () => {
    assert.throws(() => buildOfficialWritingMessages({ mode: 'nope' }));
    assert.throws(() => buildOfficialWritingMessages({ mode: 'polish', draft: '' }));
    // 模式标签覆盖到位
    assert.ok(OFFICIAL_WRITING_MODE_LABELS.review);
    assert.ok(OFFICIAL_WRITING_MODE_LABELS.rewrite_stream);
});

test('审校 JSON 解析兼容代码块与前后说明，并过滤脏数据', () => {
    const items = parseOfficialWritingReviewItems('前置说明\n```json\n[{"title":"标题不规范","original":"原句","suggestion":"改为规范标题"},{"noise":1},{"title":"","suggestion":""}]\n``` 收尾');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '标题不规范');
    assert.equal(items[0].original, '原句');
    assert.equal(items[0].suggestion, '改为规范标题');
});

test('审校 JSON 解析对非数组或无法解析的内容返回空数组', () => {
    assert.deepEqual(parseOfficialWritingReviewItems('完全不是 JSON 的整体意见'), []);
    assert.deepEqual(parseOfficialWritingReviewItems('{"title":"对象不是数组"}'), []);
    assert.deepEqual(parseOfficialWritingReviewItems(''), []);
});
