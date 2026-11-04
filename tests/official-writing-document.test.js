const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../client/common/official-writing-document');
const { buildOfficialWritingMessages, parseOfficialWritingReviewResult } = require('../server/services/official-writing');
const { createOfficialWritingTextFilter } = require('../server/services/official-writing-stream');

test('公文历史材料去重，旧备份可迁移且总历史受字节预算限制', () => {
    const material = '材'.repeat(180000);
    const state = model.normalize({ source: material, draft: '当前正文', autoSaves: Array.from({ length: 8 }, (_, index) => ({ id: String(index), draft: '版本' + index, source: material })) });
    assert.equal(Object.keys(state.materialVersions).length, 1);
    assert.equal(state.materialVersions[state.autoSaves[0].sourceRef], material);
    assert.ok(state.autoSaves.every(entry => !Object.hasOwn(entry, 'source')));
    assert.ok(model.bytes(state) < 1100000);
    const large = model.normalize({ versions: Array.from({ length: 30 }, (_, index) => ({ id: String(index), draft: '文'.repeat(60000), source: material + index })) });
    assert.ok(model.bytes({ versions: large.versions, autoSaves: large.autoSaves, materialVersions: large.materialVersions }) <= model.HISTORY_BYTES);
    assert.deepEqual(model.normalize(state), state);
});

test('服务端正文过滤器跨块剥离思考，支持标签拆分与未闭合输出', () => {
    const filter = createOfficialWritingTextFilter();
    let visible = '';
    for (const part of ['<thi', 'nk>内部思考</thi', 'nk>正文一', '<think>再次推理</', 'think>正文二']) visible += filter.push(part);
    visible += filter.finish();
    assert.equal(visible, '正文一正文二');
    const truncated = createOfficialWritingTextFilter();
    assert.equal(truncated.push('<think>尚未完成'), '');
    assert.equal(truncated.finish(), '');
});

test('建议锚点支持前文插入，拒绝多处同文和原文被改', () => {
    const anchor = model.anchor('甲乙丙丁', 2, 3);
    assert.equal(model.locate('甲甲甲乙丙丁', anchor).start, 4);
    assert.equal(model.locate('甲乙新丁', anchor), null);
    assert.equal(model.locate('重复重复', { original: '重复', start: 0, end: 2 }), null);
    assert.deepEqual(model.locate('前段重复后段与重复', { original: '重复', before: '前段', after: '后段' }), { start: 2, end: 4, contextual: true });
});

test('公文状态统一显示占位风险、审校快照与有效日期', () => {
    const state = model.normalize({ draft: '关于工作的通知\n【待补充】', meta: { issuedAt: '2026-11-04' } });
    assert.equal(model.summary(state).status, '待核对');
    state.draft = '关于工作的通知\n正文';
    state.review = { status: 'complete', digest: model.digest(state.draft) };
    assert.equal(model.summary(state).status, '已审校');
    state.draft += '有更新';
    assert.equal(model.summary(state).status, '已起草');
    assert.equal(model.isoDate('2026年2月30日'), '');
    assert.equal(model.isoDate('2028年2月29日'), '2028-02-29');
});

test('审校契约区分说明、可替换正文、无问题、截断与解析失败', () => {
    const valid = parseOfficialWritingReviewResult('[{"title":"用词","original":"截止目前","explanation":"应使用截至","replacement":"截至目前","severity":"低"}]', 'stop');
    assert.equal(valid.status, 'complete');
    assert.equal(valid.items[0].replacement, '截至目前');
    const legacy = parseOfficialWritingReviewResult('[{"title":"意见","suggestion":"建议修改"}]', 'stop');
    assert.equal(legacy.items[0].replacement, null);
    assert.deepEqual(parseOfficialWritingReviewResult('[]', 'stop'), { status: 'complete', items: [] });
    assert.equal(parseOfficialWritingReviewResult('无问题', 'stop').status, 'error');
    assert.equal(parseOfficialWritingReviewResult('[{"title":"截断"}]', 'length').status, 'partial');
    const messages = buildOfficialWritingMessages({ mode: 'draft', title: '年度检查安排', docType: '通知' });
    assert.ok(messages.messages[1].content.includes('年度检查安排'));
});
