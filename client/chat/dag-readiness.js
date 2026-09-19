/* DAG 可运行性检查：把工具契约中的必填项转为编辑期、可定位的反馈。 */

function dagReadinessToolName(tool = {}) {
    return String(tool?.fullName || tool?.full_name || tool?.name || '').trim().replace(/^mcp\.[^.]+\./i, '');
}

function dagReadinessSchema(tool = {}) {
    const schema = tool?.input_schema || tool?.inputSchema || tool?.parameters || {};
    return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
}

function dagReadinessValueMissing(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return !value.trim();
    return Array.isArray(value) && value.length === 0;
}

function dagReadinessInputValue(input = {}, field = '') {
    const raw = String(field || '');
    const snake = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const camel = snake.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase());
    for (const key of [raw, snake, camel]) {
        if (Object.hasOwn(input, key)) return input[key];
    }
    return undefined;
}

function dagReadinessExactTemplate(value) {
    return typeof value === 'string' && /^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/.test(value);
}

function dagReadinessFieldLabel(field = '') {
    const labels = {
        bindingId: '渠道绑定', body: '通知正文', code: '处理代码', compareTo: '比较值', credentialSecret: '受控凭据',
        groupBy: '分组字段', model: '节点模型', path: '报表文件', prompt: '提示词', rows: '数据行',
        target: '操作目标', template: '文本模板', value: '待判断的值', valueField: '指标字段',
        workflowId: '目标工作流', name: '参数名', items: '批处理条目', url: '访问地址', fileRef: '文件引用'
    };
    return labels[field] || String(field || '参数');
}

function dagReadinessIssue(issues, node, field, message, type = 'invalid_input') {
    if (issues.some(issue => issue.nodeId === String(node?.id || '') && issue.field === String(field || '') && issue.type === type)) return;
    issues.push({
        type,
        severity: 'error',
        nodeId: String(node?.id || ''),
        field: String(field || ''),
        message: `节点「${node?.title || node?.id || '未命名节点'}」${message}`
    });
}

function dagReadinessValidateSchemaValue(issues, node, field, schema, value) {
    if (dagReadinessValueMissing(value) || dagReadinessExactTemplate(value)) return;
    if (Array.isArray(schema?.enum) && schema.enum.length && !schema.enum.some(option => String(option) === String(value))) {
        dagReadinessIssue(issues, node, field, `的“${dagReadinessFieldLabel(field)}”取值不受支持。`, 'unsupported_enum_value');
        return;
    }
    if ((schema?.type === 'integer' || schema?.type === 'number') && typeof value !== 'number') {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            dagReadinessIssue(issues, node, field, `的“${dagReadinessFieldLabel(field)}”必须是数字。`, 'invalid_number');
            return;
        }
        value = numeric;
    }
    if (typeof value === 'number') {
        if (Number.isFinite(Number(schema?.minimum)) && value < Number(schema.minimum)) {
            dagReadinessIssue(issues, node, field, `的“${dagReadinessFieldLabel(field)}”不能小于 ${schema.minimum}。`, 'number_too_small');
        }
        if (Number.isFinite(Number(schema?.maximum)) && value > Number(schema.maximum)) {
            dagReadinessIssue(issues, node, field, `的“${dagReadinessFieldLabel(field)}”不能大于 ${schema.maximum}。`, 'number_too_large');
        }
    }
    if (Array.isArray(value)) {
        if (Number.isFinite(Number(schema?.minItems)) && value.length < Number(schema.minItems)) {
            dagReadinessIssue(issues, node, field, `至少需要 ${schema.minItems} 个“${dagReadinessFieldLabel(field)}”。`, 'array_too_short');
        }
        if (Number.isFinite(Number(schema?.maxItems)) && value.length > Number(schema.maxItems)) {
            dagReadinessIssue(issues, node, field, `最多支持 ${schema.maxItems} 个“${dagReadinessFieldLabel(field)}”。`, 'array_too_long');
        }
    }
}

