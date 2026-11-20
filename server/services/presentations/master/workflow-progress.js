'use strict';

const runtime = require('./runtime');
const { imageCoverage } = require('./model-input');
const { pauseCitationReview } = require('./citation-repair');
const { isInspection } = require('./inspection-progress');
const { confirmedWrite } = require('./observations');

const FIRST_PAGE_INSPECTION_LIMIT = 6;

const phases = {
    design: { limit: 18, goal: '提交最终页面与关键数据清单' },
    template: { limit: 12, goal: '提交模板方案确认' },
    first_page: { limit: 16, goal: '完成规范并写入第一张页面 SVG' },
    template_files: { limit: 16, goal: '完成模板工作区并提交校验和交付' }
};

async function prepareManagedProject(state, execute) {
    const { operation, profile, inputFiles = [] } = state.request;
    if (state.engine?.managedProject !== 1 || operation !== 'generate' || !['default', 'quick'].includes(profile)) return;
    const findManagedProject = async () => {
        const files = (await execute({ action: 'list' })).files || [];
        const roots = files.map(file => /^((?:pivot_authoring)[\w-]*)\/validation\/workflow\.log$/.exec(file.path)?.[1]).filter(Boolean);
        if (roots.length > 1) throw runtime.error('发现多个预备项目，请核对当前任务的工作区。', 'PPT_MASTER_PROJECT_PREPARATION_FAILED', 422);
        return roots[0];
    };
    let project = await findManagedProject();
    if (!project) {
        const init = await execute({ action: 'run', tool: 'project', args: ['init', 'pivot_authoring', '--dir', '.',
            ...(profile === 'quick' ? ['--quick-generate'] : [])] });
        if (init.exitCode === 0) project = await findManagedProject();
    }
    if (!project) throw runtime.error('执行器未确认创建当前制作项目，请核对最近的工作区诊断。', 'PPT_MASTER_PROJECT_PREPARATION_FAILED', 422);
    const text = inputFiles.filter(file => file.kind === 'text').map(file => file.path);
    const intake = text.length ? await execute({ action: 'run', tool: 'project', args: ['import-sources', project, ...text, '--copy'] }) : null;
    state.managedProject = project;
    state.messages.push({ role: 'user', content: JSON.stringify({ managedProject: project, originalTextSnapshots: text,
        ...(intake ? { importedText: intake.exitCode === 0, intakeNote: '初始文字快照始终位于 inputs/；如需核证引文，以输入快照原文为准。' } : {}) }) });
}

function currentPhase(state) {
    const approvals = state.review?.approvals;
    if (!approvals) return '';
    if (state.request.operation === 'create_template') return approvals.template ? 'template_files' : 'template';
    if (!approvals.design) return 'design';
    return !state.milestones?.firstPageWrite && !state.lastExport && !state.pageRepair ? 'first_page' : '';
}

function progressFor(state) {
    const phase = currentPhase(state);
    if (!phase) return null;
    const previous = state.workflowProgress?.phase === phase ? state.workflowProgress : { phase, calls: 0 };
    return { ...previous, ...phases[phase] };
}

