'use strict';
const acorn = require('acorn');

// 事务只保证传入 executor 的查询，省略参数的回调无法把全局写入纳入回滚。
function findMissingTransactionExecutors(source) {
    const failures = [];
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    function callsGlobalDatabase(node, parameters) {
        if (!node || typeof node !== 'object') return false;
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
            && ['query','queryOne','execute'].includes(node.callee.name) && !parameters.has(node.callee.name)) return true;
        return Object.entries(node).some(([key,value]) => key !== 'loc' && (Array.isArray(value)
            ? value.some(child => callsGlobalDatabase(child,parameters))
            : value && typeof value === 'object' && callsGlobalDatabase(value,parameters)));
    }
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'transaction') {
            const callback = node.arguments[0];
            if (['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)) {
                const parameters = new Set(callback.params.flatMap(param => param.type === 'ObjectPattern'
                    ? param.properties.map(property => property.value?.name) : [param.name]));
                if (!callback.params.length || callsGlobalDatabase(callback.body,parameters)) failures.push(node.loc.start.line);
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(ast);
    return failures;
}

module.exports = { findMissingTransactionExecutors };
