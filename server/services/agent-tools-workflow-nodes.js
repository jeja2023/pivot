/**
 * server/services/agent-tools-workflow-nodes.js
 * 工作流节点执行器与报告组装
 *
 * 从 server/services/agent-tools.js 按开发规范第 3.1 条拆出：
 * 该文件已同时承担工具定义、模型调用、HTTP、浏览器、工作流节点与报告组装多种职责，
 * 属于「职责混杂、持续膨胀」的大文件。本模块只负责工作流控制节点与报告组装，
 * 逻辑逐字迁移，未改变任何行为，agent-tools.js 只保留薄分派入口。
 */
function renderWorkflowValue(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}

function coerceWorkflowInput(value, type, name) {
    if (type === 'text') return typeof value === 'string' ? value : renderWorkflowValue(value);
    if (type === 'number') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`工作流输入“${name}”必须是数字。`);
        return parsed;
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
        if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
        throw new Error(`工作流输入“${name}”必须是布尔值。`);
    }
    if (type === 'object' || type === 'array') {
        let parsed = value;
        if (typeof value === 'string') {
            try { parsed = JSON.parse(value); } catch (e) { throw new Error(`工作流输入“${name}”必须是合法 JSON。`); }
        }
        if (type === 'array' ? !Array.isArray(parsed) : (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
            throw new Error(`工作流输入“${name}”必须是${type === 'array' ? '数组' : '对象'}。`);
        }
        return parsed;
    }
    return value;
}

function executeWorkflowInput(input = {}, context = {}) {
    const name = String(input.name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) throw new Error('工作流输入参数名无效。');
    const values = context.dagInputs && typeof context.dagInputs === 'object' ? context.dagInputs : {};
    const supplied = Object.hasOwn(values, name);
    let value = supplied ? values[name] : input.defaultValue;
    if ((value === undefined || value === null || value === '') && input.required) {
        throw new Error(`缺少必填工作流输入：${input.label || name}`);
    }
    const type = ['text', 'number', 'boolean', 'object', 'array'].includes(input.type) ? input.type : 'text';
    if (value !== undefined && value !== null && value !== '') value = coerceWorkflowInput(value, type, name);
    return { name, label: String(input.label || name), type, value: value ?? null, supplied, text: renderWorkflowValue(value) };
}

function executeWorkflowOutput(input = {}) {
    const name = String(input.name || 'result').trim() || 'result';
    const value = input.value;
    const format = ['markdown', 'text', 'json'].includes(String(input.format || 'markdown'))
        ? String(input.format || 'markdown')
        : 'markdown';
    const presentation = ['default', 'table', 'file'].includes(String(input.presentation || 'default'))
        ? String(input.presentation || 'default')
        : 'default';
    const result = { name, value, format, presentation, text: renderWorkflowValue(value) };
    if (presentation === 'table') {
        const rows = Array.isArray(value)
            ? value
            : (value && typeof value === 'object'
                ? (Array.isArray(value.rows) ? value.rows : (Array.isArray(value.data) ? value.data : (Array.isArray(value.items) ? value.items : [])))
                : []);
        const normalizedRows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 500);
        const explicitColumns = Array.isArray(input.tableColumns)
            ? input.tableColumns.map(column => String(column || '').trim()).filter(Boolean).slice(0, 50)
            : [];
        const columns = explicitColumns.length
            ? explicitColumns
            : [...new Set(normalizedRows.flatMap(row => Object.keys(row)))].slice(0, 50);
        result.table = {
            title: String(input.tableTitle || '').trim() || '工作流结果',
            columns,
            rows: normalizedRows,
            rowCount: normalizedRows.length,
            truncated: rows.length > normalizedRows.length
        };
        result.text = result.table.title + (normalizedRows.length ? `（${normalizedRows.length} 行）` : '（暂无数据）');
    }
    if (presentation === 'file') {
        const source = input.fileRef && typeof input.fileRef === 'object' ? input.fileRef : value;
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            throw new Error('文件产物需要提供文件引用对象。');
        }
        const file = {};
        ['id', 'fileId', 'name', 'mimeType', 'size', 'url', 'downloadUrl', 'path', 'storageKey'].forEach(key => {
            if (source[key] !== undefined && source[key] !== null && source[key] !== '') file[key] = source[key];
        });
        if (!Object.keys(file).some(key => ['id', 'fileId', 'url', 'downloadUrl', 'path', 'storageKey'].includes(key))) {
            throw new Error('文件引用至少需要 id、url、downloadUrl、path 或 storageKey。');
        }
        result.file = file;
        result.text = `文件产物：${file.name || file.fileId || file.id || '已生成文件'}`;
    }
    return result;
}

