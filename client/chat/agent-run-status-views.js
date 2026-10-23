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
    if (status === 'awaiting_commit') return '结果已通过验收，但外部副作用仍等待提交证据；尚未完成交付。';
    if (status === 'completed') return `${records} 条执行记录已完成，结果已生成。`;
    if (status === 'partial') return '任务已保留可用的部分结果；请查看缺失项后继续。';
    if (status === 'needs_input') return limitMessage || '任务尚未完成，请查看具体待处理事项；可继续处理，或补充确实缺少的信息。';
    if (status === 'completed_with_errors' && /最大执行轮次/.test(limitMessage)) return limitMessage;
    if (status === 'completed_with_errors') return `${records} 条执行记录已完成，但有部分结果需要留意。`;
    if (status === 'error') return '任务未能顺利完成，可直接重试或修改目标后重新执行。';
    if (status === 'cancelled') return '任务已停止，当前没有新的结果。';
    return agentStatusLabel(status) || '任务状态已更新。';
}

const AGENT_VERIFICATION_RULE_NAMES = {
    artifact_required: '成果交付文件',
    deliverables_verified: '交付内容核验',
    evidence: '资料来源与佐证',
    final_answer_non_empty: '完整回答',
    required_phrase: '必须包含内容',
    forbidden_phrase: '禁止包含内容',
    min_length: '回答长度要求',
    valid_json: '数据格式规范 (JSON)',
    output_schema: '输出结构规范',
    required_artifact: '指定产物文件'
};

const AGENT_VERIFICATION_REASON_NAMES = {
    artifact_not_materialized: '尚未生成要求的文件',
    artifact_integrity_failed: '生成文件未通过完整性检查',
    source_revoked: '原始资料已失效或不可用',
    source_not_fully_read: '尚未读取完整资料',
    verifier_unavailable: '验收服务暂时不可用',
    evidence: '缺少引用来源或佐证记录',
    invalid: '格式校验不通过',
    failed: '未满足验收条件'
};

function formatAgentVerificationItem(rule) {
    const rawKey = String(rule?.key || 'verification').trim();
    const keyLabel = AGENT_VERIFICATION_RULE_NAMES[rawKey] || rawKey;
    let actual = String(rule?.actual || '').trim();
    if (!actual || actual === 'false' || actual === '未通过') {
        actual = rawKey === 'artifact_required' ? '尚未生成要求的文件' : '未满足要求';
    } else if (AGENT_VERIFICATION_REASON_NAMES[actual]) {
        actual = AGENT_VERIFICATION_REASON_NAMES[actual];
    }
    return `<li><strong>${agentEscape(keyLabel)}</strong>：${agentEscape(actual)}</li>`;
}

function renderAgentVerification(verification = null) {
    if (!verification || typeof verification !== 'object') return '';
    const report = verification.report && typeof verification.report === 'object' ? verification.report : verification;
    const status = String(verification.outcomeStatus || report.outcomeStatus || '').trim();
    if (!status) return '';
    const label = ({ verified: '验收通过', partial: '部分完成', needs_input: '核验有待处理项' })[status] || '验收结果';
    const hardFailures = Array.isArray(report.hardFailures) ? report.hardFailures : [];
    const failedRules = (Array.isArray(report.rules) ? report.rules : []).filter(rule => rule && rule.passed === false).slice(0, 8);
    return `<section class="agent-verification ${agentEscape(status)}"><div class="agent-verification-head"><strong>${agentEscape(label)}</strong><span>${hardFailures.length ? `${hardFailures.length} 项硬性条件未通过` : '关键条件已核验'}</span></div>${failedRules.length ? `<ul>${failedRules.map(formatAgentVerificationItem).join('')}</ul>` : ''}</section>`;
}

