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
                base: 'delegate', title: '委派智能体', svgIcon: 'users', theme: 'delegate',
                desc: '调用独立专家并返回结果与结构化交接', toolName: 'agent.delegate',
                getInput: ({ selectedNode }) => ({
                    agentName: '领域专家', role: '分析专家', model: typeof defaultWorkflowModelId === 'function' ? defaultWorkflowModelId() : '',
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
                desc: '在沙箱中执行 JS，对数据做转换或计算', toolName: 'agent.code',
                getInput: ({ selectedNode }) => ({
                    code: '// vars 保存下方配置的变量\nreturn vars.input;',
                    vars: { input: selectedNode ? `{{nodes.${selectedNode.id}.output}}` : '{{goal}}' }
                }),
                outputSchema: { type: 'object', properties: { output: {}, text: { type: 'string' }, type: { type: 'string' } } }
            },
            {
                base: 'foreach', title: '循环 / 批处理', svgIcon: 'repeat', theme: 'loop',
                desc: '逐项执行安全 JS 转换，并汇总结果', toolName: 'workflow.foreach',
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
                input: { durationMs: 1000, reason: '' },
                outputSchema: { type: 'object', required: ['durationMs'], properties: { durationMs: { type: 'integer' }, completedAt: { type: 'string' } } }
            }
        ]
    },
    {
        group: '集成与数据',
        items: [
            {
                base: 'http', title: '网络请求', svgIcon: 'globe', theme: 'http',
                desc: '调用外部服务接口，支持安全凭据引用和节点测试', toolName: 'agent.http',
                input: { url: '', method: 'GET', headers: {}, credentialSecret: '', credentialHeader: 'Authorization', credentialPrefix: 'Bearer ', body: null, timeoutMs: 10000 },
                outputSchema: { type: 'object', properties: { statusCode: { type: 'integer' }, ok: { type: 'boolean' }, data: {}, text: { type: 'string' } } }
            },
            {
                base: 'merge', title: '变量聚合', iconText: '+', theme: 'merge',
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
                base: 'data', title: '数据查询', svgIcon: 'database', theme: 'db',
                desc: '选择数据库连接、字段和只读筛选条件', patterns: ['db.run_readonly_query', 'db.list_tables'],
                unavailableReason: '请先在工具库配置可用数据库连接', input: {}
            },
            {
                base: 'file', title: '文件 / 文档解析', svgIcon: 'file-text', theme: 'file',
                desc: '读取报表摘要或提取文档结构', patterns: ['reports.read_file_summary', 'doc.extract_outline', 'doc.extract_key_values'],
                unavailableReason: '请先启用报表或文档处理工具', input: {}
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

function resolvePresetTool(preset, tools = []) {
    const list = Array.isArray(tools) ? tools : [];
    if (preset?.toolName) return list.find(tool => toolValue(tool) === preset.toolName) || null;
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
