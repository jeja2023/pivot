const CATEGORIES = Object.freeze([
    'syntax', 'schema', 'data_quality', 'permission', 'policy', 'network', 'resource', 'timeout', 'unknown'
]);

const RULES = [
    ['timeout', /(?:timeout|timed out|超时|ETIMEDOUT|AGENT_.*TIMEOUT)/i],
    ['policy', /(?:policy|permission denied by policy|策略拦截|AGENT_POLICY|AGENT_APPROVAL)/i],
    ['permission', /(?:EACCES|EPERM|forbidden|permission denied|无权|越权|权限)/i],
    ['network', /(?:ECONN|ENOTFOUND|ECONNRESET|HTTP\s*[45]\d\d|网络|连接失败|DNS)/i],
    ['resource', /(?:out of memory|ENOMEM|quota|budget|resource|内存|资源|预算|AGENT_BUDGET)/i],
    ['syntax', /(?:SyntaxError|IndentationError|ParseError|语法错误|syntax error)/i],
    ['schema', /(?:KeyError|column .* not found|unknown column|schema|字段不存在|列名)/i],
    ['data_quality', /(?:NaN|invalid.*type|cannot convert|数据质量|空值|类型转换)/i]
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
        schema: '先读取实际字段/表结构，再校正字段名或输入契约。',
        data_quality: '增加空值、类型和范围校验，必要时先清洗数据。',
        permission: '将读写范围限制在授权工作区，或请求明确权限。',
        policy: '遵守当前 PEP 策略，改用已授权工具或提交人工审批。',
        network: '检查白名单、目标服务状态并使用有限次数指数退避重试。',
        resource: '减少数据规模或并发，优先使用 DuckDB 分批过滤聚合。',
        timeout: '拆分任务、降低单步复杂度或优化算法后重试。',
        unknown: '保留结构化上下文并进行一次受限诊断，避免无限重试。'
    }[category];
    return {
        category,
        message: message.slice(0, 2000),
        code: error?.code || '',
        retryable: ['network', 'timeout', 'resource', 'data_quality', 'schema'].includes(category),
        remediation,
        context: { tool: context.tool || '', step: context.step || 0 }
    };
}

function shouldRetryDiagnosis(diagnosis, attempt, maxAttempts = 3) {
    return Boolean(diagnosis?.retryable) && Number(attempt) < Math.max(Number(maxAttempts) || 1, 1);
}

module.exports = { CATEGORIES, diagnoseError, normalizeError, shouldRetryDiagnosis };
