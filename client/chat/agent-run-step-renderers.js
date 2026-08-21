// Agent 运行步骤渲染器 Agent run step renderers
// Split from agent-run-renderers.js.
// 智能体运行步骤预览与结构化输出渲染器
/* eslint-disable no-undef */
function agentStepStructuredSummary(value) {
    const structured = unwrapAgentStructuredPayload(value);
    if (!structured || typeof structured !== 'object') return '';
    if (isAgentPivotChartSpec(structured)) {
        const typeLabel = {
            bar: '柱状图',
            line: '折线图',
            pie: '饼图',
            scatter: '散点图',
            area: '面积图'
        }[String(structured.chartType || '').toLowerCase()] || '图表';
        const points = Math.max(
            Array.isArray(structured.labels) ? structured.labels.length : 0,
            ...(Array.isArray(structured.series) ? structured.series.map(item => Array.isArray(item?.data) ? item.data.length : 0) : [0])
        );
        return `已生成${typeLabel}${structured.title ? `：${structured.title}` : ''}${points ? `，包含 ${points} 个数据点` : ''}。`;
    }
    const rows = agentRowsFromStructuredPayload(structured);
    if (rows.length) {
        const limit = Number(structured.limit || structured.total || 0);
        return `查询完成，返回 ${rows.length} 行数据${limit && limit !== rows.length ? `（限制 ${limit} 行）` : ''}。`;
    }
    return '';
}