function allocateWorkflowCall(state) {
    const progress = progressFor(state);
    if (!progress) return '';
    const { phase, calls, goal, limit } = progress;
    if (calls >= limit) {
        if (phase === 'design' && state.citationRepair?.length) throw pauseCitationReview(state);
        throw runtime.error(`本阶段 ${limit} 轮后仍未达到「${goal}」。请核对材料、制作要求或模型后从检查点继续。`, 'PPT_MASTER_PHASE_LIMIT', 409);
    }
    state.workflowProgress = { phase, calls: calls + 1 };
    const images = imageCoverage(state);
    const focused = firstPageFocus(state);
    return [
        `当前阶段目标：${goal}。还可使用 ${limit - calls} 轮模型请求。读取只用于补齐当前阶段缺少的信息。`,
        phase === 'design' && '资料充分时直接提交有序的最终页面清单；只有缺少无法从材料核对的事实时才请求补充。',
        phase === 'first_page' && '沿用已登记的页面清单及所选模板。缺少设计规范或执行锁时先写入 design_spec.md、spec_lock.md，再按流程校验并写第一张 SVG。保留清单标题、关键数据和来源。已选定方向和风格后直接查阅对应指引，避开规划索引。无需等待旧版确认文件或实时预览。',
        focused && '已达到首张页面的连续只读轮次，请用现有资料写入设计规范或页面源稿，或者执行当前项目的必要校验、校准。可把确有必要的定向补读与写入或校验放在同一轮。缺少必需材料时提出具体问题。',
        state.managedProject && `宿主已准备项目 ${state.managedProject}。沿用该项目和已导入的文字材料，无需创建第二个项目。`,
        calls >= limit - 4 && (images.nextOffset !== null && phase === 'design'
            ? `先从 offset=${images.nextOffset} 读取尚未发给模型的图片，然后提交清单。`
            : '请使用已获得的内容完成本阶段目标。遇到阻断时，提出具体的补充问题或完成恢复所需的写入、校验。')
    ].filter(Boolean).join('\n');
}

function firstPageInspectionRounds(state) {
    if (Number.isSafeInteger(state.firstPageInspectionRounds)) return state.firstPageInspectionRounds;
    let reads = 0;
    const messages = state.messages || [];
    for (let index = messages.length - 2; index >= (state.workflowPhaseFrom || 0); index--) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        try {
            const { actions } = JSON.parse(messages[index].content);
            const results = JSON.parse(messages[index + 1].content);
            if (!Array.isArray(actions) || !Array.isArray(results)) continue;
            if (actions.some((action, offset) => confirmedPreparation(action, results[offset], state.managedProject))) break;
            if (actions.some(isInspection)) reads++;
        } catch (_) { continue; }
    }
    state.firstPageInspectionRounds = reads;
    return reads;
}

function firstPageFocus(state) {
    return state.request.draftFirst && state.managedProject && currentPhase(state) === 'first_page'
        && firstPageInspectionRounds(state) >= FIRST_PAGE_INSPECTION_LIMIT;
}

function confirmedPreparation(action, observation, project) {
    if (confirmedWrite(action, observation)) return action.path === project + '/design_spec.md' || action.path === project + '/spec_lock.md';
    return action?.action === 'run' && observation?.action === 'run' && observation.result?.exitCode === 0 && !observation.error
        && ((action.tool === 'project' && action.args?.[0] === 'validate' && action.args[1] === project)
            || (action.tool === 'text_measure' && action.args?.[0] === 'calibrate' && action.args[1] === project));
}

function isPreparationAction(action, project) {
    if (action?.action === 'write') return action.path.startsWith(project + '/')
        && /^(?:design_spec\.md|spec_lock\.md|svg_output\/[^/]+\.svg)$/i.test(action.path.slice(project.length + 1));
    return action?.action === 'run' && action.args?.[1] === project
        && (action.tool === 'project' && action.args[0] === 'validate' || action.tool === 'text_measure' && action.args[0] === 'calibrate');
}

function requireFirstPageProgress(state, turn) {
    if (firstPageFocus(state) && turn.actions && !turn.actions.some(action => isPreparationAction(action, state.managedProject))) {
        throw runtime.error('已连续多轮读取或检查，仍没有写入首张页面。请写入当前项目的设计规范或页面源稿，或执行项目校验、文字校准。缺少必要材料时请提出具体问题。', 'PPT_MASTER_AUTHORING_READ_LIMIT', 422);
    }
}

function recordFirstPageProgress(state, actions, observations) {
    if (!state.request.draftFirst || !state.managedProject) return;
    if (currentPhase(state) !== 'first_page') delete state.firstPageInspectionRounds;
    else if (actions.some((action, index) => confirmedPreparation(action, observations[index], state.managedProject))) state.firstPageInspectionRounds = 0;
    else state.firstPageInspectionRounds = (state.firstPageInspectionRounds || 0) + 1;
}

module.exports = { allocateWorkflowCall, progressFor, prepareManagedProject, requireFirstPageProgress, recordFirstPageProgress };
