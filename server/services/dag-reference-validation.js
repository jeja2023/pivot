/* 在工具执行前报告无法求值的数据引用，保留显式可选值和默认值。 */
const { references } = require('../../client/chat/dag-definition');

function parseReference(expression) {
    const [source, ...fallback] = expression.split('??');
    let defaultValue;
    if (fallback.length) {
        try { defaultValue = JSON.parse(fallback.join('??').trim()); }
        catch (_) { throw Object.assign(new Error('变量默认值必须是有效 JSON。'), { code: 'DAG_REFERENCE_DEFAULT_INVALID', status: 400 }); }
    }
    return { source: source.trim().replace(/^\?/, ''), optional: source.trim().startsWith('?'), hasDefault: fallback.length > 0, defaultValue };
}
function assertReferences(node, context, resolve) {
    if (node.tool === 'workflow.template' && ['keep', 'empty'].includes(node.input?.missingVariable)) return;
    const failures = [];
    for (const reference of references(node.input || {})) {
        const parsed = parseReference(reference.expression);
        if (!/^(?:nodes?\.|inputs?\.|run\.|goal$|item\.|itemIndex$|index$)/.test(parsed.source)) continue;
        if (resolve(parsed.source, context) === undefined && !parsed.optional && !parsed.hasDefault) failures.push({ ...reference, nodeId: node.id });
    }
    if (failures.length) throw Object.assign(new Error(`「${node.title || node.id}」的参数“${failures[0].path}”无法读取 ${failures[0].expression}，请重新选择来源字段。`), {
        code: 'DAG_UNRESOLVED_REFERENCE', status: 422, category: 'input', details: { references: failures }
    });
}
module.exports = { parseReference, assertReferences };
