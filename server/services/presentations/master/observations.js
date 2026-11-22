'use strict';
const { actionFields, publicFieldLabels, fieldMessage } = require('./action-parameters');

const crypto = require('node:crypto');
const READ_PAGE_CHARS = 24000;
const HISTORY_PAGE_CHARS = 12000;
const BASE_TOOL_IDS = ['project', 'check_svg', 'finalize', 'export', 'import_native', 'import_template', 'template_preview',
    'apply_template', 'split_notes', 'preset_shape', 'chart_recall', 'visualization_recall', 'chart_calculator', 'workspace',
    'text_measure', 'analyze_images'];
const DIAGNOSTIC_TOOL_IDS = new Set([...BASE_TOOL_IDS, 'icon_sync']);
// 单轮六个模型动作，宿主可插入项目校验和首张页面校验。
const MAX_RECORDED_ACTIONS = 8;

function observationLocation(action, observation) {
    const location = { action: action?.action || observation?.action };
    const offset = observation?.result?.offset ?? action?.offset;
    if (Number.isSafeInteger(offset) && offset >= 0) location.offset = offset;
    if (action?.action === 'read_history' && [action.archive, action.index].every(value => Number.isSafeInteger(value) && value >= 0)) {
        location.archive = action.archive;
        location.index = action.index;
    }
    if (action?.action === 'run' && DIAGNOSTIC_TOOL_IDS.has(action.tool)) location.tool = action.tool;
    const path = action?.path;
    if (typeof path === 'string' && path.length <= 180 &&
        (/^inputs\/material-[1-9]\d*\.md$/.test(path) ||
            action.action === 'read_runtime' && /^(?:SKILL\.md|(?:references|workflows|templates|scripts\/docs)\/(?:[\w-]+\/)*[\w.-]+\.md)$/.test(path))) {
        location.path = path;
    }
    return location;
}

function failedObservation(observation) {
    return Boolean(observation?.error || Number.isInteger(observation?.result?.exitCode) && observation.result.exitCode !== 0);
}

function confirmedWrite(action, observation) {
    const receipt = observation?.result;
    if (action?.action !== 'write' || observation?.action !== 'write' || observation.error || !action.path || action.path !== receipt?.path
        || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '')) return null;
    const expected = typeof action.text === 'string' ? crypto.createHash('sha256').update(action.text, 'utf8').digest('hex') : action.savedSha256;
    return expected === receipt.sha256 ? receipt : null;
}

function actionSummary(messages) {
    if (!Array.isArray(messages)) return undefined;
    let writes = 0, lastWrittenPath = '', failedWrites = 0, runtimeReads = 0, lastActions = [], lastFailure;
    for (let index = 0; index < messages.length - 1; index++) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        let turn, observations;
        try { turn = JSON.parse(messages[index].content); observations = JSON.parse(messages[index + 1].content); } catch (_) { continue; }
        if (!Array.isArray(turn?.actions) || !Array.isArray(observations)) continue;
        lastActions = observations.slice(0, MAX_RECORDED_ACTIONS).map((observation, position) => {
            const action = turn.actions[position], receipt = confirmedWrite(action, observation);
            // 较早版本的归档已校验摘要后才移除写入正文，但未保存单独的摘要字段。
            const legacyWrite = action?.action === 'write' && action.savedContent?.startsWith?.('已成功写入；') && observation?.action === 'write'
                && !observation.error && observation.result?.path === action.path && /^[a-f0-9]{64}$/.test(observation.result?.sha256 || '');
            if (receipt || legacyWrite) { writes++; lastWrittenPath = String(observation.result.path).slice(0, 300); }
            const exitCode = observation?.result?.exitCode;
            const failed = failedObservation(observation);
            if (failed && action?.action === observation.action) {
                lastFailure = { ...observationLocation(action, observation),
                    ...(Number.isInteger(exitCode) && exitCode !== 0 ? { exitCode } : {}),
                    ...(/^PPT_(?:MASTER|SERVICE)_[A-Z0-9_]{1,48}$/.test(observation.errorCode || '') ? { errorCode: observation.errorCode } : {}) };
            }
            if (observation?.action === 'write' && failed) failedWrites++;
            if (observation?.action === 'read_runtime' && observation.result && !failed) runtimeReads++;
            return { action: observation?.action, failed };
        });
    }
    return { writes, failedWrites, runtimeReads, lastWrittenPath, lastActions, ...(lastFailure ? { lastFailure } : {}) };
}

