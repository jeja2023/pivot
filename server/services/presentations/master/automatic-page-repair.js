'use strict';

const { error } = require('./runtime');
const { confirmedWrite } = require('./observations');
const { posix } = require('node:path');
const { checkIssues, lastPageCheck, repairIssuesText } = require('./repair-check-diagnostics');
const MAX_PASSES = 2;

function buildRepair(state, project, pages, pass) {
    const { reviewDraft: draft, lastExport: last } = state;
    if (!project || !Array.isArray(last?.args) || last.args[0] !== project
        || typeof last.path !== 'string' || !last.path.startsWith(project + '/exports/') || !/\.pptx$/i.test(last.path)) return null;
    const sourceFiles = pages.map(page => state.pageSources[page - 1]);
    if (!sourceFiles.every(path => typeof path === 'string' && path.startsWith(project + '/svg_output/'))) return null;
    const output = project + '/exports/repair-' + draft.sha256.slice(0, 16) + '-' + (state.steps || 0) + '-' + pass + '.pptx';
    const args = [];
    for (let index = 0; index < last.args.length; index++) {
        const arg = last.args[index];
        if (arg === '-o' || arg === '--output') index++;
        else if (!arg.startsWith('--output=')) args.push(arg);
    }
    return { automatic: true, pass, sha256: draft.sha256, pages, sourceFiles, remaining: [...sourceFiles],
        phase: 'edit', output, args: [...args, '-o', output], toolFailures: 0 };
}

function beginPageRepair(state, project, path) {
    const { reviewDraft: draft, pageReview: review, lastExport: last, pageRepair: previous } = state;
    if (!draft || !review || !state.pageSources || state.engine?.pageRepair !== 1 || last?.path !== path
        || previous && !previous.automatic || (previous?.pass || 0) >= MAX_PASSES) return false;
    const pages = review.failedPages.map(item => item.page);
    if (previous && pages.some(page => !previous.pages.includes(page))) return false;
    if (!pages.length || review.failedPages.some(page => !page.missingTitle && !page.items.length)) return false;
    return startPageRepair(state, project, pages, (previous?.pass || 0) + 1);
}

function startPageRepair(state, project, pages, pass, { note = '', previousPages } = {}) {
    const repair = buildRepair(state, project, pages, pass);
    if (!repair) return false;
    const sameScope = previousPages && JSON.stringify(previousPages) === JSON.stringify(pages);
    if (sameScope && !note) {
        const issues = lastPageCheck(state, project);
        const focused = issues.filter(issue => pages.includes(issue.page));
        if (focused.length) repair.remaining = focused.map(({ page }) => state.pageSources[page - 1]);
        repair.checkIssues = issues;
    }
    state.pageRepair = repair;
    state.messages.push({ role: 'user', content: JSON.stringify({
        approvedPageRepairs: state.pageReview.failedPages.filter(issue => pages.includes(issue.page)).map(issue => ({
            ...issue, sourceFile: state.pageSources[issue.page - 1]
        })),
        ...(note ? { userRepairNote: note } : {})
    }) });
    return true;
}

function automaticTurn(state) {
    const repair = state.pageRepair;
    if (!repair?.automatic || repair.phase === 'edit') return null;
    if (repair.phase === 'deliver') return { complete: { path: repair.output } };
    const project = repair.args[0], quick = repair.args.includes('--quick-generate');
    const actions = [];
    if (repair.phase === 'check') actions.push({ action: 'run', tool: 'check_svg', args: [
        project, ...(quick ? ['--quick-generate'] : []), '--canonical-authoring', '--stage', 'final', '--json'
    ] });
    if (!quick && repair.phase !== 'export') actions.push({ action: 'run', tool: 'finalize', args: [project] });
    actions.push({ action: 'run', tool: 'export', args: repair.args });
    return { actions };
}

function stopAutomaticRepair(state) {
    if (state.pageRepair?.automatic) {
        const { sha256, pages, sourceFiles } = state.pageRepair;
        state.pageRepair = { sha256, pages, sourceFiles };
    }
}

