'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMaterials } = require('../server/services/presentations/presentation-evidence');
const { buildOutlineMessages, buildSlidesMessages, compilePresentationProposal } = require('../server/services/presentations/presentation-ai');
const { validateGenerationMaterials, prepareGenerationMaterials, confirmedRoster, generateRosterPages } = require('../server/services/presentations/presentation-generation-coverage');
const { compileGenerationPage, assembleGeneratedProposal } = require('../server/services/presentations/presentation-generation-drafts');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');

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

test('失败片段只重试一次，空白等价摘录落回原文与准确位置', async () => {
    const original = '指标(A+B)  等于\n120 万元';
    const source = normalizeMaterials([{ text: original + '\n' + '后文'.repeat(21000) }]);
    const model = { context_window_tokens: 32000 };
    const build = materials => buildOutlineMessages({ topic: '经营汇报', materials });
    const calls = [];
    const result = await prepareGenerationMaterials(source, model, build, 2600, async (messages, options) => {
        const { start } = JSON.parse(messages[1].content);
        calls.push([start, options.sourceSuffix]);
        const quotes = start ? [] : options.sourceSuffix === '_material_retry' ? ['指标(A+B) 等于 120 万元'] : ['指标(A+B) 等于 121 万元'];
        return { content: JSON.stringify({ quotes }) };
    }, '经营汇报');
    assert.deepEqual(calls.slice(0, 2), [[0, '_material'], [0, '_material_retry']]);
    assert.equal(calls.filter(([start]) => start === 0).length, 2);
    assert.ok(result.materials[0].text.startsWith(`[原文字符 0–${original.length}] ${original}`));
    const ambiguous = normalizeMaterials([{ text: original + '\n' + original + '\n' + '后文'.repeat(21000) }]);
    let retries = 0;
    await assert.rejects(prepareGenerationMaterials(ambiguous, model, build, 2600, async () => {
        retries++;
        return { content: '{"quotes":["指标(A+B) 等于 120 万元"]}' };
    }, '经营汇报'), { code: 'PRESENTATION_MATERIAL_EXTRACTION_INVALID' });
    assert.equal(retries, 2);
});

test('已编译页先保存，只有失败页重试，已确认的图表不能被正文替换', async () => {
    const outline = { title: '经营汇报', slides: [{ title: '经营概况' }, { title: '收入走势', layoutHint: 'chart' }, { title: '行动建议' }] };
    const roster = confirmedRoster(outline);
    const template = getBuiltInTemplate('executive-clean');
    const request = { outline, template, templateId: template.id, materials: [] };
    const content = page => ({ outlinePageId: page.outlinePageId, title: page.title, layout: 'content', points: ['保留已确认的重点'] });
    const saved = [], calls = [];
    const result = await generateRosterPages(roster, async (pages, compact, feedback) => {
        calls.push(pages.map(page => page.outlinePageId));
        if (!compact) return { content: JSON.stringify({ slides: pages.map(content) }) };
        assert.deepEqual(saved, ['outline_page_1', 'outline_page_3']);
        assert.deepEqual(feedback.map(item => item.outlinePageId), ['outline_page_2']);
        return { content: JSON.stringify({ slides: [{ ...content(pages[0]), layout: 'chart',
            chart: { type: 'bar', columns: ['指标', '数值'], rows: [['已核实收入', 120]] } }] }) };
    }, {
        compilePage: (page, confirmed) => compileGenerationPage(page, confirmed, request, {}),
        onAccepted: async compiled => saved.push(...compiled.map(page => page.id))
    });
    assert.deepEqual(calls, [['outline_page_1', 'outline_page_2', 'outline_page_3'], ['outline_page_2']]);
    const proposal = assembleGeneratedProposal(roster, result, outline.title);
    assert.deepEqual(proposal.presentation.slides.map(slide => slide.id), roster.map(page => page.outlinePageId));
    assert.ok(proposal.presentation.slides[1].elements.some(element => element.type === 'chart'));
});

test('输出截断后逐页重试，首批的一页仍失败时继续保存后续批次', async () => {
    const roster = confirmedRoster({ slides: Array.from({ length: 6 }, (_, index) => ({ title: '页面 ' + index })) });
    const saved = [], sent = [];
    await assert.rejects(generateRosterPages(roster, async (pages, compact) => {
        sent.push(pages.map(page => page.outlinePageId));
        const firstPage = pages[0].outlinePageId === 'outline_page_1';
        return { truncated: firstPage && !compact,
            content: JSON.stringify({ slides: firstPage ? [] : pages }) };
    }, { onAccepted: async pages => saved.push(...pages.map(page => page.id)) }), { code: 'PRESENTATION_SLIDE_COVERAGE_INCOMPLETE' });
    assert.deepEqual(sent[0], roster.slice(0, 5).map(page => page.outlinePageId));
    assert.deepEqual(sent.slice(1), roster.map(page => [page.outlinePageId]));
    assert.deepEqual(saved, roster.slice(1).map(page => page.outlinePageId));
    const truncated = async () => ({ truncated: true, content: '{}' });
    await assert.rejects(generateRosterPages(roster.slice(0, 1), truncated), { code: 'PRESENTATION_AI_OUTPUT_TRUNCATED' });
});

test('两种页面生成示例都要求原样复制大纲标识，缺失或猜测标识不能据页序补齐', async () => {
    const [page] = confirmedRoster({ slides: [{ title: '已确认页' }] });
    for (const id of ['executive-clean', 'business-blue']) {
        const prompt = buildSlidesMessages({ templateId: id, enforcePageIds: true, outline: { slides: [page] } })[1].content;
        assert.match(prompt, /"outlinePageId":"复制本批对应大纲页标识"/);
    }
    await assert.rejects(generateRosterPages([page], async () => ({ content: '{"slides":[{"id":"slide_1","title":"已确认页"}]}' })),
        { code: 'PRESENTATION_SLIDE_COVERAGE_INCOMPLETE' });
});