function executeWorkflowCondition(input = {}) {
    const value = input.value;
    const compareTo = input.compareTo;
    const operator = String(input.operator || 'not_empty');
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    let matched;
    if (operator === 'equals') matched = value === compareTo || String(value) === String(compareTo);
    else if (operator === 'not_equals') matched = !(value === compareTo || String(value) === String(compareTo));
    else if (operator === 'contains') matched = Array.isArray(value) ? value.includes(compareTo) : String(value ?? '').includes(String(compareTo ?? ''));
    else if (operator === 'not_contains') matched = Array.isArray(value) ? !value.includes(compareTo) : !String(value ?? '').includes(String(compareTo ?? ''));
    else if (operator === 'greater_than') matched = Number(value) > Number(compareTo);
    else if (operator === 'less_than') matched = Number(value) < Number(compareTo);
    else if (operator === 'is_empty') matched = empty;
    else if (operator === 'is_true') matched = value === true || String(value).toLowerCase() === 'true';
    else if (operator === 'is_false') matched = value === false || String(value).toLowerCase() === 'false';
    else matched = !empty;
    return { matched, value, compareTo, operator, route: matched ? 'matched' : 'unmatched', text: matched ? 'matched' : 'unmatched' };
}

async function executeWorkflowForeach(_input = {}) {
    const error = new Error('动态代码只能在独立 Worker 沙箱中执行，服务端循环执行已关闭。');
    error.code = 'AGENT_SANDBOX_REQUIRED';
    error.category = 'policy';
    error.status = 403;
    throw error;
}

async function executeWorkflowDelay(input = {}, context = {}) {
    if (typeof context.waitForWorkflowDelay === 'function' && context.run) {
        const node = context.node || {
            id: context.delayKey || 'workflow.delay',
            title: 'Workflow delay',
            tool: 'workflow.delay'
        };
        return context.waitForWorkflowDelay({
            run: context.run,
            node,
            input,
            key: context.delayKey || ''
        });
    }
    const durationMs = Math.max(0, Math.min(Number.parseInt(input.durationMs ?? input.duration_ms, 10) || 0, 600000));
    if (durationMs) await new Promise(resolve => setTimeout(resolve, durationMs));
    return { durationMs, reason: String(input.reason || ''), completedAt: new Date().toISOString() };
}

function executeReportCompose(input = {}) {
    const title = String(input.title || '工作流报告').trim() || '工作流报告';
    const sections = input.sections && typeof input.sections === 'object' && !Array.isArray(input.sections) ? input.sections : {};
    const headings = Object.keys(sections);
    const blocks = [`# ${title}`];
    if (input.includeToc !== false && headings.length) blocks.push(`## 目录\n${headings.map((name, index) => `${index + 1}. ${name}`).join('\n')}`);
    if (input.summary !== undefined && input.summary !== null && input.summary !== '') blocks.push(`## 摘要\n${renderWorkflowValue(input.summary)}`);
    headings.forEach(name => blocks.push(`## ${name}\n${renderWorkflowValue(sections[name])}`));
    const markdown = blocks.join('\n\n');
    return { markdown, text: markdown, sectionCount: headings.length, title };
}

module.exports = {
    coerceWorkflowInput,
    executeReportCompose,
    executeWorkflowCondition,
    executeWorkflowDelay,
    executeWorkflowForeach,
    executeWorkflowInput,
    executeWorkflowOutput,
    renderWorkflowValue
};
