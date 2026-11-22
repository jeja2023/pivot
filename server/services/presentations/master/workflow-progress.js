'use strict';

const runtime = require('./runtime');
const { imageCoverage } = require('./model-input');
const { pauseCitationReview } = require('./citation-repair');
const FIRST_PAGE_FINISHING_ROUNDS = 4;

const phases = {
    design: { limit: 18, goal: '提交最终页面与关键数据清单' },
    template: { limit: 12, goal: '提交模板方案确认' },
    first_page: { limit: 16, goal: '完成规范、写入并检查第一张页面 SVG' },
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
    const awaitingFirst = state.authoringPages ? state.authoringPages.first !== 'passed' : !state.milestones?.firstPageWrite;
    return awaitingFirst && !state.lastExport && !state.pageRepair ? 'first_page' : '';
}

function progressFor(state) {
    const phase = currentPhase(state);
    if (!phase) return null;
    const previous = state.workflowProgress?.phase === phase ? state.workflowProgress : { phase, calls: 0 };
    const { goal, limit } = phases[phase];
    return { ...previous, goal, limit: ['design', 'first_page'].includes(phase) ? Math.max(limit, previous.finishBy || 0) : limit };
}

function assertWorkflowCapacity(state) {
    const progress = progressFor(state);
    if (!progress) return null;
    const { phase, calls, goal, limit } = progress;
    if (calls >= limit) {
        if (phase === 'design' && state.citationRepair?.length) throw pauseCitationReview(state);
        throw runtime.error(`本阶段 ${limit} 轮后仍未达到「${goal}」。请核对材料、制作要求或模型后从检查点继续。`, 'PPT_MASTER_PHASE_LIMIT', 409);
    }
    return progress;
}

function recordWorkflowCall(state) {
    const progress = progressFor(state);
    if (!progress) return;
    const { goal: _goal, limit: _limit, ...saved } = progress;
    state.workflowProgress = { ...saved, calls: progress.calls + 1 };
}

function workflowGuidance(state) {
    const progress = assertWorkflowCapacity(state);
    if (!progress) return '';
    const { phase, calls, goal, limit } = progress;
    const images = imageCoverage(state);
    return [
        `当前阶段目标：${goal}。还可使用 ${limit - calls} 轮模型请求。读取只用于补齐当前阶段缺少的信息。`,
        phase === 'design' && '资料充分时直接提交有序的最终页面清单；只有缺少无法从材料核对的事实时才请求补充。',
        phase === 'first_page' && '沿用已登记的页面清单及所选模板。缺少设计规范或执行锁时先写入 design_spec.md、spec_lock.md，再按流程校验并写第一张 SVG。保留清单标题、关键数据和来源。已选定方向和风格后直接查阅对应指引，避开规划索引。无需等待旧版确认文件或实时预览。',
        state.managedProject && `宿主已准备项目 ${state.managedProject}。沿用该项目和已导入的文字材料，无需创建第二个项目。`,
        calls >= limit - 4 && (images.nextOffset !== null && phase === 'design'
            ? `先从 offset=${images.nextOffset} 读取尚未发给模型的图片，然后提交清单。`
            : '请使用已获得的内容完成本阶段目标。遇到阻断时，提出具体的补充问题或完成恢复所需的写入、校验。')
    ].filter(Boolean).join('\n');
}

function recordFirstPageProgress(state) {
    const progress = state.workflowProgress;
    if (progress?.phase !== 'first_page' || currentPhase(state) !== 'first_page') return;
    const { files, validation } = state.projectPreparation || {};
    const ready = files?.['design_spec.md'] && files?.['spec_lock.md'];
    const validated = ready && validation?.signature === files['design_spec.md'] + ':' + files['spec_lock.md'] && validation.exitCode === 0;
    // 每个实际里程碑只增加一次收尾机会，反复改写同一份文件不会续期。
    const milestone = state.milestones?.firstPageWrite ? 3 : validated ? 2 : ready ? 1 : 0;
    if (milestone > (progress.milestone || 0)) {
        progress.milestone = milestone;
        progress.finishBy = Math.max(progress.finishBy || 0, progress.calls + FIRST_PAGE_FINISHING_ROUNDS);
    }
}

module.exports = { assertWorkflowCapacity, recordWorkflowCall, workflowGuidance, progressFor, prepareManagedProject, recordFirstPageProgress };
