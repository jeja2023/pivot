'use strict';

function withDetailDeadline(read, milliseconds) {
    let timer;
    return Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('任务详情暂时无法读取，请稍后重试。'), { code: 'AGENT_DETAIL_TIMEOUT', status: 503 })), milliseconds);
    })]).finally(() => clearTimeout(timer));
}

async function readRunDetailParts(readers, { timeoutMs = 6000 } = {}) {
    const warnings = [];
    const values = await Promise.all(readers.map(async (read, index) => {
        try { return await withDetailDeadline(read, timeoutMs); }
        catch (error) {
            if (index < 2) throw error;
            warnings.push({ code: 'DETAIL_SECTION_UNAVAILABLE', section: index, message: '部分诊断暂时无法加载，可重试读取；任务执行状态以已显示记录为准。' });
            return null;
        }
    }));
    return { values, warnings };
}

module.exports = { readRunDetailParts, withDetailDeadline };
