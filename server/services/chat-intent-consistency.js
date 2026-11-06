'use strict';

const { currentUserText, currentRequestText, isPlanOnlyRequest } = require('./chat-request-constraints');
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { capabilitiesCoverTool } = require('./agent-capability-registry');

function explicitContinuationTarget(prompt, tasks = []) {
    const text = currentRequestText(prompt).replace(/[。！!，,\s]+$/u, '');
    const confirmation = /^(?:请)?(?:继续|接着|继续(?:按|按照)(?:刚才|此前|上面)(?:的)?方案(?:处理|执行)|(?:好的[，,]?|好[，,]?)?就按(?:这个|刚才的方案)(?:办|处理|执行)|continue)$/iu.test(text);
    const update = {};
    const clauses = text.split(/[，,。；;\n]/u).map(clause => clause.trim()).filter(Boolean);
    const simpleUpdate = clauses.length > 0 && clauses.every(clause => {
        const time = clause.match(/^(?:这次|这轮|本轮)?(?:改为|改成)(本月|本周|上月|上周|本季度|今年|去年)(?:口径|范围)?$/u);
        if (time) { update.timeRange = time[1]; return true; }
        const format = clause.match(/^(?:这次|这轮|本轮|输出)?(?:只给|只要|仅输出|只输出|仅需)(摘要|明细)$/u);
        if (format) { update.format = format[1]; return true; }
        return /^(?:并)?保留(?:异常)?依据$/u.test(clause);
    }) && Object.keys(update).length > 0;
    if (!confirmation && !simpleUpdate) return null;
    const active = tasks.filter(task => task.active === true);
    if (active.length !== 1 || (active[0].status && !['queued', 'planning', 'running', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming',
        'approval_required', 'waiting_approval', 'awaiting_approval', 'awaiting_commit', ...(simpleUpdate ? ['needs_input'] : [])].includes(active[0].status))) return null;
    return { ...active[0], continuationUpdate: simpleUpdate ? update : {} };
}

function isStandaloneTextDraft(prompt, { history = [], tasks = [], providedSources = [] } = {}) {
    if (history.length || tasks.length || providedSources.length || String(prompt).length > 240) return false;
    const text = currentUserText(prompt).trim();
    if (/[\n；;]|(?:根据|依据|结合).*(?:文件|附件|资料|制度|数据)|公司|部门|内部|真实|实际|本周|本月|本年|今年|昨天|今天|最新|实时|\d{4}|(?:查询|检索|读取|核对|联网|下载|保存|导出|发送|发给|执行|运行|修改|修复|汇总)|\b(?:file|pdf|pptx?|word|excel|docx|xlsx|save|send|export|download|run|execute)\b/iu.test(text)) return false;
    // 只为无历史、无来源、无外部动作的独立文本草稿保留快捷路径。产品名称
    // 等可用占位符，不把模板创作误判为需要再次索取业务资料。
    return /^(?:请|帮我|为我|替我|麻烦)?(?:写|撰写|起草)(?:一份|一封|一个|一首|份|封|个|首).{1,80}(?:报告|模板|申请书|申请|邮件|通知|诗|诗歌|故事)[。！!]?$/u.test(text);
}

function reconcileIntentAction(raw, prompt, { tasks = [], history = [] } = {}) {
    if (raw?.action !== 'direct_answer' || !Array.isArray(raw.requiredCapabilities)) return { raw, adjustments: [] };
    const text = currentRequestText(prompt);
    // 仅修复明确的文件委托与已申请的渲染能力之间的动作冲突；讨论、方案、代码
    // 执行和本机写入不在此处推断授权，仍交给原语义与运行时策略复核。
    const discussion = /解释|如何|怎么|怎样|什么意思|教程|\b(?:explain|describe|how\s+to|tutorial)\b/iu.test(text);
    const baseline = classifyChatAutoExecution({ prompt: text, history });
    const taskCapabilities = raw.requiredCapabilities.some(capability => /^(?:filesystem\.write|code\.|document\.render|viz\.render|media\.|desktop\.|workflow\.)/.test(capability));
    const delegated = /^(?:请|帮我|替我|为我|麻烦|可以帮我|能否帮我|按(?:照)?(?:刚才|上面|此前)(?:给出)?的?方案)/u.test(text)
        || /^(?:please|can you|could you|would you)\b/iu.test(text);
    const supported = raw.requiredCapabilities.filter(capability => /^(?:filesystem\.write|code\.|document\.render|viz\.render|media\.|desktop\.|workflow\.)/.test(capability))
        .every(capability => capabilitiesCoverTool(baseline.requiredCapabilities || [], [capability]));
    if (!tasks.length && delegated && taskCapabilities && supported && !discussion && !isPlanOnlyRequest(prompt)
        && (baseline.action === 'agent_run' || (baseline.continuation && /修改|修复|运行|执行|\b(?:fix|implement|run|execute)\b/iu.test(text)))) {
        return { raw: { ...raw, action: 'agent_run', objective: currentUserText(prompt), routing: { ...raw.routing, tools: 'task' } }, adjustments: ['explicit_delegated_task'] };
    }
    if (!raw.requiredCapabilities.includes('document.render')) return { raw, adjustments: [] };
    const explicit = /^(?:请|帮我|替我|为我|麻烦|把|将|现在|这次|本轮|分析|总结|翻译|please\b|can\s+you\b|could\s+you\b|analy[sz]e\b|summari[sz]e\b|review\b|export\b|create\b|generate\b|convert\b)/iu.test(text);
    const artifact = /可下载|(?:生成|制作|导出|做成|转成|转换为|保存).{0,24}(?:文件|\b(?:word|pdf|pptx?|powerpoint|excel|docx|xlsx)\b)|\b(?:export|save|create|generate|convert|make)\b.{0,40}\b(?:file|document|word|pdf|pptx?|powerpoint|excel|docx|xlsx)\b/iu.test(text);
    const unexpected = raw.requiredCapabilities.some(capability => /^(?:filesystem\.write|code\.|desktop\.|workflow\.|network\.http_request)/.test(capability));
    if (!explicit || !artifact || discussion || unexpected || isPlanOnlyRequest(prompt)) return { raw, adjustments: [] };
    return { raw: { ...raw, action: 'agent_run', objective: currentUserText(prompt),
        routing: { ...raw.routing, tools: 'task' }, acceptance: { ...raw.acceptance, artifactRequired: true } }, adjustments: ['explicit_artifact_task'] };
}

module.exports = { explicitContinuationTarget, reconcileIntentAction, isStandaloneTextDraft };
