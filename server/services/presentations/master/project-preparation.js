'use strict';

const { confirmedWrite } = require('./observations');
const { error } = require('./runtime');

const specNames = ['design_spec.md', 'spec_lock.md'];
const reasons = {
    design: '设计规范的结构、字段或页序需修正',
    lock: '执行锁的结构、字段或取值需修正',
    communication: '需补全设计规范与执行锁的沟通字段',
    layout: '模板版式或资源引用需核对',
    other: '项目结构校验失败，请按执行器回执修正'
};

function isProjectValidation(action, project) {
    return action?.action === 'run' && action.tool === 'project'
        && action.args?.[0] === 'validate' && action.args[1] === project;
}

function projectIssueKinds(result) {
    if (!Number.isInteger(result?.exitCode) || result.exitCode === 0) return [];
    const { stdout = '', stderr = '' } = result;
    const block = /(?:^|\n)\[ERROR\]\s*\r?\n([\s\S]*?)(?=\r?\n\s*\[|$)/.exec(stdout);
    const detail = (block?.[1] || stderr || '').slice(0, 10000);
    const found = [
        [/design_spec(?:\.md)?|design spec/i, 'design'],
        [/spec_lock(?:\.md)?|execution lock/i, 'lock'],
        [/communication trace|communication section/i, 'communication'],
        [/prototype|layout.*(?:missing|invalid|unknown)|(?:missing|invalid|unknown).* layout/i, 'layout']
    ].flatMap(([pattern, kind]) => pattern.test(detail) ? [kind] : []);
    return found.length ? found : ['other'];
}

function projectIssueText(kinds) {
    return (kinds || []).map(kind => reasons[kind]).filter(Boolean).join('，');
}

function signature(files) {
    return specNames.every(name => files[name]) ? specNames.map(name => files[name]).join(':') : '';
}

function deterministicSpecFailure(result) {
    if (result?.exitCode !== 1 || result.truncated || result.stderr?.trim()) return false;
    const errors = /(?:^|\n)\[ERROR\]\s*\r?\n([\s\S]*?)(?=\r?\n\s*\[|$)/.exec(result.stdout || '')?.[1]?.trim();
    return Boolean(errors) && errors.split(/\r?\n/).every(line =>
        /^\s*-\s+(?:spec_lock|design_spec)\.md schema: (?:unknown section|missing section|duplicate section)\b/i.test(line));
}

function specName(action, project) {
    return action?.action === 'write' && specNames.find(name => action.path === project + '/' + name);
}

function receiptFor(prep, action, observation, project) {
    const name = specName(action, project);
    const write = name && confirmedWrite(action, observation);
    if (write) prep.files[name] = write.sha256;
    else if (isProjectValidation(action, project) && action.args.length === 2 && signature(prep.files) && observation) {
        const kinds = observation.projectIssues || projectIssueKinds(observation.result);
        prep.validation = { signature: signature(prep.files), exitCode: observation.result?.exitCode ?? null, kinds,
            cacheable: deterministicSpecFailure(observation.result) || observation.result?.cachedSpecFailure === true };
    } else if ((['write', 'copy', 'copy_template'].includes(action.action) && action.path?.startsWith(project + '/')
        && !action.path.startsWith(project + '/svg_output/')) || (action.action === 'run'
            && (['apply_template', 'import_template', 'import_native', 'icon_sync'].includes(action.tool) || action.tool === 'project' && action.args?.[0] === 'import-sources'))) {
        delete prep.validation;
    }
}

function preparationFor(state) {
    const { managedProject: project, request } = state;
    if (request.operation !== 'generate' || request.profile !== 'default' || !request.draftFirst || !project
        || state.review?.approvals?.design?.plan?.project !== project || !state.engine?.tools?.includes('project')
        || state.pageRepair || state.lastExport) return null;
    if (!state.projectPreparation && state.milestones?.firstPageWrite && !state.authoringPages) return null;
    if (state.projectPreparation) return state.projectPreparation;
    const prep = { files: {} };
    const messages = state.messages || [];
    for (let index = state.workflowPhaseFrom || 0; index + 1 < messages.length; index++) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        try {
            const { actions } = JSON.parse(messages[index].content);
            const observations = JSON.parse(messages[index + 1].content);
            if (Array.isArray(actions) && Array.isArray(observations)) {
                actions.forEach((action, offset) => receiptFor(prep, action, observations[offset], project));
            }
        } catch (_) { continue; }
    }
    state.projectPreparation = prep;
    return prep;
}

function projectValidationAction(project) {
    return { action: 'run', tool: 'project', args: ['validate', project] };
}

function withProjectValidation(state, turn) {
    const prep = turn.actions && preparationFor(state);
    if (!prep) return turn;
    const project = state.managedProject;
    const ready = new Set(Object.keys(prep.files));
    const actions = [];
    let changed = false, scheduled = false;
    for (let index = 0; index < turn.actions.length; index++) {
        const action = turn.actions[index];
        const name = specName(action, project);
        actions.push(action);
        if (isProjectValidation(action, project)) continue;
        if (!name) continue;
        ready.add(name);
        // 相邻的规范写入先完成，再校验同一次修改，避免校验半对文件。
        if (ready.size === specNames.length && !specName(turn.actions[index + 1], project)
            && !isProjectValidation(turn.actions[index + 1], project) && !scheduled) {
            actions.push(projectValidationAction(project));
            scheduled = changed = true;
        }
    }
    return changed ? { ...turn, actions } : turn;
}

function pendingProjectValidation(state) {
    const prep = preparationFor(state);
    const current = prep && signature(prep.files);
    return current && current !== prep.validation?.signature ? { actions: [projectValidationAction(state.managedProject)] } : null;
}

function requireValidatedProject(state, action) {
    const prep = preparationFor(state);
    const project = state.managedProject;
    if (!prep || action?.action !== 'write' || !action.path?.startsWith(project + '/svg_output/')) return;
    if (!signature(prep.files) || prep.validation?.signature !== signature(prep.files) || prep.validation.exitCode !== 0) {
        throw error('首张及后续页面需使用已通过项目校验的设计规范与执行锁。请先写入或修正规范文件。',
            'PPT_MASTER_PROJECT_SPEC_REVIEW_REQUIRED', 422);
    }
}

function previousProjectFailure(state, action) {
    const prep = preparationFor(state);
    if (!prep || !isProjectValidation(action, state.managedProject) || action.args.length !== 2
        || prep.validation?.signature !== signature(prep.files) || !prep.validation?.cacheable || !prep.validation.exitCode) return null;
    return { exitCode: prep.validation.exitCode, projectIssues: prep.validation.kinds, cachedSpecFailure: true,
        message: '规范文件摘要未变化，已沿用上次失败结果。请按上次执行器回执改正字段后再校验。' };
}

function recordProjectPreparation(state, action, observation) {
    const prep = preparationFor(state);
    if (prep) receiptFor(prep, action, observation, state.managedProject);
}

function projectPreparationGuidance(state) {
    const prep = preparationFor(state);
    if (!prep || prep.validation?.exitCode === 0 && prep.validation.signature === signature(prep.files)) return '';
    const detail = projectIssueText(prep.validation?.kinds);
    return detail
        ? '上次项目校验：' + detail + '。按执行器回执核对规范、引用文件和运行状态，修正后重新执行 project validate。'
        : signature(prep.files) && prep.validation?.exitCode === null
            ? '上次项目校验没有取得执行器结果。按工具回执排查连接或参数，使用 project validate 和当前项目目录重试。'
            : '先写入完整 design_spec.md 和 spec_lock.md。按真实运行包模板的 schema 首行、字段和值域编写。宿主在两份规范可用后执行 project validate，通过后再写 SVG。';
}

function missingValidationRead(state, action, failure) {
    return action.action === 'read' && state.managedProject && action.path?.startsWith(state.managedProject + '/validation/')
        && failure.code === 'PPT_MASTER_OPERATION_FAILED' && /^任务文件不存在[。.]?$/.test(failure.message);
}

module.exports = { withProjectValidation, pendingProjectValidation, requireValidatedProject, previousProjectFailure,
    recordProjectPreparation, isProjectValidation, projectPreparationGuidance, projectIssueKinds, projectIssueText, missingValidationRead };
