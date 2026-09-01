/** 技能/交付治理的上线观测快照，供管理员在 PEP shadow 观察期评审。 */
const { getAgentGovernanceMetricsSnapshot } = require('./agent-governance-metrics');
const { isShadowMode } = require('./agent-policy');
const { listRendererStatus } = require('./document-rendering');

function getAgentGovernanceStatus(env = process.env) {
    const shadow = isShadowMode(env);
    return {
        pep: {
            mode: shadow ? 'shadow' : 'enforce',
            recommendation: shadow
                ? '请持续观察 shadowDenyTotal 与 legacyUnrestrictedHitTotal；连续 1–2 周无异常后再切换 enforce。'
                : '默认拒绝已生效；如需评估历史技能影响，可临时切换 shadow 并观察 1–2 周。'
        },
        renderers: listRendererStatus(),
        metrics: getAgentGovernanceMetricsSnapshot()
    };
}

module.exports = { getAgentGovernanceStatus };
