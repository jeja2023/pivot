'use strict';

const { createHash } = require('node:crypto');
const { error } = require('./runtime');
const { getSupplement } = require('./user-supplements');
const { compact, containsValue, locateCitation, verifiedCorrection, originalLine } = require('./citation-repair');
const { normalizeTemplateUse } = require('./template-application');

const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const invalid = message => error(message, 'PPT_MASTER_ACTION_INVALID', 422);
const checklistError = message => error(message, 'PPT_MASTER_CHECKLIST_REQUIRED', 409);
const labels = { direction: '沟通方向', design: '最终页面与关键数据清单', template: '模板制作方案' };
const citationKey = ({ text, chart }) => digest([compact(text), ...(chart ? [compact(chart.series), compact(chart.category), chart.number] : [])]);
const sourceLabel = path => path === 'instruction' ? '制作要求' : path.startsWith('user-supplement:') ? '用户补充 ' + path.split(':')[1] : path || '来源待核对';
const CITATION_REVIEW_REQUIRED = 'PPT_MASTER_CITATION_REVIEW_REQUIRED';
const sourcePath = /^inputs\/[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/;
const projectPath = /^(?!inputs(?:\/|$)|delivery(?:\/|$))[A-Za-z0-9_\p{L}][A-Za-z0-9_\p{L}-]*(?:\/[A-Za-z0-9_\p{L}][A-Za-z0-9_\p{L}-]*)*$/u;

function requiredStages(request) {
    if (request.operation === 'create_template') return ['template'];
    if (request.operation === 'generate' && ['default', 'beautify'].includes(request.profile)) return ['direction', 'design'];
    return ['design'];
}

function initializeReview(state) {
    if (state.review?.version === 1) return false;
    state.review = { version: 1, approvals: {} };
    delete state.deliveryReceipt;
    delete state.deliveryReview;
    delete state.reviewDraft;
    delete state.pageReview;
    delete state.pageSources;
    delete state.pageRepair;
    delete state.pendingKind; delete state.pendingInput; delete state.response;
    state.confirmedGates = 0;
    delete state.confirmationReceipts; delete state.confirmationRevisionPending;
    return true;
}

function valueText(value, max, label, multiline = false) {
    const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
    const forbidden = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u : /[\u0000-\u001f\u007f\ud800-\udfff]/u;
    if (!text || text.length > max || forbidden.test(text)) throw invalid(label + '为空、过长或含无效字符。');
    return text;
}

function nextStage(state) {
    return requiredStages(state.request).find(stage => !state.review.approvals[stage]);
}

function checklistFor(plan) {
    return plan.pages.map(page => [page.title, page.values.map(value => value.chart
        ? [value.text, value.chart.series, value.chart.category, value.chart.number] : value.text)]);
}

function citationExcerpt(source, anchor) {
    const start = source.indexOf(anchor);
    if (start === -1 || source.indexOf(anchor, start + anchor.length) !== -1) return '';
    return source.slice(Math.max(0, start - 60), start + anchor.length + 60);
}

async function normalizeStage(input, state, verifySource) {
    const required = requiredStages(state.request);
    const stage = input.stage;
    if (!required.includes(stage) || required.slice(0, required.indexOf(stage)).some(previous => !state.review.approvals[previous])) {
        throw invalid('请按制作流程提交当前待确认阶段：' + (labels[nextStage(state)] || '已批准方案的修订') + '。');
    }
    if (!input.plan || typeof input.plan !== 'object' || Array.isArray(input.plan)) throw invalid('请提供结构化的待确认方案。');
    const summary = valueText(input.plan.summary, 4000, '方案说明');
    if (stage === 'direction') return { stage, plan: { summary } };
    const project = valueText(input.plan.project, 180, '任务项目目录');
    if (!projectPath.test(project)) throw invalid('请填写实际任务项目的相对目录。');
    if (state.managedProject && project !== state.managedProject) throw invalid('请使用宿主已经准备的项目：' + state.managedProject);
    if (stage === 'template') return { stage, plan: { summary, project } };

    const { pages } = input.plan;
    if (!Array.isArray(pages) || !pages.length || pages.length > 100) throw invalid('请逐页提交有顺序的清单，每页都要填写页面标题和关键数据数组。');
    const expected = state.request.pageCount;
    if (state.request.operation === 'generate' && ['default', 'quick', 'image_to_pptx'].includes(state.request.profile) && pages.length !== expected) {
        throw invalid(`制作要求为 ${expected} 页。请提交包含全部 ${expected} 页的页面清单。`);
    }
    const normalized = [], sources = new Map(), failures = [], seen = new Set(), verified = new Set();
    const requiredFacts = new Map((state.citationFacts || []).map(fact => [fact.key, fact]));
    const availablePaths = new Set(['instruction', ...(state.request.inputFiles || []).filter(file => file.kind === 'text' && sourcePath.test(file.path)).map(file => file.path),
        ...(state.userSupplements || []).map(entry => entry.path)]);
    const readSource = async path => {
        if (!sources.has(path)) {
            const raw = getSupplement(state, path)?.text ?? await verifySource(path);
            sources.set(path, { raw, normalized: compact(raw) });
        }
        return sources.get(path);
    };
    let totalValues = 0;
    for (const [pageIndex, page] of pages.entries()) {
        const title = valueText(page?.title, 180, '页面标题');
        if (!Array.isArray(page.values) || page.values.length > 8 || (totalValues += page.values.length) > 120) {
            throw invalid('每页最多核验八项关键数据，全稿最多一百二十项。没有关键数据的页面请明确提交空数组。');
        }
        const values = [];
        for (const [valueIndex, entry] of page.values.entries()) {
            const text = valueText(entry?.text, 120, '关键数据原文');
            const value = { text };
            if (entry.chart !== undefined) {
                const series = valueText(entry.chart?.series, 120, '图表系列');
                const category = valueText(entry.chart?.category, 120, '图表分类');
                const number = valueText(entry.chart?.number, 48, '图表数字');
                const numericLiteral = /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(number)
                    && containsValue(text, number);
                if (!numericLiteral) {
                    throw invalid('图表数据须提供原文中出现的十进制数字、系列和分类。');
                }
                value.chart = { series, category, number };
            }
            const key = citationKey(value);
            seen.add(key);
            const previous = requiredFacts.get(key);
            const fact = { key, ...value, title, page: pageIndex + 1, item: valueIndex + 1 };
            values.push(value);
            if (entry.source === undefined) {
                if (previous) failures.push({ ...fact, path: previous.path, excerpt: previous.excerpt, reason: '仍需为该数据项提供可核对的引用。' });
                continue;
            }
            let path, quote;
            try {
                path = valueText(entry.source?.path, 140, '关键数据来源');
                quote = valueText(entry.source?.quote, 350, '关键数据引文', true);
            } catch (failure) {
                if (failure.code !== 'PPT_MASTER_ACTION_INVALID') throw failure;
            }
            if (!availablePaths.has(path)) {
                failures.push({ ...fact, path: '', reason: '请为本项提供当前任务的文本材料、制作要求或已登记的用户补充。' });
                continue;
            }
            const source = await readSource(path);
            if (!quote) {
                const original = typeof entry.source?.quote === 'string' && !entry.source.quote.trim() ? originalLine(source, text) : '';
                if (original) {
                    value.source = { path, quote: original };
                    verified.add(value);
                } else failures.push({ ...fact, path, reason: '引文为空、过长或含无效字符。请提供含本项数据的连续原文。' });
                continue;
            }
            value.source = { path, quote };
            const normalizedQuote = compact(quote);
            const quoteFound = containsValue(source.normalized, normalizedQuote);
            const containsText = containsValue(normalizedQuote, text);
            if (!quoteFound && containsText) {
                const original = originalLine(source, text);
                if (original) {
                    value.source.quote = original;
                    verified.add(value);
                    continue;
                }
            }
            if (!quoteFound || !containsText) {
                if (!quoteFound && previous) {
                    const located = await locateCitation(availablePaths, path, quote, text, readSource);
                    if (located) {
                        value.source = located;
                        verified.add(value);
                        continue;
                    }
                }
                const reason = quoteFound ? '关键数据未完整出现在引文中，请核对数字、单位及原文范围。'
                    : '关键数据引文与材料原文不一致，请重新查阅该来源并引用连续原文。';
                const excerpt = citationExcerpt(source.raw, quoteFound ? quote : text);
                failures.push({ ...fact, path, reason, ...(excerpt ? { excerpt } : {}) });
            } else verified.add(value);
        }
        normalized.push({ title, values });
    }
    const approved = new Set(state.review.approvals.design?.plan?.pages?.flatMap(page => page.values.map(citationKey)));
    for (const [key, fact] of requiredFacts) {
        if (fact.allowOmit || seen.has(key)) continue;
        const matchingPages = normalized.filter(page => page.title === fact.title);
        if (!approved.has(key) && matchingPages.length === 1) {
            const candidates = matchingPages[0].values.filter(value => verified.has(value) && !value.previousText
                && verifiedCorrection(fact, value, sources.get(fact.path)?.raw));
            if (candidates.length === 1) {
                candidates[0].previousText = fact.text;
                continue;
            }
        }
        failures.push({ ...fact, missing: true, reason: '之前待核对的数据项仍需保留，或由用户说明如何调整。' });
    }
    const plan = { summary, project, pages: normalized };
    const templateUse = normalizeTemplateUse(state, input.plan, normalized);
    if (templateUse) plan.templateUse = templateUse;
    if (failures.length) {
        const citationIssues = failures.map(({ page, item, path, title, text, reason, excerpt, missing }) => ({
            location: `第 ${page} 页第 ${item} 项（${sourceLabel(path)}）`, page, item, title, text, path, reason,
            ...(excerpt ? { excerpt } : {}), ...(missing ? { missing: true } : {})
        }));
        const detail = citationIssues.slice(0, 4).map(({ location, reason }) => `${location}的${reason}`).join('');
        const remaining = citationIssues.length - 4;
        throw Object.assign(invalid(detail + (remaining > 0 ? `另有 ${remaining} 项引用待核对。` : '')), {
            citationIssues, citationFacts: failures, citationDraft: { kind: 'confirmation', stage, question: input.question, plan }
        });
    }
    return { stage, plan };
}

function reopenReview(state, stage = requiredStages(state.request).at(-1)) {
    if (!state.review) return;
    const approvals = state.review.approvals;
    const required = requiredStages(state.request);
    const stageIndex = required.indexOf(stage);
    if (stageIndex < 0) return;
    if (stage === 'direction') delete state.citationDraft;
    for (const stage of required.slice(stageIndex)) delete approvals[stage];
    delete state.deliveryReceipt;
    delete state.deliveryReview;
    delete state.reviewDraft;
    delete state.pageReview;
    delete state.pageSources;
    delete state.pageRepair;
    state.confirmedGates = Object.keys(approvals).length;
}

function applyReviewDecision(state, pending, approved) {
    const approvals = state.review.approvals;
    if (!requiredStages(state.request).includes(pending.stage) || !pending.plan) return false;
    const postingDigest = digest(pending.plan), previous = approvals[pending.stage];
    if (approved && previous?.digest === postingDigest) return false;
    reopenReview(state, pending.stage);
    if (approved) approvals[pending.stage] = { promptId: pending.promptId, digest: postingDigest, plan: pending.plan };
    state.confirmedGates = Object.keys(approvals).length;
    return true;
}

function exportReview(state, project, templateOnly = false) {
    const missing = nextStage(state);
    if (missing) throw checklistError('请先提交并取得用户对' + labels[missing] + '的明确批准，再执行导出。');
    const approval = state.review.approvals[templateOnly ? 'template' : 'design'];
    if (!approval || approval.digest !== digest(approval.plan) || approval.plan.project !== project) {
        throw checklistError('导出项目与用户批准的方案不一致，请核对任务目录和确认记录。');
    }
    if (state.request.template?.type === 'runtime' && (!state.templateSpec || approval.plan.templateUse?.id !== state.templateSpec.id
        || approval.plan.templateUse.digest !== state.templateSpec.digest)) {
        throw checklistError('请重新提交采用所选模板的最终清单并取得确认，再执行导出。');
    }
    const checklist = templateOnly ? null : checklistFor(approval.plan);
    return { checklist, checklistDigest: checklist && digest(checklist), ...(approval.plan.templateUse ? { templateUse: approval.plan.templateUse } : {}) };
}

function verifyReceipt(receipt, expected) {
    if (!expected.checklist) return;
    if (expected.templateUse && receipt?.packageCheck?.templateSpecDigest !== expected.templateUse.digest) {
        throw error('交付文件的模板安装记录与已确认清单不一致，请重新应用模板并导出。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
    }
    if (receipt?.packageCheck?.checklistDigest !== expected.checklistDigest
        || receipt.packageCheck.slideCount !== expected.checklist.length
        || receipt.packageCheck.checkedPages !== expected.checklist.length
        || receipt.packageCheck.checkedValues !== expected.checklist.reduce((count, page) => count + page[1].length, 0)) {
        throw error('交付回执缺少当前清单的完整核验，请更新 PPT Master 执行服务后继续。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
    }
}

function pageReviewFor(state, report, checklist) {
    if (!Array.isArray(report?.passedPages) || !Array.isArray(report?.failedPages) || !report.failedPages.length) return null;
    const pageNumbers = [...report.passedPages, ...report.failedPages.map(item => item?.page)];
    if (pageNumbers.length !== checklist.length || new Set(pageNumbers).size !== checklist.length
        || pageNumbers.some(page => !Number.isInteger(page) || page < 1 || page > checklist.length)) return null;
    const pages = state.review?.approvals?.design?.plan?.pages;
    return { passedPages: [...report.passedPages].sort((a, b) => a - b), failedPages: report.failedPages.map(item => {
        const [title, values] = checklist[item.page - 1];
        const missingItems = Array.isArray(item.missingValues) ? [...new Set(item.missingValues)] : [];
        return { page: item.page, title, missingTitle: item.missingTitle === true,
            items: missingItems.filter(index => Number.isInteger(index) && index > 0 && index <= values.length).map(index => {
                const value = values[index - 1], source = pages?.[item.page - 1]?.values?.[index - 1]?.source;
                return { index, text: Array.isArray(value) ? value[0] : value,
                    ...(Array.isArray(value) ? { chart: { series: value[1], category: value[2], number: value[3] } } : {}),
                    ...(source ? { source } : {}) };
            }) };
    }).sort((a, b) => a.page - b.page) };
}

function repairActionAllowed(state, action) {
    const project = state.review.approvals?.design?.plan?.project;
    if (['read', 'read_runtime', 'read_history', 'read_images', 'list'].includes(action.action)) return true;
    if (action.action === 'write') {
        return state.pageRepair.sourceFiles.includes(action.path);
    }
    if (action.action !== 'run') return false;
    if (action.tool === 'project') return ['info', 'page-context', 'page-context-report', 'validate'].includes(action.args?.[0]) && action.args[1] === project;
    if (state.pageRepair.automatic) return false;
    if (!['check_svg', 'export'].includes(action.tool) || action.args?.[0] !== project) return false;
    if (action.tool === 'export') return !action.args.some(arg => arg === '--roundtrip' || arg === '-s' || arg.startsWith('--source'));
    return true;
}

function pageRepairSources(report, project, count) {
    const files = report?.pageSources, prefix = project + '/svg_output/';
    if (!Array.isArray(files) || files.length !== count || new Set(files).size !== count) return null;
    return files.every(file => typeof file === 'string' && file.startsWith(prefix)
        && /^[^/\\:]+\.svg$/.test(file.slice(prefix.length)) && !file.slice(prefix.length).startsWith('.')) ? files : null;
}

function reviewGuidance(state) {
    if (!state.review) return '';
    const stage = nextStage(state);
    return stage
        ? `当前宿主确认协议优先：下一阶段为 ${stage}（${labels[stage]}）。用 requestInput.kind=confirmation、stage=${stage}、question、plan 提交；等 Pivot 返回用户批准，无需另起确认服务。plan 填写 summary；design 或 template 还须填写实际 project，design 另填顺序 pages:[{title,values:[{text,source?:{path,quote}}]}]。引用材料时先读取实际来源，复制含指标、数字、单位和限定条件的连续原文作 quote，从该引文截取页面实际显示的 text。制作要求仅能佐证其中明确写出的事实。确认前不得 export 或最终交付。`
        : '宿主确认阶段：必需阶段均已批准。按已批准的项目与清单继续制作；修改清单须重新提交用户批准。';
}

function reviewRecoveryGuidance(state, code, message) {
    const reason = String(message || '').slice(0, 500);
    if (code === 'PPT_MASTER_ACTION_INVALID' && reason) {
        return '\n上次无效回复未执行。失败原因：' + reason + '\n按提示核对相关字段和当前材料后，仅修正存在问题的部分。';
    }
    if (code === CITATION_REVIEW_REQUIRED) {
        return '\n上次停在清单引文核对。结合用户补充的原文修正数据项，或按明确的修改要求重提清单。';
    }
    if (code === 'PPT_MASTER_NO_PROGRESS') {
        return '\n上一轮已因反复读取或检查暂停。复用已有文件和回执，读取当前上下文缺少的具体范围，或推进当前阶段的确认、写入、导出。缺少必要事实时提交具体问题。';
    }
    if (code === 'PPT_MASTER_PHASE_LIMIT') {
        return '\n当前阶段在有限轮次内未完成。请沿用已有资料、回执和批准内容，先提交本阶段产出或提出确实需要用户补充的问题。';
    }
    if (code === 'PPT_MASTER_TOOL_REPEATED_FAILURE') {
        return '\n上次有连续制作工具执行失败。根据最近保存的错误回执修正对应动作。已有成功回执的同批动作无需重做。';
    }
    if (code === 'PPT_MASTER_DELIVERY_REEXPORT_FAILED' || code === 'PPT_MASTER_OPERATION_FAILED' && require('./delivery-recovery').isStaleExport(reason)) {
        return '\n上次交付的导出回执已失效或复检失败。请修正失败项，按已批准清单重新校验和导出，再提交实际导出的 PPTX。';
    }
    const needsDeliveryRepair = code === 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED'
        || code === 'PPT_MASTER_OPERATION_FAILED' && /^交付(?:第 \d+ 页|页数不符)/.test(reason);
    if (!needsDeliveryRepair) return '';
    const page = /^交付第 (\d+) 页/.exec(reason);
    const expected = page && state.review?.approvals?.design?.plan?.pages[Number(page[1]) - 1];
    const guidance = '\n上次交付核验：' + reason + '\n复用已生成稿件，按已确认清单局部修正，再重新导出和核验。';
    if (!expected) return guidance;
    return guidance + '\n该页已确认内容：' + JSON.stringify({ title: expected.title, values: expected.values.map(value => value.text) })
        + '\n完整标题及文字型关键数据各放在单个可回读的文本对象中，可在同一对象内换行。';
}

function resetCitationRepair(state, { allowRevision = false } = {}) {
    delete state.citationRepairAttempts;
    delete state.citationRepairRequired;
    delete state.citationPause;
    if (allowRevision) {
        state.citationFacts = state.citationFacts?.map(fact => ({ ...fact, allowOmit: true }));
        if (state.citationDraft) {
            state.messages ||= [];
            state.messages.push({ role: 'user', content: JSON.stringify({ unapprovedCitationPlan: state.citationDraft.plan }) });
            delete state.citationDraft;
        }
        delete state.citationRepair;
    }
}

module.exports = { initializeReview, normalizeStage, applyReviewDecision, reopenReview, resetCitationRepair, exportReview, verifyReceipt, pageReviewFor, pageRepairSources, repairActionAllowed, reviewGuidance, reviewRecoveryGuidance, CITATION_REVIEW_REQUIRED, labels };