function dagReadinessValidateSemantics(issues, node, nodeName, input) {
    const get = field => dagReadinessInputValue(input, field);
    if (nodeName === 'workflow.input') {
        const name = String(get('name') || '').trim();
        if (name && !/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) {
            dagReadinessIssue(issues, node, 'name', '的参数名只能使用字母、数字、下划线和短横线，且不能以数字开头。', 'invalid_workflow_input_name');
        }
    }
    if (nodeName === 'data.group_summary' || nodeName === 'data.aggregate') {
        const metrics = Array.isArray(get('metrics'))
            ? get('metrics').filter(item => item && typeof item === 'object' && !Array.isArray(item))
            : [];
        metrics.forEach((metric, index) => {
            const aggregation = String(metric.aggregation || 'count').toLowerCase();
            const field = String(metric.field || metric.valueField || '').trim();
            if (['sum', 'avg', 'min', 'max'].includes(aggregation) && !field) {
                dagReadinessIssue(issues, node, 'metrics', `第 ${index + 1} 个统计指标使用“${aggregation}”时需要指定指标字段。`, 'missing_metric_field');
            }
        });
        if (nodeName === 'data.aggregate') return;
        const groupBy = (Array.isArray(get('groupBy')) ? get('groupBy') : [get('groupBy')])
            .flatMap(value => typeof value === 'string' ? value.split(',') : [value])
            .map(value => String(value || '').trim())
            .filter(Boolean);
        if (!groupBy.length && !issues.some(issue => issue.nodeId === String(node?.id || '') && issue.field === 'groupBy')) {
            dagReadinessIssue(issues, node, 'groupBy', '至少需要选择一个分组字段。', 'missing_group_fields');
        }
        const aggregation = String(get('aggregation') || 'count').toLowerCase();
        if (!metrics.length && ['sum', 'avg', 'min', 'max'].includes(aggregation) && dagReadinessValueMissing(get('valueField'))) {
            dagReadinessIssue(issues, node, 'valueField', `选择“${aggregation}”聚合方式时需要指定指标字段。`, 'missing_aggregation_field');
        }
    }
    if (nodeName === 'workflow.condition') {
        if (dagReadinessValueMissing(get('value'))) dagReadinessIssue(issues, node, 'value', '需要指定待判断的值，通常选择上游输出或运行输入。', 'missing_condition_value');
        const operator = String(get('operator') || 'not_empty');
        if (['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than'].includes(operator) && dagReadinessValueMissing(get('compareTo'))) {
            dagReadinessIssue(issues, node, 'compareTo', `使用“${operator}”判断方式时需要填写比较值。`, 'missing_condition_compare_to');
        }
    }
    if ((nodeName === 'agent.browser' || nodeName === 'browser.click') && String(get('action') || 'inspect') === 'click' && dagReadinessValueMissing(get('target'))) {
        dagReadinessIssue(issues, node, 'target', '执行点击操作时需要配置页面目标。', 'missing_browser_target');
    }
    if (nodeName === 'workflow.subworkflow') {
        const workflowId = Number(get('workflowId'));
        if (Number.isFinite(workflowId) && workflowId <= 0) dagReadinessIssue(issues, node, 'workflowId', '的目标工作流必须是有效的已发布工作流。', 'invalid_subworkflow_id');
    }
    if (nodeName === 'workflow.iteration') {
        const workflowId = Number(get('workflowId'));
        if (!Number.isFinite(workflowId) || workflowId <= 0) dagReadinessIssue(issues, node, 'workflowId', '逐项调用子工作流需要选择有效的已发布工作流。', 'invalid_iteration_workflow_id');
        if (dagReadinessValueMissing(get('items'))) dagReadinessIssue(issues, node, 'items', '逐项调用子工作流需要指定数组输入。', 'missing_iteration_items');
    }
}

function dagReadinessOutputsAreRouteExclusive(first, second, edges = []) {
    const firstId = String(first?.id || '');
    const secondId = String(second?.id || '');
    if (!firstId || !secondId) return false;
    const routesFor = nodeId => (Array.isArray(edges) ? edges : [])
        .filter(edge => String(edge?.to || '') === nodeId)
        .map(edge => ({ from: String(edge?.from || ''), route: String(edge?.route || 'default').toLowerCase() }))
        .filter(edge => edge.from && ['true', 'false'].includes(edge.route));
    const firstRoutes = routesFor(firstId);
    const secondRoutes = routesFor(secondId);
    return firstRoutes.some(left => secondRoutes.some(right => left.from === right.from && left.route !== right.route));
}

function inspectDagReadiness(nodes = [], tools = [], edges = []) {
    const list = Array.isArray(nodes) ? nodes : [];
    const catalog = Array.isArray(tools) ? tools : [];
    const issues = [];
    const declaredInputs = new Map();
    const declaredOutputs = new Map();
    list.forEach(node => {
        const nodeName = dagReadinessToolName({ name: node?.tool });
        const tool = catalog.find(item => {
            const name = dagReadinessToolName(item);
            return name && (String(item?.fullName || item?.name || '') === String(node?.tool || '') || name === nodeName);
        });
        const schema = dagReadinessSchema(tool);
        const input = node?.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input : {};
        const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        (Array.isArray(schema.required) ? schema.required : []).forEach(field => {
            if (!dagReadinessValueMissing(dagReadinessInputValue(input, field)) || properties[field]?.default !== undefined) return;
            dagReadinessIssue(issues, node, field, `缺少必填参数：“${dagReadinessFieldLabel(field)}”。`, 'missing_required_input');
        });
        Object.entries(properties).forEach(([field, fieldSchema]) => {
            dagReadinessValidateSchemaValue(issues, node, field, fieldSchema, dagReadinessInputValue(input, field));
        });
        dagReadinessValidateSemantics(issues, node, nodeName, input);
        if (nodeName === 'workflow.input') {
            const name = String(input.name || '').trim();
            if (!name || !/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) return;
            const prior = declaredInputs.get(name);
            if (prior) {
                issues.push({
                    type: 'duplicate_workflow_input',
                    severity: 'error',
                    nodeId: String(node?.id || ''),
                    field: 'name',
                    message: `运行参数“${name}”已由节点「${prior.title || prior.id}」声明。`
                });
                return;
            }
            declaredInputs.set(name, node);
        }
        if (nodeName === 'workflow.output') {
            const name = String(dagReadinessInputValue(input, 'name') || properties.name?.default || 'result').trim();
            if (!name) return;
            const prior = declaredOutputs.get(name);
            if (prior && !dagReadinessOutputsAreRouteExclusive(prior, node, edges)) {
                issues.push({
                    type: 'duplicate_workflow_output',
                    severity: 'error',
                    nodeId: String(node?.id || ''),
                    field: 'name',
                    message: `交付名称“${name}”已由节点「${prior.title || prior.id}」使用；请为每个工作流输出设置不同名称。`
                });
                return;
            }
            declaredOutputs.set(name, node);
        }
    });
    return { valid: issues.length === 0, issues };
}

if (typeof window !== 'undefined' && window.Pivot?.exposeModule) {
    window.Pivot.exposeModule('agent.dagReadiness', { inspectDagReadiness });
}
