const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const TEMPLATE_RE = /\{\{\s*[^{}]+\s*\}\}/;

function cloneSchema(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try {
        const text = JSON.stringify(value);
        if (text.length > 50000) return {};
        return JSON.parse(text);
    } catch (e) {
        return {};
    }
}

function normalizeJsonSchema(value) {
    if (typeof value === 'string') {
        try {
            return cloneSchema(JSON.parse(value));
        } catch (e) {
            return {};
        }
    }
    return cloneSchema(value);
}

function schemaHasRules(schema) {
    return Boolean(schema && typeof schema === 'object' && !Array.isArray(schema) && Object.keys(schema).length);
}

function schemaTypes(schema = {}) {
    const raw = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
    return raw.map(item => String(item || '').trim()).filter(Boolean);
}

function validateJsonSchemaDefinition(schema, path = '契约', issues = [], depth = 0) {
    if (!schemaHasRules(schema)) return issues;
    if (depth > 12) {
        issues.push(`${path} 层级过深，最多支持 12 层。`);
        return issues;
    }
    const types = schemaTypes(schema);
    types.filter(type => !JSON_SCHEMA_TYPES.has(type)).forEach(type => issues.push(`${path}.type 不支持 ${type}。`));
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(item => typeof item !== 'string'))) {
        issues.push(`${path}.required 必须是字段名数组。`);
    }
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
        issues.push(`${path}.properties 必须是对象。`);
    } else if (schema.properties) {
        Object.entries(schema.properties).forEach(([key, child]) => {
            if (!child || typeof child !== 'object' || Array.isArray(child)) issues.push(`${path}.properties.${key} 必须是对象。`);
            else validateJsonSchemaDefinition(child, `${path}.properties.${key}`, issues, depth + 1);
        });
    }
    if (schema.items !== undefined) {
        if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) issues.push(`${path}.items 必须是对象。`);
        else validateJsonSchemaDefinition(schema.items, `${path}.items`, issues, depth + 1);
    }
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) issues.push(`${path}.enum 必须是数组。`);
    if (schema.pattern !== undefined) {
        try { new RegExp(schema.pattern); } catch (e) { issues.push(`${path}.pattern 不是有效的正则表达式。`); }
    }
    return issues;
}

function valueMatchesType(value, type) {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function readableType(types = []) {
    const labels = { object: '对象', array: '数组', string: '文本', number: '数值', integer: '整数', boolean: '布尔值', null: '空值' };
    return types.map(type => labels[type] || type).join('或');
}

function validateValueAgainstSchema(value, schema, options = {}, path = '值', issues = [], depth = 0) {
    if (!schemaHasRules(schema) || depth > 16 || issues.length >= 30) return issues;
    if (options.allowTemplates && typeof value === 'string' && TEMPLATE_RE.test(value)) return issues;
    if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
        issues.push(`${path} 不在允许值范围内。`);
        return issues;
    }
    const types = schemaTypes(schema);
    if (types.length && !types.some(type => valueMatchesType(value, type))) {
        issues.push(`${path} 应为${readableType(types)}。`);
        return issues;
    }
    if (typeof value === 'string') {
        if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) issues.push(`${path} 长度不能少于 ${schema.minLength}。`);
        if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) issues.push(`${path} 长度不能超过 ${schema.maxLength}。`);
        if (schema.pattern) {
            try { if (!new RegExp(schema.pattern).test(value)) issues.push(`${path} 格式不符合约束。`); } catch (e) {}
        }
    }
    if (typeof value === 'number') {
        if (Number.isFinite(Number(schema.minimum)) && value < Number(schema.minimum)) issues.push(`${path} 不能小于 ${schema.minimum}。`);
        if (Number.isFinite(Number(schema.maximum)) && value > Number(schema.maximum)) issues.push(`${path} 不能大于 ${schema.maximum}。`);
    }
    if (Array.isArray(value)) {
        if (Number.isFinite(Number(schema.minItems)) && value.length < Number(schema.minItems)) issues.push(`${path} 至少需要 ${schema.minItems} 项。`);
        if (Number.isFinite(Number(schema.maxItems)) && value.length > Number(schema.maxItems)) issues.push(`${path} 最多允许 ${schema.maxItems} 项。`);
        if (schema.items && typeof schema.items === 'object') {
            value.slice(0, 100).forEach((item, index) => validateValueAgainstSchema(item, schema.items, options, `${path}[${index}]`, issues, depth + 1));
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const required = Array.isArray(schema.required) ? schema.required : [];
        required.forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === '') issues.push(`${path}.${key} 为必填项。`);
        });
        if (schema.properties && typeof schema.properties === 'object') {
            Object.entries(schema.properties).forEach(([key, child]) => {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    validateValueAgainstSchema(value[key], child, options, `${path}.${key}`, issues, depth + 1);
                }
            });
        }
        if (schema.additionalProperties === false && schema.properties && typeof schema.properties === 'object') {
            Object.keys(value).filter(key => !Object.prototype.hasOwnProperty.call(schema.properties, key)).forEach(key => issues.push(`${path}.${key} 不是契约允许的字段。`));
        }
    }
    return issues;
}