const SAFE_TOOL_SUBCOMMANDS = new Set(['init', 'import-sources', 'validate', 'info', 'page-context', 'page-context-report',
    'scaffold-spec', 'scaffold-lock', 'calibrate', 'inspect', 'pack', 'unpack']);
const SAFE_ERROR_CODE = /^PPT_(?:MASTER|SERVICE)_[A-Z0-9_]{1,48}$/;
const PAGE_CHECK_KINDS = new Set(['source_path', 'first_page_pending', 'source_xml', 'source_content', 'first_page_layout']);
const SAFE_PAGE_REASONS = new Set(['页面对象区域重叠', '页面模块缺少边界声明', '重复使用了规范未声明的字号',
    '渐变路径的可见宽度或高度为零', '文字超出页面模块边界', 'SVG 格式无效', '页面未通过 SVG 校验']);
const PROJECT_ISSUES = new Set(['design', 'lock', 'communication', 'layout', 'other']);

function pageDiagnostics(observation) {
    if (!observation) return {};
    const { pageCheck, svgCheckPages } = observation;
    const safe = Array.isArray(svgCheckPages) ? svgCheckPages.filter(issue => Number.isSafeInteger(issue?.page) && issue.page > 0)
        .slice(0, 40).map(({ page, reasons }) => ({ page, reasons: Array.isArray(reasons) ? reasons.filter(reason => SAFE_PAGE_REASONS.has(reason)) : [] })) : [];
    return {
        ...(PAGE_CHECK_KINDS.has(pageCheck?.kind) ? { pageCheck: { kind: pageCheck.kind, page: Number.isSafeInteger(pageCheck.page) ? pageCheck.page : null } } : {}),
        ...(safe.length ? { svgCheckPages: safe } : {})
    };
}

function safeActionTarget(action, observation) {
    const raw = [observation?.result?.path, action?.path, action?.source].find(value => typeof value === 'string' && value.length <= 240);
    if (raw) {
        if (/^(?:inputs\/[\w.-]{1,120}|user-supplement:[1-9]\d*|selected-template(?:\/[\w.-]+)*)$/.test(raw)) return raw;
        if (/^(?:SKILL\.md|(?:references|workflows|templates|scripts\/docs)\/(?:[\w-]+\/)*[\w.-]+)$/.test(raw)) return raw;
        const sub = /(?:^|\/)((?:svg_output|svg_final|authoring-svg-flat|authoring-svg-layered|notes|images|templates|data|charts|icons|validation)\/[\w.-]+)$/i.exec(raw);
        if (sub) return sub[1];
        const exp = /(?:^|\/)(exports\/[\w.-]+\.pptx)$/i.exec(raw);
        if (exp) return exp[1];
        if (/(?:^|\/)exports\/[^/]+\.pptx$/i.test(raw)) return 'exports/*.pptx';
        const std = /(?:^|\/)(spec_lock\.md|outline\.md|content_outline\.md|design_spec\.md|brand_spec\.md|style_spec\.md|layout_spec\.md|deck_spec\.ya?ml|theme\.ya?ml|manifest\.json|README\.md|total\.md)$/i.exec(raw);
        if (std) return std[1];
        const base = /(?:^|\/)([\w.-]+\.(?:svg|md|ya?ml|json|csv|xml|pptx|png|jpe?g|webp))$/i.exec(raw);
        if (base) return base[1];
    }
    if (action?.action === 'run' && action.tool === 'check_svg' && Array.isArray(action.args)) {
        const index = action.args.indexOf('--page');
        const match = index >= 0 && /(?:^|\/)((?:svg_output\/)?[\w.-]+\.svg)$/i.exec(String(action.args[index + 1] || ''));
        if (match) return match[1];
    }
    return undefined;
}

