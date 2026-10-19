'use strict';

/**
 * 服务端拥有的持久化聊天 Agent 路径高置信度准入。
 *
 * 该分类器仅用于选择执行底座；绝不直接授予能力、工具、
 * 网络访问或审批豁免。这些校验仍由现有 Agent 运行时和工具策略边界执行。
 */
const ACTION_PATTERN = /(查询|检索|读取|收集|汇总|整理|分析|核对|比对|生成|导出|更新|同步|跟进|监控|修复|部署|发布|发送|通知|执行|查找|统计|审查|对账|归档|query|search|read|collect|summari[sz]e|analy[sz]e|verify|compare|generate|export|update|sync|monitor|fix|deploy|publish|send|notify|archive)/gi;
const DELIVERY_PATTERN = /(报告|表格|清单|方案|文档|摘要|结论|看板|邮件|通知|交付物|文件|任务|report|table|checklist|document|summary|dashboard|deliverable)/i;
const DELEGATION_PATTERN = /(?:帮我|请(?:你)?|替我|为我|交给你|由你|负责|完成|处理|执行|持续跟进|自动(?:化)?处理|开始(?:处理|执行)|run(?:\s+with)?|handle|take\s+care\s+of|complete|execute|automate)/i;
const PLAN_ONLY_PATTERN = /(?:先|只|仅)(?:给|做|提供|输出)?.{0,14}(?:方案|计划|建议|思路|分析)|(?:不要|暂不|先别|无需).{0,12}(?:执行|修改|操作|发送|发布|写入|删除)/i;
const EXPLORATION_PATTERN = /(?:解释|介绍|说明|翻译|润色|改写|续写|写一封|写个|起草|总结以下内容|给个例子|示例|概念|区别|优缺点)/i;
const CONTINUATION_PATTERN = /^(?:继续|接着|按(?:刚才|上面|此前|这个|该)(?:的)?(?:方案|计划|要求|格式)?|就按(?:这个|刚才)|开始吧|做吧|处理吧|继续处理)/i;
// 仅将无歧义的祈使句识别为任务控制。宽泛的
// 前缀匹配（如 /^停止/）容易把“停止当前任务如何实现？”误判为取消活跃任务。
const STOP_PATTERN = /^(?:(?:请|麻烦(?:你)?|帮我)(?:立即|马上)?(?:停止|暂停|取消|终止)(?:当前|正在|这个|该)?(?:的)?(?:任务|执行|处理|运行)?(?:吧|了)?|(?:停止|暂停|取消|终止)(?:当前|正在|这个|该)?(?:的)?(?:任务|执行|处理|运行)(?:吧|了)?|(?:别|不要)(?:再)?(?:执行|处理|继续)(?:了)?|(?:stop|cancel|pause)(?:\s+(?:the\s+)?(?:current\s+)?(?:task|run|execution))?)[！!。,.，\s]*$/i;
const CAPABILITY_HINT_PATTERN = /(?:数据库|数据表|订单系统|CRM|ERP|报表|文件夹|本机|本地文件|网页|网站|浏览器|API|SQL|database|crm|erp|report|file|browser|web|api)/i;