function renderAgentEvidence(evidence = []) {
    const items = Array.isArray(evidence) ? evidence.slice(0, 8) : [];
    if (!items.length) return '';
    return `<section class="agent-evidence"><div class="agent-evidence-head"><strong>来源与证据</strong><span>${items.length} 项</span></div><ul>${items.map(item => `<li>${item.url ? `<a href="${agentEscapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">${agentEscape(item.title || item.url)}</a>` : `<strong>${agentEscape(item.title || '来源')}</strong>`}${item.excerpt ? `<p>${agentEscape(item.excerpt)}</p>` : ''}</li>`).join('')}</ul></section>`;
}

function renderAgentTaskTransaction(transaction = null, runStatus = '') {
    if (!transaction || typeof transaction !== 'object') return '';
    const status = String(transaction.status || '').trim();
    if (!status) return '';
    const labels = {
        draft: '事务草稿', planned: '已规划事务', executing: '事务执行中', verifying: '事务验收中',
        awaiting_commit: '等待提交', committed: '已提交', compensating: '正在补偿', rolled_back: '已回滚',
        partial: '部分完成', needs_input: '需要人工处理', failed: '事务失败', cancelled: '已取消'
    };
    const effects = Array.isArray(transaction.effects) ? transaction.effects : [];
    const effectCount = effects.length;
    const pendingEffects = effects.filter(item => item && !['committed', 'compensated', 'cancelled'].includes(String(item.status || ''))).length;
    const unresolvedEffects = effects.filter(item => item && item.commitMode !== 'preview' && ['executing', 'failed'].includes(String(item.status || '')));
    const irreversibleEffects = effects.filter(item => item && item.commitMode !== 'preview' && item.status === 'committed'
        && (!item.compensation?.required || item.compensation?.mode === 'none'));
    const compensationCount = Array.isArray(transaction.compensations) ? transaction.compensations.length : 0;
    const leaseRows = Array.isArray(transaction.resourceLeases) ? transaction.resourceLeases : [];
    const currentLeases = leaseRows.filter(item => item && !item.releasedAt && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > Date.now());
    const activeLeases = currentLeases.length;
    const nextExpiry = currentLeases.map(item => String(item.expiresAt)).sort()[0] || '';
    const conflicts = Array.isArray(transaction.resourceConflicts) ? transaction.resourceConflicts.filter(item => item && item.status === 'open') : [];
    const snapshot = transaction.workspaceSnapshot && typeof transaction.workspaceSnapshot === 'object' ? transaction.workspaceSnapshot : {};
    const shadowWorktrees = Array.isArray(snapshot.shadowWorktrees) ? snapshot.shadowWorktrees.slice(-6) : [];

    // 普通用户视角下，无副作用、无补偿项、无租约与冲突的零价值技术事务不单独渲染卡片
    if (effectCount === 0 && compensationCount === 0 && activeLeases === 0 && conflicts.length === 0 && !shadowWorktrees.length && status !== 'awaiting_commit' && !unresolvedEffects.length) {
        return '';
    }
    const runCanCommit = !runStatus || runStatus === 'awaiting_commit';
    const summary = status === 'awaiting_commit'
        ? unresolvedEffects.length
            ? `${unresolvedEffects.length} 个外部动作正在执行或结果待核实，请勿重试或回滚，先人工核对外部状态。`
            : irreversibleEffects.length
                ? `已有 ${irreversibleEffects.length} 个不可补偿的外部动作提交，不能自动回滚。`
                : !runCanCommit
                    ? '任务已停止或不在提交阶段，不能提交外部动作；请按事务回滚流程处理。'
                : `${pendingEffects} 个副作用仍需提交证据，系统不会将任务标记为已交付。`
        : status === 'committed'
            ? '验收与提交证据已关联保存。'
            : status === 'rolled_back'
                ? '相关副作用已执行补偿或回滚。'
                : activeLeases ? `已登记 ${effectCount} 个副作用计划，并持有 ${activeLeases} 项资源租约以避免并发冲突。`
                    : `已登记 ${effectCount} 个副作用计划。`;
    const transactionActions = status === 'awaiting_commit' && !unresolvedEffects.length
        ? `${runCanCommit ? `<button type="button" class="btn-primary btn-xs" data-agent-transaction-commit="${agentEscape(transaction.id || '')}">确认提交外部动作</button>` : ''}${irreversibleEffects.length ? '' : `<button type="button" class="btn-danger-outline btn-xs" data-agent-transaction-rollback="${agentEscape(transaction.id || '')}">放弃并回滚</button>`}`
        : '';
    const uncertainActions = unresolvedEffects.filter(item => item.status === 'failed' && item.errorInfo?.outcomeUncertain === true)
        .map(item => `<button type="button" class="btn-secondary btn-xs" data-agent-effect-resolve-uncertain="${agentEscape(item.id || '')}">核对外部结果</button>`).join('');
    const actions = transactionActions || uncertainActions ? `<div class="agent-task-transaction-actions">${transactionActions}${uncertainActions}</div>` : '';
    const snapshotMarkup = shadowWorktrees.length
        ? `<section class="agent-task-workspace-snapshots"><strong>影子工作树状态记录</strong><span>状态摘要不包含文件内容，不是备份。回滚时保留工作树，请先人工检查、保存或归档未提交内容。</span><ul>${shadowWorktrees.map(item => `<li><b>${agentEscape(item.worktreeName || '未命名工作树')}</b><small>${agentEscape(item.branch || '未记录分支')} · HEAD ${agentEscape(String(item.head || '').slice(0, 12) || '—')} · 状态摘要 ${agentEscape(String(item.revision || '').slice(0, 12) || '—')} · 需要人工处理</small></li>`).join('')}</ul></section>`
        : '';
    return `<section class="agent-task-transaction ${agentEscape(status)}"><div class="agent-task-transaction-head"><strong>${agentEscape(labels[status] || '任务事务')}</strong><span>${agentEscape(summary)}</span></div><dl><div><dt>副作用</dt><dd>${effectCount}</dd></div><div><dt>待处理</dt><dd>${pendingEffects}</dd></div><div><dt>补偿项</dt><dd>${compensationCount}</dd></div><div><dt>资源租约</dt><dd title="${agentEscape(nextExpiry ? `最早到期：${nextExpiry}` : '当前无活动资源租约')}">${activeLeases}</dd></div></dl>${snapshotMarkup}${conflicts.length ? `<div class="error-detail">${conflicts.length} 项资源冲突仍待处理：${conflicts.slice(0, 3).map(item => agentEscape(item.resourceKey || '受控资源')).join('、')}。请由负责人核对持有事务的执行结果并协调处理；租约到期不代表副作用已完成。</div>` : ''}${actions}</section>`;
}

