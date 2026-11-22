'use strict';

const { confirmedWrite } = require('./observations');
const { error } = require('./runtime');
const { projectErrorBlock, projectValidationDetails, projectErrorKeys } = require('./project-validation-diagnostics');

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
    const detail = (projectErrorBlock(stdout) || stderr || '').slice(0, 10000);
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
    const errors = projectErrorBlock(result.stdout);
    return Boolean(errors) && errors.split(/\r?\n/).every(line =>
        /^\s*-\s+(?:spec_lock|design_spec)\.md schema: (?:unknown section|missing section|duplicate section|section '[\w-]+' (?:appears more than once|is missing field)|missing ppt-master-schema marker)\b/i.test(line));
}

function specName(action, project) {
    return action?.action === 'write' && specNames.find(name => action.path === project + '/' + name);
}

function changesProjectInputs(action, project) {
    return (['write', 'copy', 'copy_template'].includes(action.action) && action.path?.startsWith(project + '/')
        && !action.path.startsWith(project + '/svg_output/')) || (action.action === 'run'
        && (['apply_template', 'import_template', 'import_native', 'icon_sync'].includes(action.tool) || action.tool === 'project' && action.args?.[0] === 'import-sources'));
}

function receiptFor(prep, action, observation, project) {
    const name = specName(action, project);
    const write = name && confirmedWrite(action, observation);
    if (write) prep.files[name] = write.sha256;
    else if (isProjectValidation(action, project) && action.args.length === 2 && signature(prep.files) && observation) {
        const kinds = observation.projectIssues || projectIssueKinds(observation.result);
        const details = observation.result?.cachedSpecFailure ? prep.validation?.details : observation.projectDetails || projectValidationDetails(observation.result);
        const errorKeys = observation.result?.cachedSpecFailure ? prep.validation?.errorKeys
            : observation.projectErrorKeys || projectErrorKeys(observation.result);
        prep.validation = { signature: signature(prep.files), exitCode: observation.result?.exitCode ?? null, kinds, details, errorKeys,
            cacheable: deterministicSpecFailure(observation.result) || observation.result?.cachedSpecFailure === true };
    } else if (observation && changesProjectInputs(action, project)) {
        delete prep.validation;
    }
}

function restoreProjectDetails(state, validation) {
    const messages = state.messages || [];
    for (let index = messages.length - 2; index >= (state.workflowPhaseFrom || 0); index--) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        try {
            const { actions } = JSON.parse(messages[index].content);
            const position = actions?.findLastIndex(action => isProjectValidation(action, state.managedProject) && action.args.length === 2);
            if (position == null || position < 0) continue;
            const observation = JSON.parse(messages[index + 1].content)?.[position];
            if (!observation || observation.result?.cachedSpecFailure) continue;
            if (observation.result?.exitCode !== validation.exitCode) break;
            return projectValidationDetails(observation.result);
        } catch (_) { continue; }
    }
    return [];
}

function preparationFor(state) {
    const { managedProject: project, request } = state;
    if (request.operation !== 'generate' || request.profile !== 'default' || !request.draftFirst || !project
        || state.review?.approvals?.design?.plan?.project !== project || !state.engine?.tools?.includes('project')
        || state.pageRepair || state.lastExport) return null;
    if (!state.projectPreparation && state.milestones?.firstPageWrite && !state.authoringPages) return null;
    if (state.projectPreparation) {
        const validation = state.projectPreparation.validation;
        if (validation?.exitCode && !Array.isArray(validation.details)) validation.details = restoreProjectDetails(state, validation);
        return state.projectPreparation;
    }
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
    const ready = new Set(specNames.filter(name => prep.files[name]));
    const actions = [];
    let changed = false, dirty = ready.size === specNames.length && signature(prep.files) !== prep.validation?.signature;
    const validatePreparedFiles = () => {
        if (dirty && ready.size === specNames.length) {
            actions.push(projectValidationAction(project));
            changed = true;
            dirty = false;
        }
    };
    for (const action of turn.actions) {
        // 等同批的规范及引用资源落盘，在首次消费前或批次结束处校验。
        if (action.action === 'write' && action.path.startsWith(project + '/svg_output/')
            || action.action === 'run' && ['check_svg', 'finalize', 'export'].includes(action.tool) && action.args[0] === project) {
            validatePreparedFiles();
        }
        const name = specName(action, project);
        actions.push(action);
        if (name) ready.add(name);
        if (isProjectValidation(action, project) && action.args.length === 2) dirty = false;
        else if (changesProjectInputs(action, project)) dirty = true;
    }
    validatePreparedFiles();
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
    return { exitCode: prep.validation.exitCode, projectIssues: prep.validation.kinds, projectDetails: prep.validation.details || [],
        projectErrorKeys: prep.validation.errorKeys || [], cachedSpecFailure: true,
        message: '规范文件摘要未变化，已沿用上次失败结果。请先写回修正内容，宿主将重新校验。' };
}

function recordProjectPreparation(state, action, observation) {
    const prep = preparationFor(state);
    if (prep) receiptFor(prep, action, observation, state.managedProject);
}

function projectPreparationGuidance(state) {
    const prep = preparationFor(state);
    if (!prep || prep.validation?.exitCode === 0 && prep.validation.signature === signature(prep.files)) return '';
    const { kinds = [], details = [] } = prep.validation || {};
    const detail = projectIssueText(kinds);
    const scaffolds = specNames.filter(name => !kinds.length || kinds.includes(name === specNames[0] ? 'design' : 'lock') || kinds.includes('communication'))
        .map(name => 'templates/scaffolds/' + name).join('、');
    const reference = scaffolds ? '需要核对结构时，用 read_runtime 读取 ' + scaffolds + '。' : '';
    return detail
        ? '上次项目校验：' + detail + '。' + (details.length ? '具体问题：' + details.join('；') + '。' : '') + reference
            + '按诊断直接修正对应文件。已有文件正文可复用，无需重复读取。规范修正写入后由宿主重新校验；引用文件或临时执行问题解决后可复检。'
        : signature(prep.files) && prep.validation?.exitCode === null
            ? '上次项目校验没有取得执行器结果。按工具回执排查连接或参数，使用 project validate 和当前项目目录重试。'
            : '先写入完整 design_spec.md 和 spec_lock.md。' + reference
                + '沿用脚手架的 schema 首行、标题和字段，填入实际内容。执行锁需填写 ## communication，设计规范 §IX 每个 Slide 需填写 Audience move 和 Relationships。两份规范可用后宿主校验，通过后再写 SVG。';
}

function missingValidationRead(state, action, failure) {
    return action.action === 'read' && state.managedProject && action.path?.startsWith(state.managedProject + '/validation/')
        && failure.code === 'PPT_MASTER_OPERATION_FAILED' && /^任务文件不存在[。.]?$/.test(failure.message);
}

module.exports = { withProjectValidation, pendingProjectValidation, requireValidatedProject, previousProjectFailure,
    recordProjectPreparation, isProjectValidation, projectPreparationGuidance, projectIssueKinds, projectIssueText, missingValidationRead };
