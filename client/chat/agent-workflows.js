// Agent 工作流编排与运行控制 Agent workflow orchestration and run controls
// Agent 工作流功能从 agents.js 拆分而来。
// Split from agents.js.
/* eslint-disable no-undef */
let activeAutomationTab = 'workflows';
let automationAssetQuery = '';
let agentWorkflowReadOnly = false;

function automationScheduleConfig(schedule) {
    const value = schedule?.run_config;
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '{}');
    } catch (e) {
        return {};
    }
}

function automationFrequencyText(schedule) {
    if (schedule?.frequency === 'interval') {
        const minutes = Math.max(5, Number(schedule.interval_minutes) || 60);
        return minutes % 60 === 0 ? `每隔 ${minutes / 60} 小时` : `每隔 ${minutes} 分钟`;
    }
    if (schedule?.frequency === 'weekly') {
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return `每周${weekdays[Number(schedule.day_of_week || 0)] || '周一'} ${schedule.time_of_day || '09:00'}`;
    }
    if (schedule?.frequency === 'daily') return `每天 ${schedule.time_of_day || '09:00'}`;
    if (schedule?.frequency === 'cron') return `Cron · ${schedule.cron_expression || '-'}`;
    return '手动运行';
}

function automationWorkflowScopeText(workflow) {
    if (!workflow?.is_owner) return '共享给我';
    if (workflow.scope !== 'shared') return '仅自己';
    const units = Array.isArray(workflow.allowed_units)
        ? workflow.allowed_units.filter(Boolean)
        : [];
    const userIds = Array.isArray(workflow.allowed_user_ids)
        ? workflow.allowed_user_ids.filter(Boolean)
        : [];
    if (!units.length && !userIds.length) return '共享 · 全体成员';
    const targets = [];
    if (units.length) targets.push(units.join('、'));
    if (userIds.length) targets.push(`${userIds.length} 名个人`);
    return `共享 · ${targets.join(' + ')}`;
}

function selectAutomationWorkflow(workflowId) {
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
    if (!workflow) return null;
    activeAgentWorkflowId = String(workflow.id);
    agentWorkflowDraftName = workflow.name || '';
    agentWorkflowDraftDescription = workflow.description || '';
    writeAgentWorkflowText(workflow.dag_spec || { nodes: [] });
    renderAgentWorkflowLibrary();
    return workflow;
}

function setAutomationTab(tab = 'workflows') {
    activeAutomationTab = tab === 'schedules' ? 'schedules' : 'workflows';
    window.Pivot.legacy.syncAutomationPrimaryTabs?.(activeAutomationTab);
    const workflowsPanel = document.getElementById('automation-workflows-panel');
    const schedulesPanel = document.getElementById('automation-schedules-panel');
    workflowsPanel?.classList.toggle('hidden', activeAutomationTab !== 'workflows');
    schedulesPanel?.classList.toggle('hidden', activeAutomationTab !== 'schedules');
    workflowsPanel?.setAttribute('aria-hidden', activeAutomationTab === 'workflows' ? 'false' : 'true');
    schedulesPanel?.setAttribute('aria-hidden', activeAutomationTab === 'schedules' ? 'false' : 'true');
    document.getElementById('automation-new-workflow-btn')?.classList.toggle('hidden', activeAutomationTab !== 'workflows');
    document.getElementById('automation-new-schedule-btn')?.classList.toggle('hidden', activeAutomationTab !== 'schedules');
    const input = document.getElementById('automation-assets-search-input');
    if (input) input.placeholder = activeAutomationTab === 'workflows' ? '搜索工作流' : '搜索计划任务';
    const description = document.getElementById('automation-workspace-description');
    if (description) {
        description.textContent = activeAutomationTab === 'workflows'
            ? '编排、发布和复用可控的多步骤工作流。'
            : '统一安排自主任务和已发布工作流的单次或周期执行。';
    }
    renderAutomationAssetCenter();
}

