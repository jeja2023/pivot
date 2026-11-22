'use strict';

const { error } = require('./runtime');
const { posix } = require('node:path');

function checkTarget(action) {
    const path = action.action === 'validate_template' ? action.path : action.args?.[action.tool === 'project' ? 1 : 0];
    return path && !path.startsWith('-') ? posix.normalize(path).replace(/\/$/, '') : '';
}

function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
}

function svgMode(args) {
    if (args.includes('--template-mode')) return 'template';
    if (args.includes('--roundtrip')) return 'roundtrip';
    return args.includes('--quick-generate') ? 'quick' : 'default';
}

function svgDirectory(target) {
    return posix.basename(target) === 'svg_output' ? target : posix.join(target, 'svg_output');
}

function svgPage(action) {
    const target = checkTarget(action), page = option(action.args, '--page');
    if (!target || !page) return '';
    const directory = svgDirectory(target);
    if (page.startsWith('svg_output/')) return posix.join(posix.dirname(directory), page);
    return page.includes('/') ? posix.normalize(page) : posix.join(directory, page);
}

function coversCheck(candidate, failed) {
    if (candidate.action !== failed.action || candidate.tool !== failed.tool) return false;
    const target = checkTarget(candidate);
    const previous = checkTarget(failed);
    if (candidate.action === 'validate_template') return target === previous && candidate.kind === failed.kind;
    if (candidate.tool === 'project') return candidate.args[0] === 'validate' && failed.args[0] === 'validate' && target === previous;
    if (candidate.tool === 'finalize') return target === previous;
    if (candidate.tool !== 'check_svg' || !target || !previous) return false;
    const args = candidate.args, old = failed.args;
    if (['--roundtrip', '--template-mode', '--quick-generate'].some(flag => args.includes(flag) !== old.includes(flag))) return false;
    if (old.includes('--template-mode')) return target === previous && option(args, '--template-kind') === option(old, '--template-kind');
    if (old.includes('--roundtrip')) return target === previous;
    const stage = option(args, '--stage'), previousStage = option(old, '--stage');
    if (stage === 'final' && !option(args, '--page') && args.includes('--canonical-authoring') && svgDirectory(previous) === svgDirectory(target)) return true;
    if (stage === 'page' && previousStage === 'page' && svgPage(candidate) && svgPage(candidate) === svgPage(failed)) {
        return !old.includes('--canonical-authoring') || args.includes('--canonical-authoring');
    }
    return target === previous && stage === previousStage && option(args, '--page') === option(old, '--page')
        && (!old.includes('--canonical-authoring') || args.includes('--canonical-authoring'));
}

function matchesPageCheck(action, expected) {
    return action?.action === 'run' && action.tool === 'check_svg' && option(action.args, '--stage') === 'page'
        && action.args.includes('--canonical-authoring') && svgMode(action.args) === svgMode(expected.args)
        && svgDirectory(checkTarget(action)) === svgDirectory(checkTarget(expected)) && svgPage(action) === svgPage(expected);
}

function recordCheck(state, action, result) {
    const check = action.action === 'validate_template' || action.action === 'run' && (
        ['check_svg', 'finalize'].includes(action.tool) || action.tool === 'project' && action.args[0] === 'validate');
    if (!check || !Number.isInteger(result?.exitCode)) return;
    const id = checkId(action);
    state.failedChecks = (state.failedChecks || []).filter(item => checkId(item) !== id
        && !(result.exitCode === 0 && coversCheck(action, item)));
    if (result.exitCode !== 0) state.failedChecks.push(action);
    if (!state.failedChecks.length) delete state.failedChecks;
}

function checkId(action) {
    return JSON.stringify([action.action, action.tool, action.args, action.path, action.kind]);
}

function requireChecks(state, project, actions = [], { exportArgs, templateKind } = {}) {
    const last = state.lastExport?.args;
    const mode = svgMode(exportArgs || (last?.[0] === project ? last : null) || (state.request?.operation === 'edit_native' ? ['--roundtrip']
        : state.request?.profile === 'quick' ? ['--quick-generate'] : []));
    const remaining = state.failedChecks?.filter(check => {
        const target = checkTarget(check);
        const blocks = templateKind
            ? check.action === 'validate_template' && target === project && check.kind === templateKind
                || check.tool === 'check_svg' && target === project && svgMode(check.args) === 'template' && option(check.args, '--template-kind') === templateKind
            : check.action === 'run' && (check.tool === 'check_svg'
                ? (target === project || target === project + '/svg_output') && mode === svgMode(check.args)
                : target === project && mode !== 'roundtrip' && (check.tool === 'project' || mode === 'default'));
        return blocks && !actions.some(action => checkId(action) === checkId(check) || coversCheck(action, check));
    });
    if (remaining?.length) throw error('导出前须修正并重新通过已失败的检查：' + JSON.stringify(remaining), 'PPT_MASTER_ACTION_INVALID', 422);
}

module.exports = { recordCheck, requireChecks, matchesPageCheck };
