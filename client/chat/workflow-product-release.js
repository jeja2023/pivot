/* 发布确认固定可执行版本，复用现有影响清单与自动化状态。 */
(function () {
    let sequence = 0;
    const bridge = () => window.Pivot.moduleApi('agent.workflowBridge');
    const escape = value => window.Pivot.legacy.PivotSafeHtml.escapeHtml(String(value ?? ''));
    async function read(path) {
        const response = await bridge().request(path); const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取发布信息失败，请重试。');
        return data;
    }
    async function startup(workflowId) {
        const results = await Promise.allSettled([read('/agents/schedules'), read('/agents/triggers')]);
        const schedules = results[0].status === 'fulfilled' ? (results[0].value.data || []).filter(item => {
            let config = item.run_config || item.runConfig || {}; if (typeof config === 'string') { try { config = JSON.parse(config); } catch (_) { config = {}; } }
            return String(config.workflowId) === String(workflowId);
        }) : null;
        const triggers = results[1].status === 'fulfilled' ? (results[1].value.data || []).filter(item => String(item.workflowId || item.workflow_id) === String(workflowId)) : null;
        return { schedules, triggers };
    }
    function startupHtml(state) {
        const items = [...(state.schedules || []), ...(state.triggers || [])];
        return `${state.schedules === null || state.triggers === null ? '<p role="alert">部分自动启动状态读取失败，请重试读取。</p>' : ''}<p>${items.length ? `关联 ${state.schedules?.length || 0} 个计划、${state.triggers?.length || 0} 个事件启动规则。` : '尚未配置计划或事件启动。发布不会自动启用启动规则。'}</p>${items.map(item => `<p>${escape(item.name)}：${escape(item.status === 'active' ? '已启用' : item.status === 'paused' ? '已暂停' : item.status)}${item.lastError || item.last_error ? ` · ${escape(item.lastError || item.last_error)}` : ''}</p>`).join('')}`;
    }
    function describeDiff(before, after) {
        const stable = window.Pivot.moduleApi('agent.dagDefinition').stable;
        const old = new Map((before?.nodes || []).map(node => [node.id, node]));
        const next = new Map((after?.nodes || []).map(node => [node.id, node]));
        const added = [...next.values()].filter(node => !old.has(node.id));
        const removed = [...old.values()].filter(node => !next.has(node.id));
        const changed = [...next.values()].filter(node => old.has(node.id) && stable(old.get(node.id)) !== stable(node));
        const inputs = window.Pivot.moduleApi('agent.workflowRunForm').definitions;
        const oldInputs = inputs(before || {}); const newInputs = inputs(after || {});
        const affected = [...new Set([...oldInputs, ...newInputs].map(item => item.name))].filter(name => stable(oldInputs.find(item => item.name === name)) !== stable(newInputs.find(item => item.name === name)));
        return `<p>新增 ${added.length} 步，修改 ${changed.length} 步，移除 ${removed.length} 步。</p>${[...added, ...changed, ...removed].map(node => `<span>${escape(node.title || node.id)} </span>`).join('')}${affected.length ? `<p>运行参数发生变化：${affected.map(name => escape(newInputs.find(item => item.name === name)?.label || oldInputs.find(item => item.name === name)?.label || name)).join('、')}。接收者依赖映射需按新发布版本重新确认。</p>` : '<p>运行参数未变化。</p>'}`;
    }
    async function open() {
        if (bridge().readOnly()) return;
        const panel = document.getElementById('workflow-product-release'); panel.hidden = false;
        const ticket = ++sequence;
        const report = bridge().editor()?.validate();
        if (report?.errors?.length) {
            PivotSafeHtml.setHtml(panel, `<h3>发布前需要修正</h3><p role="alert">${escape(report.errors[0])}</p><button class="btn-secondary" type="button" data-release-fix>返回配置</button>`);
            panel.querySelector('button').addEventListener('click', () => { panel.hidden = true; }); return;
        }
        panel.textContent = '正在保存待发布版本并读取影响清单…';
        try {
            const identity = bridge().editor();
            const workflow = await bridge().persist({ showToast: false });
            if (ticket !== sequence || identity !== bridge().editor()) return;
            if (!workflow) throw new Error('待发布版本未保存。请先处理保存失败或冲突，草稿仍保留。');
            const version = workflow.current_version;
            const [versions, impactData, startupState] = await Promise.all([
                read(`/agents/workflows/${workflow.id}/versions`), read(`/agents/workflows/${workflow.id}/release-impact?version=${version}`), startup(workflow.id)
            ]);
            if (ticket !== sequence || identity !== bridge().editor()) return;
            const before = versions.data.find(item => Number(item.version) === Number(workflow.published_version))?.dag_spec || { nodes: [] };
            const after = versions.data.find(item => Number(item.version) === Number(version))?.dag_spec;
            const impact = impactData.impact;
            const risks = [...(impact.sideEffects || []), ...(impact.approvals || []), ...(impact.unavailableTools || [])];
            PivotSafeHtml.setHtml(panel, `<h3>发布 V${escape(version)}</h3><p>${workflow.published_version ? `替换线上 V${escape(workflow.published_version)}` : '首次发布'}。确认后发布本次已保存的固定版本，已有运行保留原快照。</p>${describeDiff(before, after)}<p>共享范围：${escape(workflow.scope === 'shared' ? '已授权团队 / 个人' : '个人')}。模型 ${Number(impact.dependencies?.summary?.modelCount || 0)} 项，工具 ${Number(impact.dependencies?.summary?.toolCount || 0)} 项，凭据 ${Number(impact.dependencies?.summary?.credentialCount || 0)} 项。</p>${risks.length ? `<details open><summary>需要关注的操作与依赖</summary>${risks.map(item => `<p>${escape(item.title || item.nodeId)} · ${escape(item.reason || item.tool || '')}</p>`).join('')}</details>` : ''}<details><summary>完整定义差异</summary><pre>${escape(JSON.stringify({ online: before, release: after }, null, 2))}</pre></details><section data-startup-state>${startupHtml(startupState)}</section><div class="workflow-product-row"><button type="button" class="btn-secondary" data-startup-refresh>重新读取启动状态</button><button type="button" class="btn-secondary" data-startup-config>配置自动启动</button></div><label class="workflow-product-field">发布说明<textarea class="form-input" maxlength="2000" rows="3" data-release-note></textarea></label><div class="workflow-product-row"><button type="button" class="btn-primary" data-confirm-publish>确认发布 V${escape(version)}</button><button type="button" class="btn-secondary" data-close-publish>返回修改</button></div><p data-publish-result role="status"></p>`);
            panel.querySelector('[data-close-publish]').addEventListener('click', () => { panel.hidden = true; sequence += 1; });
            panel.querySelector('[data-startup-config]').addEventListener('click', () => bridge().openTriggers(workflow.id));
            panel.querySelector('[data-startup-refresh]').addEventListener('click', async event => {
                event.target.disabled = true;
                try { const state = await startup(workflow.id); if (ticket === sequence) PivotSafeHtml.setHtml(panel.querySelector('[data-startup-state]'), startupHtml(state)); }
                finally { event.target.disabled = false; }
            });
            panel.querySelector('[data-confirm-publish]').addEventListener('click', async event => {
                event.target.disabled = true;
                try {
                    const published = await bridge().publish({ targetVersion: version, releaseNote: panel.querySelector('[data-release-note]').value });
                    if (!published) throw new Error('发布未完成。草稿和当前线上版本仍保留，请修正检查信息后重试。');
                    if (ticket !== sequence) return;
                    panel.querySelector('[data-publish-result]').textContent = `已发布 V${published.published_version}。自动启动状态单独显示如下。`;
                    PivotSafeHtml.setHtml(panel.querySelector('[data-startup-state]'), startupHtml(await startup(workflow.id)));
                } catch (error) { if (ticket === sequence) panel.querySelector('[data-publish-result]').textContent = error.message; }
                finally { event.target.disabled = false; }
            });
        } catch (error) { if (ticket === sequence) panel.textContent = error.message; }
    }
    window.Pivot.registerModule('agent.workflowRelease', { open, close: () => { sequence += 1; }, describeDiff, startupHtml });
})();
