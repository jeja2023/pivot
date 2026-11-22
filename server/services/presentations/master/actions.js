'use strict';

const { error } = require('./runtime');
const { exportReview, normalizeStage, normalizeCitationPatch, repairActionAllowed } = require('./review-plan');
const { imageCoverage, selectImagePage } = require('./model-input');
const { getSupplement } = require('./user-supplements');
const { patchCitationDraft } = require('./citation-repair');
const { requireChecks } = require('./tool-checks');
const { withProjectValidation } = require('./project-preparation');
const { HISTORY_PAGE_CHARS } = require('./observations');
const { normalizeRuntimeReads } = require('./runtime-references');
const { actionFields, rejectedFields, fieldMessage } = require('./action-parameters');
const { presentationPath, listScope } = require('./workspace-list');
const { preparePlanBatch } = require('./plan-batches');

const invalid = message => error(message, 'PPT_MASTER_ACTION_INVALID', 422);
const benignMetadata = new Set(['message', 'description', 'reason']);

function normalizeAction(action) {
    if (!action || typeof action !== 'object' || typeof action.action !== 'string' || !Object.hasOwn(actionFields, action.action)) return action;
    if (Buffer.byteLength(JSON.stringify(action), 'utf8') > 200000) throw invalid('单次制作动作过大，请按单页拆分。');
    const normalized = { ...action };
    for (const field of benignMetadata) {
        if (typeof normalized[field] === 'string' && normalized[field].length <= 500) delete normalized[field];
    }
    if (normalized.action === 'write') {
        for (const [alias, target] of [['content', 'text'], ['file_path', 'path'], ['filePath', 'path']]) {
            if (typeof normalized[alias] === 'string' && (normalized[target] === undefined || normalized[target] === normalized[alias])) {
                normalized[target] = normalized[alias];
                delete normalized[alias];
            }
        }
        if (normalized.offset === 0) delete normalized.offset;
        if (typeof normalized.encoding === 'string' && /^utf-?8$/i.test(normalized.encoding)) delete normalized.encoding;
        if (normalized.append === false) delete normalized.append;
        if (normalized.tool === '') delete normalized.tool;
        if (Array.isArray(normalized.args) && !normalized.args.length) delete normalized.args;
    }
    return normalized;
}
function parsedOutput(output) {
    if (output && typeof output === 'object' && !Array.isArray(output)) return output;
    const source = String(output || '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '');
    try {
        const value = JSON.parse(source);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (_) {}
    throw error('模型未返回完整的制作操作，请重试或切换模型。', 'PPT_MASTER_MODEL_OUTPUT_INVALID', 422);
}

function repairedTurn(output, repair) {
    const reply = parsedOutput(output);
    const single = Object.hasOwn(reply, 'repairAction');
    if (!single && !Object.hasOwn(reply, 'repairActions')) return reply;
    const issues = repair?.issues || (repair ? [{ actionIndex: repair.index + 1, actionType: repair.type }] : []);
    const patches = single ? [{ index: issues[0]?.actionIndex, action: reply.repairAction }] : reply.repairActions;
    const allowed = new Map(issues.map(issue => [issue.actionIndex, issue.actionType]));
    if (!repair || Object.keys(reply).length !== 1 || !Array.isArray(patches) || !patches.length || patches.length > allowed.size
        || new Set(patches.map(patch => patch?.index)).size !== patches.length
        || patches.some(patch => !patch?.action || Array.isArray(patch.action) || !allowed.has(patch.index) || allowed.get(patch.index) !== patch.action.action)) {
        throw invalid('局部纠正须只提交 repairActions，逐项填写原批次 index 和完整 action 对象，并保留原动作类型。');
    }
    const replacements = new Map(patches.map(patch => [patch.index, patch.action]));
    return { ...repair.turn, actions: repair.turn.actions.map((previous, index) => replacements.get(index + 1) || previous) };
}

function fieldIssues(actions, originals) {
    return actions.flatMap((action, index) => {
        if (!action || typeof action !== 'object' || typeof action.action !== 'string' || !Object.hasOwn(actionFields, action.action)) {
            throw invalid('模型请求了未登记的制作动作。');
        }
        const rejected = rejectedFields(action, originals[index]);
        return rejected.length ? [{ actionIndex: index + 1, actionType: action.action, rejectedFields: rejected }] : [];
    });
}

function validateAction(action, state) {
    if (Buffer.byteLength(JSON.stringify(action), 'utf8') > 200000) throw invalid('单次制作动作过大，请按单页拆分。');
    if (action.action === 'list') listScope(action.path);
    if (!state.review) return;
    if (state.pageRepair && !repairActionAllowed(state, action)) {
        if (state.pageRepair.automatic && action.action === 'run' && ['check_svg', 'finalize', 'export'].includes(action.tool)) {
            throw invalid('复检、定稿和导出由宿主执行。请只用 write 写回待修的已选源页。');
        }
        if (action.action === 'write') throw invalid('写入目标超出本次选页范围。请沿用原清单，仅写回已选源页，未选页面需要保留。');
        throw invalid('按页修复只允许编辑当前项目的页面源稿，或校验和导出当前项目。系统会核对未选页面是否保留。');
    }
    const supplementRead = action.action === 'read' && getSupplement(state, action.path);
    if (['read', 'read_runtime', 'write', 'copy', 'copy_template', 'validate_template'].includes(action.action) && !supplementRead && !presentationPath(action.path)) {
        throw invalid('制作动作须提供当前任务内的安全相对路径。');
    }
    if (action.action === 'write' && (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > 180000 || /^(?:inputs|delivery)(?:\/|$)/.test(action.path))) {
        throw invalid('写入须提供受限文本，长度不超过180000字节，且不能覆盖输入或交付目录。');
    }
    if (state.managedProject && ['write', 'copy'].includes(action.action) && /\/svg_output\/[^/]+\.svg$/i.test(action.path)) {
        if (!state.review.approvals.design) throw invalid('请先取得最终页面清单批准，再写入 SVG 页面。');
        if (!action.path.startsWith(state.managedProject + '/svg_output/')) throw invalid('页面须写入当前批准项目的 svg_output 目录。');
    }
    if (['copy', 'copy_template'].includes(action.action) && !presentationPath(action.source)) throw invalid('复制须提供安全的任务内来源路径。');
    if (action.action === 'validate_template' && !['brand', 'style', 'layout', 'deck'].includes(action.kind)) throw invalid('请选择有效的模板校验类型。');
    if (['read', 'read_runtime', 'read_history'].includes(action.action)) {
        const maxLength = action.action === 'read_history' ? HISTORY_PAGE_CHARS : 60000;
        if (action.offset !== undefined && (!Number.isSafeInteger(action.offset) || action.offset < 0)
            || action.length !== undefined && (!Number.isSafeInteger(action.length) || action.length < 1 || action.length > maxLength)) {
            throw invalid('请填写当前文件范围内的有效分页参数。');
        }
    }
    if (action.action === 'read_history' && [action.archive, action.index].some(key => !Number.isSafeInteger(key) || key < 0)) throw invalid('请提供有效的历史归档坐标。');
    if (action.action === 'read_images') selectImagePage(state, action.offset, action.length);
    if (action.action === 'run') {
        if (typeof action.tool !== 'string' || !Array.isArray(action.args) || action.args.length > 48
            || action.args.some(arg => typeof arg !== 'string' || !arg || arg.length > 500)
            || Array.isArray(state.engine?.tools) && !state.engine.tools.includes(action.tool)) {
            throw invalid('请选择已登记的制作工具并提供有效的参数数组。');
        }
        if (state.managedProject && action.tool === 'project' && action.args[0] === 'init') {
            throw invalid('宿主已创建当前任务项目，请使用 ' + state.managedProject + ' 继续。');
        }
        if (action.tool === 'export') exportReview(state, action.args[0]);
        if (action.tool === 'export' && state.request.operation === 'generate' && ['default', 'beautify'].includes(state.request.profile)
            && action.args.some(arg => arg === '--quick-generate' || arg.startsWith('--quick-generate='))) {
            throw invalid('当前为完整制作流程，请使用对应的完整导出方式。');
        }
    }
}

async function validateTurn(output, state, verifySource, { hostCompletion = false } = {}) {
    let turn = parsedOutput(output);
    let citationPatch;
    if (Object.hasOwn(turn, 'planPages')) {
        if (Object.keys(turn).some(key => !['planPages', 'message'].includes(key))) throw invalid('分批清单须单独提交 planPages。');
        const coverage = imageCoverage(state);
        if (coverage.read < coverage.total) throw invalid(`须先从 offset=${coverage.nextOffset} 读取未送达的原图。`);
        return preparePlanBatch(turn.planPages, state, verifySource);
    }
    if (state.planBatch && turn.requestInput?.stage === 'design' && turn.requestInput.kind === 'confirmation') {
        throw invalid('当前清单已有已核对页，请用 planPages 提交其余页面。');
    }
    if (Object.hasOwn(turn, 'repairCitations')) {
        if (turn.actions || turn.complete || turn.requestInput) throw invalid('引用修正不能与操作、询问或交付一并提交。');
        citationPatch = patchCitationDraft(state, turn.repairCitations);
        turn = { requestInput: citationPatch.draft, ...(citationPatch.ignored ? { citationPatchIgnored: citationPatch.ignored } : {}) };
    }
    if (state.citationFacts?.length && (turn.complete || Array.isArray(turn.actions) && turn.actions.some(action => action?.action === 'run' && action.tool === 'export'))) {
        throw invalid('尚有待核对的引文，请先修正并提交最终清单确认，再执行导出及交付。');
    }
    const choices = [Array.isArray(turn.actions) && turn.actions.length > 0, Boolean(turn.requestInput), Boolean(turn.complete)].filter(Boolean).length;
    if (choices !== 1) throw invalid('模型须明确选择操作、询问或最终交付，不能混合执行。');
    if (turn.actions) {
        if (!Array.isArray(turn.actions) || turn.actions.length > 6) throw invalid('单轮制作操作超过上限。');
        const originalActions = turn.actions;
        if (state.review) turn = { ...turn, actions: normalizeRuntimeReads(turn.actions.map(normalizeAction), state) };
        if (turn.actions.filter(action => action?.action === 'read_images').length > 1) throw invalid('每轮只请求一批图片。');
        const issues = fieldIssues(turn.actions, originalActions);
        if (issues.length) {
            const message = issues.map(issue => fieldMessage(issue.actionType, issue.actionIndex, issue.rejectedFields)).join(' ');
            throw Object.assign(invalid(message), { correctionKind: 'action_fields', ...issues[0], actionFieldIssues: issues });
        }
        for (const action of turn.actions) validateAction(action, state);
        turn = withProjectValidation(state, turn);
        for (const [index, action] of turn.actions.entries()) {
            if (action.action === 'run' && action.tool === 'export') requireChecks(state, action.args[0], turn.actions.slice(0, index), { exportArgs: action.args });
        }
    }
    if (turn.requestInput) {
        const { question, context, kind, stage } = turn.requestInput;
        if (typeof question !== 'string' || !question.trim() || question.length > 2000 || (context !== undefined && (typeof context !== 'string' || context.length > 12000))
            || !['confirmation', 'clarification'].includes(kind)) throw invalid('制作确认问题格式无效。');
        if (kind === 'clarification' && stage === 'direction') throw invalid('沟通方向由模型规划。请准备最终方案，缺少必要事实时再提出具体问题。');
        if (state.pageRepair?.automatic && kind === 'clarification') {
            if (!state.pageRepair.missingSource) throw invalid('此次修页所需的标题和数据已获批准。请读取列出的源页并写回修正，所需材料读取失败时才提出具体问题。');
            turn.requestInput = { kind, question, context: ('无法读取本次修页需要的材料「' + state.pageRepair.missingSource + '」。' + (context || '')).slice(0, 12000) };
        }
        if (kind === 'confirmation' && state.review) {
            if (state.pageRepair) throw invalid('按页修复须使用原已确认清单。如需改动清单，请重新生成整份。');
            const coverage = imageCoverage(state);
            if (['design', 'template'].includes(turn.requestInput.stage) && coverage.read < coverage.total) {
                throw invalid(`尚有 ${coverage.total - coverage.read} 张图片未读取。请先用 read_images 从 offset=${coverage.nextOffset} 继续。`);
            }
            const compiled = citationPatch ? await normalizeCitationPatch(citationPatch, state, verifySource)
                : await normalizeStage(turn.requestInput, state, verifySource);
            turn.requestInput = { kind, question: question.trim(), context: compiled.plan.summary, ...compiled };
        }
    }
    if (turn.complete && state.review) {
        if (state.pageRepair?.automatic && !hostCompletion) throw invalid('正在按已批准的清单自动修页，请先写回待修源文件，宿主将复检并交付修订稿。');
        const template = state.request.operation === 'create_template';
        const target = template ? turn.complete.templatePath : turn.complete.path;
        const match = !template && typeof target === 'string' ? /^(.*)\/exports\/[^/]+\.pptx$/i.exec(target) : null;
        if (!presentationPath(target) || (!template && !match) || (template && !['brand', 'style', 'layout', 'deck'].includes(turn.complete.kind))) {
            throw invalid('交付须指向已批准项目的 exports 中实际的 PPTX，或已批准的模板工作区。');
        }
        const project = template ? target : match[1];
        requireChecks(state, project, [], { templateKind: template ? turn.complete.kind : undefined });
        exportReview(state, project, template);
        if (!template && state.lastExport && state.lastExport.path !== target) {
            throw invalid('请使用本次最新成功导出的文件提交交付：' + state.lastExport.path);
        }
    }
    return turn;
}

module.exports = { validateTurn, repairedTurn, parsedOutput };
