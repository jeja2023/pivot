'use strict';

const { posix } = require('node:path');
const { parse: parsePageXml } = require('../presentation-pptx-xml');
const { compact, containsValue } = require('./citation-repair');
const { confirmedWrite } = require('./observations');
const { error } = require('./runtime');

const SVG = 'http://www.w3.org/2000/svg';
const pageDirectories = new Set(['svg_output', 'authoring-svg-flat', 'authoring-svg-layered']);
const nonRendering = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'title', 'desc', 'metadata']);
const zeroOpacity = value => value !== null && /^(?:0+(?:\.0+)?|\.0+)%?$/.test(value.trim());

function tableCellText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value?.paragraphs)) return value.paragraphs.map(part =>
        typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text
            : Array.isArray(part?.runs) ? part.runs.map(run => typeof run?.text === 'string' ? run.text : '').join('') : ''
    ).join(' ');
    return typeof value?.text === 'string' ? value.text : '';
}

function tableRows(node) {
    const kind = node.getAttribute('data-pptx-replace-with') || node.getAttribute('data-pptx-native');
    if (node.localName !== 'g' || kind !== 'table') return [];
    const metadata = Array.from(node.childNodes).find(child =>
        child.nodeType === 1 && child.namespaceURI === SVG && child.localName === 'metadata' && child.getAttribute('type') === 'application/json');
    let data;
    try { data = JSON.parse(metadata?.textContent || node.getAttribute('data-pptx-json') || 'null'); }
    catch (_) { return []; }
    if (data?.schema !== 'ppt-master.semantic-table.v2') return [];
    return [data.columns, ...(Array.isArray(data.rows) ? data.rows : [])].flatMap(row => {
        if (!Array.isArray(row)) return [];
        const cells = row.map(tableCellText);
        return [...cells, cells.join(' ')];
    });
}

function authoringGate(state, plan = state.review?.approvals?.design?.plan) {
    const { operation, profile, draftFirst } = state.request;
    if (!draftFirst || operation !== 'generate' || !['default', 'quick'].includes(profile)
        || !state.engine?.tools?.includes('check_svg') || !state.managedProject || state.managedProject !== plan?.project
        || !plan.pages?.length) return null;
    if (!state.authoringPages && (state.milestones?.firstPageWrite || state.lastExport || state.pageRepair)) return null;
    return state.authoringPages ||= { paths: {}, first: 'unwritten' };
}

function sourcePath(action, project) {
    if (!['write', 'copy'].includes(action.action) || !action.path?.startsWith(project + '/')) return '';
    const [dir, file, extra] = action.path.slice(project.length + 1).split('/');
    return pageDirectories.has(dir) && file && /\.svg$/i.test(file) && !extra ? action.path : '';
}

function pageNumber(path) {
    return Number(/^(?:[A-Za-z]+[-_]?)?(\d+)(?:[-_][\w.-]+)?\.svg$/i.exec(posix.basename(path))?.[1]);
}

function hidden(node) {
    const style = node.getAttribute('style') || '';
    return node.getAttribute('display') === 'none' || ['hidden', 'collapse'].includes(node.getAttribute('visibility'))
        || zeroOpacity(node.getAttribute('opacity'))
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*(?:0+(?:\.0+)?|\.0+)%?)\s*(?:;|$)/i.test(style);
}

function visibleText(root) {
    const fragments = [], tables = [];
    function collectSvgFragments(node, inText = false) {
        if (node.nodeType === 3 || node.nodeType === 4) return inText ? node.nodeValue || '' : '';
        if (node.nodeType !== 1 || node.namespaceURI !== SVG || nonRendering.has(node.localName) || hidden(node)) return '';
        tables.push(...tableRows(node));
        const fromText = inText || node.localName === 'text';
        const parts = Array.from(node.childNodes, child => collectSvgFragments(child, fromText));
        if (inText) return parts.join('');
        if (fromText) fragments.push(parts.join(''));
        return '';
    }
    collectSvgFragments(root);
    return { fragments, tables };
}

function sourceError(message, page, kind) {
    return Object.assign(error(message, 'PPT_MASTER_PAGE_SOURCE_REVIEW_REQUIRED', 422), { pageCheck: { page, kind } });
}

