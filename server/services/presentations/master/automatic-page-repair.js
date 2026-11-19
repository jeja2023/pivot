'use strict';

const { error } = require('./runtime');
const { confirmedWrite } = require('./observations');
const MAX_PASSES = 2;

function beginPageRepair(state, project, path) {
    const draft = state.reviewDraft, review = state.pageReview, last = state.lastExport;
    const previous = state.pageRepair;
    if (!draft || !review || !state.pageSources || state.engine?.pageRepair !== 1 || last?.path !== path || last.args?.[0] !== project
        || previous && !previous.automatic || (previous?.pass || 0) >= MAX_PASSES) return false;
    const pages = review.failedPages.map(item => item.page);
    if (previous && pages.some(page => !previous.pages.includes(page))) return false;
    if (!pages.length || review.failedPages.some(page => !page.missingTitle && !page.items.length)) return false;
    const pass = (previous?.pass || 0) + 1;
    const output = project + '/exports/repair-' + draft.sha256.slice(0, 16) + '-' + pass + '.pptx';
    const args = [];
    for (let index = 0; index < last.args.length; index++) {
        const arg = last.args[index];
        if (arg === '-o' || arg === '--output') index++;
        else if (!arg.startsWith('--output=')) args.push(arg);
    }
    const sourceFiles = pages.map(page => state.pageSources[page - 1]);
    state.pageRepair = { automatic: true, pass, sha256: draft.sha256, pages, sourceFiles, remaining: [...sourceFiles],
        phase: 'edit', output, args: [...args, '-o', output], toolFailures: 0 };
    state.messages.push({ role: 'user', content: JSON.stringify({ approvedPageRepairs: review.failedPages.map((issue, index) => ({
        ...issue, sourceFile: sourceFiles[index]
    })) }) });
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
        repair.phase = 'edit';
        repair.remaining = [...repair.sourceFiles];
        if (++repair.toolFailures >= MAX_PASSES) {
            stopAutomaticRepair(state);
            throw error('错页源稿复检或导出连续失败，已保存工具诊断与草稿，请查看制作记录。', 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', 422);
        }
        return;
    }
    if (action.tool === 'check_svg') repair.phase = repair.args.includes('--quick-generate') ? 'export' : 'finalize';
    if (action.tool === 'finalize') repair.phase = 'export';
    if (action.tool === 'export') {
        if (result.progressExport !== repair.output) {
            stopAutomaticRepair(state);
            throw error('未收到修订文件的本次导出回执，请重新导出。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
        }
        repair.phase = 'deliver';
    }
}

module.exports = { beginPageRepair, automaticTurn, recordRepairResult, stopAutomaticRepair };
