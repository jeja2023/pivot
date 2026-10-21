const CATEGORIES = Object.freeze([
    'syntax', 'schema', 'data_quality', 'permission', 'policy', 'network', 'rate_limit', 'browser', 'resource', 'timeout', 'unknown'
]);

const RULES = [
    ['timeout', /(?:timeout|timed out|超时|ETIMEDOUT|AGENT_.*TIMEOUT)/i],
    ['rate_limit', /(?:rate limit|too many requests|429|请求过于频繁|限流|配额超限)/i],
    ['browser', /(?:Target closed|waiting for selector|Element is not attached|locator\.|browser.*context|页面崩溃|元素不可点击)/i],
    ['policy', /(?:policy|permission denied by policy|策略拦截|AGENT_POLICY|AGENT_APPROVAL)/i],
    ['permission', /(?:EACCES|EPERM|forbidden|permission denied|无权|越权|401|403|Unauthorized|权限不足)/i],
    ['network', /(?:ECONN|ENOTFOUND|ECONNRESET|HTTP\s*[5]\d\d|网络|连接失败|DNS)/i],
    ['resource', /(?:out of memory|ENOMEM|quota|budget|resource|内存不足|资源不足|预算耗尽|AGENT_BUDGET)/i],
    ['syntax', /(?:SyntaxError|IndentationError|ParseError|语法错误|syntax error)/i],
    ['schema', /(?:KeyError|column .* not found|unknown column|table .* not found|schema|字段不存在|表不存在|列名不匹配)/i],
    ['data_quality', /(?:NaN|invalid.*type|cannot convert|数据质量|空值异常|类型转换失败)/i]
];

function normalizeError(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return [error.code, error.name, error.message].filter(Boolean).join(' ');
}

function diagnoseError(error, context = {}) {
    const message = normalizeError(error);
    const category = RULES.find(([, pattern]) => pattern.test(message))?.[0] || 'unknown';
    const remediation = {
        syntax: '定位报错行并修复语法、缩进或 SQL 语句后重试。',
        schema: '先读取实际字段/表结构，再校正字段名、表名或输入契约。',
        data_quality: '增加空值、类型和边界校验，必要时先清洗预处理数据。',
        permission: '将读写范围限制在授权工作区，或请求对应资源的明确权限。',
        policy: '遵守当前 PEP 策略，改用已授权工具或提交人工审批放行。',
        network: '检查白名单网络、目标服务状态，并使用有限次数退避重试。',
        rate_limit: '目标端触发速率限制，请等待冷却或调小批次并发量。',
        browser: '页面 DOM 发生重绘或选择器失效，建议重新捕获视觉页面结构后定位。',
        resource: '减少单次数据规模或并发数，优先使用 DuckDB 增量分批过滤聚合。',
        timeout: '拆分任务步骤、降低单步计算复杂度或延长超时时间后重试。',
        unknown: '保留结构化上下文并进行一次受限诊断，避免无限重试。'
    }[category];

    const actionableSteps = {
        syntax: [{ action: 'edit_code', label: '检查并修正语法/SQL' }, { action: 'retry', label: '单步重跑' }],
        schema: [{ action: 'inspect_schema', label: '读取上游字段元数据' }, { action: 'fix_mapping', label: '调整输出/输入映射' }],
        data_quality: [{ action: 'sanitize_input', label: '增加默认值与空保护' }],
        permission: [{ action: 'request_approval', label: '申请扩展授权' }],
        policy: [{ action: 'request_approval', label: '申请单次策略放行' }],
        network: [{ action: 'retry', label: '立即指数退避重试' }],
        rate_limit: [{ action: 'delay_retry', label: '等待冷却后自动重试' }, { action: 'reduce_concurrency', label: '降低并发' }],
        browser: [{ action: 'reobserve', label: '重新截屏与定位元素' }, { action: 'retry', label: '刷新页面重跑' }],
        resource: [{ action: 'split_batch', label: '缩小单次批处理规模' }],
        timeout: [{ action: 'increase_timeout', label: '延长限时或拆分子步骤' }],
        unknown: [{ action: 'retry', label: '受限重试一次' }]
    }[category] || [{ action: 'retry', label: '重试' }];

    return {
        category,
        message: message.slice(0, 2000),
        code: error?.code || '',
        retryable: ['network', 'rate_limit', 'browser', 'timeout', 'resource', 'data_quality', 'schema'].includes(category),
        remediation,
        actionableSteps,
        context: { tool: context.tool || '', step: context.step || 0 }
    };
}

function shouldRetryDiagnosis(diagnosis, attempt, maxAttempts = 3) {
    return Boolean(diagnosis?.retryable) && Number(attempt) < Math.max(Number(maxAttempts) || 1, 1);
}

function buildRecoveryPlan(diagnosis, attempt = 0) {
    const category = String(diagnosis?.category || 'unknown');
    const retryable = Boolean(diagnosis?.retryable);
    const delayMs = retryable ? Math.min(30000, 250 * (2 ** Math.max(Number(attempt) || 0, 0))) : 0;
    const actions = {
        syntax: ['修复语法或 SQL 后重试'],
        schema: ['重新读取字段/表结构', '修正字段映射后重试'],
        data_quality: ['增加空值与类型防御', '缩小批次后重试'],
        permission: ['停止越权操作', '请求明确授权'],
        policy: ['停止被拦截调用', '改用已授权工具或提交审批'],
        network: ['验证白名单和目标健康状态', '使用指数退避重试'],
        resource: ['降低并发或数据规模', '改用 DuckDB 分批处理'],
        timeout: ['拆分当前步骤', '降低单步复杂度后重试'],
        unknown: ['保留诊断上下文', '执行一次受限重试']
    }[category] || ['保留诊断上下文'];
    return { category, retryable, attempt: Number(attempt) || 0, delayMs, actions, maxAttempts: retryable ? 3 : 0 };
}

module.exports = { CATEGORIES, buildRecoveryPlan, diagnoseError, normalizeError, shouldRetryDiagnosis };
