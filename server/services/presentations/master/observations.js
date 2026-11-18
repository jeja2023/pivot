'use strict';

const crypto = require('node:crypto');

function confirmedWrite(action, observation) {
    const receipt = observation?.result;
    if (action?.action !== 'write' || observation?.action !== 'write' || observation.error || !action.path || action.path !== receipt?.path
        || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '')) return null;
    const expected = typeof action.text === 'string' ? crypto.createHash('sha256').update(action.text, 'utf8').digest('hex') : action.savedSha256;
    return expected === receipt.sha256 ? receipt : null;
}

function actionSummary(messages) {
    if (!Array.isArray(messages)) return undefined;
    let writes = 0, lastWrittenPath = '', failedWrites = 0, runtimeReads = 0, lastActions = [];
    for (let index = 0; index < messages.length - 1; index++) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        let turn, observations;
        try { turn = JSON.parse(messages[index].content); observations = JSON.parse(messages[index + 1].content); } catch (_) { continue; }
        if (!Array.isArray(turn?.actions) || !Array.isArray(observations)) continue;
        lastActions = observations.slice(0, 6).map((observation, position) => {
            const action = turn.actions[position], receipt = confirmedWrite(action, observation);
            // 较早版本的归档已校验摘要后才移除写入正文，但未保存单独的摘要字段。
            const legacyWrite = action?.action === 'write' && action.savedContent?.startsWith?.('已成功写入；') && observation?.action === 'write'
                && !observation.error && observation.result?.path === action.path && /^[a-f0-9]{64}$/.test(observation.result?.sha256 || '');
            if (receipt || legacyWrite) { writes++; lastWrittenPath = String(observation.result.path).slice(0, 300); }
            const exitCode = observation?.result?.exitCode;
            const failed = Boolean(observation?.error || Number.isInteger(exitCode) && exitCode !== 0);
            if (observation?.action === 'write' && failed) failedWrites++;
            if (observation?.action === 'read_runtime' && observation.result && !failed) runtimeReads++;
            return { action: observation?.action, failed };
        });
    }
    return { writes, failedWrites, runtimeReads, lastWrittenPath, lastActions };
}

// 长文本按字符分页保留路径和游标，其他过长诊断明确标记；不截断 JSON 结构。
function boundedObservation(action, result) {
    const limit = 12000;
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
        ...(typeof result.stdout === 'string' ? { stdout: result.stdout.slice(0, 8000) } : {}),
        ...(typeof result.stderr === 'string' ? { stderr: result.stderr.slice(0, 8000) } : {}) };
}

module.exports = { boundedObservation, confirmedWrite, actionSummary };
