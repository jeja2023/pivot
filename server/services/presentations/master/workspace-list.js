'use strict';

const { error } = require('./runtime');

function presentationPath(value) {
    return typeof value === 'string' && value.length <= 300 && !/[:\\\u0000-\u001f]/.test(value)
        && value.split('/').every(part => part && !part.startsWith('.'));
}

function listScope(value) {
    if (value === undefined || value === '.' || value === './') return '';
    const scope = typeof value === 'string' && value.replace(/^\.\//, '').replace(/\/$/, '');
    if (!presentationPath(scope)) throw error('list 的 path 须为当前任务内的安全相对目录。', 'PPT_MASTER_ACTION_INVALID', 422);
    return scope;
}

async function listWorkspace(action, execute) {
    const scope = listScope(action.path);
    // 现有执行器只提供任务级清单，目录筛选不能依赖执行器忽略的参数。
    const result = await execute({ action: 'list' });
    if (!Array.isArray(result?.files)) throw error('制作执行器未返回文件清单。', 'PPT_MASTER_OPERATION_FAILED', 422);
    const files = [];
    let chars = 0, truncated = result.truncated === true || result.files.length >= 2000;
    for (const file of result.files) {
        if (typeof file?.path !== 'string' || file.path.startsWith('.') || !Number.isSafeInteger(file.bytes) || file.bytes < 0
            || scope && !file.path.startsWith(scope + '/')) continue;
        const entry = { path: file.path, bytes: file.bytes };
        chars += JSON.stringify(entry).length + 1;
        if (chars > 18000) {
            truncated = true;
            break;
        }
        files.push(entry);
    }
    return { path: scope || '.', files, ...(truncated ? { truncated, message: '清单可能不完整，已知文件可按确切路径读取。' } : {}) };
}

module.exports = { presentationPath, listScope, listWorkspace };
