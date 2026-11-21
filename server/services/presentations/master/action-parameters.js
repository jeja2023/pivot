'use strict';

const actionFields = Object.freeze({
    read: ['path', 'offset', 'length'], read_runtime: ['path', 'offset', 'length'],
    read_history: ['archive', 'index', 'offset', 'length'], read_images: ['offset', 'length'],
    write: ['path', 'text'], run: ['tool', 'args'], list: [],
    copy: ['path', 'source'], copy_template: ['path', 'source'], validate_template: ['path', 'kind']
});
const writeExample = '{"actions":[{"action":"write","path":"项目目录/目标文件.md","text":"本次写入的完整正文"}]}';
// 诊断只记录协议字段名或键的位置，避免把动态键中的文件名、正文和凭据带入制作记录。
const diagnosticNames = new Set([...Object.values(actionFields).flat(), 'encoding', 'append', 'overwrite', 'mode',
    'filePath', 'file_path', 'filename', 'content', 'data', 'format', 'language', 'parameters', 'arguments',
    'message', 'description', 'reason', 'savedContent', 'savedSha256']);

function rejectedFields(action, original) {
    const allowed = actionFields[action.action];
    return Object.keys(original).flatMap((key, index) => !Object.hasOwn(action, key) || key === 'action' || allowed.includes(key) ? []
        : [diagnosticNames.has(key) ? key : `第${index + 1}个键`]).slice(0, 6);
}

function publicFieldLabels(labels) {
    return Array.isArray(labels) ? labels.filter(label => diagnosticNames.has(label)
        || typeof label === 'string' && /^第[1-9]\d{0,4}个键$/u.test(label)).slice(0, 6) : [];
}

function fieldMessage(type, index, labels) {
    const detail = publicFieldLabels(labels).join('、');
    return `同批第 ${index} 项 ${type} 含不支持的参数。${detail ? '请移除或修正 ' + detail + '。' : ''}请仅提交 ${['action', ...actionFields[type]].join('、')}。`;
}

const writeCorrection = '请按 ' + writeExample + ' 的结构重写该动作，填入本轮实际路径和完整正文。进度说明放在顶层 message，文件摘要和归档坐标仅供回读。';

module.exports = { actionFields, writeExample, rejectedFields, publicFieldLabels, fieldMessage, writeCorrection };
