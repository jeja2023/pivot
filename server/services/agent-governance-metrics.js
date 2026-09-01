/**
 * server/services/agent-governance-metrics.js
 * 技能治理、文档渲染与产物交付的轻量内存指标计数器
 *
 * 对应落地方案 v1.2 §8.2 的必报指标。本模块保持为无业务依赖的叶子节点，
 * 由 server/metrics.js 在渲染 Prometheus 文本时读取快照，避免形成循环依赖。
 * 计数器只在进程内累积，重启归零；用于告警与趋势观察，权威审计仍在数据库事件表。
 */

const MAX_LABEL_CARDINALITY = 60;

function createLabeledCounter() {
    return new Map();
}

const state = {
    pepDenyTotal: createLabeledCounter(),
    pepShadowDenyTotal: createLabeledCounter(),
    pepLegacyUnrestrictedHitTotal: 0,
    pepAllowTotal: 0,
    skillReleaseResolveMissTotal: createLabeledCounter(),
    renderTotal: createLabeledCounter(),
    renderFailTotal: createLabeledCounter(),
    renderDurationMsSum: createLabeledCounter(),
    renderDurationMsMax: createLabeledCounter(),
    renderFontSelfcheckFailed: 0,
    deliveryIntentTotal: createLabeledCounter(),
    deliveryDigestMismatchTotal: 0,
    deliveryOverwriteTotal: 0,
    sandboxLimitHitTotal: createLabeledCounter()
};

function normalizeLabel(value, fallback = 'unknown') {
    const text = String(value ?? '').trim().slice(0, 80);
    return text || fallback;
}

function bump(counter, label, delta = 1) {
    const key = normalizeLabel(label);
    if (!counter.has(key) && counter.size >= MAX_LABEL_CARDINALITY) {
        // 标签基数超限时统一并入 other，避免恶意输入把内存指标撑爆。
        counter.set('other', (counter.get('other') || 0) + delta);
        return;
    }
    counter.set(key, (counter.get(key) || 0) + delta);
}

function maxInto(counter, label, value) {
    const key = normalizeLabel(label);
    const current = counter.get(key) || 0;
    if (value > current) counter.set(key, value);
}

/** 记录 PEP 判定结果。reason 为拒绝原因短码，allow 时可省略。 */
function recordPolicyDecision({ decision = 'allow', reason = '', shadow = false } = {}) {
    if (shadow) {
        if (decision === 'denied') bump(state.pepShadowDenyTotal, reason || 'unspecified');
        return;
    }
    if (decision === 'denied') {
        bump(state.pepDenyTotal, reason || 'unspecified');
        return;
    }
    state.pepAllowTotal += 1;
}

/** 记录迁移期 legacy_unrestricted 兜底放行。该指标必须单调收敛到 0。 */
function recordLegacyUnrestrictedHit() {
    state.pepLegacyUnrestrictedHitTotal += 1;
}

/** 记录技能发布解析未命中。cause 区分 tenant_mismatch / rollout_excluded / no_release。 */
function recordSkillReleaseResolveMiss(cause = 'unknown') {
    bump(state.skillReleaseResolveMissTotal, cause);
}

/** 记录一次文档渲染。format 为 docx/pdf/xlsx/html/md。 */
function recordRenderResult({ format = 'unknown', durationMs = 0, failureReason = '' } = {}) {
    const safeDuration = Math.max(Number(durationMs) || 0, 0);
    if (failureReason) {
        bump(state.renderFailTotal, failureReason);
        return;
    }
    bump(state.renderTotal, format);
    bump(state.renderDurationMsSum, format, safeDuration);
    maxInto(state.renderDurationMsMax, format, safeDuration);
}

/** CJK 字体启动自检失败：PDF 能力已下线，属 P1 告警。 */
function recordFontSelfcheckFailure() {
    state.renderFontSelfcheckFailed += 1;
}

/** 记录交付意图漏斗。channel 为 web_download/local_device，state 为意图状态。 */
function recordDeliveryIntentState({ channel = 'unknown', state: intentState = 'unknown' } = {}) {
    bump(state.deliveryIntentTotal, `${normalizeLabel(channel)}|${normalizeLabel(intentState)}`);
}

/** 交付端回报摘要与 rendition 摘要不一致：传输或篡改信号，不重试。 */
function recordDeliveryDigestMismatch() {
    state.deliveryDigestMismatchTotal += 1;
}

/** 记录一次显式授权的覆盖写入。 */
function recordDeliveryOverwrite() {
    state.deliveryOverwriteTotal += 1;
}

/** 记录沙箱资源限制命中。kind 为 memory/process/timeout 等。 */
function recordSandboxLimitHit(kind = 'unknown') {
    bump(state.sandboxLimitHitTotal, kind);
}

function counterToObject(counter) {
    return Object.fromEntries([...counter.entries()]);
}

function getAgentGovernanceMetricsSnapshot() {
    return {
        pep: {
            allowTotal: state.pepAllowTotal,
            denyTotal: counterToObject(state.pepDenyTotal),
            shadowDenyTotal: counterToObject(state.pepShadowDenyTotal),
            legacyUnrestrictedHitTotal: state.pepLegacyUnrestrictedHitTotal
        },
        skill: {
            releaseResolveMissTotal: counterToObject(state.skillReleaseResolveMissTotal)
        },
        render: {
            total: counterToObject(state.renderTotal),
            failTotal: counterToObject(state.renderFailTotal),
            durationMsSum: counterToObject(state.renderDurationMsSum),
            durationMsMax: counterToObject(state.renderDurationMsMax),
            fontSelfcheckFailed: state.renderFontSelfcheckFailed
        },
        delivery: {
            intentTotal: counterToObject(state.deliveryIntentTotal),
            digestMismatchTotal: state.deliveryDigestMismatchTotal,
            overwriteTotal: state.deliveryOverwriteTotal
        },
        sandbox: {
            limitHitTotal: counterToObject(state.sandboxLimitHitTotal)
        }
    };
}

/** 仅供自动化测试重置计数器，生产代码不得调用。 */
function resetAgentGovernanceMetrics() {
    state.pepDenyTotal.clear();
    state.pepShadowDenyTotal.clear();
    state.pepLegacyUnrestrictedHitTotal = 0;
    state.pepAllowTotal = 0;
    state.skillReleaseResolveMissTotal.clear();
    state.renderTotal.clear();
    state.renderFailTotal.clear();
    state.renderDurationMsSum.clear();
    state.renderDurationMsMax.clear();
    state.renderFontSelfcheckFailed = 0;
    state.deliveryIntentTotal.clear();
    state.deliveryDigestMismatchTotal = 0;
    state.deliveryOverwriteTotal = 0;
    state.sandboxLimitHitTotal.clear();
}

module.exports = {
    getAgentGovernanceMetricsSnapshot,
    recordDeliveryDigestMismatch,
    recordDeliveryIntentState,
    recordDeliveryOverwrite,
    recordFontSelfcheckFailure,
    recordLegacyUnrestrictedHit,
    recordPolicyDecision,
    recordRenderResult,
    recordSandboxLimitHit,
    recordSkillReleaseResolveMiss,
    resetAgentGovernanceMetrics
};