function summarizeTurnAction(action, observation) {
    const type = action?.action || observation?.action;
    const failed = failedObservation(observation);
    const receipt = confirmedWrite(action, observation)
        || (action?.action === 'write' && action.savedContent?.startsWith?.('已成功写入；') && observation?.action === 'write'
            && !observation.error && observation.result?.path === action.path && /^[a-f0-9]{64}$/.test(observation.result?.sha256 || ''));
    const path = safeActionTarget(action, observation);
    const tool = action?.action === 'run' && DIAGNOSTIC_TOOL_IDS.has(action.tool) ? action.tool : undefined;
    const subcommand = tool && Array.isArray(action?.args) && SAFE_TOOL_SUBCOMMANDS.has(action.args[0]) ? action.args[0] : undefined;
    const offset = observation?.result?.offset ?? action?.offset;
    const nextOffset = observation?.result?.nextOffset;
    const exitCode = Number.isInteger(observation?.result?.exitCode) && observation.result.exitCode !== 0 ? observation.result.exitCode : undefined;
    const errorCode = SAFE_ERROR_CODE.test(observation?.errorCode || '') ? observation.errorCode : undefined;
    const fileCount = Number.isSafeInteger(observation?.result?.files?.length) ? observation.result.files.length
        : Number.isSafeInteger(observation?.result?.fileCount) ? observation.result.fileCount
        : Number.isSafeInteger(observation?.result?.count) ? observation.result.count : undefined;
    return {
        action: type,
        ...pageDiagnostics(observation),
        ...(Array.isArray(observation?.projectIssues) ? { projectIssues: observation.projectIssues.filter(kind => PROJECT_ISSUES.has(kind)) } : {}),
        ...(observation?.projectDetails?.length ? { projectDetails: observation.projectDetails } : {}),
        ...(type === 'read' && observation?.result?.unavailable === true ? { unavailable: true } : {}),
        ...(tool ? { tool } : {}),
        ...(subcommand ? { subcommand } : {}),
        ...(path ? { path } : {}),
        ...(Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
        ...(nextOffset === null || Number.isSafeInteger(nextOffset) && nextOffset >= 0 ? { nextOffset } : {}),
        ...(action?.action === 'read_history' && [action.archive, action.index].every(v => Number.isSafeInteger(v) && v >= 0) ? { archive: action.archive, index: action.index } : {}),
        ...(fileCount !== undefined ? { fileCount } : {}),
        ...(receipt ? { confirmed: true } : {}),
        ...(failed ? { failed: true } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(errorCode ? { errorCode } : {})
    };
}

function summarizeExecutedTurn(turn, observations, extra = {}) {
    if (turn?.requestInput) {
        const inputKind = turn.requestInput.kind === 'confirmation' ? 'confirmation' : 'clarification';
        const stage = ['direction', 'design', 'template'].includes(turn.requestInput.stage) ? turn.requestInput.stage : undefined;
        const planPages = Array.isArray(turn.requestInput.plan?.pages) ? turn.requestInput.plan.pages.length : undefined;
        return { outcome: 'input_required', inputKind, ...(stage ? { stage } : {}), ...(planPages ? { planPages } : {}), ...extra };
    }
    if (turn?.complete) {
        const deliveryKind = turn.complete.templatePath ? 'template' : 'pptx';
        const path = safeActionTarget({ path: turn.complete.path || turn.complete.templatePath });
        return { outcome: extra.outcome || 'completed', deliveryKind, ...(path ? { path } : {}), ...extra };
    }
    if (Array.isArray(turn?.actions)) {
        const executed = Array.isArray(observations) ? observations.filter(item => item?.action !== 'pending').slice(0, MAX_RECORDED_ACTIONS) : [];
        const actions = executed.map((observation, index) => summarizeTurnAction(turn.actions[index], observation));
        const skippedActions = Math.max(0, Math.min(MAX_RECORDED_ACTIONS, turn.actions.length) - actions.length);
        const hasFailed = actions.some(item => item.failed);
        const hasConfirmed = actions.some(item => item.confirmed);
        const failedItem = actions.find(item => item.failed);
        return {
            outcome: extra.outcome || (hasFailed ? 'tool_failed' : hasConfirmed ? 'productive' : 'progressed'),
            actions,
            ...(skippedActions ? { skippedActions } : {}),
            ...(failedItem?.errorCode && !extra.errorCode ? { errorCode: failedItem.errorCode } : {}),
            ...(failedItem?.exitCode !== undefined && extra.exitCode === undefined ? { exitCode: failedItem.exitCode } : {}),
            ...extra
        };
    }
    return { ...extra };
}

function sanitizeTurnSummary(summary) {
    if (!summary || typeof summary !== 'object') return {};
    const out = {};
    if (['progressed', 'productive', 'input_required', 'completed', 'page_repair', 'citation_placeholder', 'retry', 'model_failed', 'tool_failed', 'stalled', 'failed'].includes(summary.outcome)) out.outcome = summary.outcome;
    if (['confirmation', 'clarification'].includes(summary.inputKind)) out.inputKind = summary.inputKind;
    if (['direction', 'design', 'template'].includes(summary.stage)) out.stage = summary.stage;
    if (Number.isSafeInteger(summary.planPages) && summary.planPages > 0) out.planPages = summary.planPages;
    if (['pptx', 'template'].includes(summary.deliveryKind)) out.deliveryKind = summary.deliveryKind;
    if (typeof summary.path === 'string' && summary.path.length <= 240) out.path = summary.path;
    if (Array.isArray(summary.actions) && summary.actions.length) out.actions = summary.actions.slice(0, MAX_RECORDED_ACTIONS);
    const hostChecks = pageDiagnostics({ svgCheckPages: summary.hostSvgCheckPages });
    if (hostChecks.svgCheckPages) out.hostSvgCheckPages = hostChecks.svgCheckPages;
    if (Number.isSafeInteger(summary.skippedActions) && summary.skippedActions > 0) out.skippedActions = summary.skippedActions;
    if (SAFE_ERROR_CODE.test(summary.errorCode || '')) out.errorCode = summary.errorCode;
    if (Number.isInteger(summary.exitCode) && summary.exitCode !== 0) out.exitCode = summary.exitCode;
    if (Number.isSafeInteger(summary.citationCount) && summary.citationCount > 0) out.citationCount = summary.citationCount;
    if (Number.isSafeInteger(summary.citationPatchIgnored) && summary.citationPatchIgnored > 0) out.citationPatchIgnored = Math.min(480, summary.citationPatchIgnored);
    if (['citation_patch', 'plan_page_count', 'action_fields'].includes(summary.correctionKind)) out.correctionKind = summary.correctionKind;
    if (typeof summary.actionType === 'string' && Object.hasOwn(actionFields, summary.actionType)
        && Number.isInteger(summary.actionIndex) && summary.actionIndex >= 1 && summary.actionIndex <= 6) {
        out.actionIndex = summary.actionIndex;
        out.actionType = summary.actionType;
        const rejected = publicFieldLabels(summary.rejectedFields);
        if (out.correctionKind === 'action_fields' && rejected.length) out.rejectedFields = rejected;
    }
    if (out.correctionKind === 'action_fields' && Array.isArray(summary.actionFieldIssues)) {
        out.actionFieldIssues = summary.actionFieldIssues.slice(0, 6).flatMap(issue => {
            if (!Number.isInteger(issue?.actionIndex) || issue.actionIndex < 1 || issue.actionIndex > 6
                || !Object.hasOwn(actionFields, issue.actionType)) return [];
            return [{ actionIndex: issue.actionIndex, actionType: issue.actionType, rejectedFields: publicFieldLabels(issue.rejectedFields) }];
        });
    }
    if (['connection_reset', 'gateway_error', 'local_timeout', 'upstream_timeout', 'transport_timeout'].includes(summary.modelFailureKind)) {
        out.modelFailureKind = summary.modelFailureKind;
    }
    if (typeof summary.citationLocation === 'string' && /^第\s*\d+\s*页/.test(summary.citationLocation)) out.citationLocation = summary.citationLocation.slice(0, 80);
    if (Array.isArray(summary.failedPages) && summary.failedPages.length) out.failedPages = summary.failedPages.filter(Number.isSafeInteger).slice(0, 40);
    if (Array.isArray(summary.repairPages) && summary.repairPages.length) out.repairPages = summary.repairPages.filter(Number.isSafeInteger).slice(0, 40);
    if (Number.isSafeInteger(summary.repairAttempt) && summary.repairAttempt > 0) out.repairAttempt = summary.repairAttempt;
    if (summary.repeated && typeof summary.repeated === 'object' && typeof summary.repeated.action === 'string') out.repeated = summary.repeated;
    return out;
}

function recordTurnDiagnostic(state, summary) {
    const last = Array.isArray(state?.usageDiagnostics) ? state.usageDiagnostics.at(-1) : null;
    if (!last || typeof last !== 'object') return;
    last.turnSummary = sanitizeTurnSummary({ ...(last.turnSummary || {}), ...summary });
}

function usageDiagnosticsView(state, taskError) {
    const items = Array.isArray(state?.usageDiagnostics) ? state.usageDiagnostics : [];
    if (!items.length) return [];
    const turnsByStep = new Map();
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    let stepIndex = 0;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.role !== 'assistant' || typeof messages[index].content !== 'string') continue;
        stepIndex++;
        let turn, observations;
        try { turn = JSON.parse(messages[index].content); } catch (_) { continue; }
        if (messages[index + 1]?.role === 'user' && typeof messages[index + 1].content === 'string') {
            try {
                const parsed = JSON.parse(messages[index + 1].content);
                if (Array.isArray(parsed)) observations = parsed;
            } catch (_) {}
        }
        turnsByStep.set(stepIndex, summarizeExecutedTurn(turn, observations));
    }
    return items.map((item, index) => {
        const { call, step, inputTokens, outputTokens, inputEstimated, outputEstimated, inputEstimate, originalEstimate, compactedWrites, cumulativeTokens, breakdown, startedAt, durationMs } = item;
        const base = {
            call, step, inputTokens, outputTokens, inputEstimated, outputEstimated, inputEstimate, originalEstimate, compactedWrites, cumulativeTokens, breakdown,
            ...(startedAt ? { startedAt } : {}),
            ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {})
        };
        for (const key of ['queueMs', 'providerMs']) {
            if (Number.isSafeInteger(item[key]) && item[key] >= 0) base[key] = item[key];
        }
        let summary = item.turnSummary && Object.keys(item.turnSummary).length ? sanitizeTurnSummary(item.turnSummary) : null;
        if (!summary) {
            const hasLaterSameStep = items.slice(index + 1).some(other => other.step === step);
            if (hasLaterSameStep) {
                summary = sanitizeTurnSummary({ outcome: 'retry', ...(SAFE_ERROR_CODE.test(state?.lastActionCorrection || '') ? { errorCode: state.lastActionCorrection } : {}) });
            } else if (turnsByStep.has(step)) {
                const isLast = index === items.length - 1;
                const extra = isLast && taskError?.code === 'PPT_MASTER_NO_PROGRESS'
                    ? { outcome: 'stalled', ...(state?.inspectionDiagnostic ? { repeated: state.inspectionDiagnostic } : {}) }
                    : isLast && taskError?.code === 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED'
                        ? { outcome: 'failed', errorCode: taskError.code, ...(state?.pageReview?.failedPages?.length ? { failedPages: state.pageReview.failedPages.map(p => p.page) } : {}) }
                        : {};
                summary = sanitizeTurnSummary({ ...turnsByStep.get(step), ...extra });
            } else if (index === items.length - 1 && SAFE_ERROR_CODE.test(taskError?.code || '')) {
                summary = sanitizeTurnSummary({ outcome: 'failed', errorCode: taskError.code });
            }
        }
        if (summary?.correctionKind === 'action_fields' && summary.rejectedFields?.length) {
            const issues = summary.actionFieldIssues?.length ? summary.actionFieldIssues : [summary];
            summary.fieldMessage = issues.map(issue => fieldMessage(issue.actionType, issue.actionIndex, issue.rejectedFields)).join(' ');
        }
        return summary ? { ...base, ...summary } : base;
    });
}

