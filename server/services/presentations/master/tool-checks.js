'use strict';

const { error } = require('./runtime');
const { posix } = require('node:path');

function recordCheck(state, action, result) {
    const check = action.action === 'validate_template' || action.action === 'run' && (
        ['check_svg', 'finalize'].includes(action.tool) || action.tool === 'project' && action.args[0] === 'validate');
    if (!check || !Number.isInteger(result?.exitCode)) return;
    const id = checkId(action);
    state.failedChecks = (state.failedChecks || []).filter(item => checkId(item) !== id);
    if (result.exitCode !== 0) state.failedChecks.push(action);
    if (!state.failedChecks.length) delete state.failedChecks;
}

function checkId(action) {
    return JSON.stringify([action.action, action.tool, action.args, action.path, action.kind]);
}

function requireChecks(state, project, actions = []) {
    const remaining = state.failedChecks?.filter(check => {
        const raw = check.action === 'validate_template' ? check.path : check.args[check.tool === 'project' ? 1 : 0];
        const target = raw && !raw.startsWith('-') && posix.normalize(raw);
        return (!target || target === '.' || target === project || target.startsWith(project + '/'))
            && !actions.some(action => checkId(action) === checkId(check));
    });
    if (remaining?.length) throw error('导出前须修正并重新通过已失败的检查：' + JSON.stringify(remaining), 'PPT_MASTER_ACTION_INVALID', 422);
}

module.exports = { recordCheck, requireChecks };
