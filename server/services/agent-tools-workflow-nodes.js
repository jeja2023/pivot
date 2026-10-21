const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeWorkflowEmbedUrl } = require('./workflow-embed-policy');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');
const {
    isWorkerEnabled,
    normalizeDefinition: normalizeWorkerDefinition,
    runCapabilityWorker,
    verifyWorkerSignature
} = require('./agent-capability-worker');
const { verifyExecutionGrant } = require('./agent-execution-grant');
const { consumeExecutionGrant } = require('./agent-execution-grant-ledger');

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

function normalizeEmbeddedResourceUrl(value) {
    return normalizeWorkflowEmbedUrl(value);
}

function executeWorkflowEmbedPage(input = {}) {
    const url = normalizeEmbeddedResourceUrl(input.url);
    const title = String(input.title || '嵌入页面').trim().slice(0, 120) || '嵌入页面';
    const requestedHeight = Number.parseInt(input.height ?? input.heightPx, 10);
    const height = Math.max(180, Math.min(Number.isFinite(requestedHeight) ? requestedHeight : 480, 1200));
    return {
        type: 'embedded_page',
        url,
        title,
        height,
        text: `页面：${title}`
    };
}

function executeWorkflowEmbedImage(input = {}) {
    const url = normalizeEmbeddedResourceUrl(input.url);
    const alt = String(input.alt || '工作流图片').trim().slice(0, 160) || '工作流图片';
    const maxWidthValue = Number.parseInt(input.maxWidth ?? input.max_width, 10);
    const maxHeightValue = Number.parseInt(input.maxHeight ?? input.max_height, 10);
    return {
        type: 'embedded_image',
        url,
        alt,
        maxWidth: Math.max(160, Math.min(Number.isFinite(maxWidthValue) ? maxWidthValue : 960, 1600)),
        maxHeight: Math.max(120, Math.min(Number.isFinite(maxHeightValue) ? maxHeightValue : 640, 1200)),
        text: `图片：${alt}`
    };
}

function executeWorkflowEmbedVideo(input = {}) {
    const url = normalizeEmbeddedResourceUrl(input.url);
    const title = String(input.title || '工作流视频').trim().slice(0, 120) || '工作流视频';
    const requestedHeight = Number.parseInt(input.height ?? input.heightPx, 10);
    return {
        type: 'embedded_video',
        url,
        title,
        height: Math.max(180, Math.min(Number.isFinite(requestedHeight) ? requestedHeight : 420, 900)),
        text: `视频：${title}`
    };
}

function executeWorkflowEmbedAudio(input = {}) {
    const url = normalizeEmbeddedResourceUrl(input.url);
    const title = String(input.title || '工作流音频').trim().slice(0, 120) || '工作流音频';
    return { type: 'embedded_audio', url, title, text: `音频：${title}` };
}

function executeWorkflowLinkCard(input = {}) {
    const url = normalizeEmbeddedResourceUrl(input.url);
    const title = String(input.title || '打开链接').trim().slice(0, 120) || '打开链接';
    const description = String(input.description || '').trim().slice(0, 300);
    return { type: 'link_card', url, title, description, text: title };
}

