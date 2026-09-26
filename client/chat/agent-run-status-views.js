// 任务结果状态与证据渲染器，独立于页面交互事件绑定。
/* eslint-disable no-undef */
function agentRunFriendlySummary(run = {}, progress = {}) {
    const status = String(run.status || '').toLowerCase();
    const continuation = agentRunMetadata(run).autoContinuation || {};
    const records = Number(progress.stepCount || 0);
    const rounds = Number(progress.roundCount || 0);
    const maxSteps = Number(progress.maxSteps || run.max_steps || 0);
    const isDag = String(run.run_mode || '') === 'dag';
    const limitMessage = String(run.error_message || '').trim();
    if (status === 'queued' && Number(continuation.count || 0) > 0) return `上一时间片已结束，正在从安全检查点自动续跑（第 ${Number(continuation.count)}/${Number(continuation.max || 0)} 次）。`;
    if (status === 'queued') return '任务已进入队列，稍后将自动开始。';
    if (status === 'running') return isDag ? `工作流正在运行，当前已有 ${records} 条执行记录。` : (maxSteps > 0 ? `正在执行第 ${Math.min(rounds + 1, maxSteps)} 轮，上限 ${maxSteps} 轮。` : `正在执行第 ${rounds + 1} 轮。`);
    if (status === 'approval_required') return '任务需要确认工具权限，确认后才会继续。';
    if (status === 'verifying') return '正在检查任务结果、产物和约束是否满足要求。';
    if (status === 'completed') return `${records} 条执行记录已完成，结果已生成。`;
    if (status === 'partial') return '任务已保留可用的部分结果；请查看缺失项后继续。';
    if (status === 'needs_input') return '任务结果还缺少必要信息或交付物，请补充要求后继续。';
    if (status === 'completed_with_errors' && /最大执行轮次/.test(limitMessage)) return limitMessage;
    if (status === 'completed_with_errors') return `${records} 条执行记录已完成，但有部分结果需要留意。`;
    if (status === 'error') return '任务未能完成，请查看失败步骤并重试。';
    if (status === 'cancelled') return '任务已停止，当前没有新的结果。';
    return agentStatusLabel(status) || '任务状态已更新。';
}

function renderAgentVerification(verification = null) {
    if (!verification || typeof verification !== 'object') return '';
    const report = verification.report && typeof verification.report === 'object' ? verification.report : verification;
    const status = String(verification.outcomeStatus || report.outcomeStatus || '').trim();
    if (!status) return '';
    const label = ({ verified: '验收通过', partial: '部分完成', needs_input: '需要补充' })[status] || '验收结果';
    const hardFailures = Array.isArray(report.hardFailures) ? report.hardFailures : [];
    const failedRules = (Array.isArray(report.rules) ? report.rules : []).filter(rule => rule && rule.passed === false).slice(0, 8);
    return `<section class="agent-verification ${agentEscape(status)}"><div class="agent-verification-head"><strong>${agentEscape(label)}</strong><span>${hardFailures.length ? `${hardFailures.length} 项硬性条件未通过` : '关键条件已核验'}</span></div>${failedRules.length ? `<ul>${failedRules.map(rule => `<li>${agentEscape(rule.key || 'verification')}：${agentEscape(rule.actual || '未通过')}</li>`).join('')}</ul>` : ''}</section>`;
}

function renderAgentEvidence(evidence = []) {
    const items = Array.isArray(evidence) ? evidence.slice(0, 8) : [];
    if (!items.length) return '';
    return `<section class="agent-evidence"><div class="agent-evidence-head"><strong>来源与证据</strong><span>${items.length} 项</span></div><ul>${items.map(item => `<li>${item.url ? `<a href="${agentEscapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">${agentEscape(item.title || item.url)}</a>` : `<strong>${agentEscape(item.title || '来源')}</strong>`}${item.excerpt ? `<p>${agentEscape(item.excerpt)}</p>` : ''}</li>`).join('')}</ul></section>`;
}

function appendAgentVerificationViews(container, markup, { prepend = false } = {}) {
    if (!container || !markup) return;
    const group = document.createElement('div');
    group.className = 'agent-verification-stack';
    PivotSafeHtml.setHtml(group, markup);
    if (prepend) container.prepend(group);
    else container.append(group);
}
