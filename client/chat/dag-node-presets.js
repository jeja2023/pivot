/* Workflow node preset registry shared by the toolbar and node library. */
/* global defaultLlmInput, defaultWorkflowModelId */
(function () {
if (window.Pivot.moduleApi('agent.dagNodePresets').groups) return;

const handoffOutputSchema = {
    type: 'object',
    required: ['fromAgent', 'toAgent', 'summary', 'status'],
    properties: {
        fromAgent: { type: 'string' },
        toAgent: { type: 'string' },
        summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        status: { type: 'string' }
    }
};

const NODE_PRESET_GROUPS = [
    {
        group: '输入与输出',
        items: [
            {
                base: 'input', title: '工作流输入', svgIcon: 'log-in', theme: 'input',
                desc: '声明可填写、校验和复用的运行参数', toolName: 'workflow.input',
                input: { name: 'input', label: '输入参数', type: 'text', required: true, defaultValue: '', description: '' },
                outputSchema: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string' }, value: {}, text: { type: 'string' } } }
            },
            {
                base: 'output', title: '工作流输出', svgIcon: 'log-out', theme: 'output',
                desc: '明确指定工作流最终交付结果', toolName: 'workflow.output',
                getInput: ({ selectedNode }) => ({
                    name: 'result',
                    value: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}',
                    format: 'markdown',
                    presentation: 'default'
                }),
                outputSchema: {
                    type: 'object',
                    required: ['name', 'value'],
                    properties: {
                        name: { type: 'string' },
                        value: {},
                        format: { type: 'string' },
                        presentation: { type: 'string' },
                        table: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                columns: { type: 'array', items: { type: 'string' } },
                                rows: { type: 'array', items: { type: 'object' } },
                                rowCount: { type: 'integer' },
                                truncated: { type: 'boolean' }
                            }
                        },
                        file: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                fileId: { type: 'string' },
                                name: { type: 'string' },
                                mimeType: { type: 'string' },
                                size: { type: 'number' },
                                url: { type: 'string' },
                                downloadUrl: { type: 'string' },
                                path: { type: 'string' },
                                storageKey: { type: 'string' }
                            }
                        },
                        text: { type: 'string' }
                    }
                }
            }
        ]
    },
    {
        group: '智能体',
        items: [
            {
                base: 'llm', title: '大模型', svgIcon: 'bot', theme: 'llm',
                desc: '调用大模型分析、生成或改写内容', toolName: 'agent.llm',
                getInput: ({ selectedNode }) => typeof defaultLlmInput === 'function'
                    ? defaultLlmInput(selectedNode || null)
                    : { model: '', prompt: '{{goal}}', responseFormat: 'markdown', temperature: 0.2, maxTokens: 1200 },
                outputSchema: { type: 'string' }
            },
            {
                base: 'content_review', title: '富文本内容校对', svgIcon: 'file-check', theme: 'llm',
                desc: '清洗数据库富文本，按模型上下文逐条校对并生成报告', toolName: 'agent.content_review',
                getInput: ({ selectedNode }) => ({
                    records: selectedNode ? `{{nodes.${selectedNode.id}.output.structuredContent}}` : [],
                    model: typeof defaultWorkflowModelId === 'function' ? defaultWorkflowModelId() : '',
                    idField: 'id', titleField: 'title', contentField: 'content', instructions: '',
                    maxRecords: 50, chunkTokens: 3000, overlapTokens: 80, maxTokens: 1800, concurrency: 2,
                    maxSummaryChars: 30000, reportTitle: '新闻内容校对报告'
                }),
                outputSchema: {
                    type: 'object', required: ['type', 'status', 'reviewComplete', 'stats', 'records', 'text'],
                    properties: {
                        type: { type: 'string' },
                        status: { type: 'string', enum: ['completed', 'incomplete'] },
                        reviewComplete: { type: 'boolean' },
                        stats: {
                            type: 'object',
                            properties: {
                                sourceRowCount: { type: 'integer' }, processedRecords: { type: 'integer' }, skippedRecords: { type: 'integer' },
                                completedRecords: { type: 'integer' }, passedRecords: { type: 'integer' }, issueRecords: { type: 'integer' },
                                incompleteRecords: { type: 'integer' }, titleIssues: { type: 'integer' }, contentIssues: { type: 'integer' },
                                originalChars: { type: 'integer' }, cleanChars: { type: 'integer' }, modelCallCount: { type: 'integer' },
                                chunkTokens: { type: 'integer' }, overlapTokens: { type: 'integer' }, upstreamPartial: { type: 'boolean' },
                                oversizedRowCount: { type: 'integer' }, inputTruncated: { type: 'boolean' }
                            }
                        },
                        records: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    recordId: {}, title: { type: 'string' }, status: { type: 'string', enum: ['passed', 'issues_found', 'incomplete'] },
                                    reviewComplete: { type: 'boolean' }, titleIssueCount: { type: 'integer' }, contentIssueCount: { type: 'integer' },
                                    chunkCount: { type: 'integer' }, originalChars: { type: 'integer' }, cleanChars: { type: 'integer' },
                                    removedChars: { type: 'integer' }, error: { type: 'string' }, contextAdjusted: { type: 'boolean' },
                                    issues: {
                                        type: 'array', items: {
                                            type: 'object', properties: {
                                                field: { type: 'string' }, category: { type: 'string' }, original: { type: 'string' },
                                                suggestion: { type: 'string' }, context: { type: 'string' }, reason: { type: 'string' },
                                                confidence: { type: 'string' }, chunkIndex: { type: 'integer' }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        artifact: { type: ['object', 'null'], properties: { id: {}, title: { type: 'string' }, type: { type: 'string' } } },
                        warnings: { type: 'array', items: { type: 'string' } },
                        text: { type: 'string' },
                        markdown: { type: 'string' }
                    }
                }
            },
            {
                base: 'delegate', title: '委派智能体', svgIcon: 'users', theme: 'delegate', advanced: true,
                desc: '调用独立专家并返回结果与结构化交接', toolName: 'agent.delegate',
                getInput: ({ selectedNode }) => ({
                    agentName: '领域专家', role: 'analyst', model: typeof defaultWorkflowModelId === 'function' ? defaultWorkflowModelId() : '',
                    task: '{{goal}}',
                    context: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}',
                    responseFormat: 'markdown', temperature: 0.2, maxTokens: 1200
                }),
                outputSchema: { type: 'object', required: ['content', 'agent', 'handoff'], properties: { content: { type: 'string' }, agent: { type: 'object' }, handoff: { type: 'object' } } }
            },
            {
                base: 'handoff', title: '智能体交接', svgIcon: 'shuffle', theme: 'handoff', advanced: true,
                desc: '统一已有结果的交接格式，不调用模型', toolName: 'agent.handoff',
                getInput: ({ selectedNode }) => ({
                    fromAgent: selectedNode?.title || '上游智能体', toAgent: '主管智能体',
                    summary: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '',
                    findings: [], evidence: [], risks: [], openQuestions: [], confidence: 0.7
                }),
                outputSchema: handoffOutputSchema
            }
        ]
    },
    {
        group: '逻辑与流程',
        items: [
            {
                base: 'condition', title: '条件路由', svgIcon: 'git-branch', theme: 'condition',
                desc: '计算路由值，供下游条件分支直接引用', toolName: 'workflow.condition',
                getInput: ({ selectedNode }) => ({ value: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}', operator: 'not_empty', compareTo: '' }),
                outputSchema: { type: 'object', required: ['matched', 'value'], properties: { matched: { type: 'boolean' }, value: {}, route: { type: 'string' } } }
            },
            {
                base: 'approval', title: '人工审批', svgIcon: 'user-check', theme: 'approval',
                desc: '暂停工作流，等待用户批准后继续', toolName: 'workflow.approval',
                getInput: ({ selectedNode }) => ({ title: '请审批本节点', summary: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}', instructions: '' }),
                outputSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, text: { type: 'string' } } }
            },
            {
                base: 'code', title: '代码执行', svgIcon: 'code', theme: 'code',
                advanced: true,
                desc: '需独立受控 Worker 沙箱，服务端不会直接执行 JS', toolName: 'agent.code',
                getInput: ({ selectedNode }) => ({
                    code: '// vars 保存下方配置的变量\nreturn vars.input;',
                    vars: { input: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}' }
                }),
                outputSchema: { type: 'object', properties: { output: {}, text: { type: 'string' }, type: { type: 'string' } } }
            },
            {
                base: 'foreach', title: '循环 / 批处理', svgIcon: 'repeat', theme: 'loop',
                advanced: true,
                desc: '需独立受控 Worker 沙箱，服务端不会直接执行循环代码', toolName: 'workflow.foreach',
                getInput: ({ selectedNode }) => ({ items: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : [], code: 'return item;', concurrency: 4, stopOnError: true }),
                outputSchema: { type: 'object', required: ['items', 'count'], properties: { items: { type: 'array' }, count: { type: 'integer' }, errors: { type: 'array' } } }
            },
            {
                base: 'subworkflow', title: '子工作流', svgIcon: 'workflow', theme: 'subflow',
                desc: '调用另一个已发布工作流并接收其输出', toolName: 'workflow.subworkflow',
                input: { workflowId: '', version: 'published', goal: '{{goal}}', inputs: {} },
                outputSchema: { type: 'object', required: ['workflowId', 'output'], properties: { workflowId: { type: 'integer' }, version: { type: 'integer' }, output: {}, outputs: { type: 'object' }, text: { type: 'string' } } }
            },
            {
                base: 'delay', title: '延时', svgIcon: 'clock', theme: 'delay',
                desc: '等待指定时长后继续执行下游节点', toolName: 'workflow.delay',
                input: { durationMs: 60000, reason: '' },
                outputSchema: { type: 'object', required: ['durationMs'], properties: { durationMs: { type: 'integer' }, completedAt: { type: 'string' } } }
            }
        ]
    },
    {
        group: '集成与数据',
        items: [
            {
                base: 'http', title: '网络请求', svgIcon: 'globe', theme: 'http',
                advanced: true,
                desc: '调用外部服务接口，支持安全凭据引用和节点测试', toolName: 'agent.http',
                input: { url: '', method: 'GET', headers: {}, credentialSecret: '', credentialHeader: 'Authorization', credentialPrefix: 'Bearer ', body: null, timeoutMs: 10000 },
                outputSchema: { type: 'object', properties: { statusCode: { type: 'integer' }, ok: { type: 'boolean' }, data: {}, text: { type: 'string' } } }
            },
            {
                base: 'browser', title: '浏览器自动化', svgIcon: 'globe', theme: 'http', advanced: true,
                desc: '在允许的网站上执行受控查看或点击操作', toolName: 'agent.browser',
                input: { url: '', action: 'inspect', target: {}, screenshot: false }
            },
            {
                base: 'merge', title: '变量聚合', iconText: '+', theme: 'merge',
                advanced: true,
                desc: '把多个上游输出映射为统一对象', toolName: 'agent.merge',
                getInput: ({ selectedNode }) => ({ fields: selectedNode ? { [selectedNode.id]: `{{nodes.${selectedNode.id}.output}}` } : {} }),
                outputSchema: { type: 'object', properties: { merged: { type: 'object' }, keys: { type: 'array' }, count: { type: 'integer' } } }
            },
            {
                base: 'search', title: '知识检索', svgIcon: 'search', theme: 'rag',
                desc: '从知识库按语义检索相关片段', toolName: 'rag.search',
                input: { query: '{{goal}}', topK: 5, candidateLimit: 80 }
            },
            {
                base: 'knowledge_graph', title: '知识关系查询', svgIcon: 'search', theme: 'rag', advanced: true,
                desc: '查询知识库中的实体关系、归属和影响路径', toolName: 'knowledge.graph.query',
                input: { query: '{{goal}}', entityLimit: 6, relationLimit: 12 }
            },
            {
                base: 'session_search', title: '历史会话检索', svgIcon: 'search', theme: 'rag', advanced: true,
                desc: '按关键词查找当前用户的历史会话内容', toolName: 'sessions.search',
                input: { query: '{{goal}}', limit: 8 }
            },
            {
                base: 'data', title: '数据查询', svgIcon: 'database', theme: 'db',
                desc: '选择数据库连接、数据表、字段和筛选条件', patterns: ['db.run_readonly_query'],
                unavailableReason: '请先在工具库配置可用数据库连接', input: {}
            },
            {
                base: 'report_file', title: '读取报表文件', svgIcon: 'file-text', theme: 'file',
                desc: '读取电子表格或 CSV 的工作表、字段和样本行', toolName: 'reports.read_file_summary',
                unavailableReason: '当前没有可用的报表文件读取工具', input: { path: '', sheet: '', sampleRows: 20 }
            },
            {
                base: 'report_query', title: '查询报表数据', svgIcon: 'table', theme: 'file',
                desc: '从电子表格或 CSV 中选择字段、筛选并返回数据行', toolName: 'reports.query_table',
                unavailableReason: '当前没有可用的报表数据查询工具', input: { path: '', columns: [], filters: {}, limit: 100 }
            },
            {
                base: 'document_outline', title: '提取文档大纲', svgIcon: 'file-text', theme: 'file', advanced: true,
                desc: '从长文本中提取标题和层级结构', toolName: 'doc.extract_outline',
                input: { text: '{{goal}}', maxHeadings: 30 }
            },
            {
                base: 'document_values', title: '提取文档信息', svgIcon: 'file-text', theme: 'file', advanced: true,
                desc: '从文档中提取名称、编号等键值信息', toolName: 'doc.extract_key_values',
                input: { text: '{{goal}}', maxItems: 50 }
            },
            {
                base: 'filter_rows', title: '筛选数据行', svgIcon: 'table', theme: 'db', advanced: true,
                desc: '按字段和值筛选上游表格数据', toolName: 'data.filter_rows',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output.rows}}` : [], filters: {}, matchMode: 'exact', limit: 200 })
            },
            {
                base: 'group_summary', title: '数据分组汇总', svgIcon: 'chart', theme: 'db', advanced: true,
                desc: '按字段分组并计算数量、求和或平均值', toolName: 'data.group_summary',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output.rows}}` : [], groupBy: '', valueField: '', aggregation: 'count', limit: 100 })
            },
            {
                base: 'profile_rows', title: '分析表格字段', svgIcon: 'table', theme: 'db', advanced: true,
                desc: '查看字段类型、填写率和样本值，帮助决定后续处理方式', toolName: 'data.profile_rows',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output.rows}}` : [], limit: 500 })
            },
            {
                base: 'normalize_fields', title: '规范表格字段', svgIcon: 'table', theme: 'db', advanced: true,
                desc: '批量重命名字段并清理文本首尾空格', toolName: 'data.normalize_fields',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output.rows}}` : [], renameMap: {}, trimStrings: true, limit: 1000 })
            },
            {
                base: 'compare_reports', title: '对比报表文件', svgIcon: 'file-text', theme: 'file', advanced: true,
                desc: '对比两份报表的工作表、字段和样本数据', toolName: 'reports.compare_files',
                input: { leftPath: '', rightPath: '', sheet: '', sampleRows: 20 }
            },
            {
                base: 'chunk_text', title: '拆分长文本', svgIcon: 'file-text', theme: 'file', advanced: true,
                desc: '按段落拆分长文本，便于后续逐段处理', toolName: 'doc.chunk_text',
                getInput: ({ selectedNode }) => ({ text: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}', maxChars: 3000 })
            }
        ]
    },
    {
        group: '呈现与交付',
        items: [
            {
                base: 'chart', title: '图表生成', svgIcon: 'chart', theme: 'viz',
                desc: '基于上游数据生成可渲染图表', toolName: 'viz.build_chart',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : [], chartType: 'bar', title: '', xAxis: '', yAxis: '', aggregation: 'sum', limit: 100 })
            },
            {
                base: 'table', title: '表格输出', svgIcon: 'table', theme: 'viz',
                desc: '把数据行整理成清晰易读的表格', toolName: 'viz.build_table',
                getInput: ({ selectedNode }) => ({ rows: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : [], columns: [], title: '', limit: 50 })
            },
            {
                base: 'report', title: '报告编排', svgIcon: 'file-text', theme: 'report',
                desc: '聚合章节、摘要和结论生成结构化报告', toolName: 'report.compose',
                getInput: ({ selectedNode }) => ({ title: '工作流报告', summary: '', sections: selectedNode ? { result: `{{nodes.${selectedNode.id}.output}}` } : {}, includeToc: true }),
                outputSchema: { type: 'object', required: ['markdown', 'text'], properties: { markdown: { type: 'string' }, text: { type: 'string' }, sectionCount: { type: 'integer' } } }
            }
        ]
    }
];