function outputValueForContract(output, node = {}) {
    if (!output || typeof output !== 'object') return output;
    if (output.structuredContent !== undefined) return output.structuredContent;
    if (String(node.tool || '') === 'agent.llm') {
        const format = String(node.input?.responseFormat || node.input?.response_format || 'markdown');
        if (format === 'json' && typeof output.content === 'string') {
            try { return JSON.parse(output.content); } catch (e) { return output.content; }
        }
        if (typeof output.content === 'string') return output.content;
    }
    return output;
}

function summarizeSchema(schema = {}) {
    if (!schemaHasRules(schema)) return { configured: false, type: '', required: [], fieldCount: 0 };
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return {
        configured: true,
        type: schemaTypes(schema).join('|') || 'any',
        required: Array.isArray(schema.required) ? schema.required.slice(0, 30) : [],
        fieldCount: Object.keys(properties).length
    };
}

function inspectDagContracts(dag = {}, toolList = []) {
    const tools = new Map((toolList || []).map(tool => [String(tool.name || tool.fullName || ''), tool]));
    const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
    const results = nodes.map(node => {
        const tool = tools.get(String(node.tool || ''));
        const explicitInputSchema = normalizeJsonSchema(node.inputSchema || node.input_schema || {});
        const inputSchema = schemaHasRules(explicitInputSchema)
            ? explicitInputSchema
            : normalizeJsonSchema(tool?.input_schema || tool?.inputSchema || tool?.parameters || {});
        const outputSchema = normalizeJsonSchema(node.outputSchema || node.output_schema || {});
        const blockers = [];
        const warnings = [];
        if (!tool) blockers.push(`${node.title || node.id} 使用的工具不可用：${node.tool || '-'}。`);
        validateJsonSchemaDefinition(inputSchema, `${node.title || node.id} 输入契约`, blockers);
        validateJsonSchemaDefinition(outputSchema, `${node.title || node.id} 输出契约`, blockers);
        if (schemaHasRules(inputSchema)) {
            validateValueAgainstSchema(node.input || {}, inputSchema, { allowTemplates: true }, `${node.title || node.id} 输入`, blockers);
        } else {
            warnings.push(`${node.title || node.id} 没有可识别的输入契约。`);
        }
        if (!schemaHasRules(outputSchema)) warnings.push(`${node.title || node.id} 尚未配置输出契约，下游变量只能在运行时发现。`);
        return {
            id: node.id,
            title: node.title || node.id,
            tool: node.tool,
            input: summarizeSchema(inputSchema),
            output: summarizeSchema(outputSchema),
            blockers,
            warnings,
            status: blockers.length ? 'blocked' : (warnings.length ? 'warning' : 'ready')
        };
    });
    return {
        nodes: results,
        blockers: results.flatMap(item => item.blockers),
        warnings: results.flatMap(item => item.warnings),
        summary: {
            nodeCount: results.length,
            readyNodeCount: results.filter(item => item.status === 'ready').length,
            inputContractCount: results.filter(item => item.input.configured).length,
            outputContractCount: results.filter(item => item.output.configured).length
        }
    };
}

module.exports = {
    inspectDagContracts,
    normalizeJsonSchema,
    outputValueForContract,
    schemaHasRules,
    summarizeSchema,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
};
