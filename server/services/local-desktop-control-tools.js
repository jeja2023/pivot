'use strict';

const DESKTOP_CONTROL_TOOL_NAMES = Object.freeze(['desktop.inspect', 'desktop.screenshot', 'desktop.click', 'desktop.type', 'desktop.wait']);

function desktopControlError(message, code = 'LOCAL_DESKTOP_CONTROL_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.expose = true;
    return error;
}

function normalizeDesktopControlGrant(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const windowTitle = String(source.windowTitle || source.window_title || '').trim().replace(/[\r\n]/g, ' ').slice(0, 240);
    const processName = String(source.processName || source.process_name || '').trim().replace(/[\r\n]/g, ' ').slice(0, 160);
    if (!windowTitle || !processName) return { windowTitle: '', processName: '' };
    return { windowTitle, processName, label: String(source.label || processName).slice(0, 160) };
}

function normalizeDesktopTarget(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const target = {
        automationId: String(source.automationId || source.automation_id || '').trim().slice(0, 240),
        name: String(source.name || source.text || '').trim().slice(0, 240)
    };
    if (!target.automationId && !target.name) throw desktopControlError('桌面操作需要 automationId 或可访问性名称。', 'LOCAL_DESKTOP_CONTROL_TARGET_REQUIRED');
    return target;
}

function normalizeDesktopControlTask(toolName, input = {}, grant = {}) {
    const action = String(toolName || '').trim();
    if (!DESKTOP_CONTROL_TOOL_NAMES.includes(action)) throw desktopControlError('不支持的原生桌面控制工具。', 'LOCAL_DESKTOP_CONTROL_TOOL_INVALID');
    const approved = normalizeDesktopControlGrant(grant);
    if (!approved.windowTitle || !approved.processName) throw desktopControlError('当前设备没有授权可控制的桌面应用。', 'LOCAL_DESKTOP_CONTROL_GRANT_REQUIRED', 403);
    const task = { action, grant: approved, timeoutMs: Math.min(Math.max(Number.parseInt(input.timeoutMs || input.timeout_ms, 10) || 10000, 100), 30000) };
    if (action === 'desktop.inspect') task.limit = Math.min(Math.max(Number.parseInt(input.limit, 10) || 80, 1), 160);
    if (action === 'desktop.click' || action === 'desktop.type' || action === 'desktop.wait') task.target = normalizeDesktopTarget(input.target || input);
    if (action === 'desktop.type') {
        task.text = String(input.text ?? input.value ?? '');
        if (!task.text || task.text.length > 4000) throw desktopControlError('桌面输入内容必须为 1 至 4000 个字符。', 'LOCAL_DESKTOP_CONTROL_TEXT_INVALID');
    }
    return task;
}

function localDesktopControlToolDefinitions() {
    const target = { type: 'object', properties: { automationId: { type: 'string' }, name: { type: 'string' } } };
    const timeout = { timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 } };
    return [
        { name: 'desktop.inspect', title: '查看当前桌面应用', description: '读取当前前台且已授权桌面应用的可访问性控件摘要；不会读取文本框内容或凭据。', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 160 }, ...timeout } } },
        { name: 'desktop.screenshot', title: '截取桌面应用', description: '截取当前前台且已授权应用的压缩截图作为任务证据；每次均需本机确认。', inputSchema: { type: 'object', properties: timeout } },
        { name: 'desktop.click', title: '点击桌面应用控件', description: '通过可访问性树调用当前授权前台应用中的按钮/控件，不使用坐标点击。每次均需本机确认。', inputSchema: { type: 'object', properties: { target, ...timeout }, required: ['target'] } },
        { name: 'desktop.type', title: '填写桌面应用字段', description: '仅向当前授权前台应用中的非密码可访问性编辑字段写入文本；每次均需本机确认。', inputSchema: { type: 'object', properties: { target, text: { type: 'string', maxLength: 4000 }, ...timeout }, required: ['target', 'text'] } },
        { name: 'desktop.wait', title: '等待桌面应用控件', description: '等待当前授权前台应用出现指定可访问性控件，不执行点击或输入。', inputSchema: { type: 'object', properties: { target, ...timeout }, required: ['target'] } }
    ];
}

function isLocalDesktopControlTool(name) { return DESKTOP_CONTROL_TOOL_NAMES.includes(String(name || '').trim()); }

module.exports = { isLocalDesktopControlTool, localDesktopControlToolDefinitions, normalizeDesktopControlGrant, normalizeDesktopControlTask, normalizeDesktopTarget };
