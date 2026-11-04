'use strict';

const FAILURES = Object.freeze({
    KNOWLEDGE_SCOPE_DENIED: ['knowledge', 'blocked', '所选资料不可用或不在任务范围内，请重新选择。'],
    KNOWLEDGE_RETRIEVAL_UNAVAILABLE: ['knowledge', 'failed', '资料检索服务暂不可用，请稍后重试。'],
    KNOWLEDGE_SOURCE_UNAVAILABLE: ['knowledge', 'blocked', '资料来源已变化或不可访问，请重新选择资料并运行检索。'],
    AGENT_NO_PROGRESS: ['execution', 'waiting_user', '连续多轮没有新的资料或执行结果，请补充要求或检查工具。'],
    AGENT_BUDGET_PERSIST_FAILED: ['execution', 'blocked', '累计用量保存失败，请检查存储后重试。'],
    TOOL_DISCOVERY_NO_PROGRESS: ['discovery', 'waiting_user', '当前任务未找到所需工具，请重新选择工具或调整目标。'],
    TOOL_NOT_AVAILABLE: ['discovery', 'blocked', '所选工具当前不可用，请刷新工具目录。'],
    TOOL_INPUT_INVALID: ['input', 'failed', '工具参数不符合要求，本次尚未执行，请依据契约修正后重试。'],
    AGENT_POLICY_DENIED: ['authorization', 'blocked', '本次调用不符合任务授权范围，请查看权限与审批要求。'],
    TOOL_POLICY_DENIED: ['authorization', 'blocked', '本次调用不符合任务授权范围，请查看权限与审批要求。'],
    AGENT_APPROVAL_REQUIRED: ['approval', 'waiting_user', '需要确认操作后才能执行。'],
    AGENT_APPROVAL_EXPIRED: ['approval', 'blocked', '操作授权已过期，请重新确认。'],
    AGENT_APPROVAL_STALE: ['approval', 'blocked', '工具版本、目标或授权已变化，请重新确认本次操作。'],
    AGENT_DISCOVERY_SCOPE_REVOKED: ['authorization', 'blocked', '任务授权来源已撤回或任务已暂停，请核对范围后继续。'],
    MCP_NETWORK_POLICY_DENIED: ['network', 'blocked', '连接目标未通过网络策略检查，请联系管理员检查登记地址与允许范围。'],
    MCP_TOOL_EXECUTION_ERROR: ['execution', 'failed', '工具服务返回业务错误，请核对输入和服务状态。'],
    TOOL_OUTPUT_INVALID: ['output', 'failed', '工具返回内容不符合结果契约，尚未完成交付。'],
    TOOL_ARTIFACT_MATERIALIZATION_FAILED: ['delivery', 'failed', '工具已返回结果，但文件登记或渲染失败；请检查结果文件。']
});

function failureStage(error = {}) {
    const code = Object.hasOwn(FAILURES, error.code) ? error.code : 'TOOL_EXECUTION_FAILED';
    const [stage, status, message] = FAILURES[code] || ['execution', 'failed', '操作未完成，请查看任务详情。'];
    return { stage, status, reasonCode: code, message };
}

function resultStage(output) {
    if (output?.knowledgeSourceVersion === 1) return { stage: 'knowledge', status: output.retrieval?.status || 'blocked', reasonCode: output.retrieval?.reasonCode || 'KNOWLEDGE_NO_RELIABLE_MATCH',
        message: output.matches?.length ? '已获得可引用片段，尚不代表资料全文覆盖。' : '未获得可靠资料，本次检索不能提供回答依据。' };
    if (output?.artifactId && output?.renditionId) return { stage: 'delivery', status: 'succeeded', reasonCode: 'ARTIFACT_REGISTERED', message: '文件已生成，内容核验及预览状态需分别确认。' };
    return { stage: 'execution', status: 'succeeded', reasonCode: 'TOOL_EXECUTED', message: '工具调用完成。' };
}

module.exports = { failureStage, resultStage };
