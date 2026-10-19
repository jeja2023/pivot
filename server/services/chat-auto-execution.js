'use strict';

const { isRegisteredCapability } = require('./agent-capability-registry');
const ACTION_PATTERN = /(查询|检索|读取|收集|汇总|整理|分析|核对|比对|生成|导出|更新|同步|跟进|监控|修复|部署|发布|发送|通知|执行|查找|统计|审查|对账|归档|修改|测试|query|search|read|collect|summari[sz]e|analy[sz]e|verify|compare|generate|export|update|sync|monitor|fix|deploy|publish|send|notify|archive)/gi;
const TASK_SIGNAL = /附件|表格|数据|订单|代码|项目|系统|文件|目录|网页|浏览器|报告|工具|CRM|ERP|API|SQL|执行|完成|处理|继续|刚才|上次|按.*方案|修复|修改|部署|发布|发送|监控|生成|分析|核对|清理|制作|整理|收集|研究|调查|查找|准备|解决|优化|升级|改造|办好|export|implement|fix|deploy|execute|continue|analy[sz]e/i;
const CONTINUE = /^(?:继续|接着|按(?:刚才|上面|此前|这个|该)|就按|开始吧|做吧|处理吧|再按上次|continue\b)/i;
const CONTEXTUAL = /^(?:这次|这轮|改成|改为|补充|另外|不要继续|先别|保留|只要|只给|换成)/;
const STOP = /^(?:(?:请|麻烦你|帮我)?(?:立即|马上)?(?:停止|暂停|取消|终止)(?:当前|正在|这个|该)?的?(?:任务|执行|处理|运行)?(?:吧|了)?|(?:别|不要)再?(?:执行|处理|继续)了?|(?:stop|cancel|pause)(?:\s+(?:the\s+)?(?:current\s+)?(?:task|run|execution))?)[！!。,.，\s]*$/i;
const PLAN = /(?:先|只|仅)(?:给|做|提供|输出)?.{0,14}(?:方案|计划|建议|思路|分析)|(?:不要|暂不|先别|无需).{0,12}(?:执行|修改|操作|发送|发布|写入|删除|改代码)/i;
const DISCUSS = /解释|介绍|说明|是什么|什么意思|如何|怎么|怎样|区别|优缺点|要求是什么|应该如何|能否|能不能|是否可以|为什么|[？?]/i;
const CREATIVE = /翻译|润色|改写|续写|写一封|写个|起草|写一份|撰写/i;
const MEMORY = /^(?:不对[，,。 ]*)?(?:请|帮我)?(?:记住|记下|(?:以后|今后|下次)(?:报告|回答|回复|输出|请|用|按|先|简短|详细)|忘记|忘掉|不要再用|不再记住|更正|改正|这个口径只用于当前项目)/;

