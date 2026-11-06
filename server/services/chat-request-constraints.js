'use strict';

// 只把用户本轮的独立限制作为硬边界；引用中的指令仍交给语义层理解。
function currentUserText(prompt = '') {
    return String(prompt).split(/\n---\s*\n【参考文档/)[0]
        .replace(/!?\[(?:附件|文件)[:：][^\]]*\]\([^\n)]*\)/g, '').trim();
}

function currentRequestText(prompt = '') {
    return currentUserText(prompt)
        .replace(/```[\s\S]*?```/g, '').replace(/^[ \t]*>.*$/gm, '')
        .replace(/[“「][^”」]*[”」]|"[^"\n]*"/g, '').trim();
}

function requestClauses(prompt = '') {
    return currentRequestText(prompt).split(/[，,。！？!?；;\n]|\b(?:but|however|then)\b/iu).map(item => item.trim()).filter(Boolean);
}

function isPureMemoryRequest(prompt = '') {
    const text = currentUserText(prompt);
    if (/[?？]|什么意思|怎么说|如何|是什么|\b(?:what|how|why|explain|translate)\b/iu.test(text)) return false;
    const clauses = requestClauses(text);
    // 混合意图交给语义入口，避免用有限的任务对象词表抢占当前工作。
    if (clauses.length > 1 && clauses.slice(1).some(clause => !/^(?:只|仅)(?:用于|限于|在)(?:当前|这个|本)(?:项目|会话)$/.test(clause))) return false;
    return !/(?:并且|然后|同时|另外|顺便|并(?!列))|(?:再)(?:请|帮我|替我|为我)|\b(?:and|also)\b/iu.test(text);
}

function isPlanOnlyRequest(prompt = '') {
    const text = currentRequestText(prompt);
    const clauses = text.split(/[，,。！!；;\n]/).map(item => item.trim()).filter(Boolean);
    if (/^(?:please\s+)?(?:only|just)\s+(?:give|provide|write|outline|show)(?:\s+me)?(?:\s+(?:a|the))?\s+(?:plan|proposal|suggestions?)\b/i.test(text)) return true;
    const prefix = '(?:(?:这次|这轮|当前|请|麻烦你|现在)[：: ]*)*';
    const plan = new RegExp(`^${prefix}(?:先|只|仅|只需|只要)(?:给出|给|做|提供|输出)?(?:我)?[^?？：:]{0,16}(?:方案|计划|建议|思路)(?:就好|即可|就行|吧)?$`, 'i');
    const restriction = new RegExp(`^${prefix}(?:不要|不用|暂不|先别|无需)(?:实际|直接|继续|再)?(?:执行|操作|动手|启动任务|修改|改代码|写入|删除|发送|发布)(?:任何)?(?:文件|代码|数据|消息)?(?:了|吧)?$`, 'i');
    // “查询订单，不要发送”只限制发送；“先给方案”才限制整轮处理方式。
    return clauses.some(clause => plan.test(clause)) || (clauses.length > 0 && clauses.every(clause => restriction.test(clause)));
}

module.exports = { currentUserText, currentRequestText, isPureMemoryRequest, isPlanOnlyRequest };