function renderAgentWorkingMemory(revisions = []) {
    const list = Array.isArray(revisions) ? revisions : [];
    if (!list.length) return '';
    const latest = list[0] || {};
    const retention = latest.retention && typeof latest.retention === 'object' ? latest.retention : {};
    const rate = Math.round(Number(retention.retentionRate ?? 1) * 100);
    const lost = Number(retention.missingConstraintIds?.length || 0) + Number(retention.missingPendingWorkIds?.length || 0);
    const status = retention.blockingLoss === true ? 'loss' : 'healthy';
    const reason = ({ initial: '初始任务约束', control_message: '人工控制更新', tool_observation: '工具观察更新', context_compacted: '上下文压缩' })[latest.reason] || latest.reason || '运行更新';
    return `<section class="agent-working-memory ${agentEscape(status)}"><div><strong>任务工作记忆</strong><span>${agentEscape(reason)} · 第 ${Number(latest.revision || 0)} 版</span></div><dl><div><dt>修订</dt><dd>${list.length}</dd></div><div><dt>约束保留</dt><dd>${rate}%</dd></div><div><dt>遗漏项</dt><dd>${lost}</dd></div></dl>${lost ? `<p>压缩/更新检测到 ${lost} 项约束或待办未保留；任务不得据此宣称已完整交付。</p>` : '<p>当前修订未检测到关键约束或待办遗漏。</p>'}</section>`;
}