function recordRepairResult(state, action, observation, result = observation.result) {
    if (action.tool === 'export' && result?.exitCode === 0) {
        if (result.progressExport) state.lastExport = { path: result.progressExport, args: action.args };
        else delete state.lastExport;
    }
    const repair = state.pageRepair;
    if (!repair?.automatic) return;
    if (action.action === 'read') {
        const needed = repair.sourceFiles.includes(action.path) || state.pageReview?.failedPages.some(page =>
            page.items.some(item => item.source?.path === action.path));
        if (needed && observation.error && /不存在|找不到|已不可用|No such file|ENOENT/i.test(observation.error)) repair.missingSource = action.path;
        if (!observation.error && repair.missingSource === action.path) delete repair.missingSource;
    }
    if (confirmedWrite(action, observation)) {
        repair.remaining = repair.remaining.filter(path => path !== action.path);
        if (!repair.remaining.length) repair.phase = 'check';
    }
    if (repair.phase === 'edit' || action.action !== 'run') return;
    if (observation.error || result?.exitCode !== 0) {
        const issues = action.tool === 'check_svg' ? checkIssues(result, state.pageSources) : [];
        const selected = issues.filter(({ page }) => repair.pages.includes(page));
        if (issues.length && !selected.length) {
            stopAutomaticRepair(state);
            throw error(`整稿复检发现未选页未通过：${repairIssuesText(issues)}。已保留草稿和未选页，请选择重新生成整份。`, 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', 422);
        }
        const previousPages = repair.checkIssues?.filter(({ page }) => repair.pages.includes(page)).map(({ page }) => page) || [];
        const narrowed = selected.length > 0 && selected.length < previousPages.length && selected.every(({ page }) => previousPages.includes(page));
        repair.phase = 'edit';
        repair.checkIssues = issues;
        repair.remaining = selected.length ? selected.map(({ page }) => state.pageSources[page - 1]) : [...repair.sourceFiles];
        const failures = ++repair.toolFailures;
        if (failures >= MAX_PASSES && !(failures === MAX_PASSES && narrowed)) {
            stopAutomaticRepair(state);
            const detail = repairIssuesText(issues);
            throw error(`错页源稿复检或导出连续失败${detail ? '：' + detail : ''}。已保留草稿，请查看制作记录。`, 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', 422);
        }
        return;
    }
    if (action.tool === 'check_svg') {
        delete repair.checkIssues;
        repair.phase = repair.args.includes('--quick-generate') ? 'export' : 'finalize';
    }
    if (action.tool === 'finalize') repair.phase = 'export';
    if (action.tool === 'export') {
        if (result.progressExport !== repair.output) {
            stopAutomaticRepair(state);
            throw error('未收到修订文件的本次导出回执，请重新导出。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
        }
        repair.phase = 'deliver';
    }
}

function repairPrompt(repair) {
    if (!repair?.automatic) return '';
    const detail = repairIssuesText(repair.checkIssues);
    return [
        `自动修页。按 approvedPageRepairs 保留清单标题、数据和未选页。本轮只需读取必要文件，并用 write 写回剩余源页：${repair.remaining.map(path => posix.normalize(path)).join('、')}。`,
        detail && `最近一次整稿复检：${detail}。优先解决本轮源页的阻断项，其他页由宿主保护。`,
        '保留其余设计。区域重叠时调整对应模块的边界及位置，字号优先沿用 spec_lock 已声明的字号。完整标题和关键文字须各自放在一个可回读的文字对象中，需要换行时在同一对象内用 tspan。',
        '写完后宿主负责整稿复检、定稿、导出和回读。材料无法读取时再请求具体补充。'
    ].filter(Boolean).join(' ');
}

module.exports = { beginPageRepair, startPageRepair, automaticTurn, recordRepairResult, stopAutomaticRepair, repairPrompt };
