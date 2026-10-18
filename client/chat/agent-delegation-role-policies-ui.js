/* 组织协作角色策略工作台：只编辑可收紧上限，实际授权仍由服务端验证。 */
(function () {
    function create({ state, escape, escapeAttr, setMarkup, setNotice, apiJson }) {
        function renderDelegationRolePolicies() {
            const target = document.getElementById('agent-delegation-policy-list');
            const policies = state.delegationRolePolicies?.policies;
            if (!target) return;
            if (!policies || typeof policies !== 'object') {
                setMarkup(target, '<div class="agent-harness-empty-card"><strong>尚未加载组织协作策略</strong><span>刷新后可查看当前组织角色的受控上限。</span></div>');
                return;
            }
            const labels = { researcher: '研究', analyst: '分析', reviewer: '审阅', writer: '写作' };
            const revision = Number(state.delegationRolePolicies?.revision || 0);
            const organizationId = Number(state.delegationRolePolicies?.organizationId || 0);
            setMarkup(target, `<div class="agent-harness-subhead"><strong>当前策略快照</strong><span>组织 ${organizationId || '—'} · 修订 ${revision || '默认'}</span></div><div class="aht-wrap"><table class="aht data-table"><thead><tr><th>角色</th><th>工具边界</th><th>审批边界</th><th>最大步骤</th><th>最大 Token</th></tr></thead><tbody>${Object.entries(labels).map(([role, label]) => {
                const policy = policies[role] || {};
                return `<tr data-agent-delegation-role="${escapeAttr(role)}"><td><strong>${escape(label)}</strong><small>${escape(policy.id || `${role}-org-v1`)}</small></td><td><span class="agent-inbox-type-badge badge-run">仅内置工具</span></td><td><span class="agent-inbox-type-badge badge-approval">始终审批 MCP</span></td><td><input class="form-input" type="number" min="1" max="${Number(policy.maxSteps || 1)}" value="${Number(policy.maxSteps || 1)}" data-agent-delegation-max-steps="${escapeAttr(role)}" aria-label="${escapeAttr(`${label}角色最大步骤`)}"></td><td><input class="form-input" type="number" min="1000" max="${Number(policy.maxTokenBudget || 1000)}" value="${Number(policy.maxTokenBudget || 1000)}" data-agent-delegation-max-tokens="${escapeAttr(role)}" aria-label="${escapeAttr(`${label}角色最大 Token`)}"></td></tr>`;
            }).join('')}</tbody></table></div>`);
        }

        async function loadDelegationRolePolicies() {
            const data = await apiJson(`${API_BASE}/agents/delegation/role-policies`, { cache: 'no-store' });
            state.delegationRolePolicies = data.data || null;
            renderDelegationRolePolicies();
            return state.delegationRolePolicies;
        }

        async function saveDelegationRolePolicies() {
            const roles = ['researcher', 'analyst', 'reviewer', 'writer'];
            const policies = {};
            for (const role of roles) {
                const maxSteps = Number(document.querySelector(`[data-agent-delegation-max-steps="${role}"]`)?.value);
                const maxTokenBudget = Number(document.querySelector(`[data-agent-delegation-max-tokens="${role}"]`)?.value);
                if (!Number.isSafeInteger(maxSteps) || !Number.isSafeInteger(maxTokenBudget)) return setNotice('角色步数和 Token 上限必须是整数。', 'error');
                policies[role] = { maxSteps, maxTokenBudget };
            }
            try {
                const data = await apiJson(`${API_BASE}/agents/delegation/role-policies`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies }) });
                state.delegationRolePolicies = data.data || null;
                renderDelegationRolePolicies();
                setNotice('组织协作角色策略已保存。', 'success');
            } catch (error) { setNotice(error.message || '组织协作角色策略保存失败。', 'error'); }
        }

        return { loadDelegationRolePolicies, saveDelegationRolePolicies };
    }

    window.Pivot?.exposeModule?.('agent.delegationRolePolicies', { create });
})();

