'use strict';

const runtime = require('./runtime');
const { getRunnableModelForUserAsync, getModelDailyUsageAsync } = require('../../models');
const { runModelTurn } = require('./model-turn');
const { boundedObservation, confirmedWrite, summarizeExecutedTurn, recordTurnDiagnostic, READ_PAGE_CHARS, HISTORY_PAGE_CHARS } = require('./observations');
const { archiveOlderObservations, readHistory } = require('./history');
const { createInspectionProgress } = require('./inspection-progress');
const { pendingInput, planDigest, isLegacyDirection } = require('./confirmation');
const { markMilestone } = require('./milestones');
const { validateTurn, repairedTurn } = require('./actions');
const { writeCorrection } = require('./action-parameters');
const { recordCheck, requireChecks } = require('./tool-checks');
const { beginPageRepair, automaticTurn, recordRepairResult, stopAutomaticRepair, repairPrompt } = require('./automatic-page-repair');
const { checkIssues, repairIssuesText } = require('./repair-check-diagnostics');
const { requirePageSource, withFirstPageCheck, resumeFirstPageCheck, recordPageProof, authoringPageGuidance, requireAuthoringPages } = require('./authoring-pages');
const { pendingProjectValidation, requireValidatedProject, previousProjectFailure, recordProjectPreparation,
    isProjectValidation, projectPreparationGuidance, projectIssueKinds, projectIssueText, missingValidationRead } = require('./project-preparation');
const { loadTemplateSpec, installTemplate } = require('./template-application');
const { applyReviewDecision, recordDraftPlan, reopenReview, resetCitationRepair, exportReview, verifyReceipt, pageReviewFor, pageRepairSources, reviewGuidance } = require('./review-plan');
const { pauseCitationReview, canUseCitationDraft, draftWithCitationPlaceholders, CITATION_REVIEW_REQUIRED } = require('./citation-repair');
const { selectImagePage, imageCoverage } = require('./model-input');
const { registerSupplement, getSupplement, readSupplement, supplementGuidance, prepareRevisionSources, recordRevisionRead } = require('./user-supplements');
const { workflowGuidance, progressFor, prepareManagedProject, recordFirstPageProgress } = require('./workflow-progress');
const { deliverWithRecovery } = require('./delivery-recovery');
const { sourceBundleLimit } = require('./delivery');
const { listWorkspace } = require('./workspace-list');
const { projectValidationDetails, projectErrorKeys } = require('./project-validation-diagnostics');
const { checklistLimits } = require('./checklist-limits');
const { batchGuidance } = require('./plan-batches');
const { imageReviewTurn } = require('./image-evidence');

const AUTHORITY = {
    generate: { default: 'workflows/generate-pptx.md', quick: 'workflows/profiles/quick-generate.md', beautify: 'workflows/profiles/beautify-pptx.md', image_to_pptx: 'workflows/profiles/image-to-pptx.md' },
    create_template: { default: 'workflows/create-template.md' }, edit_native: { default: 'workflows/edit-native-pptx.md' }
};
const { initialMessages } = require('./host-protocol');

async function resolveModel(user, request) {
    const model = await getRunnableModelForUserAsync(request.modelId, user);
    if (!model || model.secret_error) throw runtime.error('所选制作模型不可用，请检查当前账号授权与模型配置。', 'PPT_MASTER_MODEL_UNAVAILABLE', 403);
    if (Number(model.daily_token_limit) > 0 && await getModelDailyUsageAsync(user.id, model.id) >= Number(model.daily_token_limit)) throw runtime.error('当前模型今日额度已用完。', 'PPT_MASTER_QUOTA_EXCEEDED', 429);
    return model;
}
const correctable = new Set(['PPT_MASTER_ACTION_INVALID', 'PPT_MASTER_MODEL_OUTPUT_INVALID', 'PPT_MASTER_MODEL_TRUNCATED',
    'PPT_MASTER_CHECKLIST_REQUIRED', 'PPT_MASTER_PAGE_SOURCE_REVIEW_REQUIRED']);
const MAX_CITATION_REPAIRS = 3;
const MAX_INSPECTION_REPAIRS = 2;
const PAGED_READS = new Set(['read', 'read_runtime', 'read_history']);
const CITATION_REPAIR_GUIDANCE = '上一份清单有未通过核验的引用。按实际数据项核对引用，优先用本轮 citationRepairEvidence.excerpt 和已读取的原文。quote 必须保留原文，覆盖页面显示数据的指标、精确数值和限定条件。人民币单位换算及百分比小数位调整须精确等值。只有现有证据不足时才定向读取缺失的材料范围；仍缺事实时提出具体的补充问题。';
const CITATION_PATCH_GUIDANCE = 'savedCitationPlan 是本轮待修的完整清单。修正已有 id 的数据项时，返回 repairCitations 数组，每项只填 id、path 和原文 quote。其余由宿主保留。确需更正数据时用 correctedText，图表数字变化时同时填 correctedNumber，口径须可唯一核实。若修正 titleClaim 或 missing 项，需要重提完整清单，并在受影响页提供 titleSource 或修订标题、补齐缺项。';
const INSPECTION_REPAIR_GUIDANCE = '当前正在从重复检查中恢复。先根据已有文件和回执选择下一项实际制作步骤，适用时提交本阶段确认、局部写入、校验或导出。需要继续读资料时，只请求明确尚未读到的范围。缺少推进所必需的事实时提交具体问题。遵守已确认的方案和原有确认顺序。';
function resetInspectionRepair(state) {
    delete state.inspectionRepairPending;
    delete state.inspectionRepairAttempts;
    delete state.inspectionDiagnostic;
}