function renderAgentPromptProvenance(invocations = []) {
    const list = Array.isArray(invocations) ? invocations : [];
    if (!list.length) return '';
    const latest = list[0] || {};
    const manifest = latest.manifest && typeof latest.manifest === 'object' ? latest.manifest : {};
    const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
    const stable = sections.filter(item => item.stability === 'stable');
    const dynamic = sections.filter(item => item.stability !== 'stable');
    const sourceLabel = latest.source === 'agent' ? '智能体' : (latest.source || '智能体');
    return `<section class="agent-prompt-provenance"><div><strong>提示词版本证据</strong><span>${agentEscape(sourceLabel)} · ${Number(manifest.sectionCount || sections.length)} 段</span></div><dl><div><dt>稳定段</dt><dd>${stable.length}</dd></div><div><dt>动态段</dt><dd>${dynamic.length}</dd></div><div><dt>调用记录</dt><dd>${list.length}</dd></div></dl><p>稳定摘要 ${agentEscape(String(manifest.stableDigest || latest.stableDigest || '').slice(0, 12) || '—')} · 动态摘要 ${agentEscape(String(manifest.dynamicDigest || latest.dynamicDigest || '').slice(0, 12) || '—')}</p><details><summary>查看章节段落清单</summary><ul>${sections.map(item => `<li><strong>${agentEscape(item.key || '')}</strong> · ${agentEscape(item.version || '')} · ${agentEscape(item.owner || '')} · ${item.stability === 'stable' ? '稳定段' : '动态段'}</li>`).join('')}</ul></details></section>`;
}

function renderAgentBrowserActionEvidence(items = [], sessions = []) {
    const list = Array.isArray(items) ? items : [];
    const browserSessions = Array.isArray(sessions) ? sessions : [];
    const recoverable = browserSessions.filter(item => item?.status === 'needs_user_recovery');
    if (!list.length && !recoverable.length) return '';
    const changed = list.filter(item => item.before?.bodyTextDigest !== item.after?.bodyTextDigest || item.before?.url !== item.after?.url).length;
    const recoveryMarkup = recoverable.map(session => `<div class="agent-browser-recovery"><div><strong>浏览器会话等待人工观察</strong><span>${agentEscape(session.pageTitle || session.currentUrl || '已中断页面')}</span><small>请先确认旧执行器已停止并核对外部写入结果；系统不会自动重放写操作，确认后仅重新打开页面供观察。</small></div><div class="agent-browser-recovery-actions"><button type="button" class="btn-primary btn-xs" data-agent-browser-recover="${agentEscapeAttr(session.id)}">重新打开并观察</button>${session.mutationPendingRecovery ? '' : `<button type="button" class="btn-secondary btn-xs" data-agent-browser-close="${agentEscapeAttr(session.id)}">关闭会话</button>`}</div></div>`).join('');
    const evidenceMarkup = list.length ? `<ul>${list.slice(-8).map(item => `<li><strong>${agentEscape(item.action || '操作')}</strong><span>${agentEscape(item.before?.title || item.before?.url || '操作前页面')} → ${agentEscape(item.after?.title || item.after?.url || '操作后页面')}</span><small>前 ${agentEscape(String(item.before?.bodyTextDigest || '').slice(0, 12) || '—')} · 后 ${agentEscape(String(item.after?.bodyTextDigest || '').slice(0, 12) || '—')}${item.transactionId ? ` · 事务 ${agentEscape(String(item.transactionId).slice(0, 8))}` : ''}</small></li>`).join('')}</ul>` : '';
    return `<section class="agent-browser-evidence"><div><strong>浏览器操作证据</strong><span>${list.length} 次受控写操作 · ${changed} 次页面状态变化</span></div>${recoveryMarkup}${evidenceMarkup}</section>`;
}

function appendAgentVerificationViews(container, markup, { prepend = false } = {}) {
    if (!container || !markup) return;
    const group = document.createElement('div');
    group.className = 'agent-verification-stack';
    PivotSafeHtml.setHtml(group, markup);
    if (prepend) container.prepend(group);
    else container.append(group);
}
