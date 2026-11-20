'use strict';

// 宿主只兼容固定运行包的文档路径。材料和当前项目的文件仍由 read 读取。
const documentPath = /^(?:SKILL\.md|(?:references|workflows|templates|scripts\/docs)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md)$/u;

function normalizeRuntimeReads(actions, state) {
    const approvals = state.review.approvals;
    const project = state.managedProject || approvals?.design?.plan?.project || approvals?.template?.plan?.project;
    return actions.map(action => {
        if (action?.action !== 'read' || typeof action.path !== 'string' || !documentPath.test(action.path)) return action;
        if (project && action.path.startsWith(project + '/')) return action;
        return { ...action, action: 'read_runtime' };
    });
}

module.exports = { normalizeRuntimeReads };