function toolValue(tool) {
    return String(tool?.fullName || tool?.name || '').trim();
}

function toolShortValue(tool) {
    return toolValue(tool).replace(/^mcp\.\d+\./, '');
}

function resolvePresetTool(preset, tools = []) {
    const list = Array.isArray(tools) ? tools : [];
    if (preset?.toolName) {
        return list.find(tool => toolValue(tool) === preset.toolName || toolShortValue(tool) === preset.toolName) || null;
    }
    const patterns = Array.isArray(preset?.patterns) ? preset.patterns.map(item => String(item).toLowerCase()) : [];
    if (!patterns.length) return null;
    return list.find(tool => {
        const value = toolValue(tool).toLowerCase();
        const title = String(tool?.title || '').toLowerCase();
        return patterns.some(pattern => value.includes(pattern) || title.includes(pattern));
    }) || null;
}

function presetAvailability(preset, tools = []) {
    const tool = resolvePresetTool(preset, tools);
    return {
        available: Boolean(tool),
        tool,
        reason: tool ? '' : (preset?.unavailableReason || `当前没有可用的“${preset?.title || '节点'}”工具`)
    };
}

function buildPreset(preset, context = {}) {
    const input = typeof preset?.getInput === 'function' ? preset.getInput(context) : (preset?.input || {});
    return {
        base: preset.base,
        title: preset.title,
        toolName: preset.toolName || '',
        patterns: preset.patterns || [],
        input: input && typeof input === 'object' && !Array.isArray(input) ? structuredCloneSafe(input) : {},
        inputSchema: structuredCloneSafe(preset.inputSchema || {}),
        outputSchema: structuredCloneSafe(preset.outputSchema || {})
    };
}

function structuredCloneSafe(value) {
    try {
        return JSON.parse(JSON.stringify(value || {}));
    } catch (e) {
        return {};
    }
}

function allPresets() {
    return NODE_PRESET_GROUPS.flatMap(group => group.items);
}

window.Pivot.exposeModule('agent.dagNodePresets', {
    groups: NODE_PRESET_GROUPS,
    all: allPresets,
    build: buildPreset,
    resolveTool: resolvePresetTool,
    availability: presetAvailability
});
})();
