/* 组织协作角色策略工作台：只编辑可收紧上限，实际授权仍由服务端验证。 */
(function () {
    const ROLE_METAS = Object.freeze({
        researcher: {
            name: '研究',
            enName: 'Researcher',
            defaultId: 'researcher-org-v1',
            subtitle: '多源资料搜集、知识库检索与工具初探',
            iconSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
            colorClass: 'role-researcher',
            baselineSteps: 12,
            baselineTokens: 30000
        },
        analyst: {
            name: '分析',
            enName: 'Analyst',
            defaultId: 'analyst-org-v1',
            subtitle: '多维数据整合、结构化归纳与复杂推理',
            iconSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
            colorClass: 'role-analyst',
            baselineSteps: 12,
            baselineTokens: 30000
        },
        reviewer: {
            name: '审阅',
            enName: 'Reviewer',
            defaultId: 'reviewer-org-v1',
            subtitle: '结论事实校验、格式约束审查与合规审核',
            iconSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>',
            colorClass: 'role-reviewer',
            baselineSteps: 8,
            baselineTokens: 20000
        },
        writer: {
            name: '写作',
            enName: 'Writer',
            defaultId: 'writer-org-v1',
            subtitle: '整合各阶段成果，按预设模板格式规范成文',
            iconSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
            colorClass: 'role-writer',
            baselineSteps: 8,
            baselineTokens: 20000
        }
    });

    const ROLE_KEYS = Object.keys(ROLE_METAS);
    const TOTAL_BASELINE_STEPS = Object.values(ROLE_METAS).reduce((acc, m) => acc + m.baselineSteps, 0); // 40

    function create({ state, escape, escapeAttr, setMarkup, setNotice, apiJson }) {
        let loadedSnapshot = null;

        function updateDirtyState() {
            const dirtyDot = document.querySelector('.agent-delegation-status-dot');
            const dirtyText = document.getElementById('agent-delegation-dirty-text');
            if (!dirtyDot || !dirtyText || !loadedSnapshot) return;

            let isDirty = false;
            for (const role of ROLE_KEYS) {
                const stepInput = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
                const tokenInput = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
                if (!stepInput || !tokenInput) continue;

                const currSteps = Number.parseInt(stepInput.value, 10);
                const currTokens = Number.parseInt(tokenInput.value, 10);
                const origPolicy = loadedSnapshot[role] || {};

                if (currSteps !== Number(origPolicy.maxSteps) || currTokens !== Number(origPolicy.maxTokenBudget)) {
                    isDirty = true;
                    break;
                }
            }

            dirtyDot.classList.toggle('dirty', isDirty);
            dirtyText.textContent = isDirty ? '检测到未保存的策略调整' : '配置与服务器保持一致';
        }

        function refreshRoleIndicators(role) {
            const meta = ROLE_METAS[role];
            if (!meta) return;

            const stepInput = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
            const tokenInput = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
            if (!stepInput || !tokenInput) return;

            const currSteps = Number.parseInt(stepInput.value, 10);
            const currTokens = Number.parseInt(tokenInput.value, 10);

            // 步数进度条与校验
            const stepFill = document.getElementById(`agent-step-fill-${role}`);
            const stepRatioText = document.getElementById(`agent-step-ratio-${role}`);
            const stepError = document.getElementById(`agent-step-error-${role}`);
            const stepValid = Number.isSafeInteger(currSteps) && currSteps >= 1 && currSteps <= meta.baselineSteps;

            stepInput.classList.toggle('is-invalid', !stepValid);
            if (stepError) {
                stepError.textContent = !stepValid ? (currSteps > meta.baselineSteps ? `超基线上限 (${meta.baselineSteps})` : '至少为 1') : '';
            }
            if (stepFill && stepValid) {
                const pct = Math.min(100, Math.max(0, Math.round((currSteps / meta.baselineSteps) * 100)));
                stepFill.style.width = `${pct}%`;
                if (stepRatioText) stepRatioText.textContent = `${pct}%`;
            }

            // Token 进度条与校验
            const tokenFill = document.getElementById(`agent-token-fill-${role}`);
            const tokenRatioText = document.getElementById(`agent-token-ratio-${role}`);
            const tokenError = document.getElementById(`agent-token-error-${role}`);
            const tokenValid = Number.isSafeInteger(currTokens) && currTokens >= 1000 && currTokens <= meta.baselineTokens;

            tokenInput.classList.toggle('is-invalid', !tokenValid);
            if (tokenError) {
                tokenError.textContent = !tokenValid ? (currTokens > meta.baselineTokens ? `超基线上限 (${meta.baselineTokens})` : '至少 1000') : '';
            }
            if (tokenFill && tokenValid) {
                const tokenPct = Math.min(100, Math.max(0, Math.round((currTokens / meta.baselineTokens) * 100)));
                tokenFill.style.width = `${tokenPct}%`;
                if (tokenRatioText) tokenRatioText.textContent = `${tokenPct}%`;
            }

            updateDirtyState();
        }

        function renderDelegationRolePolicies() {
            const target = document.getElementById('agent-delegation-policy-list');
            const policies = state.delegationRolePolicies?.policies;
            if (!target) return;
            if (!policies || typeof policies !== 'object') {
                setMarkup(target, '<div class="agent-harness-empty-card"><strong>尚未加载组织协作策略</strong><span>刷新后可查看当前组织角色的受控上限。</span></div>');
                return;
            }

            // 保存原始快照用于变更对比
            loadedSnapshot = JSON.parse(JSON.stringify(policies));

            const revision = Number(state.delegationRolePolicies?.revision || 0);
            const organizationId = Number(state.delegationRolePolicies?.organizationId || 0);

            // 计算全局总步数收紧率
            let currentTotalSteps = 0;
            ROLE_KEYS.forEach(role => {
                const p = policies[role] || {};
                currentTotalSteps += Number(p.maxSteps || ROLE_METAS[role].baselineSteps);
            });
            const tighteningRate = Math.round((currentTotalSteps / TOTAL_BASELINE_STEPS) * 100);

            const markup = `
                <!-- 顶部治理指标网格 -->
                <div class="agent-delegation-metrics">
                    <div class="agent-delegation-metric-card">
                        <div class="metric-header">
                            <span>受管角色覆盖</span>
                            <span class="agent-inbox-type-badge badge-run">全部接入</span>
                        </div>
                        <div class="metric-value">4 / 4 个协作角色</div>
                        <div class="metric-hint">研究、分析、审阅、写作全部受控</div>
                    </div>
                    <div class="agent-delegation-metric-card">
                        <div class="metric-header">
                            <span>组织快照版本</span>
                            <span class="agent-inbox-type-badge badge-run">已生效</span>
                        </div>
                        <div class="metric-value">组织 #${organizationId || 1} · Rev.${revision || 0}</div>
                        <div class="metric-hint">严格受服务端 CAS 与权限门禁保护</div>
                    </div>
                    <div class="agent-delegation-metric-card">
                        <div class="metric-header">
                            <span>安全隔离基线</span>
                            <span class="agent-inbox-type-badge badge-approval">严格限制</span>
                        </div>
                        <div class="metric-value">仅内置 · MCP全审</div>
                        <div class="metric-hint">任何角色不可放宽至外部无审模式</div>
                    </div>
                    <div class="agent-delegation-metric-card">
                        <div class="metric-header">
                            <span>全局额度指数</span>
                            <span class="agent-inbox-type-badge badge-run">${tighteningRate}%</span>
                        </div>
                        <div class="metric-value">${tighteningRate === 100 ? '标准基线' : `收紧 ${100 - tighteningRate}%`}</div>
                        <div class="metric-hint">当前总配置步数: ${currentTotalSteps} / ${TOTAL_BASELINE_STEPS}</div>
                    </div>
                </div>

                <!-- 工具栏与快捷收紧预设 -->
                <div class="agent-delegation-toolbar">
                    <div class="agent-delegation-toolbar-info">
                        <strong>当前策略快照 <span>(组织 ${organizationId || '—'} · 修订 ${revision || '默认'})</span></strong>
                        <span class="agent-delegation-toolbar-desc">角色仅能在父任务限额内继承权限，修改后对后续派生任务实时生效。</span>
                    </div>
                    <div class="agent-delegation-presets" role="group" aria-label="快捷策略预设">
                        <button type="button" class="agent-delegation-preset-btn" data-delegation-preset="100">恢复基线 (100%)</button>
                        <button type="button" class="agent-delegation-preset-btn" data-delegation-preset="75">适度收紧 (75%)</button>
                        <button type="button" class="agent-delegation-preset-btn" data-delegation-preset="50">严格限制 (50%)</button>
                    </div>
                </div>

                <!-- 角色策略矩阵表格 -->
                <div class="agent-delegation-table-wrap">
                    <table class="aht data-table agent-delegation-matrix-table">
                        <thead>
                            <tr>
                                <th style="width: 28%;">角色定义与职责</th>
                                <th style="width: 14%;">工具边界</th>
                                <th style="width: 14%;">审批边界</th>
                                <th style="width: 20%;">最大步骤 (Max Steps)</th>
                                <th style="width: 20%;">最大 Token (Max Tokens)</th>
                                <th style="width: 4%; text-align: center;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${ROLE_KEYS.map(role => {
                                const meta = ROLE_METAS[role];
                                const policy = policies[role] || {};
                                const steps = Number(policy.maxSteps || meta.baselineSteps);
                                const tokens = Number(policy.maxTokenBudget || meta.baselineTokens);
                                const stepPct = Math.min(100, Math.max(0, Math.round((steps / meta.baselineSteps) * 100)));
                                const tokenPct = Math.min(100, Math.max(0, Math.round((tokens / meta.baselineTokens) * 100)));

                                return `
                                    <tr data-agent-delegation-role="${escapeAttr(role)}">
                                        <td>
                                            <div class="agent-delegation-role-cell">
                                                <div class="agent-delegation-role-avatar ${meta.colorClass}">
                                                    ${meta.iconSvg}
                                                </div>
                                                <div class="agent-delegation-role-meta">
                                                    <strong>
                                                        ${escape(meta.name)}
                                                        <span class="role-id-tag">${escape(policy.id || meta.defaultId)}</span>
                                                    </strong>
                                                    <span class="role-subtitle">${escape(meta.subtitle)}</span>
                                                </div>
                                            </div>
                                        </td>
                                        <td>
                                            <div class="agent-delegation-boundary-wrap">
                                                <span class="agent-inbox-type-badge badge-run agent-delegation-boundary-badge" title="仅内置工具：禁止扩展外部工具，保障宿主环境隔离">
                                                    仅内置工具
                                                </span>
                                            </div>
                                        </td>
                                        <td>
                                            <div class="agent-delegation-boundary-wrap">
                                                <span class="agent-inbox-type-badge badge-approval agent-delegation-boundary-badge" title="始终审批 MCP：任何外部 MCP 调用均需显式审批">
                                                    始终审批 MCP
                                                </span>
                                            </div>
                                        </td>
                                        <td>
                                            <div class="agent-delegation-config-cell">
                                                <div class="agent-delegation-stepper">
                                                    <button type="button" class="agent-stepper-btn" data-step-dir="-1" data-role="${escapeAttr(role)}" title="减少 1 步">-</button>
                                                    <input class="form-input agent-delegation-num-input" type="number" min="1" max="${meta.baselineSteps}" value="${steps}" data-agent-delegation-max-steps="${escapeAttr(role)}" aria-label="${escapeAttr(`${meta.name}角色最大步骤`)}">
                                                    <button type="button" class="agent-stepper-btn" data-step-dir="1" data-role="${escapeAttr(role)}" title="增加 1 步">+</button>
                                                </div>
                                                <div class="agent-delegation-progress-bar">
                                                    <div id="agent-step-fill-${role}" class="agent-delegation-progress-fill" style="width: ${stepPct}%;"></div>
                                                </div>
                                                <div class="agent-delegation-progress-caption">
                                                    <span>基线上限: ${meta.baselineSteps} 步</span>
                                                    <span id="agent-step-ratio-${role}">${stepPct}%</span>
                                                </div>
                                                <div id="agent-step-error-${role}" class="agent-delegation-error-hint"></div>
                                            </div>
                                        </td>
                                        <td>
                                            <div class="agent-delegation-config-cell">
                                                <div class="agent-delegation-stepper">
                                                    <button type="button" class="agent-stepper-btn agent-stepper-token" data-token-dir="-1000" data-role="${escapeAttr(role)}" title="减少 1000 Token">-1k</button>
                                                    <input class="form-input agent-delegation-num-input token-input" type="number" min="1000" max="${meta.baselineTokens}" step="1000" value="${tokens}" data-agent-delegation-max-tokens="${escapeAttr(role)}" aria-label="${escapeAttr(`${meta.name}角色最大 Token`)}">
                                                    <button type="button" class="agent-stepper-btn agent-stepper-token" data-token-dir="1000" data-role="${escapeAttr(role)}" title="增加 1000 Token">+1k</button>
                                                </div>
                                                <div class="agent-delegation-progress-bar">
                                                    <div id="agent-token-fill-${role}" class="agent-delegation-progress-fill" style="width: ${tokenPct}%;"></div>
                                                </div>
                                                <div class="agent-delegation-progress-caption">
                                                    <span>基线上限: ${meta.baselineTokens.toLocaleString()}</span>
                                                    <span id="agent-token-ratio-${role}">${tokenPct}%</span>
                                                </div>
                                                <div id="agent-token-error-${role}" class="agent-delegation-error-hint"></div>
                                            </div>
                                        </td>
                                        <td style="text-align: center;">
                                            <button type="button" class="agent-delegation-row-reset" data-agent-delegation-reset-role="${escapeAttr(role)}" title="恢复此角色默认基线">重置</button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;

            setMarkup(target, markup);
            bindDelegationControls();
            updateDirtyState();
        }

        function applyPreset(factor) {
            ROLE_KEYS.forEach(role => {
                const meta = ROLE_METAS[role];
                const stepInput = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
                const tokenInput = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
                if (!stepInput || !tokenInput) return;

                if (factor === 1) {
                    stepInput.value = meta.baselineSteps;
                    tokenInput.value = meta.baselineTokens;
                } else {
                    const targetSteps = Math.max(1, Math.round(meta.baselineSteps * factor));
                    const rawTokens = meta.baselineTokens * factor;
                    const targetTokens = Math.max(1000, Math.round(rawTokens / 1000) * 1000);
                    stepInput.value = targetSteps;
                    tokenInput.value = targetTokens;
                }
                refreshRoleIndicators(role);
            });
            setNotice(`已应用 ${Math.round(factor * 100)}% 策略预设，请核对后点击保存。`, 'info');
        }

        function bindDelegationControls() {
            const target = document.getElementById('agent-delegation-policy-list');
            if (!target) return;

            // 监听步长按钮与重置按钮点击
            target.querySelectorAll('[data-step-dir]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const role = btn.dataset.role;
                    const dir = Number.parseInt(btn.dataset.stepDir, 10);
                    const input = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
                    const meta = ROLE_METAS[role];
                    if (!input || !meta) return;
                    const curr = Number.parseInt(input.value || meta.baselineSteps, 10);
                    const next = Math.min(meta.baselineSteps, Math.max(1, curr + dir));
                    input.value = next;
                    refreshRoleIndicators(role);
                });
            });

            target.querySelectorAll('[data-token-dir]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const role = btn.dataset.role;
                    const dir = Number.parseInt(btn.dataset.tokenDir, 10);
                    const input = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
                    const meta = ROLE_METAS[role];
                    if (!input || !meta) return;
                    const curr = Number.parseInt(input.value || meta.baselineTokens, 10);
                    const next = Math.min(meta.baselineTokens, Math.max(1000, curr + dir));
                    input.value = next;
                    refreshRoleIndicators(role);
                });
            });

            target.querySelectorAll('[data-agent-delegation-reset-role]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const role = btn.dataset.agentDelegationResetRole;
                    const meta = ROLE_METAS[role];
                    const stepInput = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
                    const tokenInput = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
                    if (stepInput && tokenInput && meta) {
                        stepInput.value = meta.baselineSteps;
                        tokenInput.value = meta.baselineTokens;
                        refreshRoleIndicators(role);
                        setNotice(`已将「${meta.name}」角色恢复为系统默认基线。`, 'info');
                    }
                });
            });

            // 监听输入框手动输入
            ROLE_KEYS.forEach(role => {
                const stepInput = document.querySelector(`[data-agent-delegation-max-steps="${role}"]`);
                const tokenInput = document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`);
                stepInput?.addEventListener('input', () => refreshRoleIndicators(role));
                tokenInput?.addEventListener('input', () => refreshRoleIndicators(role));
            });

            // 快捷预设按钮
            target.querySelectorAll('[data-delegation-preset]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const pct = Number.parseInt(btn.dataset.delegationPreset, 10);
                    if (pct === 100) applyPreset(1);
                    else if (pct === 75) applyPreset(0.75);
                    else if (pct === 50) applyPreset(0.5);
                });
            });

            // 全局重置按钮（位于操作栏）
            const resetAllBtn = document.getElementById('agent-delegation-policy-reset-btn');
            if (resetAllBtn && !resetAllBtn.dataset.bound) {
                resetAllBtn.dataset.bound = 'true';
                resetAllBtn.addEventListener('click', () => {
                    applyPreset(1);
                    setNotice('已恢复所有角色为默认基线，请点击保存组织策略生效。', 'info');
                });
            }
        }

        async function loadDelegationRolePolicies() {
            const data = await apiJson(`${API_BASE}/agents/delegation/role-policies`, { cache: 'no-store' });
            state.delegationRolePolicies = data.data || null;
            renderDelegationRolePolicies();
            return state.delegationRolePolicies;
        }

        async function saveDelegationRolePolicies() {
            const saveBtn = document.getElementById('agent-delegation-policy-save');
            const policies = {};

            for (const role of ROLE_KEYS) {
                const meta = ROLE_METAS[role];
                const maxSteps = Number(document.querySelector(`[data-agent-delegation-max-steps="${role}"]`)?.value);
                const maxTokenBudget = Number(document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`)?.value);

                if (!Number.isSafeInteger(maxSteps) || !Number.isSafeInteger(maxTokenBudget)) {
                    return setNotice('角色步数和 Token 上限必须是整数。', 'error');
                }
                if (maxSteps < 1 || maxSteps > meta.baselineSteps) {
                    return setNotice(`角色「${meta.name}」的步数只能收紧在 1 到 ${meta.baselineSteps} 之间。`, 'error');
                }
                if (maxTokenBudget < 1000 || maxTokenBudget > meta.baselineTokens) {
                    return setNotice(`角色「${meta.name}」的 Token 只能收紧在 1000 到 ${meta.baselineTokens} 之间。`, 'error');
                }
                policies[role] = { maxSteps, maxTokenBudget };
            }

            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = '正在保存...';
            }

            try {
                const data = await apiJson(`${API_BASE}/agents/delegation/role-policies`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ policies })
                });
                state.delegationRolePolicies = data.data || null;
                renderDelegationRolePolicies();
                setNotice('组织协作角色策略已保存。', 'success');
            } catch (error) {
                setNotice(error.message || '组织协作角色策略保存失败。', 'error');
            } finally {
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = '保存组织策略';
                }
            }
        }

        return { loadDelegationRolePolicies, saveDelegationRolePolicies };
    }

    window.Pivot?.exposeModule?.('agent.delegationRolePolicies', { create });
})();