// 长文本按字符分页保留路径和游标，其他过长诊断明确标记；不截断 JSON 结构。
function boundedObservation(action, result) {
    const limit = action.action === 'read_history' ? HISTORY_PAGE_CHARS : READ_PAGE_CHARS;
    if (!result || typeof result !== 'object') return result;
    if (['read', 'read_runtime', 'read_history'].includes(action.action) && typeof result.text === 'string') {
        const chars = Array.from(result.text);
        if (chars.length <= limit) return result;
        const offset = Number.isSafeInteger(Number(result.offset)) ? Number(result.offset) : Math.max(0, Number(action.offset) || 0);
        return { ...result, text: chars.slice(0, limit).join(''), offset, nextOffset: offset + limit, truncated: true };
    }
    const text = JSON.stringify(result);
    if (text.length <= 24000) return result;
    return { truncated: true, message: '工具结果过长，请按路径或较小范围重新读取。',
        ...(typeof result.path === 'string' ? { path: result.path } : {}),
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        ...(result.validatedSpecs ? { validatedSpecs: result.validatedSpecs } : {}),
        ...(typeof result.stdout === 'string' ? { stdout: result.stdout.slice(0, 8000) } : {}),
        ...(typeof result.stderr === 'string' ? { stderr: result.stderr.slice(0, 8000) } : {}) };
}

module.exports = { boundedObservation, confirmedWrite, actionSummary, observationLocation, failedObservation, summarizeExecutedTurn, recordTurnDiagnostic, usageDiagnosticsView, READ_PAGE_CHARS, HISTORY_PAGE_CHARS, BASE_TOOL_IDS };