function getWorkflowPresentationToolDefinitions(asJsonSchema) {
    return [
        ['workflow.embed_page', '嵌入页面', '在工作流结果中嵌入同源页面或管理员白名单页面。', { url: { type: 'string' }, title: { type: 'string', default: '嵌入页面', maxLength: 120 }, height: { type: 'integer', minimum: 180, maximum: 1200, default: 480 } }],
        ['workflow.embed_image', '嵌入图片', '在工作流结果中展示图片资源。', { url: { type: 'string' }, alt: { type: 'string', default: '工作流图片', maxLength: 160 }, maxWidth: { type: 'integer', minimum: 160, maximum: 1600, default: 960 }, maxHeight: { type: 'integer', minimum: 120, maximum: 1200, default: 640 } }],
        ['workflow.embed_video', '嵌入视频', '在工作流结果中展示带控件的视频资源，不自动播放。', { url: { type: 'string' }, title: { type: 'string', default: '工作流视频', maxLength: 120 }, height: { type: 'integer', minimum: 180, maximum: 900, default: 420 } }],
        ['workflow.embed_audio', '嵌入音频', '在工作流结果中展示带控件的音频资源，不自动播放。', { url: { type: 'string' }, title: { type: 'string', default: '工作流音频', maxLength: 120 } }],
        ['workflow.link_card', '链接卡片', '生成安全的链接卡片，在新窗口打开目标地址。', { url: { type: 'string' }, title: { type: 'string', default: '打开链接', maxLength: 120 }, description: { type: 'string', maxLength: 300 } }],
        ['workflow.embed_code', '网站嵌入代码', '生成可粘贴到其它网站页面的 HTML iframe 嵌入代码。', { url: { type: 'string' }, title: { type: 'string', default: '嵌入页面', maxLength: 120 }, width: { type: 'integer', minimum: 320, maximum: 1600, default: 960 }, height: { type: 'integer', minimum: 180, maximum: 1200, default: 480 }, responsive: { type: 'boolean', default: true } }]
    ].map(([name, title, description, properties]) => ({ name, title, description, input_schema: asJsonSchema(properties, ['url']) }));
}

function escapeEmbedHtmlAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function executeWorkflowEmbedCode(input = {}) {
    const url = normalizeWorkflowEmbedUrl(input.url, { allowExternal: true });
    const title = String(input.title || '嵌入页面').trim().slice(0, 120) || '嵌入页面';
    const widthValue = Number.parseInt(input.width, 10);
    const heightValue = Number.parseInt(input.height, 10);
    const width = Math.max(320, Math.min(Number.isFinite(widthValue) ? widthValue : 960, 1600));
    const height = Math.max(180, Math.min(Number.isFinite(heightValue) ? heightValue : 480, 1200));
    const responsive = input.responsive !== false;
    const src = escapeEmbedHtmlAttribute(url);
    const iframeTitle = escapeEmbedHtmlAttribute(title);
    const widthAttribute = responsive ? '100%' : `${width}`;
    const code = `<iframe src="${src}" title="${iframeTitle}" width="${widthAttribute}" height="${height}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts" style="border:0;max-width:100%;" allowfullscreen></iframe>`;
    return {
        type: 'embed_code',
        url,
        title,
        width,
        height,
        responsive,
        language: 'html',
        code,
        text: code,
        notice: '将这段 HTML 粘贴到目标网站页面中；目标页面必须允许被 iframe 加载。'
    };
}