function renderAutomationAssetCenter() {
    const workflowList = document.getElementById('automation-workflow-assets-list');
    const scheduleList = document.getElementById('automation-schedule-assets-list');
    if (!workflowList || !scheduleList) return;
    const publishedCount = agentWorkflowsCache.filter(item => Number(item.published_version || 0) > 0).length;
    const activeScheduleCount = agentSchedulesCache.filter(item => item.status !== 'paused').length;
    const workflowCount = document.getElementById('automation-workflow-count');
    const published = document.getElementById('automation-published-count');
    const scheduleCount = document.getElementById('automation-schedule-count');
    if (workflowCount) workflowCount.textContent = String(agentWorkflowsCache.length);
    if (published) published.textContent = String(publishedCount);
    if (scheduleCount) scheduleCount.textContent = String(activeScheduleCount);

    const query = String(automationAssetQuery || '').trim().toLowerCase();
    const workflows = agentWorkflowsCache.filter(item => !query || [
        item.name,
        item.description,
        agentWorkflowVersionText(item)
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
    const experience = window.Pivot.moduleApi('agent.workflowExperience');
    const prefs = experience?.preferences?.() || [];
    const preference = id => prefs.find(item => String(item.workflow_id) === String(id)) || {};
    workflows.sort((a, b) => Number(Boolean(preference(b.id).favorite)) - Number(Boolean(preference(a.id).favorite)) || (Date.parse(preference(b.id).last_used_at) || 0) - (Date.parse(preference(a.id).last_used_at) || 0));
    PivotSafeHtml.setHtml(workflowList, workflows.length ? `
        <div class="automation-table-wrap">
            <table class="data-table automation-assets-table automation-workflows-table">
                <thead><tr><th class="text-center">序号</th><th>工作流</th><th>简介</th><th>状态</th><th>可见范围</th><th>版本</th><th>节点</th><th>更新时间</th><th>操作</th></tr></thead>
                <tbody>${workflows.map((workflow, index) => {
        const publishedVersion = Number(workflow.published_version || 0);
        const isFavorite = Boolean(preference(workflow.id).favorite);
        const recentRun = experience?.recent?.(workflow.id);
        const recentStatusText = recentRun ? (({ completed: '已完成', error: '失败', partial: '部分完成', needs_input: '需补充', running: '运行中', queued: '排队中', cancelled: '已取消' })[recentRun.status] || '运行记录') : '';
        const currentVersion = Number(workflow.current_version || 1);
        const favoriteTitle = isFavorite ? '取消收藏' : '加入收藏';
        const workflowTitle = agentEscapeAttr(workflow.name || '未命名工作流');
        const workflowDesc = agentEscapeAttr(workflow.description || '暂无说明');
        const versionTagHtml = (publishedVersion && currentVersion > publishedVersion)
            ? `<span class="automation-version-badge">V${currentVersion}</span> <small class="automation-version-sub">线上 V${publishedVersion}</small>`
            : `<span class="automation-version-badge">V${publishedVersion || currentVersion}</span>`;
        return `
                    <tr>
                        <td class="text-center automation-index-cell">${index + 1}</td>
                        <td>
                            <div class="automation-name-cell">
                                <button type="button" class="btn-secondary automation-workflow-title-link" data-automation-workflow-edit="${agentEscapeAttr(workflow.id)}" title="${workflowTitle}">
                                    <strong>${agentEscape(workflow.name || '未命名工作流')}</strong>
                                </button>
                            </div>
                        </td>
                        <td>
                            <div class="automation-desc-cell ${workflow.description ? '' : 'is-empty'}" title="${workflowDesc}">
                                ${agentEscape(workflow.description || '暂无说明')}
                            </div>
                        </td>
                        <td>
                            <div class="automation-status-cell">
                                <span class="automation-status-badge ${publishedVersion ? 'published' : 'draft'}">
                                    <span class="automation-status-dot" aria-hidden="true"></span>
                                    ${publishedVersion ? '已发布' : '草稿'}
                                </span>
                            </div>
                        </td>
                        <td><span class="automation-scope-tag ${workflow.is_owner && workflow.scope === 'shared' ? 'is-shared' : ''}">${agentEscape(automationWorkflowScopeText(workflow))}</span></td>
                        <td><span class="automation-version-tag">${versionTagHtml}</span></td>
                        <td><span class="automation-nodes-badge">${agentWorkflowNodeCount(workflow)} 步</span></td>
                        <td><span class="automation-time-text">${agentEscape(agentWorkflowUpdatedText(workflow) || '-')}</span></td>
                        <td>
                            <div class="automation-row-actions">
                                ${workflow.can_edit ? `<button class="btn-primary-outline btn-xs automation-action-btn" type="button" data-automation-workflow-edit="${agentEscapeAttr(workflow.id)}">编排</button>` : `<button class="btn-primary-outline btn-xs automation-action-btn" type="button" data-automation-workflow-view="${agentEscapeAttr(workflow.id)}">查看</button>`}
                                ${publishedVersion ? `<button class="btn-secondary btn-success-outline btn-xs automation-action-btn" type="button" data-automation-workflow-run="${agentEscapeAttr(workflow.id)}">运行</button>` : ''}
                                <button class="btn-secondary btn-xs automation-action-btn automation-favorite-btn ${isFavorite ? 'is-favorited' : ''}" type="button" data-workflow-favorite="${agentEscapeAttr(workflow.id)}" aria-pressed="${isFavorite}" title="${favoriteTitle}">
                                    <span>${isFavorite ? '已收藏' : '收藏'}</span>
                                </button>
                                <details class="automation-dropdown">
                                    <summary class="btn-secondary btn-xs automation-action-btn automation-dropdown-summary" title="更多操作">
                                        <span>更多</span>
                                        <svg class="automation-dropdown-caret" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                    </summary>
                                    <div class="automation-dropdown-menu automation-dropdown-menu-right">
                                        ${workflow.can_edit ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-metadata-edit="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> 编辑信息</button>` : ''}
                                        ${workflow.can_edit ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-versions="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg> 版本历史</button>` : ''}
                                        ${workflow.can_edit && publishedVersion ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-schedule="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> 计划任务</button>` : ''}
                                        ${workflow.can_edit && publishedVersion ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-triggers="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> 自动启动</button>` : ''}
                                        ${!workflow.can_edit ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-dependencies="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4 7.55 4.24a1.79 1.79 0 0 0-1.8 0l-4.5 2.58a1.78 1.78 0 0 0-.9 1.55v5.18c0 .64.34 1.23.9 1.55l4.5 2.58a1.78 1.78 0 0 0 1.8 0l8.95-5.16a1.8 1.8 0 0 0 .9-1.55V9.4z"></path></svg> 配置依赖</button>` : ''}
                                        ${workflow.can_edit ? `<button class="automation-dropdown-item" type="button" data-automation-workflow-share="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg> 设置分享</button>` : ''}
                                        ${recentRun ? `<button class="automation-dropdown-item" type="button" data-workflow-recent="${agentEscapeAttr(workflow.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> 最近结果 (${agentEscape(recentStatusText)})</button>` : ''}
                                    </div>
                                </details>
                            </div>
                        </td>
                    </tr>`;
    }).join('')}</tbody>
            </table>
        </div>
    ` : '<div class="automation-empty-state"><strong>暂无匹配的工作流</strong><span>新建工作流后，可在这里统一管理版本、发布和计划。</span></div>');

    workflowList.querySelectorAll('[data-workflow-favorite]').forEach(button => button.addEventListener('click', () => experience.toggleFavorite(button.dataset.workflowFavorite)));
    workflowList.querySelectorAll('[data-workflow-recent]').forEach(button => button.addEventListener('click', () => experience.openRecent(button.dataset.workflowRecent)));
    workflowList.querySelectorAll('.automation-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
            const details = item.closest('details.automation-dropdown');
            if (details) details.open = false;
        });
    });
    workflowList.querySelectorAll('.automation-dropdown').forEach(dropdown => {
        dropdown.addEventListener('toggle', () => {
            const tr = dropdown.closest('tr');
            const td = dropdown.closest('td');
            if (dropdown.open) {
                tr?.classList.add('is-dropdown-open');
                td?.classList.add('is-dropdown-open');
                workflowList.querySelectorAll('.automation-dropdown[open]').forEach(other => {
                    if (other !== dropdown) other.open = false;
                });
                const rect = dropdown.getBoundingClientRect();
                const spaceBelow = window.innerHeight - rect.bottom;
                if (spaceBelow < 220 && rect.top > 220) {
                    dropdown.classList.add('is-dropup');
                } else {
                    dropdown.classList.remove('is-dropup');
                }
            } else {
                tr?.classList.remove('is-dropdown-open');
                td?.classList.remove('is-dropdown-open');
                dropdown.classList.remove('is-dropup');
            }
        });
    });
    if (!workflowList.dataset.dropdownBound) {
        workflowList.dataset.dropdownBound = 'true';
        document.addEventListener('click', event => {
            if (!event.target.closest('.automation-dropdown')) {
                workflowList.querySelectorAll('.automation-dropdown[open]').forEach(d => { d.open = false; });
            }
        });
    }
    const schedules = agentSchedulesCache.filter(schedule => {
        const config = automationScheduleConfig(schedule);
        const workflow = agentWorkflowsCache.find(item => String(item.id) === String(config.workflowId || config.workflow_id || ''));
        const text = [schedule.name, schedule.goal, workflow?.name, automationFrequencyText(schedule)].filter(Boolean).join(' ').toLowerCase();
        return !query || text.includes(query);
    });
    PivotSafeHtml.setHtml(scheduleList, schedules.length ? `
        <div class="automation-table-wrap">
            <table class="data-table automation-assets-table automation-schedules-table">
                <thead><tr><th>计划任务</th><th>来源</th><th>周期</th><th>状态</th><th>下次运行</th><th>操作</th></tr></thead>
                <tbody>${schedules.map(schedule => {
        const config = automationScheduleConfig(schedule);
        const workflowId = config.workflowId || config.workflow_id || '';
        const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
        const paused = schedule.status === 'paused';
        return `
                    <tr>
                        <td><strong>${agentEscape(schedule.name || '未命名计划')}</strong><small>${agentEscape(schedule.goal || '暂无说明')}</small></td>
                        <td>${workflow ? `<button type="button" class="automation-link-button" data-automation-workflow-edit="${agentEscapeAttr(workflow.id)}">${agentEscape(workflow.name)}</button>` : '自主任务'}</td>
                        <td>${agentEscape(automationFrequencyText(schedule))}</td>
                        <td><span class="automation-status ${paused ? 'paused' : 'published'}">${paused ? '已暂停' : '已启用'}</span></td>
                        <td>${agentEscape(paused ? '-' : (schedule.next_run_at || '-'))}</td>
                        <td><div class="automation-row-actions">
                            <button class="btn-secondary" type="button" data-automation-schedule-edit="${agentEscapeAttr(schedule.id)}">编辑</button>
                            <button class="btn-secondary" type="button" data-automation-schedule-toggle="${agentEscapeAttr(schedule.id)}">${paused ? '启用' : '暂停'}</button>
                            <button class="btn-secondary" type="button" data-automation-schedule-runs="${agentEscapeAttr(schedule.id)}">运行记录</button>
                            <button class="btn-secondary" type="button" data-automation-schedule-run="${agentEscapeAttr(schedule.id)}">立即运行</button>
                            <button class="btn-danger-outline" type="button" data-automation-schedule-delete="${agentEscapeAttr(schedule.id)}">删除</button>
                        </div></td>
                    </tr>`;
    }).join('')}</tbody>
            </table>
        </div>
    ` : '<div class="automation-empty-state"><strong>暂无匹配的计划任务</strong><span>可为自主任务或已发布工作流创建手动、按间隔、每天或每周执行的计划。</span></div>');

    workflowList.querySelectorAll('[data-automation-workflow-edit], [data-automation-workflow-view], [data-automation-workflow-run], [data-automation-workflow-dependencies], [data-automation-workflow-versions], [data-automation-workflow-triggers], [data-automation-workflow-schedule], [data-automation-workflow-share]').forEach(button => {
        button.addEventListener('click', async () => {
            const workflowId = button.dataset.automationWorkflowEdit
                || button.dataset.automationWorkflowView
                || button.dataset.automationWorkflowRun
                || button.dataset.automationWorkflowDependencies
                || button.dataset.automationWorkflowVersions
                || button.dataset.automationWorkflowTriggers
                || button.dataset.automationWorkflowSchedule
                || button.dataset.automationWorkflowShare;
            const workflow = selectAutomationWorkflow(workflowId);
            if (!workflow) return;
            if (button.dataset.automationWorkflowEdit) return showAutomationWorkflowEditor(workflowId);
            if (button.dataset.automationWorkflowView) return showAutomationWorkflowEditor(workflowId, { readOnly: true });
            if (button.dataset.automationWorkflowDependencies) return window.Pivot.moduleApi('agent.automation').openWorkflowDependencies?.(workflowId);
            if (button.dataset.automationWorkflowRun) return window.Pivot.legacy.runAgentWorkflowPublished?.();
            if (button.dataset.automationWorkflowVersions) return window.Pivot.legacy.openAgentWorkflowVersions();
            if (button.dataset.automationWorkflowTriggers) return window.Pivot.moduleApi('agent.automationResources').open?.({ tab: 'triggers', workflowId });
            if (button.dataset.automationWorkflowSchedule) return openAgentWorkflowSchedules();
            if (button.dataset.automationWorkflowShare) return window.Pivot.moduleApi('agent.automation').openWorkflowShare?.(workflowId);
        });
    });
    workflowList.querySelectorAll('[data-automation-workflow-metadata-edit]').forEach(button => {
        button.addEventListener('click', () => window.Pivot.moduleApi('agent.automation').openWorkflowMetadata?.(button.dataset.automationWorkflowMetadataEdit));
    });
    scheduleList.querySelectorAll('[data-automation-workflow-edit]').forEach(button => {
        button.addEventListener('click', () => {
            const workflow = agentWorkflowsCache.find(item => String(item.id) === String(button.dataset.automationWorkflowEdit));
            showAutomationWorkflowEditor(button.dataset.automationWorkflowEdit, { readOnly: workflow ? !workflow.can_edit : false });
        });
    });
    const scheduleApi = window.Pivot.moduleApi('agent.schedules');
    scheduleList.querySelectorAll('[data-automation-schedule-edit]').forEach(button => {
        button.addEventListener('click', () => scheduleApi.openEditor?.(button.dataset.automationScheduleEdit));
    });
    scheduleList.querySelectorAll('[data-automation-schedule-toggle]').forEach(button => {
        button.addEventListener('click', () => scheduleApi.toggle?.(button.dataset.automationScheduleToggle));
    });
    scheduleList.querySelectorAll('[data-automation-schedule-runs]').forEach(button => {
        button.addEventListener('click', () => scheduleApi.openRuns?.(button.dataset.automationScheduleRuns));
    });
    scheduleList.querySelectorAll('[data-automation-schedule-run]').forEach(button => {
        button.addEventListener('click', () => runAgentSchedule(button.dataset.automationScheduleRun));
    });
    scheduleList.querySelectorAll('[data-automation-schedule-delete]').forEach(button => {
        button.addEventListener('click', () => deleteAgentSchedule(button.dataset.automationScheduleDelete));
    });
}

function showAutomationAssetCenter(options = {}) {
    agentWorkflowReadOnly = false;
    closeAgentDagJsonModal();
    closeAgentDagNodeDrawer();
    const assetsView = document.getElementById('automation-assets-view');
    const editorView = document.getElementById('automation-editor-view');
    if (assetsView) {
        assetsView.classList.remove('hidden');
        assetsView.hidden = false;
    }
    if (editorView) {
        editorView.classList.add('hidden');
        editorView.hidden = true;
    }
    window.Pivot.moduleApi('agent.workflowExperience')?.closed?.();
    document.getElementById('automation-new-workflow-btn')?.classList.toggle('hidden', activeAutomationTab !== 'workflows');
    document.getElementById('automation-refresh-btn')?.classList.remove('hidden');
    document.getElementById('agent-dag-save-btn')?.classList.add('hidden');
    document.getElementById('agent-workflow-dependency-btn')?.classList.add('hidden');
    document.getElementById('agent-workflow-triggers-btn')?.classList.add('hidden');
    document.getElementById('agent-workflow-readonly-run-btn')?.classList.add('hidden');
    document.getElementById('agent-dag-back-btn')?.classList.add('hidden');
    document.getElementById('agent-workflow-management-menu')?.classList.remove('hidden');
    editorView?.classList.remove('is-readonly');
    const title = document.getElementById('automation-workspace-title');
    const description = document.getElementById('automation-workspace-description');
    if (title) title.textContent = '自动化';
    if (description) description.textContent = '集中管理工作流与计划任务，并跟踪发布和运行状态。';
    setAutomationTab(options.tab || activeAutomationTab);
}

function showAutomationWorkflowEditor(workflowId = '', options = {}) {
    window.Pivot.moduleApi('agent.workflowResults')?.stop?.();
    agentWorkflowReadOnly = Boolean(options.readOnly && workflowId);
    window.Pivot.legacy.syncAutomationPrimaryTabs?.('workflows');
    const assetsView = document.getElementById('automation-assets-view');
    const editorView = document.getElementById('automation-editor-view');
    if (assetsView) {
        assetsView.classList.add('hidden');
        assetsView.hidden = true;
    }
    if (editorView) {
        editorView.classList.remove('hidden');
        editorView.hidden = false;
    }
    document.getElementById('automation-new-workflow-btn')?.classList.add('hidden');
    document.getElementById('automation-refresh-btn')?.classList.add('hidden');
    document.getElementById('agent-dag-save-btn')?.classList.toggle('hidden', agentWorkflowReadOnly);
    document.getElementById('agent-workflow-dependency-btn')?.classList.toggle('hidden', !agentWorkflowReadOnly);
    document.getElementById('agent-workflow-triggers-btn')?.classList.toggle('hidden', agentWorkflowReadOnly || !workflowId);
    document.getElementById('agent-workflow-readonly-run-btn')?.classList.toggle('hidden', !agentWorkflowReadOnly);
    document.getElementById('agent-dag-back-btn')?.classList.remove('hidden');
    document.getElementById('agent-workflow-management-menu')?.classList.toggle('hidden', agentWorkflowReadOnly);
    document.getElementById('automation-editor-view')?.classList.toggle('is-readonly', agentWorkflowReadOnly);
    document.getElementById('automation-editor-view')?.setAttribute('aria-readonly', agentWorkflowReadOnly ? 'true' : 'false');
    const title = document.getElementById('automation-workspace-title');
    const description = document.getElementById('automation-workspace-description');
    if (title) title.textContent = agentWorkflowReadOnly ? '查看共享工作流' : (workflowId ? '工作流详情' : '新建工作流');
    if (description) description.textContent = agentWorkflowReadOnly
        ? '当前为只读视图，可查看并运行已发布版本。'
        : '编排节点、校验流程并管理发布版本。';
    if (workflowId) selectAutomationWorkflow(workflowId);
    else if (!options.keepDraft) newAgentWorkflow({ showToast: false, clearSnapshots: true, remount: false });
    mountAgentDagEditor();
    window.Pivot.legacy.refreshAgentDagEditor?.();
    updateAgentWorkflowRunUi();
    window.Pivot.moduleApi('agent.workflowExperience')?.opened?.();
}

async function openAgentDagWorkbench(options = {}) {
    window.Pivot.legacy.closeAgentConfigModal();
    const navigation = window.Pivot.moduleApi('workspaces.navigation');
    (navigation.showWorkspaceWithStyleGate || navigation.showMainWorkspace)?.('agent-dag');
    window.Pivot.legacy.initAgentRealtime?.();
    const requestedWorkflowId = options.workflowId || '';
    const incomingDraft = options.draft || pendingAgentWorkflowDraft || null;
    window.Pivot.legacy.bindUnifiedAutomationTabs?.();
    try {
        await Promise.all([
            loadAgentModels(),
            agentToolsCache.length ? Promise.resolve() : loadAgentTools(),
            loadAgentWorkflows(),
            loadAgentSchedules()
        ]);
    } catch (error) {
        showToast(error.message || '自动化资产加载失败', 'error');
        return false;
    }
    if (incomingDraft) {
        pendingAgentWorkflowDraft = null;
        newAgentWorkflow({
            showToast: false,
            clearSnapshots: true,
            remount: false,
            name: incomingDraft.name || '',
            description: incomingDraft.description || ''
        });
        writeAgentWorkflowText(incomingDraft.dagSpec || incomingDraft.dag_spec || { nodes: [] });
        renderAgentWorkflowLibrary();
        showAutomationWorkflowEditor('', { keepDraft: true });
        showToast('自主任务已转为工作流草稿，检查节点后可保存、发布或计划运行。', 'success');
    } else if (options.editor || requestedWorkflowId) {
        showAutomationWorkflowEditor(requestedWorkflowId);
    } else {
        showAutomationAssetCenter({ tab: options.tab });
        if (options.scheduleDraft) {
            window.Pivot.moduleApi('agent.schedules').openEditor?.('', { draft: options.scheduleDraft });
        }
    }
    window.Pivot.legacy.bindAgentDagWorkbench?.();
    window.Pivot.legacy.updateAgentAutoRefresh?.();
}

window.Pivot.legacy.closeAgentDagWorkbench = async function() {
    const confirmed = await confirmAgentWorkflowDiscard('关闭工作流编排会放弃当前画布中尚未保存的修改，确定继续吗？');
    if (!confirmed) return;
    window.Pivot.moduleApi('agent.workflowExperience')?.closed?.();
    closeAgentDagJsonModal();
    closeAgentDagNodeDrawer();
    window.Pivot.moduleApi('workspaces.navigation').returnFromWorkspace?.('personal');
    window.Pivot.legacy.updateAgentAutoRefresh?.();
};

window.Pivot.legacy.bindAgentDagWorkbench = function() {
    const newBtn = document.getElementById('agent-workflow-new-btn');
    if (newBtn && newBtn.dataset.boundAgentWorkflowNew !== '1') {
        newBtn.dataset.boundAgentWorkflowNew = '1';
        newBtn.addEventListener('click', async () => {
            const confirmed = await confirmAgentWorkflowDiscard('新建工作流会清空当前画布中尚未保存的修改，确定继续吗？');
            if (confirmed) newAgentWorkflow();
        });
    }
    const saveBtn = document.getElementById('agent-dag-save-btn');
    if (saveBtn && saveBtn.dataset.boundAgentDagSave !== '1') {
        saveBtn.dataset.boundAgentDagSave = '1';
        saveBtn.addEventListener('click', () => window.Pivot.legacy.saveAgentWorkflow?.());
    }
    const readonlyRunBtn = document.getElementById('agent-workflow-readonly-run-btn');
    if (readonlyRunBtn && readonlyRunBtn.dataset.boundAgentWorkflowReadonlyRun !== '1') {
        readonlyRunBtn.dataset.boundAgentWorkflowReadonlyRun = '1';
        readonlyRunBtn.addEventListener('click', () => window.Pivot.legacy.runAgentWorkflowPublished?.());
    }
    const dependencyBtn = document.getElementById('agent-workflow-dependency-btn');
    if (dependencyBtn && dependencyBtn.dataset.boundAgentWorkflowDependency !== '1') {
        dependencyBtn.dataset.boundAgentWorkflowDependency = '1';
        dependencyBtn.addEventListener('click', () => window.Pivot.moduleApi('agent.automation').openWorkflowDependencies?.());
    }
    const triggersBtn = document.getElementById('agent-workflow-triggers-btn');
    if (triggersBtn && triggersBtn.dataset.boundAgentWorkflowTriggers !== '1') {
        triggersBtn.dataset.boundAgentWorkflowTriggers = '1';
        triggersBtn.addEventListener('click', () => window.Pivot.moduleApi('agent.automationResources').open?.({
            tab: 'triggers',
            workflowId: activeAgentWorkflowId
        }));
    }
    const backBtn = document.getElementById('agent-dag-back-btn');
    if (backBtn && backBtn.dataset.boundAgentDagBack !== '1') {
        backBtn.dataset.boundAgentDagBack = '1';
        backBtn.addEventListener('click', async () => {
            const confirmed = await confirmAgentWorkflowDiscard('返回资产中心会放弃当前画布中尚未保存的修改，确定继续吗？');
            if (confirmed) showAutomationAssetCenter();
        });
    }
    const newWorkflowBtn = document.getElementById('automation-new-workflow-btn');
    if (newWorkflowBtn && newWorkflowBtn.dataset.boundAutomationNew !== '1') {
        newWorkflowBtn.dataset.boundAutomationNew = '1';
        newWorkflowBtn.addEventListener('click', () => window.Pivot.moduleApi('agent.workflowExperience')?.start?.() || showAutomationWorkflowEditor());
    }
    const newScheduleBtn = document.getElementById('automation-new-schedule-btn');
    if (newScheduleBtn && newScheduleBtn.dataset.boundAutomationNewSchedule !== '1') {
        newScheduleBtn.dataset.boundAutomationNewSchedule = '1';
        newScheduleBtn.addEventListener('click', () => window.Pivot.moduleApi('agent.schedules').openEditor?.());
    }
    const refreshAutomationBtn = document.getElementById('automation-refresh-btn');
    if (refreshAutomationBtn && refreshAutomationBtn.dataset.boundAutomationRefresh !== '1') {
        refreshAutomationBtn.dataset.boundAutomationRefresh = '1';
        refreshAutomationBtn.addEventListener('click', async () => {
            if (refreshAutomationBtn.disabled) return;
            refreshAutomationBtn.disabled = true;
            refreshAutomationBtn.setAttribute('aria-busy', 'true');
            try {
                await Promise.all([loadAgentWorkflows(), loadAgentSchedules()]);
                showToast('自动化资产已刷新', 'success');
            } catch (error) {
                showToast(error.message || '自动化资产刷新失败', 'error');
            } finally {
                refreshAutomationBtn.disabled = false;
                refreshAutomationBtn.removeAttribute('aria-busy');
            }
        });
    }
    const closeAutomationBtn = document.getElementById('automation-close-btn');
    if (closeAutomationBtn && closeAutomationBtn.dataset.boundAutomationClose !== '1') {
        closeAutomationBtn.dataset.boundAutomationClose = '1';
        closeAutomationBtn.addEventListener('click', () => window.Pivot.legacy.closeAgentDagWorkbench?.());
    }
    const automationSearch = document.getElementById('automation-assets-search-input');
    if (automationSearch && automationSearch.dataset.boundAutomationSearch !== '1') {
        automationSearch.dataset.boundAutomationSearch = '1';
        automationSearch.addEventListener('input', () => {
            automationAssetQuery = automationSearch.value || '';
            renderAutomationAssetCenter();
        });
    }
    const workflowPicker = document.getElementById('agent-workflow-picker');
    const workflowPickerTrigger = document.getElementById('agent-workflow-picker-trigger');
    const workflowPickerSearch = document.getElementById('agent-workflow-picker-search');
    const workflowPickerList = document.getElementById('agent-workflow-picker-list');
    const workflowManagementMenu = document.getElementById('agent-workflow-management-menu');
    if (workflowPickerTrigger && workflowPickerTrigger.dataset.boundAgentWorkflowPicker !== '1') {
        workflowPickerTrigger.dataset.boundAgentWorkflowPicker = '1';
        workflowPickerTrigger.addEventListener('click', () => {
            if (workflowManagementMenu) workflowManagementMenu.open = false;
            const isOpen = workflowPicker?.classList.contains('is-open');
            setAgentWorkflowPickerOpen(!isOpen);
        });
        workflowPickerTrigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(true);
            }
        });
    }
    if (workflowPickerSearch && workflowPickerSearch.dataset.boundAgentWorkflowSearch !== '1') {
        workflowPickerSearch.dataset.boundAgentWorkflowSearch = '1';
        workflowPickerSearch.addEventListener('input', () => {
            agentWorkflowPickerQuery = workflowPickerSearch.value || '';
            renderAgentWorkflowPicker();
        });
        workflowPickerSearch.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                workflowPickerList?.querySelector('.agent-workflow-picker-option')?.focus();
            }
        });
    }
    if (workflowPickerList && workflowPickerList.dataset.boundAgentWorkflowList !== '1') {
        workflowPickerList.dataset.boundAgentWorkflowList = '1';
        workflowPickerList.addEventListener('keydown', event => {
            const option = event.target.closest('.agent-workflow-picker-option');
            if (!option) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const options = Array.from(workflowPickerList.querySelectorAll('.agent-workflow-picker-option'));
                const index = options.indexOf(option);
                const nextIndex = event.key === 'ArrowDown'
                    ? Math.min(index + 1, options.length - 1)
                    : Math.max(index - 1, 0);
                options[nextIndex]?.focus();
            }
        });
    }
    if (workflowPicker && workflowPicker.dataset.boundAgentWorkflowOutside !== '1') {
        workflowPicker.dataset.boundAgentWorkflowOutside = '1';
        document.addEventListener('click', event => {
            if (!workflowPicker.contains(event.target)) setAgentWorkflowPickerOpen(false, { focusSearch: false });
        });
    }
    if (workflowManagementMenu && workflowManagementMenu.dataset.boundAgentWorkflowManagement !== '1') {
        workflowManagementMenu.dataset.boundAgentWorkflowManagement = '1';
        workflowManagementMenu.addEventListener('toggle', () => {
            if (workflowManagementMenu.open) setAgentWorkflowPickerOpen(false, { focusSearch: false });
        });
        workflowManagementMenu.addEventListener('click', event => {
            if (event.target.closest('button')) workflowManagementMenu.open = false;
        });
        workflowManagementMenu.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            workflowManagementMenu.open = false;
            workflowManagementMenu.querySelector('summary')?.focus();
        });
        document.addEventListener('click', event => {
            if (!workflowManagementMenu.contains(event.target)) workflowManagementMenu.open = false;
        });
    }
    const workflowSelect = document.getElementById('agent-workflow-select');
    if (workflowSelect && workflowSelect.dataset.boundAgentWorkflowSelect !== '1') {
        workflowSelect.dataset.boundAgentWorkflowSelect = '1';
        workflowSelect.addEventListener('change', () => {
            activeAgentWorkflowId = workflowSelect.value || '';
            document.getElementById('agent-workflow-triggers-btn')?.classList.toggle('hidden', agentWorkflowReadOnly || !activeAgentWorkflowId);
            if (!activeAgentWorkflowId) {
                newAgentWorkflow({ showToast: false, clearSnapshots: false });
                return;
            }
            const selected = agentWorkflowsCache.find(item => String(item.id) === String(activeAgentWorkflowId));
            agentWorkflowDraftName = selected?.name || '';
            agentWorkflowDraftDescription = selected?.description || '';
            renderAgentWorkflowLibrary();
            updateAgentWorkflowRunUi();
        });
    }
    const versionsBtn = document.getElementById('agent-workflow-versions-btn');
    if (versionsBtn && versionsBtn.dataset.boundAgentWorkflowVersions !== '1') {
        versionsBtn.dataset.boundAgentWorkflowVersions = '1';
        versionsBtn.addEventListener('click', window.Pivot.legacy.openAgentWorkflowVersions);
    }
    const scheduleBtn = document.getElementById('agent-workflow-schedule-btn');
    if (scheduleBtn && scheduleBtn.dataset.boundAgentWorkflowSchedule !== '1') {
        scheduleBtn.dataset.boundAgentWorkflowSchedule = '1';
        scheduleBtn.addEventListener('click', () => openAgentWorkflowSchedules());
    }
    const shareBtn = document.getElementById('agent-workflow-share-btn');
    if (shareBtn && shareBtn.dataset.boundAgentWorkflowShare !== '1') {
        shareBtn.dataset.boundAgentWorkflowShare = '1';
        shareBtn.addEventListener('click', () => window.Pivot.moduleApi('agent.automation').openWorkflowShare?.(activeAgentWorkflowId));
    }
    const deleteBtn = document.getElementById('agent-workflow-delete-btn');
    if (deleteBtn && deleteBtn.dataset.boundAgentWorkflowDelete !== '1') {
        deleteBtn.dataset.boundAgentWorkflowDelete = '1';
        deleteBtn.addEventListener('click', deleteSelectedAgentWorkflow);
    }
    const drawerDeleteBtn = document.getElementById('agent-dag-node-drawer-delete');
    if (drawerDeleteBtn && drawerDeleteBtn.dataset.boundAgentDagDrawerDelete !== '1') {
        drawerDeleteBtn.dataset.boundAgentDagDrawerDelete = '1';
        drawerDeleteBtn.addEventListener('click', deleteSelectedAgentDagNode);
    }
    const drawerCloseBtn = document.getElementById('agent-dag-node-drawer-close');
    if (drawerCloseBtn && drawerCloseBtn.dataset.boundAgentDagDrawerClose !== '1') {
        drawerCloseBtn.dataset.boundAgentDagDrawerClose = '1';
        drawerCloseBtn.addEventListener('click', closeAgentDagNodeDrawer);
    }
    const jsonCloseBtn = document.getElementById('agent-dag-json-close-btn');
    if (jsonCloseBtn && jsonCloseBtn.dataset.boundAgentDagJsonClose !== '1') {
        jsonCloseBtn.dataset.boundAgentDagJsonClose = '1';
        jsonCloseBtn.addEventListener('click', closeAgentDagJsonModal);
    }
    const jsonApplyBtn = document.getElementById('agent-dag-json-apply-btn');
    if (jsonApplyBtn && jsonApplyBtn.dataset.boundAgentDagJsonApply !== '1') {
        jsonApplyBtn.dataset.boundAgentDagJsonApply = '1';
        jsonApplyBtn.addEventListener('click', syncAgentDagJsonToCanvas);
    }
    const jsonModal = document.getElementById('agent-dag-json-modal');
    if (jsonModal && jsonModal.dataset.boundAgentDagJsonOverlay !== '1') {
        jsonModal.dataset.boundAgentDagJsonOverlay = '1';
    }
    // 运行时输入面板刷新按钮
    const inputsRefreshBtn = document.getElementById('agent-dag-inputs-refresh-btn') || document.getElementById('agent-dag-inputs-refresh');
    if (inputsRefreshBtn && inputsRefreshBtn.dataset.boundInputsRefresh !== '1') {
        inputsRefreshBtn.dataset.boundInputsRefresh = '1';
        inputsRefreshBtn.addEventListener('click', refreshAgentDagInputsPanel);
    }
};

window.Pivot.exposeModule('agent.automation', {
    renderAssetCenter: renderAutomationAssetCenter,
    showAssetCenter: showAutomationAssetCenter,
    showWorkflowEditor: showAutomationWorkflowEditor,
    openWorkflowMetadata: openAgentWorkflowMetadata,
    openWorkflowShare: openAgentWorkflowShare,
    openWorkflowDependencies: openAgentWorkflowDependencies,
    listWorkflows: () => agentWorkflowsCache.map(item => ({ ...item })),
    currentWorkflowId: () => String(activeAgentWorkflowId || ''),
    currentWorkflowName: currentAgentWorkflowName
});
window.Pivot.exposeModule('workspaces.implementations', { openAgentDagWorkbench });
