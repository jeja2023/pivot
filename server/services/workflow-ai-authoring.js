/* AI 只生成受目录约束的可撤销草稿，不能执行或发布。 */
const { getRunnableModelForUserAsync } = require('./models');
const { callModelText, recordAgentModelUsage } = require('./agent-model');
const { formatToolList } = require('./agent-tool-catalog');
const { normalizeDagSpec, inspectDagTopology } = require('./agent-validators');
const { inspectDagContracts } = require('./agent-dag-contracts');
const { toolHasSideEffectsOrApproval } = require('./agent-dag-execution-guard');
const { fitMessagesToContextBudget } = require('./context-budget');

async function propose(user, body = {}, deps = {}) {
    const prompt = String(body.prompt || '').trim();
    if (prompt.length < 4 || prompt.length > 6000) throw Object.assign(new Error('请填写 4 至 6000 字的流程目标或修改要求。'), { status: 400 });
    if (Buffer.byteLength(JSON.stringify(body.spec || {})) > 512 * 1024) throw Object.assign(new Error('当前流程内容过大，请先缩小本次需要修改的范围。'), { status: 400 });
    const model = await (deps.getModel || getRunnableModelForUserAsync)(body.modelId, user);
    if (!model) throw Object.assign(new Error('请选择当前账号可用的文本模型。'), { status: 400 });
    const tools = await (deps.tools || formatToolList)(user, { toolPolicy: 'all' });
    const allowed = tools.filter(tool => !toolHasSideEffectsOrApproval(tool)).slice(0, 100);
    const usageRef = {};
    const sanitized = require('./agent-workflows').sanitizeSharedDagSpec(body.spec || { nodes: [] });
    const messages = [
        { role: 'system', content: '你是工作流草稿设计器。只输出 JSON：{name,description,plan,dagSpec:{nodes,edges?}}。节点必须来自给定目录；未知连接和模型保持空值并在计划中说明。不得写凭据、生成发送/写入动作，不运行、不发布。输入输出使用 {{inputs.name}} 和 {{nodes.id.output.field}}，用 dependsOn 表示依赖。保留用户未要求修改的步骤。' },
        { role: 'user', content: JSON.stringify({ request: prompt, current: sanitized, tools: allowed.map(tool => ({ name: tool.name || tool.fullName, title: tool.title, input: tool.input_schema, output: tool.output_schema })) }) }
    ];
    const fitted = fitMessagesToContextBudget(messages, model, { maxOutputTokens: 6000 }).messages;
    const text = await (deps.call || callModelText)(model, fitted, { user, usageRef, maxTokens: 6000, temperature: 0.1 });
    await (deps.record || recordAgentModelUsage)(user, model, fitted, text, 'workflow_authoring', '', { usage: usageRef.usage });
    let candidate;
    try { candidate = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch (_) { throw Object.assign(new Error('模型未返回有效流程草稿，请调整描述后重试；当前内容已保留。'), { status: 422 }); }
    const spec = normalizeDagSpec(candidate.dagSpec || {});
    const names = new Set(allowed.map(tool => tool.name || tool.fullName));
    if (spec.nodes.some(node => !names.has(node.tool))) throw Object.assign(new Error('生成草稿包含未授权或不支持的步骤，请修改要求后重试。'), { status: 422 });
    if (/"(?:password|secret|authorization|api.?key)"\s*:\s*"(?!\{\{)[^"\s]+/i.test(JSON.stringify(spec))) throw Object.assign(new Error('生成草稿包含敏感值，已拒绝应用。'), { status: 422 });
    const topology = inspectDagTopology(spec);
    if (topology.blockers.length) throw Object.assign(new Error(`生成草稿结构需修正：${topology.blockers[0]}`), { status: 422 });
    return { name: String(candidate.name || 'AI 工作流草稿').slice(0, 100), description: String(candidate.description || '').slice(0, 300),
        plan: String(candidate.plan || '检查参数与连接后再试运行。').slice(0, 4000), spec,
        issues: inspectDagContracts(spec, allowed).blockers, source: 'ai_draft', executed: false };
}
module.exports = { propose };