function agentStepRowsMarkup(structured) {
    const rows = agentRowsFromStructuredPayload(structured);
    if (!rows.length) return '';
    const objectRows = rows
        .map(row => (row && typeof row === 'object' && !Array.isArray(row)) ? row : { value: row });
    const columns = [...new Set(objectRows.flatMap(row => Object.keys(row)))].slice(0, 6);
    const previewRows = objectRows.slice(0, 5);
    const hiddenCount = Math.max(rows.length - previewRows.length, 0);
    const limit = Number(structured?.limit || 0);
    return `
        <div class="agent-step-readable">
            <div class="agent-step-readable-head">
                <strong>查询结果</strong>
                <span>返回 ${rows.length} 行${limit && limit !== rows.length ? ` · 限制 ${limit} 行` : ''}</span>
            </div>
            <div class="agent-step-table-wrap">
                <table class="agent-step-table">
                    <thead>
                            <tr>${columns.map(column => `<th>${agentEscape(AGENT_RESULT_FIELD_LABELS[column] || column)}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${previewRows.map(row => `
                            <tr>${columns.map(column => {
                                const value = row[column];
                                const display = agentResultIsScalar(value)
                                    ? agentResultDisplayValue(column, value)
                                    : agentReadableCell(value);
                                return `<td>${agentEscape(display)}</td>`;
                            }).join('')}</tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${(hiddenCount || structured.__partial) ? `<div class="agent-step-readable-note">${structured.__partial ? `工具返回内容较多，已展示前 ${previewRows.length} 行。` : `仅展示前 ${previewRows.length} 行，还有 ${hiddenCount} 行可在原始数据中查看。`}</div>` : ''}
        </div>
    `;
}

const AGENT_RESULT_FIELD_LABELS = {
    answer: '结果',
    content: '内容',
    text: '内容',
    markdown: '内容',
    summary: '摘要',
    description: '说明',
    message: '消息',
    title: '标题',
    name: '名称',
    id: '标识',
    arguments: '参数',
    argument: '参数',
    status: '状态',
    state: '状态',
    type: '类型',
    error: '错误',
    warning: '提示',
    warnings: '提示',
    query: '查询条件',
    sql: '查询语句',
    total: '总数',
    count: '数量',
    limit: '返回上限',
    score: '相关度',
    confidence: '置信度',
    rows: '数据明细',
    data: '数据明细',
    items: '结果列表',
    result: '结果',
    results: '结果列表',
    matches: '匹配结果',
    documents: '文档',
    sessions: '会话',
    models: '模型',
    files: '文件',
    recommendations: '建议',
    findings: '分析发现',
    insights: '洞察',
    metrics: '关键指标',
    details: '详细信息',
    path: '路径',
    url: '链接',
    createdAt: '创建时间',
    created_at: '创建时间',
    updatedAt: '更新时间',
    updated_at: '更新时间',
    completedAt: '完成时间',
    completed_at: '完成时间',
    duration: '耗时',
    durationMs: '耗时（毫秒）',
    duration_ms: '耗时（毫秒）',
    checked: '已检查',
    size: '大小',
    table: '数据表',
    schema: '数据库模式',
    groupBy: '分组字段',
    group_by: '分组字段',
    value: '值',
    ok: '执行状态',
    governance: '数据安全',
    tableAllowlistActive: '数据表白名单',
    fieldAllowlistActive: '字段白名单',
    sensitiveMaskingActive: '敏感信息脱敏',
    queryTimeoutMs: '查询超时时间（毫秒）',
    cost: '查询开销',
    operation: '操作类型',
    databaseType: '数据库类型',
    database_type: '数据库类型',
    database_name: '数据库名称',
    boundedByLimit: '已限制返回数量',
    estimate: '预计开销',
    tables: '涉及数据表',
    fields: '涉及字段',
    columns: '字段信息',
    tableSchema: '数据库模式',
    table_schema: '数据库模式',
    TABLE_SCHEMA: '数据库模式',
    tableName: '数据表名称',
    table_name: '数据表名称',
    TABLE_NAME: '数据表名称',
    tableType: '数据表类型',
    table_type: '数据表类型',
    TABLE_TYPE: '数据表类型',
    columnName: '字段名称',
    column_name: '字段名称',
    dataType: '数据类型',
    data_type: '数据类型',
    isNullable: '允许为空',
    is_nullable: '允许为空',
    columnDefault: '默认值',
    column_default: '默认值',
    responseFormat: '返回格式',
    format: '输出格式',
    presentation: '交付方式',
    fileRef: '文件引用',
    file: '文件产物',
    temperature: '生成随机性',
    maxTokens: '最大输出量',
    max_tokens: '最大输出量',
    finishReason: '结束原因',
    finish_reason: '结束原因',
    toolCalls: '工具调用',
    modelName: '模型文件',
    model_name: '模型名称',
    modelId: '模型标识',
    model_id: '模型标识',
    model: '调用模型',
    input: '输入数据',
    output: '输出数据',
    stats: '指标统计',
    records: '校对明细',
    artifact: '任务产物',
    artifacts: '任务产物',
    reviewComplete: '校对完成',
    review_complete: '校对完成',
    sourceRowCount: '原始数据行数',
    source_row_count: '原始数据行数',
    processedRecords: '已处理记录数',
    processed_records: '已处理记录数',
    skippedRecords: '已跳过记录数',
    skipped_records: '已跳过记录数',
    completedRecords: '已完成记录数',
    completed_records: '已完成记录数',
    passedRecords: '无问题记录数',
    passed_records: '无问题记录数',
    issueRecords: '存在问题记录数',
    issue_records: '存在问题记录数',
    incompleteRecords: '未完整处理记录数',
    incomplete_records: '未完整处理记录数',
    titleIssues: '标题问题数',
    title_issues: '标题问题数',
    contentIssues: '正文问题数',
    content_issues: '正文问题数',
    titleIssueCount: '标题问题数',
    title_issue_count: '标题问题数',
    contentIssueCount: '正文问题数',
    content_issue_count: '正文问题数',
    originalChars: '原始字符数',
    original_chars: '原始字符数',
    cleanChars: '清洗后字符数',
    clean_chars: '清洗后字符数',
    removedChars: '移除字符数',
    removed_chars: '移除字符数',
    modelCallCount: '模型调用次数',
    model_call_count: '模型调用次数',
    chunkTokens: '分块 Token 预算',
    chunk_tokens: '分块 Token 预算',
    overlapTokens: '重叠 Token 数',
    overlap_tokens: '重叠 Token 数',
    upstreamPartial: '上游数据截断',
    upstream_partial: '上游数据截断',
    oversizedRowCount: '超长记录数',
    oversized_row_count: '超长记录数',
    inputTruncated: '输入已截断',
    input_truncated: '输入已截断',
    recordId: '记录标识',
    record_id: '记录标识',
    issues: '发现问题',
    issue: '问题',
    original: '原文内容',
    suggestion: '建议修改',
    reason: '修改理由',
    category: '问题类型',
    field: '涉及字段',
    chunkCount: '分块数量',
    chunk_count: '分块数量',
    contextAdjusted: '上下文预算调整',
    context_adjusted: '上下文预算调整',
    reportTitle: '报告标题',
    report_title: '报告标题',
    instructions: '补充规则',
    idField: '主键字段',
    id_field: '主键字段',
    titleField: '标题字段',
    title_field: '标题字段',
    contentField: '正文字段',
    content_field: '正文字段',
    maxRecords: '最大记录数',
    max_records: '最大记录数',
    maxSummaryChars: '摘要字符上限',
    max_summary_chars: '摘要字符上限',
    concurrency: '并发数量',
    fromAgent: '发起智能体',
    from_agent: '发起智能体',
    toAgent: '接收智能体',
    to_agent: '接收智能体',
    agentName: '专家智能体',
    agent_name: '专家智能体',
    role: '角色设定',
    task: '指派任务',
    context: '上下文',
    evidence: '支撑证据',
    risks: '潜在风险',
    openQuestions: '待决问题',
    open_questions: '待决问题',
    route: '匹配路由',
    matched: '匹配状态',
    operator: '比较操作符',
    compareTo: '比较目标值',
    compare_to: '比较目标值',
    vars: '注入变量',
    code: '代码内容',
    stopOnError: '出错时终止',
    stop_on_error: '出错时终止',
    sectionCount: '章节数量',
    section_count: '章节数量',
    sections: '报告章节',
    includeToc: '包含目录',
    include_toc: '包含目录',
    workflowId: '工作流标识',
    workflow_id: '工作流标识',
    workflowName: '工作流名称',
    workflow_name: '工作流名称',
    inputs: '输入参数',
    credentialSecret: '凭据名称',
    credentialHeader: '凭据请求头',
    credentialPrefix: '凭据前缀',
    timeoutMs: '超时时间（毫秒）',
    timeout_ms: '超时时间（毫秒）',
    timeoutAction: '超时处理',
    timeoutHours: '超时小时数',
    approvers: '审批人员',
    approverUserIds: '审批用户标识',
    approverUnits: '审批部门',
    approvalLevels: '多级审批流',
    imServerId: '即时通讯服务',
    imTargetType: '目标类型',
    imTarget: '发送目标',
    callbackBaseUrl: '回调地址',
    callbackCredential: '回调凭据',
    target: '发送目标',
    allowedTargets: '允许目标',
    defaultTarget: '默认目标',
    allowAtAll: '允许 @所有人',
    selectedSheet: '选定工作表',
    selected_sheet: '选定工作表',
    sheets: '工作表列表',
    sheetName: '工作表名称',
    sheet_name: '工作表名称',
    lineCount: '代码行数',
    line_count: '代码行数',
    headers: '响应头',
    statusCode: '状态码',
    status_code: '状态码',
    response: '响应数据',
    retryable: '可重试',
    originalRowCount: '原始数据行数',
    original_row_count: '原始数据行数',
    rowCount: '数据行数',
    row_count: '数据行数',
    columnCount: '字段列数',
    column_count: '字段列数',
    cellCount: '单元格数',
    differenceCount: '差异数量',
    diffCount: '差异数量',
    provenance: '数据溯源',
    docName: '文档名称',
    doc_name: '文档名称',
    hit: '匹配命中',
    prompt: '提示词',
    systemPrompt: '系统提示词',
    system_prompt: '系统提示词',
    topK: '检索数量',
    top_k: '检索数量',
    candidateLimit: '候选上限',
    candidate_limit: '候选上限',
    usage: '资源用量',
    inputTokens: '输入 Token',
    input_tokens: '输入 Token',
    outputTokens: '输出 Token',
    output_tokens: '输出 Token',
    totalTokens: '总计 Token',
    total_tokens: '总计 Token',
    reasoningTokens: '推理 Token',
    reasoning_tokens: '推理 Token',
    cachedTokens: '缓存 Token',
    cached_tokens: '缓存 Token',
    notes: '补充说明',
    note: '说明',
    attempt: '尝试次数',
    attempt_count: '尝试次数',
    condition: '执行条件',
    depends_on: '前置步骤',
    dependsOn: '前置步骤',
    node_key: '节点标识',
    nodeKey: '节点标识',
    tool_name: '工具名称',
    toolName: '工具名称',
    tool: '工具名称',
    draft: '工作流草稿',
    version: '版本',
    endpointHost: '服务主机',
    password: '密码',
    relativePath: '相对路径',
    extension: '文件扩展名',
    sample: '数据样本',
    trace: '调用链追踪',
    step: '步骤',
    nodes: '节点列表',
    variables: '变量列表',
    keys: '键列表',
    options: '配置项',
    additionalProperties: '附加属性',
    _owner: '所有者'
};

const AGENT_RESULT_ENVELOPE_FIELDS = new Set([
    'content', 'text', 'markdown', 'answer', 'message', 'summary', 'structuredContent',
    'responseFormat', 'temperature', 'maxTokens', 'model', 'usage', 'finishReason',
    'toolCalls', 'renderer', 'version'
]);

function agentResultFieldLabel(key) {
    const value = String(key || '').trim();
    if (!value) return '信息';
    if (AGENT_RESULT_FIELD_LABELS[value]) return AGENT_RESULT_FIELD_LABELS[value];
    const compact = value.replace(/[\s_-]+/g, '').toLowerCase();
    const knownKey = Object.keys(AGENT_RESULT_FIELD_LABELS).find(item => item.replace(/[\s_-]+/g, '').toLowerCase() === compact);
    if (knownKey) return AGENT_RESULT_FIELD_LABELS[knownKey];

    // 智能子词与后缀翻译匹配
    const wordMap = {
        count: '数量', list: '列表', name: '名称', type: '类型', time: '时间',
        size: '大小', status: '状态', ratio: '比例', percent: '百分比', rate: '比率',
        limit: '上限', code: '编码', error: '错误', msg: '消息', message: '消息',
        title: '标题', desc: '说明', description: '说明', id: '标识', url: '链接',
        path: '路径', text: '文本', value: '值', total: '总计', max: '最大',
        min: '最小', avg: '平均', rows: '行数', columns: '列数', tokens: 'Token',
        source: '来源', target: '目标', input: '输入', output: '输出',
        processed: '已处理', skipped: '已跳过', completed: '已完成', passed: '通过',
        failed: '失败', issue: '问题', clean: '清洗', raw: '原始', user: '用户',
        group: '群组', file: '文件', item: '条目', record: '记录', data: '数据',
        table: '数据表', field: '字段', column: '列', row: '行', chunk: '分块',
        model: '模型', rule: '规则', workflow: '工作流', agent: '智能体', server: '服务',
        db: '数据库', info: '信息', config: '配置', param: '参数', params: '参数',
        result: '结果', detail: '详情', details: '详情', header: '请求头', body: '正文'
    };

    const parts = value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .split(/[_\s-]+/)
        .map(p => p.toLowerCase())
        .filter(Boolean);

    if (parts.length > 1 && parts.every(p => wordMap[p])) {
        return parts.map(p => wordMap[p]).join('');
    }

    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function agentResultIsScalar(value) {
    return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

function agentResultScalarText(value) {
    if (value === undefined || value === null || value === '') return '-';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
    return String(value);
}

function agentResultDisplayValue(key, value) {
    if (value === undefined || value === null || value === '') return '-';
    const normalizedKey = String(key || '').replace(/[\s_-]+/g, '').toLowerCase();

    // 布尔值本地化
    if (typeof value === 'boolean') {
        if (['ok', 'success'].includes(normalizedKey)) return value ? '成功' : '失败';
        return value ? '是' : '否';
    }

    // 数值格式化
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (normalizedKey.includes('percent') || normalizedKey.includes('ratio') || normalizedKey.includes('rate')) {
            if (value <= 1 && value >= 0) return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
        }
        return value.toLocaleString('zh-CN');
    }

    // 状态枚举
    if (['status', 'statuscode', 'state'].includes(normalizedKey)) {
        const statusLabels = {
            awaiting_approval: '等待审批',
            approval_required: '待审批',
            waiting_approval: '待审批',
            queued: '排队中',
            planning: '规划中',
            executing: '执行中',
            observing: '观察中',
            diagnosing: '诊断中',
            replanning: '重规划中',
            resuming: '恢复中',
            pending: '待执行',
            running: '运行中',
            completed: '已完成',
            completed_with_errors: '完成但有错误',
            continued_error: '失败后继续',
            issues_found: '存在问题',
            passed: '未发现问题',
            incomplete: '未完整处理',
            success: '成功',
            error: '失败',
            failed: '失败',
            cancelled: '已停止',
            skipped: '已跳过',
            deleted: '已删除'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (statusLabels[normalized]) return statusLabels[normalized];
    }

    // 类型与产物
    if (['type', 'tabletype', 'table_type', 'artifacttype', 'spantype', 'tasktype', 'runtype', 'presentation', 'format', 'responseformat', 'datatype'].includes(normalizedKey)) {
        const typeLabels = {
            content_review_report: '内容校对报告',
            pivot_chart: '图表',
            pivot_table: '数据表格',
            pivot_report: '结构化报告',
            format_markdown_table: '数据表格',
            markdown: 'Markdown 格式',
            text: '纯文本',
            json: 'JSON 数据',
            table: '数据表格',
            file: '文件产物',
            default: '默认交付',
            'base table': '数据表',
            view: '视图',
            'system view': '系统视图',
            builtin_tool: '系统工具',
            database_connection: '数据库连接',
            mcp_server: 'MCP 工具服务',
            user: '用户私聊',
            group: '群组消息',
            free: '自主任务',
            workflow: '工作流任务',
            scheduled: '计划任务',
            model: '模型调用',
            tool: '工具执行',
            plan: '任务规划',
            dag: '工作流',
            dag_node: '工作流节点',
            agent: '智能体',
            handoff: '交接上下文',
            routing: '条件路由',
            control: '任务控制',
            note: '执行记录',
            string: '字符串',
            number: '数值',
            integer: '整数',
            boolean: '布尔值',
            object: '对象',
            array: '列表'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (typeLabels[normalized]) return typeLabels[normalized];
    }

    // 智能体角色
    if (['role', 'agentrole'].includes(normalizedKey)) {
        const roleLabels = {
            analyst: '分析师',
            researcher: '研究员',
            reviewer: '审查员',
            writer: '撰稿人',
            custom: '自定义角色',
            assistant: '智能助手',
            user: '用户',
            system: '系统',
            admin: '管理员'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (roleLabels[normalized]) return roleLabels[normalized];
    }

    // 分类与问题类型
    if (['category', 'issuecategory', 'errorcategory', 'error_type'].includes(normalizedKey)) {
        const categoryLabels = {
            typo: '错别字',
            grammar: '语法语病',
            punctuation: '标点符号',
            terminology: '业务术语',
            sensitive: '敏感词汇',
            clarity: '表述不清',
            style: '文风格式',
            syntax: '语法错误',
            schema: '结构模式',
            data_quality: '数据质量',
            permission: '权限问题',
            policy: '安全策略',
            network: '网络问题',
            resource: '资源限制',
            timeout: '执行超时'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (categoryLabels[normalized]) return categoryLabels[normalized];
    }

    // 操作符与条件
    if (['operator', 'condition'].includes(normalizedKey)) {
        const conditionLabels = {
            always: '始终执行',
            success: '上游成功时',
            failure: '上游失败时',
            error: '上游异常时',
            equals: '等于',
            not_equals: '不等于',
            contains: '包含',
            not_contains: '不包含',
            greater_than: '大于',
            less_than: '小于',
            is_empty: '为空',
            not_empty: '非空',
            is_true: '为真',
            is_false: '为假'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (conditionLabels[normalized]) return conditionLabels[normalized];
    }

    // 运行模式
    if (['mode', 'runmode', 'contextmode'].includes(normalizedKey)) {
        const modeLabels = {
            any: '任一满足',
            all: '全部满足',
            standard: '标准模式',
            deep: '深度模式',
            audit: '审查模式',
            dag: '工作流',
            auto: '自动选择',
            recent: '最近会话',
            knowledge: '知识库优先',
            custom: '自定义说明',
            none: '不扩展'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (modeLabels[normalized]) return modeLabels[normalized];
    }

    // 工具名称转换
    if (['name', 'toolname', 'tool_name', 'tool'].includes(normalizedKey) && typeof value === 'string' && typeof agentToolTitle === 'function') {
        const friendlyName = agentToolTitle(value);
        if (friendlyName && friendlyName !== value) return friendlyName;
    }

    // 模型结束原因
    if (['finishreason', 'finish_reason'].includes(normalizedKey)) {
        const finishReasonLabels = {
            stop: '正常结束',
            tool_calls: '调用工具',
            function_call: '调用函数',
            length: '达到输出上限',
            content_filter: '内容安全拦截'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (finishReasonLabels[normalized]) return finishReasonLabels[normalized];
    }

    // 数据库与系统操作
    if (normalizedKey === 'operation') {
        const operationLabels = {
            readonly_sql: '只读查询',
            query: '数据查询',
            aggregate: '聚合分析',
            describe: '表结构分析',
            count: '统计计数'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (operationLabels[normalized]) return operationLabels[normalized];
    }

    // 涉及字段
    if (normalizedKey === 'field') {
        const fieldLabels = {
            title: '标题',
            content: '正文',
            body: '正文',
            summary: '摘要',
            description: '说明'
        };
        const normalized = String(value || '').trim().toLowerCase();
        if (fieldLabels[normalized]) return fieldLabels[normalized];
    }

    // 全局常见枚举值直译
    const globalScalarTranslations = {
        content_review_report: '内容校对报告',
        issues_found: '存在问题',
        passed: '未发现问题',
        incomplete: '未完整处理',
        readonly_sql: '只读查询',
        stop: '正常结束',
        tool_calls: '调用工具',
        function_call: '调用函数',
        length: '达到输出上限',
        content_filter: '内容安全拦截',
        'base table': '数据表',
        view: '视图',
        'system view': '系统视图'
    };
    if (typeof value === 'string' && globalScalarTranslations[value.trim().toLowerCase()]) {
        return globalScalarTranslations[value.trim().toLowerCase()];
    }

    return agentResultScalarText(value);
}

function agentResultObjectSummary(value, maxFields = 3) {
    const parsed = agentParsePayload(value);
    if (agentResultIsScalar(parsed)) return agentShortText(agentResultScalarText(parsed), 120);
    if (Array.isArray(parsed)) {
        const preview = parsed.slice(0, maxFields).map(item => agentResultObjectSummary(item, 2)).filter(Boolean);
        return `${preview.join('、')}${parsed.length > preview.length ? ` 等 ${parsed.length} 项` : ''}` || `${parsed.length} 项`;
    }
    const preferred = agentLlmOutputText(parsed);
    if (preferred) {
        const preferredParsed = agentParsePayload(preferred);
        return preferredParsed === preferred
            ? agentShortText(preferred, 120)
            : agentResultObjectSummary(preferredParsed, maxFields);
    }
    const parts = Object.entries(parsed || {})
        .filter(([, item]) => agentResultIsScalar(item) && item !== '' && item !== null && item !== undefined)
        .slice(0, maxFields)
        .map(([key, item]) => `${agentResultFieldLabel(key)}：${agentShortText(agentResultScalarText(item), 48)}`);
    return parts.join(' · ') || `${Object.keys(parsed || {}).length} 项信息`;
}

function agentResultArrayColumns(rows) {
    const objectRows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row));
    if (!objectRows.length) return [];
    return [...new Set(objectRows.flatMap(row => Object.keys(row)))].slice(0, 8);
}

function agentResultTableMarkup(rows, options = {}) {
    const values = Array.isArray(rows) ? rows : [];
    if (!values.length) return '';
    const columns = agentResultArrayColumns(values);
    if (!columns.length) return '';
    const maxRows = Math.max(1, Number(options.maxRows || 8));
    const previewRows = values.slice(0, maxRows);
    const hiddenCount = Math.max(values.length - previewRows.length, 0);
    return `
        <div class="agent-result-table-wrap">
            <table class="agent-result-table">
                <thead><tr>${columns.map(column => `<th>${agentEscape(agentResultFieldLabel(column))}</th>`).join('')}</tr></thead>
                <tbody>
                    ${previewRows.map(row => `
                        <tr>${columns.map(column => {
                            const value = agentParsePayload(row?.[column]);
                            const text = agentResultIsScalar(value)
                                ? agentResultDisplayValue(column, value)
                                : agentResultObjectSummary(value, 2);
                            return `<td>${agentEscape(text)}</td>`;
                        }).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ${hiddenCount ? `<div class="agent-result-note">已展示前 ${previewRows.length} 条，其余 ${hiddenCount} 条可在原始数据中查看。</div>` : ''}
    `;
}

function agentWorkflowTableMarkup(table = {}) {
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const columns = Array.isArray(table.columns) && table.columns.length ? table.columns : agentResultArrayColumns(rows);
    if (!columns.length) return '<div class="agent-result-empty">暂无表格数据</div>';
    return `
        <div class="agent-result-table-wrap agent-workflow-output-table">
            ${table.title ? `<div class="agent-result-table-title">${agentEscape(table.title)}</div>` : ''}
            <table class="agent-result-table">
                <thead><tr>${columns.map(column => `<th>${agentEscape(agentResultFieldLabel(column))}</th>`).join('')}</tr></thead>
                <tbody>${rows.slice(0, 20).map(row => `<tr>${columns.map(column => `<td>${agentEscape(agentResultDisplayValue(column, agentParsePayload(row?.[column])))}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
            ${Number(table.rowCount || rows.length) > rows.slice(0, 20).length ? `<div class="agent-result-note">已展示前 20 行，共 ${Number(table.rowCount || rows.length)} 行。</div>` : ''}
        </div>
    `;
}

function agentWorkflowFileMarkup(file = {}) {
    const href = String(file.downloadUrl || file.url || '').trim();
    const safeHref = /^(?:https?:\/\/|\/(?!\/))/i.test(href) ? href : '';
    return `
        <div class="agent-workflow-output-file">
            <div class="agent-workflow-output-file-icon">文件</div>
            <div class="agent-workflow-output-file-main">
                <strong>${agentEscape(file.name || file.fileId || file.id || '文件产物')}</strong>
                <span>${agentEscape(file.mimeType || '文件引用')}${file.size ? ` · ${agentEscape(String(file.size))} 字节` : ''}</span>
            </div>
            ${safeHref ? `<a class="btn-secondary" href="${agentEscapeAttr(safeHref)}" target="_blank" rel="noopener noreferrer">打开</a>` : '<span class="agent-result-note">已保留引用</span>'}
        </div>
    `;
}

function agentResultArrayMarkup(items, options = {}, depth = 0) {
    if (!items.length) return '<div class="agent-result-empty">暂无数据</div>';
    const table = agentResultTableMarkup(items, options);
    if (table) return table;
    const maxItems = Math.max(1, Number(options.maxItems || 10));
    const visibleItems = items.slice(0, maxItems);
    return `
        <ul class="agent-result-list">
            ${visibleItems.map(item => {
                const parsedItem = agentParsePayload(item);
                if (agentResultIsScalar(parsedItem)) return `<li>${agentEscape(agentResultScalarText(parsedItem))}</li>`;
                return `<li>${agentResultReadableMarkup(parsedItem, options, depth + 1)}</li>`;
            }).join('')}
        </ul>
        ${items.length > visibleItems.length ? `<div class="agent-result-note">已展示前 ${visibleItems.length} 项，其余 ${items.length - visibleItems.length} 项可在原始数据中查看。</div>` : ''}
    `;
}

function agentResultPrimaryText(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    return agentLlmOutputText(payload);
}

function agentResultObjectMarkup(payload, options = {}, depth = 0) {
    if (isAgentPivotChartSpec(payload)) return renderAgentPivotChartBlock(payload);
    if (payload.presentation === 'table' && payload.table) return agentWorkflowTableMarkup(payload.table);
    if (payload.presentation === 'file' && payload.file) return agentWorkflowFileMarkup(payload.file);
    const type = String(payload.type || '').trim();
    const markdown = String(payload.markdown || '').trim();
    if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) {
        return renderMarkdown(normalizeAgentMarkdown(markdown));
    }
    if (payload.structuredContent && typeof payload.structuredContent === 'object') {
        return agentResultReadableMarkup(payload.structuredContent, options, depth);
    }

    const primaryText = agentResultPrimaryText(payload);
    const entries = Object.entries(payload).map(([key, value]) => [key, agentParsePayload(value)]).filter(([key, value]) => {
        if (value === undefined || value === null || value === '') return false;
        if (primaryText && AGENT_RESULT_ENVELOPE_FIELDS.has(key)) return false;
        return true;
    });
    const scalarEntries = entries.filter(([, value]) => agentResultIsScalar(value) && String(value).length <= 180 && !String(value).includes('\n'));
    const scalarKeys = new Set(scalarEntries.map(([key]) => key));
    const complexEntries = entries.filter(([key]) => !scalarKeys.has(key));
    const parts = [];

    if (primaryText) {
        parts.push(`<div class="agent-result-lead">${agentResultReadableMarkup(primaryText, options, depth + 1)}</div>`);
    }
    if (scalarEntries.length) {
        parts.push(`
            <dl class="agent-result-facts">
                ${scalarEntries.map(([key, value]) => `
                    <div><dt>${agentEscape(agentResultFieldLabel(key))}</dt><dd>${agentEscape(agentResultDisplayValue(key, value))}</dd></div>
                `).join('')}
            </dl>
        `);
    }
    complexEntries.forEach(([key, value]) => {
        parts.push(`
            <section class="agent-result-section">
                <h4>${agentEscape(agentResultFieldLabel(key))}</h4>
                ${agentResultReadableMarkup(value, options, depth + 1)}
            </section>
        `);
    });
    if (parts.length) return parts.join('');
    return '<div class="agent-result-empty">任务已完成，未返回可展示内容。</div>';
}

function agentResultReadableMarkup(value, options = {}, depth = 0) {
    const parsed = agentParsePayload(value);
    if (parsed === undefined || parsed === null || parsed === '') return '<div class="agent-result-empty">暂无结果</div>';
    if (depth > 4) return `<p>${agentEscape(agentResultObjectSummary(parsed, 4))}</p>`;
    if (typeof parsed === 'string') return renderMarkdown(normalizeAgentMarkdown(parsed));
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return `<p>${agentEscape(agentResultScalarText(parsed))}</p>`;
    if (Array.isArray(parsed)) return agentResultArrayMarkup(parsed, options, depth);
    return agentResultObjectMarkup(parsed, options, depth);
}

function agentResultRawText(value) {
    const parsed = agentParsePayload(value);
    if (!parsed || typeof parsed !== 'object') return '';
    try {
        return JSON.stringify(parsed, null, 2);
    } catch (e) {
        return '';
    }
}

function renderAgentFinalAnswer(value) {
    const raw = agentResultRawText(value);
    return `
        <div class="agent-final">
            <div class="agent-final-label">任务结果</div>
            <div class="agent-result-readable">${agentResultReadableMarkup(value, { maxRows: 10, maxItems: 12 })}</div>
            ${raw ? `<details class="agent-result-raw"><summary>查看原始数据</summary><pre>${agentEscape(raw)}</pre></details>` : ''}
        </div>
    `;
}

function agentStepChartSummaryMarkup(structured) {
    if (!isAgentPivotChartSpec(structured)) return '';
    const typeLabel = {
        bar: '柱状图',
        line: '折线图',
        pie: '饼图',
        scatter: '散点图',
        area: '面积图'
    }[String(structured.chartType || '').toLowerCase()] || '图表';
    const series = Array.isArray(structured.series) ? structured.series : [];
    const points = Math.max(
        Array.isArray(structured.labels) ? structured.labels.length : 0,
        ...series.map(item => Array.isArray(item?.data) ? item.data.length : 0),
        0
    );
    const xAxis = structured.xAxis?.label || structured.xAxis?.field || '';
    const yAxis = structured.yAxis?.label || structured.yAxis?.field || '';
    return `
        <div class="agent-step-readable agent-step-chart-summary">
            <div class="agent-step-readable-head">
                <strong>图表已生成</strong>
                <span>${agentEscape(typeLabel)}</span>
            </div>
            <div class="agent-step-kpis">
                ${structured.title ? `<span><em>标题</em><strong>${agentEscape(structured.title)}</strong></span>` : ''}
                ${xAxis ? `<span><em>横轴</em><strong>${agentEscape(xAxis)}</strong></span>` : ''}
                ${yAxis ? `<span><em>纵轴</em><strong>${agentEscape(yAxis)}</strong></span>` : ''}
                <span><em>数据点</em><strong>${Number(points || 0)}</strong></span>
                ${series.length ? `<span><em>系列</em><strong>${series.map(item => agentEscape(item?.name || '数据')).join('、')}</strong></span>` : ''}
            </div>
        </div>
    `;
}

function agentLlmOutputText(value) {
    const payload = agentParsePayload(value);
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload !== 'object') return String(payload || '').trim();
    const contentText = Array.isArray(payload.content)
        ? payload.content.map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return String(item.text || item.content || item.markdown || '').trim();
        }).filter(Boolean).join('\n').trim()
        : '';
    return [
        typeof payload.content === 'string' ? payload.content : '',
        payload.text,
        payload.markdown,
        payload.answer,
        payload.message,
        payload.summary,
        contentText
    ].map(item => String(item || '').trim()).find(Boolean) || '';
}

function agentStepLlmReadableMarkup(step) {
    if (String(step?.tool_name || '').trim() !== 'agent.llm') return '';
    const text = stripAgentWorkflowReportHeading(agentLlmOutputText(step.output));
    if (!text) return '';
    return `<div class="agent-step-readable agent-step-llm-output">${agentResultReadableMarkup(text, { maxRows: 6, maxItems: 8 })}</div>`;
}

function agentStepReadableMarkup(step) {
    const llmReadable = agentStepLlmReadableMarkup(step);
    if (llmReadable) return llmReadable;
    const normalized = agentNormalizeToolPayload(step.output || step.input || {});
    const structured = normalized && typeof normalized === 'object'
        ? (unwrapAgentStructuredPayload(normalized) || normalized)
        : null;
    if (!structured || typeof structured !== 'object') return '';
    return agentStepChartSummaryMarkup(structured)
        || agentStepRowsMarkup(structured)
        || `<div class="agent-step-readable agent-result-readable">${agentResultReadableMarkup(structured, { maxRows: 5, maxItems: 6 })}</div>`;
}

function agentStepPreview(step) {
    if (String(step?.tool_name || '').trim() === 'agent.llm') {
        const llmText = stripAgentWorkflowReportHeading(agentLlmOutputText(step.output));
        if (llmText) return agentShortText(llmText, 500);
    }
    const normalized = agentNormalizeToolPayload(step.output || step.input || {});
    const payload = normalized && typeof normalized !== 'string'
        ? normalized
        : agentParsePayload(normalized);
    if (typeof payload === 'string') return agentShortText(payload, 500);
    if (Array.isArray(payload)) return `返回 ${payload.length} 条结果。`;
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    if (payload?.__partial && Array.isArray(payload.rows)) return `工具返回内容较多，已读取前 ${payload.rows.length} 行。`;
    const structuredSummary = agentStepStructuredSummary(payload);
    if (structuredSummary) return structuredSummary;
    if (payload.answer) return payload.answer;
    if (payload.error) return payload.error;
    if (payload.thought || payload.action) {
        const lines = [];
        if (payload.thought) lines.push(`判断：${agentShortText(payload.thought, 220)}`);
        if (payload.action === 'tool') lines.push(`动作：调用 ${agentToolTitle(payload.tool)}`);
        if (payload.action === 'final') lines.push('动作：生成最终结果');
        if (payload.input) lines.push(`参数：${agentSummarizeInput(payload.input)}`);
        return lines.join('\n') || '已完成一次规划。';
    }
    if (Array.isArray(payload.matches)) {
        const scores = payload.matches
            .map(item => Number(item.score))
            .filter(score => Number.isFinite(score));
        const best = scores.length ? `，最高相关度 ${Math.max(...scores).toFixed(3)}` : '';
        const named = payload.matches.find(item => item.name || item.source || item.document_name);
        const source = named ? `，来源：${agentShortText(named.name || named.source || named.document_name, 80)}` : '';
        return `返回 ${payload.matches.length} 条匹配结果${best}${source}。`;
    }
    if (Array.isArray(payload.documents)) return `返回 ${payload.documents.length} 个知识库文档。`;
    if (Array.isArray(payload.sessions)) return `返回 ${payload.sessions.length} 条会话记录。`;
    if (Array.isArray(payload.models)) return `返回 ${payload.models.length} 个可用模型。`;
    if (payload.query) return `查询：${payload.query}`;
    if (payload.status) return `状态：${agentResultDisplayValue('status', payload.status)}`;
    return agentResultObjectSummary(payload, 5);
}

function normalizeAgentMarkdown(text) {
    return String(text || '')
        .replace(/\*\*([^*\n]+?)：\s+\*\*/g, '**$1：**')
        .replace(/\*\*([^*\n]+?):\s+\*\*/g, '**$1:**');
}

function stripAgentWorkflowReportHeading(text) {
    const value = String(text || '').replace(/^\uFEFF/, '');
    const trimmed = value.trim();
    if (!trimmed) return '';
    const lines = value.split(/\r?\n/);
    let start = 0;
    while (start < lines.length && !String(lines[start] || '').trim()) start += 1;
    if (start >= lines.length) return '';
    const firstLine = String(lines[start] || '').trim();
    const normalized = firstLine.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
    if (!/^(?:工作流分析报告|工作流报告|分析报告)\s*[：:]/.test(normalized)) {
        return trimmed;
    }
    const remainder = lines.slice(start + 1);
    while (remainder.length && !String(remainder[0] || '').trim()) remainder.shift();
    return remainder.join('\n').trim();
}

function agentStepRawDetail(step, preview) {
    const payload = step.output || step.input;
    if (payload === undefined || payload === null) return '';
    const raw = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload, null, 2);
    if (!raw || raw === preview) return '';
    return raw.length > 5000 ? `${raw.slice(0, 5000)}\n...` : raw;
}

function agentStepMarkup(step) {
    const preview = normalizeAgentMarkdown(agentStepPreview(step));
    const readable = agentStepReadableMarkup(step);
    const raw = agentStepRawDetail(step, preview);
    return `
        <div class="agent-step ${agentEscape(step.status)}">
            <div class="agent-step-head">
                <strong>${step.step_index}. ${agentEscape(agentStepTitle(step))}</strong>
                <span>${agentEscape(agentToolTitle(step.tool_name || step.type))} · ${Number(step.duration_ms || 0)} 毫秒</span>
            </div>
            <div class="agent-step-body">${readable || renderMarkdown(agentEscape(preview))}</div>
            ${raw ? `<details class="agent-step-raw"><summary>查看原始数据</summary><pre>${agentEscape(raw)}</pre></details>` : ''}
        </div>
    `;
}

function unwrapAgentStructuredPayload(value) {
    const payload = agentParsePayload(value);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.structuredContent && typeof payload.structuredContent === 'object') return payload.structuredContent;
    if (Array.isArray(payload.content)) {
        const text = payload.content
            .map(item => item?.text || item?.content || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        const nested = agentParsePayload(text);
        if (nested && typeof nested === 'object') {
            return nested.structuredContent && typeof nested.structuredContent === 'object'
                ? nested.structuredContent
                : nested;
        }
    }
    return payload;
}

function agentDecodeResultEntities(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function agentExtractMcpContentText(value) {
    const source = String(value || '');
    const match = source.match(/["']text["']\s*:\s*"((?:\\.|[^"\\])*)/s);
    if (!match) return '';
    try {
        return JSON.parse(`"${match[1]}"`);
    } catch (e) {
        return agentDecodeResultEntities(match[1])
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function agentExtractPartialRows(value, maxRows = 8) {
    const source = agentDecodeResultEntities(value);
    const matches = source.match(/\{[^{}]*\}/g) || [];
    const rows = [];
    matches.some(fragment => {
        try {
            const row = JSON.parse(fragment);
            if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
        } catch (e) {
            // 长文本被截断时，忽略不完整的最后一行。
        }
        return rows.length >= maxRows;
    });
    return rows;
}

function agentNormalizeToolPayload(value) {
    const parsed = agentParsePayload(value);
    if (!parsed || typeof parsed !== 'string') return parsed;
    const text = agentExtractMcpContentText(parsed);
    if (!text) return parsed;
    const nested = agentParsePayload(text);
    if (Array.isArray(nested)) return { rows: nested, __partial: /\.\.\.\[truncated\]/i.test(text) };
    if (nested && typeof nested === 'object') {
        return nested.structuredContent && typeof nested.structuredContent === 'object'
            ? nested.structuredContent
            : nested;
    }
    const rows = agentExtractPartialRows(text);
    if (rows.length) return { rows, __partial: true };
    return { text: agentShortText(agentDecodeResultEntities(text), 900), __mcpText: true };
}

function isAgentPivotChartSpec(value) {
    return Boolean(value && typeof value === 'object'
        && value.type === 'pivot_chart'
        && Array.isArray(value.labels)
        && Array.isArray(value.series));
}

function renderAgentPivotChartBlock(spec) {
    return `
        <div class="pivot-echart-block" data-pivot-echart="${agentEscapeAttr(JSON.stringify(spec))}">
            <div class="pivot-echart-title">图表</div>
            <div class="pivot-echart-canvas"></div>
            <canvas height="300"></canvas>
            <pre class="pivot-echart-error-text"></pre>
        </div>
    `;
}

function renderAgentStructuredOutput(value, label = '') {
    const payload = unwrapAgentStructuredPayload(value);
    if (!payload) return '';
    let body = '';
    if (isAgentPivotChartSpec(payload)) {
        body = renderAgentPivotChartBlock(payload);
    } else if (payload && typeof payload === 'object') {
        const type = String(payload.type || '');
        const markdown = String(payload.markdown || '').trim();
        if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) {
            body = renderMarkdown(markdown);
        }
    }
    if (!body) return '';
    return `
        <div class="agent-structured-output">
            ${label ? `<div class="agent-structured-output-title">${agentEscape(label)}</div>` : ''}
            <div class="agent-structured-output-body">${body}</div>
        </div>
    `;
}