function requirePageSource(state, action) {
    const plan = state.review?.approvals?.design?.plan;
    const gate = authoringGate(state, plan);
    if (!gate) return;
    const path = sourcePath(action, plan.project);
    if (!path) return;
    const page = pageNumber(path), expected = plan.pages[page - 1];
    if (action.action !== 'write' || !expected || !path.endsWith('.svg') || posix.dirname(path) !== plan.project + '/svg_output') {
        throw sourceError('请用 write 写入当前项目 svg_output 下带页码的源稿，例如 slide_01.svg。', null, 'source_path');
    }
    if (gate.paths[page] && gate.paths[page] !== path || Object.entries(gate.paths).some(([number, other]) =>
        other !== path && (Number(number) < page) !== (other < path))) {
        throw sourceError('请沿用已写入的文件名，确保 SVG 文件名排序与已登记的页序一致。', page, 'source_path');
    }
    if (!state.pageRepair && page !== 1 && gate.first !== 'passed') {
        throw sourceError('请先写入并通过第 1 页检查，再继续制作后续页面。', 1, 'first_page_pending');
    }
    let fragments, tables;
    try {
        const { documentElement } = parsePageXml(action.text);
        if (documentElement?.localName !== 'svg' || documentElement.namespaceURI !== SVG) throw new Error('缺少有效的 SVG 根节点');
        ({ fragments, tables } = visibleText(documentElement));
    } catch (_) {
        throw sourceError(`第 ${page} 页 SVG 格式无效，请修正后重新写入。`, page, 'source_xml');
    }
    const missingTitle = !fragments.some(fragment => compact(fragment).includes(compact(expected.title)));
    const contents = [...fragments, ...tables];
    const missingValues = expected.values.flatMap((value, index) =>
        value.chart || contents.some(fragment => containsValue(fragment, value.text)) ? [] : [index + 1]);
    if (missingTitle || missingValues.length) {
        const detail = [missingTitle ? '完整标题' : '', ...missingValues.map(item => '第 ' + item + ' 项正文')].filter(Boolean);
        throw sourceError(`第 ${page} 页缺少清单中的${detail.join('、')}。各项请逐字写入独立可见 <text> 对象，同一对象可用 <tspan> 换行。`, page, 'source_content');
    }
}

function firstPageAction(state, path) {
    const { managedProject, request } = state;
    return { action: 'run', tool: 'check_svg', args: [
        managedProject, ...(request.profile === 'quick' ? ['--quick-generate'] : []),
        '--canonical-authoring', '--stage', 'page', '--page', path, '--json'
    ] };
}

function withFirstPageCheck(state, turn) {
    if (!turn.actions || !authoringGate(state) || state.pageRepair) return turn;
    const index = turn.actions.findIndex(action => action.action === 'write' && pageNumber(sourcePath(action, state.managedProject)) === 1);
    if (index < 0) return turn;
    const actions = [...turn.actions];
    const check = firstPageAction(state, actions[index].path);
    actions.splice(index + 1, 0, check);
    return { ...turn, actions };
}

function resumeFirstPageCheck(state) {
    if (!state.pageRepair && authoringGate(state)?.first === 'pending') {
        return { actions: [firstPageAction(state, state.authoringPages.paths[1])] };
    }
    return null;
}

function recordPageProof(state, action, observation) {
    const gate = state.authoringPages;
    if (!gate || state.pageRepair) return;
    const path = sourcePath(action, state.managedProject);
    if (path && confirmedWrite(action, observation)) {
        const page = pageNumber(path);
        gate.paths[page] = path;
        if (page === 1) gate.first = 'pending';
        return;
    }
    if (gate.first === 'pending' && action.action === 'run' && action.tool === 'check_svg'
        && JSON.stringify(action.args) === JSON.stringify(firstPageAction(state, gate.paths[1]).args)) {
        gate.first = !observation.error && observation.result?.exitCode === 0 ? 'passed' : 'failed';
        if (gate.first === 'failed') observation.pageCheck = { page: 1, kind: 'first_page_layout' };
    }
}

function authoringPageGuidance(state) {
    const gate = authoringGate(state);
    if (!gate || state.pageRepair) return '';
    return [
        '按清单页序写入当前项目的 svg_output/slide_01.svg、slide_02.svg 等。完整标题和正文各用一个可见 SVG <text>，逐字保留清单中的内容。原生表格可用对应单元格或同行数据。用同一对象内的 <tspan> 换行时保持共同起点，坐标独立的片段可能被导出为不同文本框。',
        gate.first !== 'passed' && '先写第 1 页，宿主立即执行单页检查。通过后再制作后续页。首张页面的内容分组需声明 data-pptx-bounds，文字需留出边界余量。'
    ].filter(Boolean).join(' ');
}

function requireAuthoringPages(state, project) {
    if (state.pageRepair || project !== state.managedProject) return;
    const plan = state.review?.approvals.design?.plan;
    const gate = authoringGate(state, plan);
    if (!gate) return;
    const missing = plan.pages.flatMap((_, index) => gate.paths[index + 1] ? [] : [index + 1]);
    if (gate.first !== 'passed' || missing.length) {
        throw sourceError(gate.first !== 'passed' ? '导出前须通过首张 SVG 检查。'
            : '导出前仍需写入第 ' + missing.join('、') + ' 页。', gate.first !== 'passed' ? 1 : missing[0], 'first_page_pending');
    }
}

module.exports = { requirePageSource, withFirstPageCheck, resumeFirstPageCheck, recordPageProof, authoringPageGuidance, requireAuthoringPages };
