/* 场景模板使用真实节点；展示样例与实际执行入口明确区分。 */
(function () {
    const templates = [
        { id: 'knowledge', name: '资料问答', description: '从自己的材料中查找依据，生成可复核的回答。', needs: '资料内容、已授权文本模型', example: '示例：制度规定了申请条件、办理材料和审批路径。',
            nodes: [
                { id: 'material', title: '准备资料', tool: 'workflow.input', input: { name: 'material', label: '资料内容', type: 'text', required: true, defaultValue: '示例制度：申请人提交申请表，经部门负责人确认后办理。' } },
                { id: 'answer', title: '根据资料回答', tool: 'agent.llm', input: { model: '', prompt: '只依据以下材料说明办理流程，缺少依据时说明。\n{{inputs.material}}' }, dependsOn: ['material'] },
                { id: 'result', title: '交付回答', tool: 'workflow.output', input: { name: 'answer', value: '{{nodes.answer.output.text}}' }, dependsOn: ['answer'] }
            ] },
        { id: 'table', name: '表格分析', description: '输入记录列表，先汇总，再形成可阅读的分析。', needs: '记录列表、已授权文本模型', example: '示例：华东 1280 元，华南 650 元；合计 1930 元。',
            nodes: [
                { id: 'rows', title: '准备业务记录', tool: 'workflow.input', input: { name: 'rows', label: '业务记录', type: 'array', required: true, defaultValue: [{ region: '华东', amount: 1280 }, { region: '华南', amount: 650 }] } },
                { id: 'analysis', title: '分析记录', tool: 'agent.llm', input: { model: '', prompt: '比较以下记录，核对合计并列出异常；说明分析范围。\n{{inputs.rows}}' }, dependsOn: ['rows'] },
                { id: 'report', title: '交付分析报告', tool: 'workflow.output', input: { name: 'report', value: '{{nodes.analysis.output.text}}' }, dependsOn: ['analysis'] }
            ] },
        { id: 'review', name: '批量内容检查', description: '检查多条内容，保留原文并汇总需要修正的项目。', needs: '记录列表、已授权文本模型', example: '示例：第 2 条缺少日期，请核对后补充。',
            nodes: [
                { id: 'items', title: '准备待检查记录', tool: 'workflow.input', input: { name: 'items', label: '待检查内容', type: 'array', required: true, defaultValue: [{ text: '10月20日提交报告。' }, { text: '请于指定日期办理。' }] } },
                { id: 'check', title: '逐条复核内容', tool: 'agent.content_review', input: { model: '', records: '{{inputs.items}}', contentField: 'text', instructions: '逐条检查内容的完整性与清晰度，保留原文并给出可核对的修正建议。', reportTitle: '批量内容检查报告' }, dependsOn: ['items'] },
                { id: 'output', title: '交付检查清单', tool: 'workflow.output', input: { name: 'review', value: '{{nodes.check.output.text}}' }, dependsOn: ['check'] }
            ] }
    ];
    const instantiate = (id, modelId = '') => {
        const template = templates.find(item => item.id === id);
        if (!template) return null;
        const spec = JSON.parse(JSON.stringify({ nodes: template.nodes }));
        spec.nodes.forEach(node => { if (['agent.llm', 'agent.content_review'].includes(node.tool)) node.input.model = String(modelId); });
        return { name: template.name, description: template.description, spec };
    };
    window.Pivot.registerModule('agent.workflowTemplates', { templates, instantiate });
})();
