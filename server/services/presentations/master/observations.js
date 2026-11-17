'use strict';

// 长文本按字符分页保留路径和游标，其他过长诊断明确标记；不截断 JSON 结构。
function boundedObservation(action, result) {
    const limit = 12000;
    if (!result || typeof result !== 'object') return result;
    if (['read', 'read_runtime'].includes(action.action) && typeof result.text === 'string') {
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
        ...(typeof result.stdout === 'string' ? { stdout: result.stdout.slice(0, 8000) } : {}),
        ...(typeof result.stderr === 'string' ? { stderr: result.stderr.slice(0, 8000) } : {}) };
}

module.exports = { boundedObservation };