function coerceWorkflowInput(value, type, name) {
    if (type === 'date') {
        const parsed = new Date(`${value}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`工作流输入“${name}”必须是有效日期。`);
        return value;
    }
    if (type === 'file') {
        let file = value;
        if (typeof value === 'string') { try { file = JSON.parse(value); } catch (_) { throw new Error(`工作流输入“${name}”需要上传文件。`); } }
        if (!file || typeof file !== 'object' || Array.isArray(file) || !/^\/uploads\//.test(String(file.url || '')) || !file.name) throw new Error(`工作流输入“${name}”需要有效的附件引用。`);
        return file;
    }
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
    const type = ['text', 'number', 'boolean', 'object', 'array', 'date', 'file'].includes(input.type) ? input.type : 'text';
    if (value !== undefined && value !== null && value !== '') value = coerceWorkflowInput(value, type, name);
    return { name, label: String(input.label || name), type, value: value ?? null, supplied, text: renderWorkflowValue(value) };
}

function executeWorkflowTemplate(input = {}) {
    const template = (typeof input.template === 'string' ? input.template : renderWorkflowValue(input.template)).slice(0, 50000);
    const missingVariable = ['keep', 'empty', 'error'].includes(String(input.missingVariable || 'keep'))
        ? String(input.missingVariable || 'keep')
        : 'keep';
    const missingVariables = [...new Set([...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => String(match[1] || '').trim()).filter(Boolean))];
    if (missingVariables.length && missingVariable === 'error') {
        throw new Error(`文本模板存在未解析变量：${missingVariables.slice(0, 5).join('、')}`);
    }
    let text = template;
    if (missingVariables.length && missingVariable === 'empty') {
        text = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression) => {
            return missingVariables.includes(String(expression || '').trim()) ? '' : match;
        });
    }
    if (input.trim !== false) text = text.trim();
    return {
        text,
        charCount: text.length,
        missingVariables: missingVariable === 'keep' ? missingVariables : []
    };
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

function workflowNodeError(message, code = 'AGENT_FOREACH_WORKER_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function foreachWorkerDefinition(env = process.env) {
    const image = String(env.PIVOT_AGENT_FOREACH_WORKER_IMAGE || '').trim();
    if (!image) return null;
    return {
        image,
        command: String(env.PIVOT_AGENT_FOREACH_WORKER_COMMAND || 'node,/runner/agent-foreach-worker.js')
            .split(',').map(item => item.trim()).filter(Boolean).slice(0, 8),
        limits: {
            cpu: Number(env.PIVOT_AGENT_FOREACH_WORKER_CPU || 1),
            memoryMb: Number(env.PIVOT_AGENT_FOREACH_WORKER_MEMORY_MB || 512),
            timeoutMs: Math.min(Math.max(Number(env.PIVOT_AGENT_FOREACH_WORKER_TIMEOUT_MS || 120000), 1000), 10 * 60 * 1000),
            maxOutputBytes: Number(env.PIVOT_AGENT_FOREACH_WORKER_MAX_OUTPUT_BYTES || 2 * 1024 * 1024)
        }
    };
}

function allowUnsafeLocalForeach(context = {}) {
    const env = context.env || process.env;
    return context.allowUnsafeLocal === true
        && env.NODE_ENV === 'test'
        && String(env.PIVOT_AGENT_UNSAFE_LOCAL_TEST || '').toLowerCase() === 'true';
}

function foreachWorkspaceScopeId(context = {}) {
    const runId = String(context.run?.id || context.runId || context.node?.id || '').trim();
    return String(context.executionWorkspaceScopeId || (runId ? `run:${runId}` : '')).slice(0, 160);
}

function assertForeachExecutionGrant(input, context = {}) {
    const env = context.env || process.env;
    const runId = String(context.run?.id || context.runId || context.node?.id || '').trim();
    const workspaceScopeId = foreachWorkspaceScopeId(context);
    if (!runId || !workspaceScopeId) {
        throw workflowNodeError('循环 Worker 执行必须关联运行与工作区授权范围。', 'AGENT_EXECUTION_GRANT_CONTEXT_INVALID', 403);
    }
    try {
        return verifyExecutionGrant(context.executionGrant, {
            runId,
            userId: context.user?.id || context.run?.user_id || context.userId,
            tool: 'workflow.foreach',
            input,
            workspaceScopeId
        }, { env });
    } catch (error) {
        throw workflowNodeError(error.message || '循环 Worker 执行授权无效。', error.code || 'AGENT_EXECUTION_GRANT_INVALID', error.status || 403);
    }
}

async function executeWorkflowForeach(input = {}, context = {}) {
    const env = context.env || process.env;
    if (String(env.AGENT_FOREACH_WORKER_ENABLED || 'true').toLowerCase() === 'false') {
        const error = new Error('工作流循环 Worker 已由部署策略停用。');
        error.code = 'AGENT_FOREACH_WORKER_DISABLED';
        error.category = 'policy';
        error.status = 503;
        throw error;
    }
    if (context.sandboxExecution !== true) {
        const error = new Error('动态代码只能在独立 Worker 沙箱中执行，当前入口未授权受控 Worker。');
        error.code = 'AGENT_SANDBOX_REQUIRED';
        error.category = 'policy';
        error.status = 403;
        throw error;
    }
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length > 1000) throw new Error('循环节点最多处理 1000 项。');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-foreach-'));
    const allowUnsafeLocalTest = allowUnsafeLocalForeach(context);
    const taskId = String(context.run?.id || context.runId || context.node?.id || 'foreach').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'foreach';
    const jail = createWorkspaceJail(root, taskId);
    const workerScript = jail.resolve('foreach-worker.js');
    try {
        const timeoutMs = Math.max(1000, Math.min(Number(context.timeoutMs || input.timeoutMs || 120000), 10 * 60 * 1000));
        const workerDefinition = foreachWorkerDefinition(env);
        if (workerDefinition && isWorkerEnabled(env) && !allowUnsafeLocalTest) {
            try { normalizeWorkerDefinition(workerDefinition); } catch (error) {
                throw workflowNodeError(error.message || '循环 Worker 配置无效。', error.code || 'AGENT_FOREACH_WORKER_INVALID', error.status || 503);
            }
            // 在消费一次性授权前验证受管镜像的签名信任。否则部署侧的清单或
            // 公钥错误会把一个尚未启动的任务错误地记成“授权已使用”，既妨碍
            // 人工修复后的重试，也掩盖供应链配置故障。
            try { verifyWorkerSignature(workerDefinition, { env }); } catch (error) {
                throw workflowNodeError(error.message || '循环 Worker 生产信任清单校验失败。', error.code || 'AGENT_FOREACH_WORKER_UNTRUSTED', error.status || 503);
            }
            const executionGrant = assertForeachExecutionGrant(input, context);
            try {
                await consumeExecutionGrant({
                    token: context.executionGrant,
                    payload: executionGrant.payload,
                    consumer: `workflow.foreach:${process.pid}`
                });
            } catch (error) {
                throw workflowNodeError(error.message || '循环 Worker 执行授权账本校验失败。', error.code || 'AGENT_EXECUTION_GRANT_UNAVAILABLE', error.status || 403);
            }
            const output = await runCapabilityWorker(workerDefinition, {
                version: 1,
                action: 'foreach',
                items,
                code: String(input.code || 'return item;'),
                vars: input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {},
                concurrency: input.concurrency,
                stopOnError: input.stopOnError,
                retryLimit: input.retryLimit,
                itemTimeoutMs: input.itemTimeoutMs,
                approvedByControlPlane: true
            }, {
                env,
                signal: context.signal || null,
                workspaceMount: { source: jail.workspace, target: '/workspace', readOnly: false },
                requireExecutionGrant: true,
                executionGrant: context.executionGrant,
                executionGrantExpected: {
                    runId: String(context.run?.id || context.runId || context.node?.id || ''),
                    userId: context.user?.id || context.run?.user_id || context.userId,
                    tool: 'workflow.foreach',
                    input,
                    workspaceScopeId: foreachWorkspaceScopeId(context)
                }
            });
            if (!output?.ok || !output?.result || typeof output.result !== 'object') {
                throw workflowNodeError(output?.error?.message || '循环 Capability Worker 返回格式无效。', output?.error?.code || 'AGENT_FOREACH_WORKER_OUTPUT_INVALID', 502);
            }
            return {
                ...output.result,
                worker: {
                    provider: 'capability-worker',
                    code: Number.isInteger(output.exitCode) ? output.exitCode : 0,
                    timedOut: false,
                    truncated: false,
                    isolation: {
                        enforcement: 'enforced', filesystem: 'container-mount', process: 'container', network: 'none'
                    },
                    executionGrant: executionGrant.summary
                }
            };
        }
        if (!allowUnsafeLocalTest) {
            throw workflowNodeError('循环动态代码需要已启用、镜像摘要固定的 Capability Worker；宿主进程后备已被禁止。', 'AGENT_FOREACH_WORKER_REQUIRED', 503);
        }
        fs.copyFileSync(path.join(__dirname, 'agent-foreach-worker.js'), workerScript);
        const result = await runSandboxedProcess(process.execPath, [workerScript], {
            jail,
            timeoutMs,
            maxBufferBytes: 2 * 1024 * 1024,
            input: JSON.stringify({
                items,
                code: String(input.code || 'return item;'),
                vars: input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {},
                concurrency: input.concurrency,
                stopOnError: input.stopOnError,
                retryLimit: input.retryLimit,
                itemTimeoutMs: input.itemTimeoutMs,
                approvedByControlPlane: true
            }),
            env: { PIVOT_AGENT_FOREACH_WORKER: '1', PIVOT_AGENT_WORKSPACE: jail.workspace },
            inheritEnv: false,
            networkDisabled: true,
            requireEnforcedIsolation: !allowUnsafeLocalTest,
            signal: context.signal || null
        });
        let message;
        try { message = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch (_) { message = null; }
        if (!message?.ok) {
            const error = new Error(message?.error?.message || result.stderr || '循环 Worker 执行失败。');
            error.code = message?.error?.code || 'AGENT_FOREACH_WORKER_FAILED';
            throw error;
        }
        return {
            ...message.result,
            worker: {
                code: result.code,
                timedOut: Boolean(result.timedOut),
                truncated: Boolean(result.truncated),
                isolation: result.isolation || jail.metadata
            }
        };
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
}

async function executeWorkflowIteration(input = {}, context = {}) {
    if (typeof context.executeIteration !== 'function') {
        const error = new Error('当前运行环境不支持逐项调用子工作流。');
        error.code = 'AGENT_ITERATION_UNSUPPORTED';
        error.status = 400;
        throw error;
    }
    return await context.executeIteration(input);
}

async function executeWorkflowNotify(input = {}, user = null, context = {}) {
    const bindingId = String(input.bindingId || input.binding_id || '').trim();
    const body = String(input.body ?? input.message ?? '').trim();
    if (!bindingId) throw new Error('通知节点需要选择已配置的渠道绑定。');
    if (!body) throw new Error('通知节点消息内容不能为空。');
    if (!user?.id) throw new Error('通知节点需要有效的运行用户。');
    const { enqueueChannelDelivery } = require('./agent-channel-adapters');
    const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || `${context.run?.id || context.runId || 'workflow'}:${context.node?.id || 'notify'}`).slice(0, 255);
    const delivery = await enqueueChannelDelivery(user, {
        bindingId,
        platform: '',
        requirePlatform: true,
        eventType: String(input.eventType || 'workflow.notify').slice(0, 80),
        subject: String(input.subject || input.title || '').slice(0, 255),
        body,
        idempotencyKey,
        interaction: {
            format: String(input.format || 'text').toLowerCase() === 'markdown' ? 'markdown' : 'text'
        }
    });
    if (!delivery) throw new Error('通知渠道不存在、未启用或当前用户无权使用。');
    return {
        queued: true,
        deliveryId: delivery.id,
        bindingId,
        status: delivery.status || 'queued',
        platform: delivery.bindingPlatform || '',
        idempotencyKey
    };
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
    executeWorkflowEmbedAudio,
    executeWorkflowEmbedImage,
    executeWorkflowEmbedPage,
    executeWorkflowEmbedVideo,
    executeWorkflowCondition,
    executeWorkflowDelay,

    executeWorkflowForeach,

    executeWorkflowIteration,
    executeWorkflowInput,
    executeWorkflowNotify,
    executeWorkflowTemplate,
    executeWorkflowOutput,
    executeWorkflowLinkCard,
    getWorkflowPresentationToolDefinitions,
    executeWorkflowEmbedCode,
    renderWorkflowValue
};
