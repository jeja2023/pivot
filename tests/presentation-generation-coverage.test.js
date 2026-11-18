'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMaterials } = require('../server/services/presentations/presentation-evidence');
const { buildOutlineMessages, buildSlidesMessages, compilePresentationProposal } = require('../server/services/presentations/presentation-ai');
const { validateGenerationMaterials, prepareGenerationMaterials, confirmedRoster, generateRosterPages } = require('../server/services/presentations/presentation-generation-coverage');

test('标准制作在 256K 窗口保留材料尾部，较长材料逐段读取并校对原文', async () => {
    const build = materials => buildOutlineMessages({ topic: '年度汇报', materials });
    const model = { context_window_tokens: 256000 };
    const fact = '原文尾部事实为收入120万元。';
    const direct = normalizeMaterials([{ text: '甲'.repeat(6500) + fact }]);
    assert.match(JSON.stringify(buildSlidesMessages({ materials: direct })), /原文尾部事实/);
    const full = await prepareGenerationMaterials(direct, model, build, 2600, () => assert.fail('可装入窗口时不分段'), '年度汇报');
    assert.equal(full.coverage[0].mode, 'full');
    assert.match(JSON.stringify(build(full.materials)), /原文尾部事实/);

    const source = normalizeMaterials([{ text: '甲'.repeat(45000) + fact }]);
    const slices = [];
    const chunked = await prepareGenerationMaterials(source, model, build, 2600, async messages => {
        const part = JSON.parse(messages[1].content);
        slices.push(part.text);
        return { content: JSON.stringify({ quotes: part.text.includes(fact) ? [fact] : [] }) };
    }, '年度汇报');
    assert.equal(slices.join(''), source[0].text);
    assert.equal(chunked.coverage[0].chunks, slices.length);
    assert.match(chunked.materials[0].text, /原文字符 45000.*收入120万元/);
    await assert.rejects(prepareGenerationMaterials(source, model, build, 2600, async () => ({ content: '{"quotes":["虚构摘录"]}' }), '测试'), { code: 'PRESENTATION_MATERIAL_EXTRACTION_INVALID' });
    assert.throws(() => validateGenerationMaterials([{ text: '部分材料', truncated: true }]), { code: 'PRESENTATION_MATERIAL_INCOMPLETE' });
});

test('大纲三页先生成两页，重试只请求缺页并按原顺序编译，缺页不能交付', async () => {
    const roster = confirmedRoster({ outline: [{ section: '测试', slides: ['甲', '乙', '丙'].map(title => ({ title })) }] });
    const sent = [], reply = pages => ({ content: JSON.stringify({ slides: pages.map(page => ({ outlinePageId: page.outlinePageId, title: page.title, elements: [{
        id: 'title', type: 'text', x: 100, y: 100, height: 80, width: 500, content: { text: page.title }
    }] })) }) });
    const raw = await generateRosterPages(roster, async (pages, compact) => {
        sent.push(pages.map(page => page.outlinePageId));
        return reply(compact ? pages : [pages[2], pages[0]]);
    });
    assert.deepEqual(sent, [['outline_page_1', 'outline_page_2', 'outline_page_3'], ['outline_page_2']]);
    const compiled = await compilePresentationProposal(JSON.stringify({ ...raw, title: '测试' }), { templateId: 'business-blue' });
    assert.deepEqual(compiled.presentation.slides.map(page => page.id), roster.map(page => page.outlinePageId));
    await assert.rejects(generateRosterPages(roster, async () => reply([roster[0], roster[0]])), { code: 'PRESENTATION_SLIDE_COVERAGE_INCOMPLETE' });
});

test('后批超时前已逐批保存，补回页可保留用户编辑与原大纲位置', async () => {
    const roster = confirmedRoster({ slides: Array.from({ length: 7 }, (_, index) => ({ title: String(index + 1) })) });
    const saved = [];
    await assert.rejects(generateRosterPages(roster, async pages => {
        if (pages[0].outlinePageId === 'outline_page_6') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        return { content: JSON.stringify({ slides: pages }) };
    }, { onAccepted: async pages => saved.push(...pages.map(page => page.id)) }), { code: 'ETIMEDOUT' });
    assert.deepEqual(saved, roster.slice(0, 5).map(page => page.outlinePageId));

    const { mergeContent } = require('../server/services/presentations/presentation-generation-drafts');
    const ids = roster.slice(0, 3).map(page => page.outlinePageId);
    const first = { id: ids[0], speakerNotes: '手动编辑' };
    const result = mergeContent({ slides: [first, { id: ids[2] }], sources: [] }, [
        { id: ids[0], content: { slides: [{ id: ids[0], speakerNotes: '陈旧生成结果' }], sources: [] } },
        { id: ids[1], content: { slides: [{ id: ids[1] }, { id: ids[1] + '_part_2' }], sources: [] } }
    ], { roster: ids.map(id => ({ id })), pages: { [ids[0]]: [ids[0]], [ids[2]]: [ids[2]] } });
    assert.deepEqual(result.content.slides.map(slide => slide.id), [ids[0], ids[1], ids[1] + '_part_2', ids[2]]);
    assert.equal(result.content.slides[0].speakerNotes, first.speakerNotes);
    assert.deepEqual(result.pages[ids[1]], [ids[1], ids[1] + '_part_2']);
});
