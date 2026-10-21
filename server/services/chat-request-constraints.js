'use strict';

// 只把用户本轮的独立限制作为硬边界；引用中的指令仍交给语义层理解。
function currentRequestText(prompt = '') {
    return String(prompt).split(/\n---\s*\n【参考文档/)[0]
        .replace(/```[\s\S]*?```/g, '').replace(/^[ \t]*>.*$/gm, '')
        .replace(/[“「][^”」]*[”」]|"[^"\n]*"/g, '').trim();
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

module.exports = { currentRequestText, isPlanOnlyRequest };
