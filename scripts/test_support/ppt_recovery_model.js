'use strict';
const fixture = require('./ppt_master_default_model');

function standard(messages, fail) {
    const prompt = String(messages.find(message => message.role === 'user')?.content || '');
    if (prompt.includes('outline 总页数')) return {
        title: '标准制作断点验收', outline: [{ section: '七页汇报', slides: Array.from({ length: 7 }, (_, index) => ({
            title: '大纲第' + (index + 1) + '页', purpose: '测试按页恢复', layoutHint: index ? 'design-content' : 'design-cover', keyPoints: ['根据已确认大纲生成']
        })) }], assumptions: []
    };
    const roster = JSON.parse(prompt.match(/^大纲：(.*)$/m)?.[1] || '{}').slides || [];
    const pages = fail ? roster.filter(page => Number(page.outlinePageId.split('_').at(-1)) <= 5) : roster;
    if (!fail && pages.some(page => Number(page.outlinePageId.split('_').at(-1)) <= 5)) throw new Error('续作不应重新请求已生成页');
    return { slides: pages.map(page => ({
        outlinePageId: page.outlinePageId, title: page.title,
        layout: page.outlinePageId === 'outline_page_1' ? 'cover' : 'content', points: ['根据已确认大纲生成'],
        speakerNotes: '原始备注', sourceRefs: []
    })) };
}

function master(messages, finish, citations = false, automatic = false) {
    if (messages.some(item => JSON.stringify(item.content).includes('PPT_MASTER_PREFLIGHT_V1'))) {
        return require('./ppt_master_model').pptMasterModelTurn(messages);
    }
    const assistant = messages.filter(message => message.role === 'assistant').flatMap(message => {
        try { return [JSON.parse(message.content)]; } catch (_) { return []; }
    });
    const exports = assistant.flatMap(turn => turn.actions || []).filter(action => action.tool === 'export');
    const designTurns = assistant.filter(turn => turn.requestInput?.stage === 'design');
    const system = messages.find(message => message.role === 'system')?.content || '';
    const budget = '项目预算80万元';
    const finalCost = '全年决算成本80.25万元';
    if (automatic && exports.length === 1) {
        if (!system.includes('自动修页')) return { complete: { path: exports[0].args.at(-1) } };
        const issues = messages.flatMap(message => {
            try { return JSON.parse(message.content)?.approvedPageRepairs || []; } catch (_) { return []; }
        });
        if (issues.length !== 1 || issues[0].page !== 2 || issues[0].items[0].text !== fixture.pages[1].fact) throw new Error('自动修页没有收到已批准的错页及数据');
        return { actions: [{ action: 'write', path: issues[0].sourceFile, text: fixture.slide(fixture.pages[1]) }] };
    }
    if (citations && exports.length === 1 && designTurns.length === 1) {
        if (system.includes('user-supplement:2')) {
            const text = finalCost;
            return { repairCitations: [{ page: 2, item: 1, text, path: 'user-supplement:2', quote: text }] };
        }
        const next = globalThis.structuredClone(designTurns[0]);
        next.requestInput.plan.pages[1].values[0] = { text: finalCost, source: { path: 'instruction', quote: finalCost } };
        return next;
    }
    if (citations && exports.length === 1 && designTurns.length === 2) finish = true;
    const action = exports.length === 1 && finish ? exports[0] : null;
    if (action) {
        const project = action.args[0];
        const revisedFact = citations ? designTurns.at(-1)?.requestInput.plan.pages[1].values[0].text || finalCost : '';
        return { actions: [
            { action: 'write', path: project + '/svg_output/slide_02.svg', text: fixture.slide(citations ? { ...fixture.pages[1], fact: revisedFact } : fixture.pages[1]) },
            { action: 'run', tool: 'check_svg', args: [project, '--canonical-authoring', '--stage', 'final', '--json'] },
            { action: 'run', tool: 'finalize', args: [project] },
            { action: 'run', tool: 'export', args: [project, '--no-notes', '-o', project + '/exports/repaired.pptx'] }
        ] };
    }
    if (exports.length === 1) return { actions: [{ action: 'write', path: '../outside.md', text: 'invalid fixture' }] };
    if (exports.length > 1) return { complete: { path: exports.at(-1).args.at(-1) } };
    const observations = messages.filter(message => message.role === 'user').map(message => {
        try { return JSON.parse(message.content); } catch (_) { return null; }
    });
    const request = observations.find(value => Array.isArray(value?.sources)) || { sources: [] };
    const next = fixture.turn(request, messages, assistant);
    if (citations && next.requestInput?.stage === 'design') {
        if (!assistant.some(turn => turn.requestInput?.kind === 'clarification')) {
            return { requestInput: { kind: 'clarification', question: '请补充项目预算及其单位。' } };
        }
        const fixing = system.includes('上一份清单有未通过核验的引用');
        if (fixing && !assistant.some(turn => turn.actions?.some(item => item.path === 'user-supplement:1'))) {
            return { actions: [{ action: 'read', path: 'user-supplement:1' }] };
        }
        const values = next.requestInput.plan.pages[0].values;
        const extra = { text: budget, source: { path: fixing ? 'user-supplement:1' : 'instruction', quote: budget } };
        if (fixing) values.unshift(extra);
        else values.push(extra);
    }
    const firstPage = next.actions?.find(item => item.path?.endsWith('/svg_output/slide_01.svg'));
    if (citations && firstPage) firstPage.text = firstPage.text.replace('</g></svg>',
        '<text x="128" y="375" font-family="Noto Sans CJK SC" font-size="32" fill="#17324D">' + budget + '</text></g></svg>');
    const secondPage = next.actions?.find(item => item.path?.endsWith('/svg_output/slide_02.svg'));
    // SVG 的同一个 text 对象内有完整数据，实际导出会拆开独立坐标的 tspan。
    if (secondPage) secondPage.text = fixture.slide(fixture.pages[1]).replace(fixture.pages[1].fact,
        '<tspan>全年核定成本</tspan><tspan x="280" y="362">80.25万元</tspan>');
    return next;
}

module.exports = { standard, master };