async function nextTurn(user, id, state, hooks, deps, inspection) {
    let correction = '', actionRepair;
    let model;
    let fieldRetries = 0;
    const verifySource = async path => path === 'instruction' ? state.request.instruction
        : (await (deps.inputBuffer || runtime.inputBuffer)(user, id, path.slice('inputs/'.length), 500000)).toString('utf8');
    for (;;) {
        const current = progressFor(state);
        const savedImageCandidate = state.retryImageCandidate;
        if (!savedImageCandidate && state.request.draftFirst && current?.phase === 'design' && (current.calls >= current.limit || inspection.stalled())) {
            const draft = draftWithCitationPlaceholders({ citationDraft: state.citationDraft, citationIssues: state.citationRepair });
            if (draft) return { turn: { requestInput: draft }, pendingCitations: state.citationRepair, recoveredPlan: true };
        }
        const images = imageCoverage(state);
        const imageHint = state.review && images.total ? `图片覆盖 ${images.read}/${images.total}，下一未读 offset=${images.nextOffset ?? '无'}。` : '';
        const guidance = [!savedImageCandidate && workflowGuidance(state), batchGuidance(state), inspection.guidance(), reviewGuidance(state), projectPreparationGuidance(state),
            authoringPageGuidance(state), supplementGuidance(state), imageHint, correction,
            state.templateSpec && '按 selectedTemplateSpec.text 和已安装模板制作。确需查阅任务副本时，用 read 读取 selected-template/templates/design_spec.md。可填 plan.templateUse:{rule,page,visibleText} 供风格复核，rule 引用模板第 II 至 VII 节正文，visibleText 对应该页标题或关键数据。宿主核对模板安装记录。',
            state.pageRepair && `按页修复范围为第 ${state.pageRepair.pages.join('、')} 页。根据用户指示修改这几页的原页面文件，不改变页序、其他页、共享版式、主题或资源。保留原清单，校验并重新导出当前项目。`,
            state.pageRepair?.automatic ? repairPrompt(state.pageRepair)
                : state.pageRepair && `本次可写文件：${state.pageRepair.sourceFiles.join('、')}。导出时用 -o 指定当前项目 exports 下的 PPTX 文件。`,
            state.citationRepair && CITATION_REPAIR_GUIDANCE, state.citationRepair && state.citationDraft && CITATION_PATCH_GUIDANCE,
            state.inspectionRepairPending && INSPECTION_REPAIR_GUIDANCE].filter(Boolean).join('\n');
        delete state.retryImageCandidate;
        const { output, usageRef, readResultBudget } = savedImageCandidate
            ? { output: savedImageCandidate, usageRef: {}, readResultBudget: Infinity }
            : await runModelTurn(user, id, state, model ||= await (deps.resolveModel || resolveModel)(user, state.request), hooks, deps, guidance, state.citationRepair);
        await hooks.ensureCurrent();
        if (state.request.tokenBudget !== 0 && state.usedTokens > state.request.tokenBudget) throw runtime.error('本次制作的实际模型用量已超过预算，本轮未继续执行制作动作。检查点已保留。', 'PPT_MASTER_BUDGET_EXHAUSTED', 429);
        let candidate;
        try {
            if (usageRef.truncated) throw runtime.error('模型输出被截断。清单请改用 planPages 分批提交，制稿请拆为单页或减少同轮动作。', 'PPT_MASTER_MODEL_TRUNCATED', 422);
            candidate = repairedTurn(output, actionRepair);
            const turn = await validateTurn(candidate, state, verifySource);
            if (turn.complete?.path) requireAuthoringPages(state, turn.complete.path.split('/exports/')[0]);
            if (turn.requestInput?.plan?.templateUse && state.installedTemplateProject !== turn.requestInput.plan.project) {
                await hooks.ensureCurrent();
                await installTemplate(state, turn.requestInput.plan.project, op => (deps.execute || runtime.execute)(user, id, op, hooks));
                state.installedTemplateProject = turn.requestInput.plan.project;
            }
            return { turn: withFirstPageCheck(state, turn), readResultBudget, pendingCitations: turn.batchIssues };
        } catch (failure) {
            const progress = progressFor(state);
            const designLimitReached = progress?.phase === 'design' && progress.calls >= progress.limit;
            const diagnostic = { correctionKind: failure.correctionKind, citationPatchIgnored: failure.citationPatchIgnored, actionFieldIssues: failure.actionFieldIssues,
                actionIndex: failure.actionIndex, actionType: failure.actionType, rejectedFields: failure.rejectedFields };
            const correctionReason = failure.correctionKind === 'action_fields' && failure.actionType === 'write'
                ? failure.message + writeCorrection : failure.message;
            if (failure.citationIssues) {
                const review = imageReviewTurn(state, candidate, failure.citationIssues);
                if (review) return { turn: review };
                if (savedImageCandidate) {
                    const draft = draftWithCitationPlaceholders(failure);
                    if (draft) return { turn: { requestInput: draft }, pendingCitations: failure.citationIssues, recoveredPlan: true };
                }
                const attempts = Number(state.citationRepairAttempts || 0);
                const keepPrior = state.request.draftFirst && canUseCitationDraft(state.citationDraft, state.citationRepair)
                    && failure.citationIssues.some(issue => issue.missing);
                const unchanged = keepPrior || JSON.stringify(state.citationRepair) === JSON.stringify(failure.citationIssues);
                if (!keepPrior) {
                    state.citationRepair = failure.citationIssues;
                    state.citationDraft = failure.citationDraft;
                }
                const facts = new Map((state.citationFacts || []).map(fact => [fact.key, fact]));
                if (!keepPrior) for (const fact of failure.citationFacts) {
                    if (!fact.titleClaim) facts.set(fact.key, { ...fact, allowOmit: facts.get(fact.key)?.allowOmit === true });
                }
                const first = state.citationRepair[0];
                const maximumFacts = checklistLimits(state).total;
                const exhausted = attempts >= MAX_CITATION_REPAIRS || facts.size > maximumFacts || designLimitReached
                    || Boolean(state.request.draftFirst && unchanged);
                const draft = exhausted && state.request.draftFirst && draftWithCitationPlaceholders({
                    citationDraft: state.citationDraft, citationIssues: state.citationRepair
                });
                recordTurnDiagnostic(state, { ...diagnostic, outcome: draft ? 'citation_placeholder' : exhausted ? 'failed' : 'retry',
                    errorCode: CITATION_REVIEW_REQUIRED, citationCount: state.citationRepair.length,
                    ...(typeof first?.location === 'string' ? { citationLocation: first.location } : {}) });
                if (exhausted) {
                    state.citationFacts = [...facts.values()].slice(0, maximumFacts);
                    if (draft) return { turn: { requestInput: draft }, readResultBudget, pendingCitations: state.citationRepair };
                    throw pauseCitationReview(state);
                }
                state.citationFacts = [...facts.values()];
                state.citationRepairAttempts = attempts + 1;
                state.actionRetries = Number(state.actionRetries || 0) + 1;
                state.lastActionCorrection = CITATION_REVIEW_REQUIRED;
                await hooks.checkpoint(state, { phase: 'authoring', message: `正在查证并修复清单引用（第 ${state.citationRepairAttempts}/${MAX_CITATION_REPAIRS} 次）。` });
                continue;
            }
            if (state.request.draftFirst && progress?.phase === 'design' && state.citationDraft && state.citationRepair?.length && correctable.has(failure.code)) {
                const attempts = state.citationRepairAttempts = Number(state.citationRepairAttempts || 0) + 1;
                const exhausted = attempts > MAX_CITATION_REPAIRS || designLimitReached;
                const draft = exhausted && draftWithCitationPlaceholders({ citationDraft: state.citationDraft, citationIssues: state.citationRepair });
                recordTurnDiagnostic(state, { ...diagnostic, outcome: draft ? 'citation_placeholder' : exhausted ? 'failed' : 'retry',
                    errorCode: failure.code, citationCount: state.citationRepair.length });
                if (draft) return { turn: { requestInput: draft }, readResultBudget, pendingCitations: state.citationRepair };
                if (exhausted) throw pauseCitationReview(state);
                correction = '引文修复回复未通过。' + correctionReason + '请只修正当前待核对项，已经通过的页面由宿主保留。';
                state.actionRetries = Number(state.actionRetries || 0) + 1;
                state.lastActionCorrection = CITATION_REVIEW_REQUIRED;
                await hooks.checkpoint(state, { phase: 'authoring', message: '正在按已保存清单修复引文。' });
                continue;
            }
            if (designLimitReached && state.citationRepair?.length && correctable.has(failure.code)) {
                recordTurnDiagnostic(state, { outcome: 'failed', errorCode: failure.code });
                const draft = state.request.draftFirst && draftWithCitationPlaceholders({ citationDraft: state.citationDraft, citationIssues: state.citationRepair });
                if (draft) return { turn: { requestInput: draft }, pendingCitations: state.citationRepair, recoveredPlan: true };
                throw pauseCitationReview(state);
            }
            const issues = failure.actionFieldIssues;
            const previous = actionRepair?.issues;
            const countFields = entries => entries.reduce((sum, item) => sum + item.rejectedFields.length, 0);
            const improved = fieldRetries < 6 && issues?.length && previous?.length && countFields(issues) < countFields(previous)
                && issues.every(issue => previous.some(item => item.actionIndex === issue.actionIndex && item.actionType === issue.actionType
                    && issue.rejectedFields.every(field => item.rejectedFields.includes(field))));
            const willRetry = Boolean(state.review && (!correction || improved) && correctable.has(failure.code));
            recordTurnDiagnostic(state, { ...diagnostic, outcome: willRetry ? 'retry' : 'failed', ...(failure.code ? { errorCode: failure.code } : {}) });
            if (!willRetry) throw failure;
            correction = '上一回复未执行任何制作动作。请修正并只返回一个合法 JSON 对象。问题：' + correctionReason;
            if (issues?.length && Array.isArray(candidate?.actions)) {
                actionRepair = { turn: candidate, issues };
                fieldRetries++;
                correction += issues.length === 1
                    ? `宿主暂存了本批动作。可只提交 repairAction，在其中填入完整的第 ${failure.actionIndex} 项 ${failure.actionType} 动作。宿主按原顺序复核整批。若需改动其他项，请重提完整 actions。`
                    : '宿主暂存了本批动作。可提交 repairActions 数组，每项含从 1 开始的原批次 index 和完整的 action 对象。全部复核通过后按原顺序执行。';
            }
            state.actionRetries = Number(state.actionRetries || 0) + 1;
            state.lastActionCorrection = failure.code;
            let message = '模型操作格式或制作阶段不符，正在修正一次。';
            if (failure.correctionKind || failure.pageCheck) message = failure.message;
            else if (state.pageRepair?.automatic) message = '修页操作未通过校验。请仅写回已选源页，复检、定稿和导出由宿主执行。';
            await hooks.checkpoint(state, { phase: 'authoring', message });
        }
    }
}
async function drive(user, id, state, hooks, deps = {}) {
    const execute = deps.execute || runtime.execute;
    const request = state.request;
    if (!state.bootstrapped) {
        await hooks.ensureCurrent();
        await hooks.checkpoint(state, { phase: 'preflight', message: '正在核对完整制作运行包的固定版本和内容摘要。' });
        const health = await execute(user, id, { action: 'health' }, hooks);
        if (health.status !== 'ready' || (health.serviceProtocol !== 1 && health.contentDigest !== runtime.lock.contentDigest)) throw runtime.error('完整制作引擎没有通过运行包及服务协议预检。');
        if (state.review && health.deliveryChecklist !== 1) throw runtime.error('当前执行服务缺少交付清单核验能力，请更新镜像后继续。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 503);
        if (state.review && request.operation !== 'create_template' && health.currentExport !== 1) throw runtime.error('当前执行服务缺少修订稿版本核验能力，请更新镜像后继续。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 503);
        state.engine = health; state.messages = initialMessages(request);
        for (const file of ['SKILL.md', 'workflows/routing.md', AUTHORITY[request.operation][request.profile]]) {
            await hooks.checkpoint(state, { phase: 'loading_workflow', message: '正在载入完整制作指引：' + file });
            const read = await execute(user, id, { action: 'read_runtime', path: file, length: 60000 }, hooks);
            state.messages.push({ role: 'user', content: JSON.stringify({ runtimeDocument: file, ...read }) });
        }
        if (request.template?.type === 'runtime') {
            const selected = require('../presentation-template-catalog').runtimeTemplate(request.template.id);
            if (!selected) throw runtime.error('固定发行包中没有此模板。');
            const copy = { action: 'copy_template', source: selected.path, path: 'selected-template' };
            if (health.selectedTemplateRecovery === 1) {
                await execute(user, id, { ...copy, ensureSelectedTemplate: true }, hooks);
            } else {
                const files = await execute(user, id, { action: 'list' }, hooks);
                if (!files.files?.some(file => file.path.startsWith('selected-template/'))) await execute(user, id, copy, hooks);
            }
            const validation = await execute(user, id, { action: 'validate_template', path: 'selected-template', kind: selected.kind }, hooks);
            if (validation.exitCode !== 0) throw runtime.error('所选模板未通过上游工作区校验。');
            state.messages.push({ role: 'user', content: JSON.stringify({ selectedTemplate: { name: selected.name, kind: selected.kind, workspace: 'selected-template' }, instruction: '用户明确选择此模板。已复制到任务目录并通过上游模板校验。按所选制作流程读取模板指引并应用，不修改只读发行包。' }) });
        }
        await prepareManagedProject(state, action => execute(user, id, action, hooks));
        state.workflowPhaseFrom = state.messages.length;
        state.bootstrapped = true;
        await hooks.checkpoint(state, { phase: 'authoring', message: '已载入完整制作流程，开始规划页面。' });
    }
    if (state.request.template?.type === 'runtime' && !state.templateSpec) {
        await hooks.ensureCurrent();
        await loadTemplateSpec(state, op => execute(user, id, op, hooks));
        if (state.review?.approvals.design && !state.review.approvals.design.plan.templateUse) reopenReview(state);
        await hooks.checkpoint(state, { phase: 'authoring', message: '已读取所选模板的原始规范，正在核对最终项目。' });
    }
    if (state.response) {
        const response = typeof state.response === 'string' ? { decision: 'revise', answer: state.response } : state.response;
        const pending = pendingInput(id, state);
        const legacyDirection = isLegacyDirection(pending);
        const continueDraft = response.decision === 'continue';
        const approved = !legacyDirection && response.decision === 'approve' && state.pendingKind === 'confirmation'
            && response.promptId === pending?.promptId;
        let source = response.source;
        if (!approved && response.answer && !source) source = registerSupplement(state, response.answer, response.decision, response.promptId);
        if (source && state.pendingInput?.imageReview) {
            const { origin, candidate } = state.pendingInput.imageReview;
            state.reviewedImageDigests = [...new Set([...(state.reviewedImageDigests || []), origin.digest])];
            if (response.answer.trim() !== '跳过') (state.imageTranscriptions ||= {})[origin.path] = { source, digest: origin.digest };
            state.retryImageCandidate = candidate;
        }
        if (source) {
            if (state.pageRepair?.automatic) delete state.pageRepair.missingSource;
            resetCitationRepair(state, { allowRevision: response.decision === 'revise' });
            if (state.pendingKind === 'clarification' && !state.pageRepair) reopenReview(state);
        }
        let repeatedApproval = false;
        if (state.review && state.pendingKind === 'confirmation' && pending?.stage) {
            const changed = applyReviewDecision(state, pending, approved);
            repeatedApproval = approved && !changed;
            if (changed && approved) markMilestone(state, 'firstApproval');
        } else if (state.pendingKind === 'confirmation' && !legacyDirection) {
            state.confirmationRevisionPending = !approved;
            if (approved) {
                state.confirmationReceipts ||= [];
                const digest = planDigest(pending);
                repeatedApproval = state.confirmationReceipts.some(receipt => receipt.planDigest === digest);
                if (!repeatedApproval) {
                    state.confirmationReceipts.push({ promptId: response.promptId, planDigest: digest });
                    state.confirmedGates = state.confirmationReceipts.length;
                    markMilestone(state, 'firstApproval');
                }
            }
        }
        const answer = legacyDirection || continueDraft ? '旧方案作为历史参考。请直接准备最终页面与关键数据清单，宿主自动核验后开始制作初稿。' + (response.answer || '')
            : repeatedApproval ? '用户已再次确认同一方案。'
            : approved ? '已明确确认当前方案。' : state.pendingKind === 'confirmation'
            ? '用户提供了修改意见，请调整后重新提交本阶段方案。' + (response.answer || '')
            : response.answer || '';
        state.messages.push({ role: 'user', content: '用户对本次确认问题的实际答复：' + (source ? '[引用来源 ' + source + '] ' : '') + answer });
        if (legacyDirection || continueDraft || approved && !repeatedApproval || source) {
            resetInspectionRepair(state);
            state.workflowPhaseFrom = state.messages.length;
        }
        delete state.response; delete state.pendingKind; delete state.pendingInput;
    }
    if (state.managedProject && state.templateSpec && !state.installedTemplateProject) {
        await hooks.ensureCurrent();
        await installTemplate(state, state.managedProject, action => execute(user, id, action, hooks));
        state.installedTemplateProject = state.managedProject;
        await hooks.checkpoint(state, { phase: 'authoring', message: '已安装并核对所选模板，正在准备最终页面清单。' });
    }
    prepareRevisionSources(state);
    const inspection = createInspectionProgress(state.messages, state.workflowPhaseFrom);
    for (;;) {
        await hooks.ensureCurrent();
        const exhausted = state.steps >= request.maxSteps;
        const path = state.lastExport?.path;
        const canDeliver = state.review?.approvals?.design && path && !state.citationFacts?.length
            && (!state.pageRepair?.automatic || state.pageRepair.phase === 'deliver')
            && (!state.reviewDraft || state.deliveryPendingPath === path || state.pageRepair?.phase === 'deliver')
            && state.deferredExport !== path;
        let automatic;
        if (canDeliver) {
            try { automatic = await validateTurn({ complete: { path } }, state, undefined, { hostCompletion: true }); }
            catch (failure) {
                if (state.pageRepair?.automatic) {
                    state.deferredExport = path;
                    stopAutomaticRepair(state);
                    throw failure;
                }
                if (exhausted || !correctable.has(failure.code)) throw failure;
                state.deferredExport = path;
                state.messages.push({ role: 'user', content: '本次导出暂不能登记。' + failure.message });
            }
        } else if (exhausted) {
            break;
        } else {
            automatic = pendingProjectValidation(state) || resumeFirstPageCheck(state) || automaticTurn(state);
        }
        const { turn, readResultBudget = Infinity, pendingCitations, recoveredPlan } = automatic ? { turn: automatic }
            : await nextTurn(user, id, state, hooks, deps, inspection);
        inspection.syncVisibleObservations(state.messages);
        if (turn.requestInput?.kind === 'confirmation' && turn.requestInput.stage === 'design' || turn.complete) {
            delete state.citationRepair;
            delete state.citationDraft;
            delete state.citationFacts;
            resetCitationRepair(state);
        }
        if (turn.requestInput || turn.complete) delete state.inspectionRepairPending;
        if (!exhausted && !(automatic && turn.complete)) state.steps++;
        if (turn.planBatch) {
            state.planBatch = turn.planBatch;
            if (state.workflowProgress?.phase === 'design') {
                const { calls, finishBy = 0 } = state.workflowProgress;
                state.workflowProgress.finishBy = Math.max(finishBy, calls + 4);
            }
            const message = `已核对分批清单 ${turn.planBatch.pages.length}/${turn.planBatch.pageCount} 页。`;
            recordTurnDiagnostic(state, { outcome: 'progressed', planPages: turn.planBatch.pages.length });
            await hooks.checkpoint(state, { phase: 'authoring', message });
            continue;
        }
        if (request.draftFirst && turn.requestInput?.kind === 'confirmation' && turn.requestInput.stage === 'design') {
            const { plan } = turn.requestInput;
            if (plan.templateUse && state.installedTemplateProject !== plan.project) {
                await hooks.ensureCurrent();
                await installTemplate(state, plan.project, op => execute(user, id, op, hooks));
                state.installedTemplateProject = plan.project;
            }
            recordDraftPlan(state, plan);
            let visiblePlan = turn;
            delete state.modelPlanPaged;
            if (state.planBatch || turn.batchIssues) {
                const concise = plan.pages.map(page => ({ title: page.title,
                    values: page.values.map(({ text, chart }) => ({ text, ...(chart ? { chart } : {}) })) }));
                state.modelPlanPaged = JSON.stringify(concise).length > 16000;
                const roster = state.modelPlanPaged ? concise.map(page => ({ title: page.title, valueCount: page.values.length })) : concise;
                visiblePlan = { requestInput: { ...turn.requestInput, plan: { ...plan, pages: roster } } };
            }
            delete state.planBatch;
            if (!state.lastExport) delete state.projectPreparation;
            if (state.authoringPages && !state.lastExport) state.authoringPages = { paths: {}, first: 'unwritten' };
            state.draftCitationIssues = pendingCitations?.map(({ page, item, reason, titleClaim }) => ({ page, item, reason, ...(titleClaim ? { titleClaim } : {}) })) || [];
            markMilestone(state, 'firstPlan');
            state.messages.push({ role: 'assistant', content: JSON.stringify(visiblePlan) },
                { role: 'user', content: '宿主已登记本次初稿清单，请按清单生成页面。待核对项只显示占位文字。' });
            if (!recoveredPlan && !pendingCitations?.length) recordTurnDiagnostic(state, { outcome: 'progressed', citationPatchIgnored: turn.citationPatchIgnored });
            resetInspectionRepair(state);
            state.workflowPhaseFrom = state.messages.length;
            await hooks.checkpoint(state, { phase: 'authoring', message: '已准备初稿清单，开始生成页面。' });
            continue;
        }
        const { imageReview: _imageReview, ...visibleTurn } = turn;
        state.messages.push({ role: 'assistant', content: JSON.stringify(visibleTurn) });
        if (turn.requestInput) {
            const question = String(turn.requestInput.question || '').trim(), context = String(turn.requestInput.context || '').trim();
            if (!question || question.length > 2000 || context.length > 12000) throw runtime.error('制作确认问题无效。');
            state.pendingKind = turn.requestInput.kind === 'confirmation' ? 'confirmation' : 'clarification';
            state.pendingInput = { question, context, ...(turn.requestInput.stage ? { stage: turn.requestInput.stage, plan: turn.requestInput.plan } : {}),
                ...(turn.imageReview ? { imageReview: turn.imageReview } : {}) };
            if (state.pendingKind === 'confirmation') markMilestone(state, 'firstPlan');
            if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn));
            await hooks.checkpoint(state, { phase: 'input_required', message: question });
            return { pending: { question, context } };
        }
        await hooks.checkpoint(state, { phase: 'authoring', message: String(turn.message || '已生成制作操作，准备逐项执行。').slice(0, 500) });
        if (turn.complete) {
            const requiredConfirmations = request.operation === 'generate' && ['default', 'beautify'].includes(request.profile) ? 2 : request.operation === 'create_template' || request.template?.type === 'organization' ? 1 : 0;
            if (!state.review && (state.confirmationRevisionPending || Number(state.confirmedGates || 0) < requiredConfirmations)) throw runtime.error('当前流程尚未取得全部设计方案的实际确认，不能登记完成。', 'PPT_MASTER_CONFIRMATION_REQUIRED', 409);
            await hooks.ensureCurrent();
            const templateOnly = request.operation === 'create_template' && turn.complete.templatePath;
            const project = templateOnly ? turn.complete.templatePath : String(turn.complete.path).split('/exports/')[0];
            requireAuthoringPages(state, project);
            const expected = state.review ? exportReview(state, project, Boolean(templateOnly)) : null;
            const limits = state.engine?.boundedSourceBundle === 1 ? { sourceBundleLimit: sourceBundleLimit() } : {};
            const delivery = templateOnly ? { action: 'deliver_template', path: turn.complete.templatePath, kind: turn.complete.kind, ...limits }
                : { action: 'deliver', path: turn.complete.path, ...(expected ? { checklist: expected.checklist, retainReviewDraft: true } : {}),
                    ...(expected?.templateUse ? { templateSource: state.templateSpec.path } : {}),
                    ...limits,
                    ...(state.pageRepair ? { repair: { sha256: state.pageRepair.sha256, pages: state.pageRepair.pages, automatic: state.pageRepair.automatic === true } } : {}) };
            let receipt;
            try {
                receipt = await deliverWithRecovery(state, delivery, action => execute(user, id, action, hooks), hooks, { reexport: !exhausted });
            } catch (failure) {
                if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, null, { outcome: 'failed', ...(failure.code ? { errorCode: failure.code } : {}) }));
                if (failure.code === 'PPT_MASTER_OPERATION_FAILED') stopAutomaticRepair(state);
                if (automatic && failure.code === 'PPT_MASTER_DELIVERY_REEXPORT_FAILED') {
                    state.deferredExport = path;
                    if (state.pageRepair?.automatic) stopAutomaticRepair(state);
                    else if (!exhausted) {
                        await hooks.checkpoint(state, { phase: 'delivery_review', message: failure.message });
                        continue;
                    }
                }
                throw failure;
            }
            if (expected?.checklist && typeof receipt?.reviewFailure === 'string' && receipt.reviewFailure) {
                delete state.deliveryPendingPath;
                state.deferredExport = path;
                const { sha256, byteSize } = receipt.reviewDraft || {};
                if (typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) && Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= 60 * 1024 * 1024) {
                    state.reviewDraft = { sha256, byteSize };
                    state.pageReview = pageReviewFor(state, receipt.pageReview, expected.checklist);
                    state.pageSources = pageRepairSources(receipt.pageReview, project, expected.checklist.length);
                    if (state.pageRepair) state.pageRepair.sha256 = sha256;
                    if (!exhausted && beginPageRepair(state, project, turn.complete.path)) {
                        if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, null, { outcome: 'page_repair', repairPages: state.pageRepair.pages }));
                        await hooks.checkpoint(state, { phase: 'authoring', message: '正在按已批准清单自动修复第 ' + state.pageRepair.pages.join('、') + ' 页，随后重新导出并核验。' });
                        continue;
                    }
                }
                stopAutomaticRepair(state);
                if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, null, { outcome: 'failed', errorCode: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED',
                    ...(state.pageReview?.failedPages?.length ? { failedPages: state.pageReview.failedPages.map(page => page.page) } : {}) }));
                await hooks.checkpoint(state, { phase: 'delivery_review', message: '交付内容待复核，已保留当前制作检查点。' });
                throw runtime.error(receipt.reviewFailure.slice(0, 500), 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', 422);
            }
            if (expected) {
                verifyReceipt(receipt, expected);
                const preserved = receipt.packageCheck?.preservation;
                if (state.pageRepair && (preserved?.sha256 !== state.pageRepair.sha256
                    || JSON.stringify(preserved.pages) !== JSON.stringify(state.pageRepair.pages))) {
                    throw runtime.error('当前执行服务未核对已保留页面，请更新独立 PPT 制作服务。', 'PPT_MASTER_PAGE_REPAIR_UNVERIFIED', 422);
                }
                state.deliveryReview = { project, templateOnly: Boolean(templateOnly) };
            }
            state.deliveryReceipt = receipt;
            delete state.deliveryPendingPath;
            if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn));
            await hooks.checkpoint(state, { phase: 'delivery', message: '上游导出已完成，正在核验并登记交付文件。' });
            return { receipt };
        }
        const observations = [];
        let failureMessage;
        const reads = turn.actions.filter(action => PAGED_READS.has(action.action)).length;
        const batchPageLimit = Math.floor(readResultBudget / Math.max(1, reads));
        state.messages.push({ role: 'user', content: JSON.stringify([{ action: 'pending', error: '本轮动作尚未确认完成；恢复后先核对任务文件。' }]) });
        await hooks.checkpoint(state, { phase: 'authoring', message: '正在执行制作操作；已保存当前检查点。' });
        for (const action of turn.actions) {
            await hooks.ensureCurrent();
            let result;
            try {
                requireValidatedProject(state, action);
                requirePageSource(state, action);
                if (action.action === 'run' && ['export', 'finalize'].includes(action.tool)) {
                    requireAuthoringPages(state, action.args[0]);
                    if (action.tool === 'export') requireChecks(state, action.args[0], [], { exportArgs: action.args });
                }
                if (action.action === 'read_images') {
                    const page = selectImagePage(state, action.offset, action.length);
                    state.imagePage = page;
                    result = { ...page, message: '本批图片将随下一轮模型请求发送。' };
                } else if (action.action === 'list') {
                    result = await listWorkspace(action, command => execute(user, id, command, hooks));
                } else {
                    const supplement = action.action === 'read' && getSupplement(state, action.path);
                    const pageLimit = action.action === 'read_history' ? HISTORY_PAGE_CHARS : READ_PAGE_CHARS;
                    const toolAction = PAGED_READS.has(action.action)
                        ? { ...action, length: Math.min(action.length ?? pageLimit, pageLimit, batchPageLimit) } : action;
                    result = supplement ? readSupplement(supplement, toolAction)
                        : action.action === 'read_history' ? await readHistory(state, toolAction)
                            : previousProjectFailure(state, toolAction) || await execute(user, id, toolAction, hooks);
                }
                observations.push({ action: action.action, result: boundedObservation(action, result) });
                recordCheck(state, action, result);
                if (Number.isInteger(result?.exitCode) && result.exitCode !== 0) {
                    observations.at(-1).error = '该工具未通过，已停止本批后续动作。请根据诊断修正后重新检查。';
                    if (isProjectValidation(action, state.managedProject)) {
                        observations.at(-1).projectIssues = result.projectIssues || projectIssueKinds(result);
                        observations.at(-1).projectDetails = result.cachedSpecFailure ? result.projectDetails : projectValidationDetails(result);
                        observations.at(-1).projectErrorKeys = result.cachedSpecFailure ? result.projectErrorKeys : projectErrorKeys(result);
                    }
                }
            }
            catch (error) {
                hooks.signal?.throwIfAborted();
                if (missingValidationRead(state, action, error)) {
                    observations.push({ action: 'read', result: { path: action.path, unavailable: true,
                        message: '这份可选报告尚未生成。继续本批其他动作。' } });
                } else {
                    recordCheck(state, action, { exitCode: 1 });
                    observations.push({ action: action.action, error: String(error.message).slice(0, 2000),
                        ...(error.pageCheck ? { pageCheck: error.pageCheck } : {}),
                        ...(/^PPT_(?:MASTER|SERVICE)_[A-Z0-9_]{1,48}$/.test(error.code || '') ? { errorCode: error.code } : {}) });
                }
            }
            const observation = observations.at(-1);
            recordRevisionRead(state, action, observation);
            recordProjectPreparation(state, action, observation);
            recordPageProof(state, action, observation);
            if (observation.error && action.tool === 'check_svg') {
                const pages = state.review?.approvals.design?.plan?.pages || [];
                const sources = state.pageSources || pages.map((_, index) => state.authoringPages?.paths[index + 1]);
                observation.svgCheckPages = checkIssues(result, sources);
                if (automatic && observation.svgCheckPages.length) {
                    recordTurnDiagnostic(state, { hostSvgCheckPages: observation.svgCheckPages });
                }
            }
            state.messages[state.messages.length - 1].content = JSON.stringify(observations);
            recordRepairResult(state, action, observation, result);
            if (observation.error) {
                const detail = repairIssuesText(observation.svgCheckPages);
                failureMessage = detail
                    ? 'SVG 检查未通过：' + detail + '。已保存诊断。'
                    : observation.projectIssues?.length ? projectIssueText(observation.projectIssues) + '。已保存诊断。'
                        : observation.pageCheck || observation.errorCode === 'PPT_MASTER_PROJECT_SPEC_REVIEW_REQUIRED'
                            ? observation.error : '制作操作未完成，已保存诊断与检查点。';
                await hooks.checkpoint(state, { phase: 'authoring', message: failureMessage });
                break;
            }
            if (confirmedWrite(action, observation)) {
                markMilestone(state, 'firstWrite');
                if (/\/(?:svg_output|authoring-svg-flat)\/[^/]+\.svg$/i.test(action.path)
                    && (!state.review?.approvals.design || action.path.startsWith(state.review.approvals.design.plan.project + '/'))) {
                    markMilestone(state, 'firstPageWrite');
                }
            }
            state.messages[state.messages.length - 1].content = JSON.stringify([...observations, ...(observations.length < turn.actions.length ? [{ action: 'pending', error: '本轮余下动作尚未确认完成；恢复后先核对任务文件。' }] : [])]);
            await hooks.checkpoint(state, { phase: 'authoring', message: '已保存制作进度。' });
            await hooks.captureProgress?.(state, action, result);
        }
        state.messages[state.messages.length - 1].content = JSON.stringify(observations);
        const justExported = observations.some((item, index) => turn.actions[index]?.tool === 'export'
            && !item.error && item.result?.exitCode === 0 && state.lastExport?.path);
        if (!justExported && JSON.stringify(state.messages).length > 650000) {
            await archiveOlderObservations(state, { preserveActive: true });
            if (JSON.stringify(state.messages).length > 650000) await archiveOlderObservations(state, { force: true, recentTurns: 1 });
            if (JSON.stringify(state.messages).length > 650000) throw runtime.error('制作检查点超过当前保存上限，请保留项目后分批制作。', 'PPT_MASTER_HISTORY_LIMIT', 422);
        }
        const { progressed, productive, failed, repeated } = inspection.evaluate(turn.actions, observations);
        recordFirstPageProgress(state);
        if (productive) resetInspectionRepair(state);
        if (progressed || failed) {
            delete state.inspectionRepairPending;
            delete state.inspectionDiagnostic;
        } else if (repeated) state.inspectionDiagnostic = repeated;
        else delete state.inspectionDiagnostic;
        if (inspection.failed()) {
            if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, observations, { outcome: 'failed', errorCode: 'PPT_MASTER_TOOL_REPEATED_FAILURE' }));
            const details = observations.find(item => item.projectDetails?.length)?.projectDetails;
            const message = details?.length ? '项目校验反复未通过。' + details.slice(0, 3).join('；') + '。请修正后从检查点继续。'
                : '制作工具连续执行失败。请核对最近失败的动作与材料，再从检查点继续。';
            throw runtime.error(message, 'PPT_MASTER_TOOL_REPEATED_FAILURE', 409);
        }
        if (!progressed && !failed && (inspection.stalled() || state.inspectionRepairPending) && state.steps < request.maxSteps) {
            const attempts = Number(state.inspectionRepairAttempts || 0);
            if (attempts >= MAX_INSPECTION_REPAIRS) {
                if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, observations, { outcome: 'stalled', errorCode: 'PPT_MASTER_NO_PROGRESS', ...(repeated ? { repeated } : {}) }));
                throw runtime.error('多轮读取或检查未取得新结果，调整制作步骤后仍未推进。检查点已保留，可切换模型后继续。', 'PPT_MASTER_NO_PROGRESS', 409);
            }
            state.inspectionRepairAttempts = attempts + 1;
            state.inspectionRepairPending = true;
            if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, observations, { outcome: 'stalled', repairAttempt: state.inspectionRepairAttempts, ...(repeated ? { repeated } : {}) }));
            await hooks.checkpoint(state, { phase: 'authoring', message: `正在复用已有结果并调整制作步骤（第 ${state.inspectionRepairAttempts}/${MAX_INSPECTION_REPAIRS} 次）。` });
            continue;
        }
        if (!automatic) recordTurnDiagnostic(state, summarizeExecutedTurn(turn, observations, { ...(!progressed && !failed && repeated ? { repeated } : {}) }));
        await hooks.checkpoint(state, { phase: 'authoring', message: String(failureMessage || turn.message || '正在制作和检查页面。').slice(0, 500) });
    }
    throw runtime.error('本次制作达到步骤上限，检查点与源稿已保留。', 'PPT_MASTER_STEP_LIMIT', 422);
}
module.exports = { drive };
