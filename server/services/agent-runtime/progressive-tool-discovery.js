'use strict';

const {
    buildProgressivePlannerToolList,
    createToolDiscoveryState,
    plannerToolNames
} = require('../agent-tool-progressive-discovery');

function prepareProgressiveToolDiscovery(toolList = []) {
    if (!toolList.length) throw new Error('没有可用工具符合当前任务配置。');
    const plannerToolList = buildProgressivePlannerToolList(toolList);
    const names = new Set(plannerToolList.map(tool => String(tool.name || '')));
    if (!['tools.search', 'tools.describe', 'tools.execute'].every(name => names.has(name))) {
        throw new Error('工具渐进式发现元工具不可用，无法安全启动 Agent。');
    }
    return {
        plannerToolList,
        toolDiscoveryState: createToolDiscoveryState(),
        plannerToolNames: plannerToolNames(plannerToolList)
    };
}

module.exports = { prepareProgressiveToolDiscovery };