function normalize(value, max = 12000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function countDistinctActions(value) {
    const matches = normalize(value).match(ACTION_PATTERN) || [];
    return new Set(matches.map(item => item.toLowerCase())).size;
}

function profileAffinity(prompt, profile = {}) {
    const text = normalize(prompt).toLowerCase();
    const entries = [
        ...(Array.isArray(profile.commonTasks) ? profile.commonTasks : []),
        ...(Array.isArray(profile.workHabits) ? profile.workHabits : [])
    ].map(item => normalize(item, 120).toLowerCase()).filter(Boolean);
    if (!text || !entries.length) return 0;
    return entries.some(item => item.length >= 4 && (text.includes(item) || item.includes(text.slice(0, 48)))) ? 0.08 : 0;
}

function hasPriorDelegatedTask(history = []) {
    return (Array.isArray(history) ? history : []).slice(-8).some(message => {
        if (String(message?.role || '').toLowerCase() !== 'user') return false;
        const content = normalize(message?.content);
        return DELEGATION_PATTERN.test(content) && (countDistinctActions(content) >= 2 || DELIVERY_PATTERN.test(content));
    });
}

/**
 * 此处仅为能力“类别”，而非具体的工具名称或权限授予。
 * 保持粗粒度设计，确保模型或路由决策绝不会凭空捏造集成或扩展用户权限。
 * 运行时会在后续依据调用者既有能力策略进行实际解析。
 */
function inferRequiredCapabilities(text = '') {
    const source = normalize(text).toLowerCase();
    const capabilities = new Set();
    if (/(?:数据库|数据表|订单系统|crm|erp|sql|database|table)/i.test(source)) capabilities.add('data.read');
    if (/(?:文件夹|本机|本地文件|文件|file|folder|workspace)/i.test(source)) capabilities.add('workspace.read');
    if (/(?:网页|网站|浏览器|browser|web)/i.test(source)) capabilities.add('browser.inspect');
    if (/(?:api|接口|第三方系统|external\s+system)/i.test(source)) capabilities.add('external.system.read');
    return [...capabilities].sort();
}

function buildIntentDecision({
    action,
    intent,
    reasonCode,
    objective,
    continuation = false,
    missingFacts = [],
    ...extras
} = {}) {
    const nextAction = {
        agent_run: 'create_agent_run',
        plan_only: 'plan_only',
        control: 'stop_task',
        direct_answer: 'direct_answer'
    }[action] || 'direct_answer';
    const requiredCapabilities = action === 'agent_run'
        ? inferRequiredCapabilities(objective)
        : [];
    return {
        version: 1,
        action: action || 'direct_answer',
        intent: intent || 'understand',
        nextAction,
        reasonCode: String(reasonCode || ''),
        objective: String(objective || ''),
        requiredCapabilities,
        missingFacts: Array.isArray(missingFacts) ? missingFacts.slice(0, 4) : [],
        // 刻意仅保留相对于消息的证据标识。详细消息 ID 仍保存在现有聊天桥接与审计记录中。
        evidenceRefs: continuation ? ['current_message', 'recent_task_context'] : ['current_message'],
        ...extras
    };
}

function classifyChatAutoExecution({ prompt = '', history = [], profile = {}, enabled = true } = {}) {
    const text = normalize(prompt);
    const direct = (reasonCode, extras = {}) => buildIntentDecision({
        action: 'direct_answer',
        intent: extras.intent || 'understand',
        reasonCode,
        objective: text,
        confidence: 0,
        ...extras
    });
    if (!enabled) return direct('auto_execution_disabled');
    if (!text || text.length < 4) return direct('prompt_too_short');
    if (STOP_PATTERN.test(text)) return buildIntentDecision({ action: 'control', intent: 'stop', control: 'stop', confidence: 0.98, reasonCode: 'explicit_stop', objective: text });
    if (PLAN_ONLY_PATTERN.test(text)) return buildIntentDecision({ action: 'plan_only', intent: 'plan', confidence: 0.96, reasonCode: 'explicit_plan_only', objective: text });

    const actionCount = countDistinctActions(text);
    const hasDeliverable = DELIVERY_PATTERN.test(text);
    const delegated = DELEGATION_PATTERN.test(text);
    const continuation = CONTINUATION_PATTERN.test(text) && hasPriorDelegatedTask(history);
    const exploratory = EXPLORATION_PATTERN.test(text) && !delegated;
    if (exploratory) return direct('exploratory_request', { intent: 'explore', actionCount, hasDeliverable, delegated, continuation });

    let confidence = 0;
    if (delegated) confidence += 0.58;
    if (actionCount >= 2) confidence += 0.26;
    if (hasDeliverable) confidence += 0.16;
    if (continuation) confidence += 0.22;
    confidence += profileAffinity(text, profile);
    confidence = Math.min(0.99, confidence);

    const hasExecutionShape = (delegated && (actionCount >= 1 || hasDeliverable))
        || (actionCount >= 2 && hasDeliverable)
        || continuation;
    if (hasExecutionShape && confidence >= 0.74) {
        return buildIntentDecision({
            action: 'agent_run',
            intent: continuation ? 'continue' : 'delegate',
            confidence,
            reasonCode: continuation ? 'contextual_task_continuation' : delegated ? 'explicit_delegated_task' : 'multi_step_deliverable',
            objective: text,
            actionCount,
            hasDeliverable,
            delegated,
            continuation,
            allowMcp: CAPABILITY_HINT_PATTERN.test(text)
        });
    }
    return direct('insufficient_execution_evidence', {
        intent: delegated ? 'delegate' : 'understand',
        actionCount,
        hasDeliverable,
        delegated,
        continuation,
        confidence,
        ...(delegated ? { missingFacts: ['task_scope_or_expected_deliverable'] } : {})
    });
}

module.exports = {
    classifyChatAutoExecution,
    countDistinctActions
};