function clean(value, max = 12000) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function countDistinctActions(value) { return new Set((clean(value).match(ACTION_PATTERN) || []).map(item => item.toLowerCase())).size; }
function capabilitiesFor(text) {
    const caps = ['agent.execute'];
    if (/数据|订单|CRM|ERP|SQL|database|query/i.test(text)) caps.push('data.query');
    if (/附件|文件|目录|代码|项目|file|workspace/i.test(text)) caps.push('filesystem.read_workspace', 'artifact.read');
    if (/网页|网站|浏览器|browser|web/i.test(text)) caps.push('network.browser_visit', 'network.web_search');
    if (/知识库|资料库|公司制度|knowledge/i.test(text)) caps.push('knowledge.search');
    if (/报告|表格|图表|文档|导出|report|document/i.test(text)) caps.push('document.render', 'viz.render');
    if (/修改|修复|测试|代码|implement|fix|test/i.test(text)) caps.push('filesystem.write_workspace', 'code.execute');
    if (/API|接口/i.test(text)) caps.push('network.http_request');
    if (/交付|保存到|写入文件/i.test(text)) caps.push('artifact.deliver');
    return [...new Set(caps)].filter(isRegisteredCapability);
}
function decision(action, text, extras = {}) {
    return {
        version: 2, action, objective: clean(text), constraints: [], deliverables: [], missingFacts: [], evidenceRefs: [],
        intent: { agent_run: 'delegate', continue_run: 'continue', plan_only: 'plan', control: 'stop', memory: 'correct', clarify: 'clarify' }[action] || 'understand',
        nextAction: { agent_run: 'create_agent_run', continue_run: 'continue_agent_run', plan_only: 'plan_only', control: 'stop_task', memory: 'update_memory', clarify: 'clarify' }[action] || 'direct_answer',
        requiredCapabilities: ['agent.execute'], confidence: 1, reasonCode: 'safe_baseline', ...extras
    };
}
// 规则仅作语义候选准入，不以动作数量或历史习惯决定执行授权。
function classifyChatAutoExecution({ prompt = '', history = [], enabled = true } = {}) {
    const text = clean(prompt);
    if (!enabled || !text) return decision('direct_answer', text, { reasonCode: 'auto_execution_disabled' });
    if (STOP.test(text)) return decision('control', text, { control: /暂停|pause/i.test(text) ? 'pause' : 'stop', reasonCode: 'explicit_stop' });
    if (MEMORY.test(text) && (!/^(?:请|帮我)?(?:更正|改正|忘记|忘掉)/.test(text) || /偏好|记忆|习惯/.test(text))) return decision('memory', text, { reasonCode: 'explicit_memory_intent' });
    if (PLAN.test(text)) return decision('plan_only', text, { constraints: ['仅提供分析与计划，不执行工具或外部动作。'], reasonCode: 'explicit_plan_only' });
    const continuation = CONTINUE.test(text) || CONTEXTUAL.test(text);
    const politeDelegation = /(?:可以|能否|能不能|能).*(?:帮我|替我).*(?:分析|修复|处理|核对|汇总|修改)|(?:can|could|would) you.*(?:fix|analy[sz]e|implement|process|verify)/i.test(text);
    if (!continuation && (DISCUSS.test(text) && !politeDelegation && !/(?:请|帮我|替我).*(?:实际|直接|动手|执行|完成)/.test(text) || CREATIVE.test(text) && !/(?:读取|核对|检索|导出|保存|发送|附件|数据)/.test(text))) {
        return decision('direct_answer', text, { reasonCode: 'exploratory_request' });
    }
    if (!TASK_SIGNAL.test(text) && !continuation) return decision('direct_answer', text, { reasonCode: 'no_task_signal' });
    const prior = (Array.isArray(history) ? history : []).slice(-8).some(item => item.role === 'user' && TASK_SIGNAL.test(clean(item.content)));
    if (continuation) return decision(prior ? 'continue_run' : 'clarify', text, {
        continuation: true, reasonCode: prior ? 'contextual_task_continuation' : 'continuation_target_missing',
        contextualOnly: CONTEXTUAL.test(text),
        question: '你希望继续处理哪项任务？', requiredCapabilities: capabilitiesFor(text)
    });
    const delegated = /请|帮我|替我|为我|完成|处理|执行|汇总|分析|修复|修改|生成|export|implement|fix/i.test(text);
    const actionCount = countDistinctActions(text);
    if (delegated && (actionCount >= 2 || /附件|代码|文件|数据库|CRM|ERP/i.test(text))) {
        return decision('agent_run', text, { delegated: true, actionCount, reasonCode: 'explicit_delegated_task', requiredCapabilities: capabilitiesFor(text), allowMcp: /CRM|ERP|数据库|网页|网站|API/i.test(text) });
    }
    return decision('clarify', text, { reasonCode: 'ambiguous_task_scope', question: '你希望对这些内容做什么处理，并得到什么结果？', missingFacts: ['处理目标与交付结果'] });
}
module.exports = { classifyChatAutoExecution, countDistinctActions };
