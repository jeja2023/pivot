/* 流程表达式与执行定义的共用语义；视图和服务端使用同一套引用规则。 */
(function () {
    function stable(value) {
        if (value === undefined) return 'null';
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    function executionSpec(spec = {}) {
        const { layout: _layout, groups: _groups, ...rest } = spec;
        return { ...rest, nodes: (spec.nodes || []).map(node => {
            const { _x, _y, ui: _ui, title: _title, ...execution } = node;
            return execution;
        }) };
    }
    function references(value, path = '', result = []) {
        if (typeof value === 'string') {
            for (const match of value.matchAll(/(?<!\\)\{\{\s*([^{}]+?)\s*\}\}/g)) {
                const expression = match[1].trim();
                result.push({ path, expression, nodeId: /^\??(?:nodes|node)\.([\w-]+)(?:\.|$)/.exec(expression)?.[1] || '' });
            }
        } else if (Array.isArray(value)) value.forEach((item, index) => references(item, `${path}.${index}`, result));
        else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => references(item, path ? `${path}.${key}` : key, result));
        return result;
    }
    function rewrite(value, mapping) {
        if (typeof value === 'string') return value.replace(/(?<!\\)\{\{\s*([^{}]+?)\s*\}\}/g, (raw, expression) => {
            return raw.replace(expression, expression.replace(/^(\??nodes?)\.([\w-]+)(?=\.|\s*\?\?|$)/, (all, prefix, id) => mapping.get(id) ? `${prefix}.${mapping.get(id)}` : all));
        });
        if (Array.isArray(value)) return value.map(item => rewrite(item, mapping));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, mapping)]));
        return value;
    }
    function cloneSelection(nodes, mapping) {
        return nodes.map(node => {
            const cloned = JSON.parse(JSON.stringify(node));
            cloned.id = mapping.get(node.id);
            cloned.title = `${node.title || node.id} 副本`.slice(0, 120);
            cloned.dependsOn = (node.dependsOn || []).map(id => mapping.get(id) || id);
            cloned.input = rewrite(node.input || {}, mapping);
            if (node.when?.source) cloned.when.source = rewrite(`{{${node.when.source}}}`, mapping).slice(2, -2);
            cloned._x = Number(node._x || 0) + 40;
            cloned._y = Number(node._y || 0) + 40;
            return cloned;
        });
    }
    function inspectReferences(spec = {}, tools = []) {
        const issues = [];
        for (const node of spec.nodes || []) {
            for (const reference of references(node.input || {})) {
                if (reference.expression.startsWith('?') || reference.expression.includes('??')) continue;
                const source = reference.expression.split('??')[0].trim().replace(/^\?/, '');
                const match = /^(?:nodes?)\.([\w-]+)\.output\.(.+)$/.exec(source);
                if (!match) continue;
                const upstream = (spec.nodes || []).find(item => item.id === match[1]);
                if (!upstream) { issues.push({ ...reference, nodeId: node.id, message: `「${node.title || node.id}」引用的步骤“${match[1]}”已不存在。` }); continue; }
                const tool = tools.find(item => (item.fullName || item.name) === upstream.tool);
                let schema = Object.keys(upstream.outputSchema || {}).length ? upstream.outputSchema : tool?.output_schema || tool?.outputSchema;
                for (const segment of match[2].split('.')) {
                    if (!schema || !Object.keys(schema).length) break;
                    if (schema.type === 'array' && /^\d+$/.test(segment)) { schema = schema.items; continue; }
                    if (!schema.properties) break;
                    if (!Object.hasOwn(schema.properties, segment)) {
                        issues.push({ ...reference, nodeId: node.id, message: `「${node.title || node.id}」的“${reference.path}”引用了“${upstream.title || upstream.id}”中不存在的字段“${segment}”。` }); break;
                    }
                    schema = schema.properties[segment];
                }
            }
        }
        return issues;
    }
    const api = { stable, executionSpec, references, rewrite, cloneSelection, inspectReferences };
    if (typeof window !== 'undefined') window.Pivot?.registerModule('agent.dagDefinition', api);
    if (typeof module !== 'undefined') module.exports = api;
})();
