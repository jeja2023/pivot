(function () {
    let learningModulePromise = null;
    function loadLearningModule() {
        const current = window.Pivot?.moduleApi?.('agent.learning');
        if (current?.load) return Promise.resolve(current);
        if (learningModulePromise) return learningModulePromise;
        learningModulePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/chat/agent-learning.js';
            script.onload = () => resolve(window.Pivot?.moduleApi?.('agent.learning'));
            script.onerror = () => reject(new Error('个人学习模块加载失败。'));
            document.head.append(script);
        }).catch(error => { learningModulePromise = null; throw error; });
        return learningModulePromise;
    }
    const state = {
        skills: [], skillsPage: 1, skillsLimit: 8,
        residents: [], residentsPage: 1, residentsLimit: 8,
        profile: null, memoryPolicy: null,
        feedback: [], feedbackPage: 1, feedbackLimit: 15, feedbackSummary: null,
        proposals: [], proposalsPage: 1, proposalsLimit: 8,
        inbox: [], inboxPage: 1, inboxLimit: 20,
        goals: [], goalsPage: 1, goalsLimit: 8,
        reliability: [], reliabilityPage: 1, reliabilityLimit: 15,
        quality: null, channels: [], residentScope: 'self', diagnostics: new Map(), organizationCandidateByVersion: new Map()
    };
    // 控制面会在打开工作台、切换子页和保存操作后重复刷新。只允许最新一轮
    // 请求提交状态，避免旧请求在创建目标后返回并把新列表覆盖掉。
    let controlPlaneLoadSequence = 0;
    let controlPlaneLoadController = null;
    const escape = value => window.PivotSafeHtml?.escapeHtml
        ? window.PivotSafeHtml.escapeHtml(value)
        : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const escapeAttr = value => window.PivotSafeHtml?.escapeAttr
        ? window.PivotSafeHtml.escapeAttr(value)
        : escape(value).replace(/"/g, '&quot;');
    const formatDate = value => {
        const text = String(value || '').trim();
        if (!text) return '-';
        const date = new Date(text.includes('T') || /Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`);
        if (Number.isNaN(date.getTime())) return text;
        return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    };
    const shortText = (value, max = 120) => {
        const text = String(value ?? '').trim();
        return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    const canReviewOrganizationExperience = () => Boolean(isAdminUser?.() || currentUser?.role === 'root' || isSuperAdminUser?.());
    const getInboxTypeMeta = t => ({
        approval: { label: '待审批', badgeClass: 'badge-approval' },
        evolution: { label: '进化提议', badgeClass: 'badge-evolution' },
        run: { label: '任务运行', badgeClass: 'badge-run' },
        notification: { label: '运行通知', badgeClass: 'badge-notification' }
    }[t] || { label: '系统事件', badgeClass: 'badge-event' });

    const formatInboxTitle = item => {
        const raw = String(item.title || item.sourceType || '').trim();
        if (raw === 'DAG run completed' || raw.startsWith('DAG run')) return '工作流执行完成';
        if (raw === 'Run completed' || raw === 'Agent run completed') return '自主任务执行完成';
        if (raw === 'Task completed with errors') return '任务执行完成（含局部告警）';
        if (raw === 'Approval required' || raw === '任务需要审批') return '任务需要人工审批确认';
        if (raw === 'Evolution proposal' || raw === '智能体进化提案') return '智能体自进化提案';
        if (raw === 'Memory consolidated' || raw === '智能体结果已沉淀') return '智能体知识与记忆沉淀';
        return raw || '未命名通知';
    };

    const formatGoalTrigger = (spec = {}) => {
        const type = spec?.type || spec?.trigger_type || 'timer';
        if (type === 'timer') return `定时 ${spec?.timeOfDay || spec?.time || '09:00'}`;
        if (type === 'webhook') return 'Webhook 外部调用';
        if (type === 'file') return `文件变更 ${spec?.directory ? shortText(spec.directory, 20) : ''}`;
        if (type === 'database') return '数据变更增量监控';
        return '手动触发';
    };

    function openGoalModal(goal = null) {
        const modal = document.getElementById('agent-goal-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        const notice = document.getElementById('agent-goal-token-notice');
        if (notice) { notice.textContent = ''; notice.classList.add('hidden'); }

        const titleEl = document.getElementById('agent-goal-modal-title');
        const descEl = document.getElementById('agent-goal-modal-desc');
        const editIdInput = document.getElementById('agent-goal-edit-id');
        const submitBtn = document.getElementById('agent-goal-submit');

        if (goal) {
            if (titleEl) titleEl.textContent = '编辑持续目标';
            if (descEl) descEl.textContent = '修改自主 Agent 持续目标的目标描述与触发参数';
            if (editIdInput) editIdInput.value = goal.id;
            if (submitBtn) submitBtn.textContent = '保存修改';

            const titleInput = document.getElementById('agent-goal-title');
            const goalInput = document.getElementById('agent-goal-goal');
            const triggerSelect = document.getElementById('agent-goal-trigger');
            if (titleInput) titleInput.value = goal.title || '';
            if (goalInput) goalInput.value = goal.goal || '';
            const spec = goal.triggerSpec || {};
            const type = spec.type || spec.trigger_type || 'timer';
            if (triggerSelect) {
                triggerSelect.value = type;
                triggerSelect.dispatchEvent(new Event('change'));
            }
            if (type === 'timer') {
                const timeInput = document.getElementById('agent-goal-time');
                if (timeInput) timeInput.value = spec.timeOfDay || spec.time || '09:00';
            } else if (type === 'file') {
                const dirInput = document.getElementById('agent-goal-directory');
                if (dirInput) dirInput.value = spec.directory || '';
            } else if (type === 'database') {
                const queryInput = document.getElementById('agent-goal-query');
                if (queryInput) queryInput.value = spec.query || '';
            }
        } else {
            if (titleEl) titleEl.textContent = '新建持续目标';
            if (descEl) descEl.textContent = '配置由定时调度或外部事件源自动触发的自主 Agent 持续目标';
            if (editIdInput) editIdInput.value = '';
            if (submitBtn) submitBtn.textContent = '保存持续目标';
            document.getElementById('agent-goal-editor')?.reset();
            const triggerSelect = document.getElementById('agent-goal-trigger');
            if (triggerSelect) {
                triggerSelect.value = 'timer';
                triggerSelect.dispatchEvent(new Event('change'));
            }
        }

        setTimeout(() => document.getElementById('agent-goal-title')?.focus(), 50);
    }

    function closeGoalModal() {
        const modal = document.getElementById('agent-goal-modal');
        if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
        const editIdInput = document.getElementById('agent-goal-edit-id');
        if (editIdInput) editIdInput.value = '';
        document.getElementById('agent-goal-editor')?.reset();
    }

    function renderAgentControlPlane() {
        const inboxPanel = document.getElementById('agent-inbox-panel');
        const goalsPanel = document.getElementById('agent-goals-panel');
        const reliabilityPanel = document.getElementById('agent-reliability-panel');
        const qualityPanel = document.getElementById('agent-quality-panel');
        const channelsPanel = document.getElementById('agent-channels-panel');
        const unreadCount = state.inbox.filter(item => item.unread).length;
        const activeGoalsCount = state.goals.filter(g => g.status === 'active').length;
        const count = document.getElementById('agent-inbox-count');
        if (count) count.textContent = String(unreadCount);
        const shortcutBadge = document.getElementById('agent-inbox-shortcut-badge');
        if (shortcutBadge) { shortcutBadge.textContent = String(unreadCount); shortcutBadge.classList.toggle('hidden', unreadCount === 0); }
        const badgeInbox = document.getElementById('agent-cp-inbox-badge');
        if (badgeInbox) { badgeInbox.textContent = String(unreadCount); badgeInbox.classList.toggle('hidden', unreadCount === 0); }
        const badgeGoals = document.getElementById('agent-cp-goals-badge');
        if (badgeGoals) badgeGoals.textContent = `${activeGoalsCount}/${state.goals.length}`;
        const badgeChannels = document.getElementById('agent-cp-channels-badge');
        if (badgeChannels) badgeChannels.textContent = String(state.channels.length);
        if (goalsPanel) {
            const page = Math.max(1, Number(state.goalsPage || 1));
            const limit = Math.max(1, Number(state.goalsLimit || 8));
            const total = state.goals.length;
            const totalPages = Math.max(1, Math.ceil(total / limit));
            const currentPage = Math.min(page, totalPages);
            state.goalsPage = currentPage;
            const startIndex = (currentPage - 1) * limit;
            const pageGoals = state.goals.slice(startIndex, startIndex + limit);

            const goalStatusBadge = (status) => {
                if (status === 'active') return `<span class="agent-inbox-type-badge badge-run">● 运行中</span>`;
                if (status === 'paused') return `<span class="agent-inbox-type-badge badge-event">○ 已暂停</span>`;
                return `<span class="agent-inbox-type-badge badge-event">${escape(status)}</span>`;
            };
            setMarkup(goalsPanel, state.goals.length
                ? `<div class="agent-goal-table-wrap"><table class="agent-goal-table"><thead><tr><th style="width:52px" class="text-center">序号</th><th style="width:90px" class="text-center">状态</th><th style="width:170px">目标名称</th><th style="width:120px">触发方式</th><th>目标内容</th><th style="width:170px" class="text-center">操作</th></tr></thead><tbody>${pageGoals.map((goal, index) => `<tr><td class="text-center">${startIndex + index + 1}</td><td class="text-center">${goalStatusBadge(goal.status)}</td><td title="${escapeAttr(goal.title)}">${escape(shortText(goal.title, 24))}</td><td>${escape(formatGoalTrigger(goal.triggerSpec))}</td><td title="${escapeAttr(goal.goal || '')}">${escape(shortText(goal.goal || '-', 80))}</td><td class="text-center"><div class="agent-goal-table-actions">${goal.status === 'active' ? `<button type="button" class="btn-secondary btn-xs" data-agent-goal-action="pause" data-agent-goal-id="${escapeAttr(goal.id)}">暂停</button>` : goal.status === 'paused' ? `<button type="button" class="btn-secondary btn-xs" data-agent-goal-action="resume" data-agent-goal-id="${escapeAttr(goal.id)}">恢复</button>` : ''}<button type="button" class="btn-secondary btn-xs" data-agent-goal-action="edit" data-agent-goal-id="${escapeAttr(goal.id)}">编辑</button><button type="button" class="btn-danger btn-xs" data-agent-goal-action="delete" data-agent-goal-id="${escapeAttr(goal.id)}">删除</button></div></td></tr>`).join('')}</tbody></table></div>`
                : '<div class="agent-harness-empty-card"><strong>暂无持续目标</strong><span>点击右上角「新建持续目标」，可设置由定时或事件触发的自主智能体目标</span></div>');
            const paginationContainer = document.getElementById('agent-goals-pagination');
            if (paginationContainer) {
                if (window.renderWorkspacePagination) {
                    window.renderWorkspacePagination(paginationContainer, {
                        total,
                        limit,
                        page: currentPage,
                        onPageChange: (newPage) => {
                            state.goalsPage = newPage;
                            renderAgentControlPlane();
                        }
                    });
                } else {
                    paginationContainer.replaceChildren();
                }
            }
        }
        if (inboxPanel) {
            const page = Math.max(1, Number(state.inboxPage || 1));
            const limit = Math.max(1, Number(state.inboxLimit || 20));
            const total = state.inbox.length;
            const totalPages = Math.max(1, Math.ceil(total / limit));
            const currentPage = Math.min(page, totalPages);
            state.inboxPage = currentPage;
            const startIndex = (currentPage - 1) * limit;
            const pageItems = state.inbox.slice(startIndex, startIndex + limit);

            setMarkup(inboxPanel, state.inbox.length ? `<div class="agent-inbox-table-wrap"><table class="agent-inbox-table"><thead><tr><th class="text-center" style="width: 50px;">序号</th><th class="text-center" style="width: 96px;">类型</th><th style="width: 200px;">事项名称</th><th>内容说明</th><th class="text-center" style="width: 130px;">发生时间</th><th class="text-center" style="width: 110px;">操作</th></tr></thead><tbody>${pageItems.map((item, index) => {
                const meta = getInboxTypeMeta(item.sourceType);
                return `<tr class="${item.unread ? 'is-unread' : 'is-read'}"><td class="text-center">${startIndex + index + 1}</td><td class="text-center agent-inbox-type-col"><span class="agent-inbox-type-badge ${meta.badgeClass}">${meta.label}</span></td><td><strong class="agent-inbox-table-title" title="${escape(item.title || '')}">${escape(formatInboxTitle(item))}</strong></td><td><span class="agent-inbox-table-desc" title="${escape(item.body || '')}">${escape(shortText(item.body || '-', 120))}</span></td><td class="text-center agent-inbox-table-time">${escape(formatDate(item.createdAt))}</td><td class="text-center"><div class="agent-inbox-table-actions">${item.sourceType === 'approval' ? `<button type="button" class="btn-primary btn-xs" data-agent-inbox-action="approve" data-agent-inbox-type="approval" data-agent-inbox-id="${escapeAttr(item.sourceId)}">批准</button><button type="button" class="btn-danger btn-xs" data-agent-inbox-action="reject" data-agent-inbox-type="approval" data-agent-inbox-id="${escapeAttr(item.sourceId)}">拒绝</button>` : ''}${item.sourceType === 'evolution' ? `<button type="button" class="btn-secondary btn-xs" data-agent-inbox-action="validate" data-agent-inbox-type="evolution" data-agent-inbox-id="${escapeAttr(item.sourceId)}">验证</button>` : ''}${item.sourceType === 'notification' && item.unread ? `<button type="button" class="btn-secondary btn-xs" data-agent-inbox-action="read" data-agent-inbox-type="notification" data-agent-inbox-id="${escapeAttr(item.sourceId)}">已读</button>` : ''}${item.runId ? `<button type="button" class="btn-secondary btn-xs" data-agent-inbox-open-run="${escapeAttr(item.runId)}" data-agent-inbox-type="${escapeAttr(item.sourceType)}" data-agent-inbox-id="${escapeAttr(item.sourceId)}" data-agent-inbox-unread="${item.unread ? '1' : '0'}">详情</button>` : ''}</div></td></tr>`;
            }).join('')}</tbody></table></div>` : '<div class="agent-harness-empty-card"><strong>收件箱暂无待处理事项</strong><span>任务运行结果、人工审批请求与智能体进化提醒将在此实时汇聚</span></div>');

            const paginationContainer = document.getElementById('agent-inbox-pagination');
            if (paginationContainer) {
                if (window.renderWorkspacePagination) {
                    window.renderWorkspacePagination(paginationContainer, {
                        total,
                        limit,
                        page: currentPage,
                        onPageChange: (newPage) => {
                            state.inboxPage = newPage;
                            renderAgentControlPlane();
                        }
                    });
                } else {
                    paginationContainer.replaceChildren();
                }
            }
        }
        if (channelsPanel) {
            const chStatusBadge = (s) => s === 'active' ? `<span class="agent-inbox-type-badge badge-run">● 活跃</span>` : s === 'error' ? `<span class="agent-inbox-type-badge badge-approval">✕ 异常</span>` : `<span class="agent-inbox-type-badge badge-event">○ 停用</span>`;
            const chListHtml = state.channels.length
                ? `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:56px" class="tc">序号</th><th style="width:100px">渠道类型</th><th>目标地址 / 用户标识</th><th style="width:130px">凭据引用</th><th style="width:80px" class="tc">状态</th><th style="width:60px" class="tc">操作</th></tr></thead><tbody>${state.channels.map((ch, i) => `<tr><td class="tc font-mono">${i + 1}</td><td>${escape(ch.channelType)}</td><td title="${escapeAttr(ch.channelKey)}">${escape(ch.channelKey)}</td><td class="mono">${escape(ch.credentialRef || '—')}</td><td class="tc">${chStatusBadge(ch.status)}</td><td class="tc"><div class="aht-actions"><button type="button" class="btn-secondary btn-xs" data-agent-channel-test="${escapeAttr(ch.id)}">测试</button></div></td></tr>`).join('')}</tbody></table></div>`
                : '<div class="agent-harness-empty-card">暂无活跃外部通知渠道</div>';
            setMarkup(channelsPanel, `<div class="agent-channel-editor-form"><div class="agent-channel-form-row"><label class="modal-form-field"><span>渠道类型</span><select id="agent-channel-type" class="form-input"><option value="webhook">Webhook</option><option value="im">企业 IM (企微/钉钉/飞书)</option><option value="email">邮件通知</option><option value="web">Web 弹窗</option></select></label><label class="modal-form-field"><span>目标地址 / 用户标识</span><input id="agent-channel-key" class="form-input" placeholder="Webhook URL 或接收人标识"></label><label class="modal-form-field"><span>凭据引用 (可选)</span><input id="agent-channel-credential" class="form-input" placeholder="secret_key 等凭据别名"></label><label class="modal-form-field"><span>网关 Endpoint (可选)</span><input id="agent-channel-endpoint" class="form-input" placeholder="自定义 endpoint"></label></div><div class="agent-channel-form-actions"><span class="agent-channel-form-hint">填写类型与目标地址后点击添加</span><button type="button" class="btn-primary btn-xs" data-agent-channel-create>+ 添加渠道</button></div></div>${chListHtml}`);
        }
        if (reliabilityPanel) {
            const page = Math.max(1, Number(state.reliabilityPage || 1));
            const limit = Math.max(1, Number(state.reliabilityLimit || 15));
            const total = state.reliability.length;
            const totalPages = Math.max(1, Math.ceil(total / limit));
            const currentPage = Math.min(page, totalPages);
            state.reliabilityPage = currentPage;
            const startIndex = (currentPage - 1) * limit;
            const pageSignals = state.reliability.slice(startIndex, startIndex + limit);

            setMarkup(reliabilityPanel, state.reliability.length
                ? `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:56px" class="tc">序号</th><th>工具名称</th><th style="width:90px" class="tc">样本数</th><th style="width:90px" class="tc">可靠性分</th><th style="width:100px" class="tc">置信度</th></tr></thead><tbody>${pageSignals.map((sig, i) => `<tr><td class="tc font-mono">${startIndex + i + 1}</td><td title="${escapeAttr(sig.toolName)}">${escape(sig.toolName)}</td><td class="tc">${escape(sig.sampleCount)}</td><td class="tc">${Math.round(sig.score * 100)}</td><td class="tc">${sig.confidence > 0 ? `<span class="agent-inbox-type-badge badge-run">置信度高</span>` : `<span class="agent-inbox-type-badge badge-event">积累中</span>`}</td></tr>`).join('')}</tbody></table></div>`
                : '<div class="agent-harness-empty-card"><strong>暂无工具可靠性样本</strong><span>随智能体任务执行自动记录各工具调用稳定性</span></div>');

            const paginationContainer = document.getElementById('agent-reliability-pagination');
            if (paginationContainer) {
                if (window.renderWorkspacePagination) {
                    window.renderWorkspacePagination(paginationContainer, {
                        total,
                        limit,
                        page: currentPage,
                        onPageChange: (newPage) => {
                            state.reliabilityPage = newPage;
                            renderAgentControlPlane();
                        }
                    });
                } else {
                    paginationContainer.replaceChildren();
                }
            }
        }
        if (qualityPanel) {
            const q = state.quality || {};
            setMarkup(qualityPanel, `<div class="agent-quality-metrics-grid"><div class="agent-metric-tile"><span>任务成功率</span><strong>${Math.round(Number(q.runs?.successRate ?? 1) * 100)}%</strong><small>近 30 天完成率</small></div><div class="agent-metric-tile"><span>审批中位数</span><strong>${Math.round(Number(q.approvals?.medianSeconds || 0) / 60)} 分钟</strong><small>人工介入耗时</small></div><div class="agent-metric-tile"><span>工具错误率</span><strong>${Math.round(Number(q.tools?.errorRate || 0) * 100)}%</strong><small>外部调用异常率</small></div><div class="agent-metric-tile"><span>渠道死信</span><strong>${escape(q.deliveries?.deadLetter || 0)}</strong><small>未送达消息队列</small></div></div>`);
        }
    }

    async function loadControlPlane() {
        const sequence = ++controlPlaneLoadSequence;
        controlPlaneLoadController?.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        controlPlaneLoadController = controller;
        const requestOptions = { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) };
        try {
            const [inbox, goals, reliability, quality, channels] = await Promise.all([
                apiJson(`${API_BASE}/agents/inbox?limit=100`, requestOptions),
                apiJson(`${API_BASE}/agents/goals?limit=50`, requestOptions),
                apiJson(`${API_BASE}/agents/tools/reliability?days=30`, requestOptions),
                apiJson(`${API_BASE}/agents/quality?days=30`, requestOptions).catch(() => ({ dashboard: null })),
                apiJson(`${API_BASE}/agents/channels?status=active`, requestOptions).catch(() => ({ data: [] }))
            ]);
            if (sequence !== controlPlaneLoadSequence) return false;
            state.inbox = Array.isArray(inbox.data) ? inbox.data : [];
            state.goals = Array.isArray(goals.data) ? goals.data : [];
            state.reliability = Array.isArray(reliability.signals) ? reliability.signals : [];
            state.quality = quality.dashboard || null;
            state.channels = Array.isArray(channels.data) ? channels.data : [];
            renderAgentControlPlane();
            let currentSub = 'inbox';
            try { currentSub = sessionStorage.getItem('pivot.agent.cp_subview') || 'inbox'; } catch (_) {}
            if (currentSub === 'quality') {
                loadFeedback().catch(() => {});
                window.Pivot?.moduleApi?.('agent.evaluations')?.bind?.();
                window.Pivot?.moduleApi?.('agent.evaluations')?.loadSuites?.({ silent: true })?.catch(() => {});
            }
            return true;
        } catch (error) {
            if (controller?.signal.aborted || sequence !== controlPlaneLoadSequence) return false;
            throw error;
        } finally {
            if (controlPlaneLoadController === controller) controlPlaneLoadController = null;
        }
    }

    async function saveAgentGoal(event) {
        event.preventDefault();
        const editId = document.getElementById('agent-goal-edit-id')?.value;
        const triggerType = document.getElementById('agent-goal-trigger')?.value || 'timer';
        const triggerSpec = triggerType === 'timer' ? { type: 'timer', frequency: 'daily', timeOfDay: document.getElementById('agent-goal-time')?.value || '09:00' } : triggerType === 'file' ? { type: 'file', directory: document.getElementById('agent-goal-directory')?.value || '' } : triggerType === 'database' ? { type: 'database', query: document.getElementById('agent-goal-query')?.value || '' } : { type: triggerType };
        const payload = {
            title: document.getElementById('agent-goal-title')?.value,
            goal: document.getElementById('agent-goal-goal')?.value,
            triggerSpec
        };

        try {
            if (editId) {
                await apiJson(`${API_BASE}/agents/goals/${encodeURIComponent(editId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                closeGoalModal();
                if (typeof showToast === 'function') showToast('持续目标已成功修改', 'success');
                setNotice('持续目标已修改。', 'success');
            } else {
                const response = await apiJson(`${API_BASE}/agents/goals`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const tokenNotice = document.getElementById('agent-goal-token-notice');
                if (tokenNotice && response.token) {
                    tokenNotice.textContent = `Webhook 令牌（仅展示一次，请妥善保存）：${response.token}`;
                    tokenNotice.classList.remove('hidden');
                } else {
                    closeGoalModal();
                }
                if (typeof showToast === 'function') showToast('持续目标已成功创建', 'success');
                setNotice('持续目标已创建。', 'success');
            }
            await loadControlPlane();
        } catch (error) {
            const actionName = editId ? '修改' : '创建';
            if (typeof showToast === 'function') showToast(error.message || `持续目标${actionName}失败`, 'error');
            setNotice(error.message || `持续目标${actionName}失败。`, 'error');
        }
    }

    async function deleteAgentGoal(id) {
        if (!confirm('确定要删除该持续目标吗？删除后将终止相关的自动化触发')) return;
        try {
            await apiJson(`${API_BASE}/agents/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (typeof showToast === 'function') showToast('持续目标已成功删除', 'success');
            setNotice('持续目标已删除。', 'success');
            await loadControlPlane();
        } catch (error) {
            if (typeof showToast === 'function') showToast(error.message || '删除持续目标失败', 'error');
            setNotice(error.message || '删除持续目标失败。', 'error');
        }
    }
    async function changeAgentGoal(id, action) {
        try { await apiJson(`${API_BASE}/agents/goals/${encodeURIComponent(id)}/${action}`, { method: 'POST' }); await loadControlPlane(); } catch (error) { setNotice(error.message || '持续目标操作失败。', 'error'); }
    }
    const jsonText = value => { try { return JSON.stringify(value ?? {}, null, 2); } catch (_) { return '{}'; } };

    const getCurrentUser = () => (typeof currentUser !== 'undefined' ? currentUser : window.currentUser || null);

    function setNotice(message = '', tone = '') {
        if (!message) return;
        if (typeof showToast === 'function') {
            const toastType = tone === 'error' ? 'error' : (tone === 'warn' ? 'warning' : 'success');
            showToast(message, toastType);
        }
        const notice = document.getElementById('agent-harness-notice');
        if (notice) {
            notice.textContent = message;
            notice.className = `agent-harness-notice${tone ? ` is-${tone}` : ''}`;
        }
    }

    function setMarkup(element, markup) {
        if (!element) return;
        if (window.PivotSafeHtml?.setHtml) window.PivotSafeHtml.setHtml(element, markup);
        else element.textContent = String(markup || '');
    }

    function prependMarkup(element, markup) {
        if (!element) return;
        if (window.PivotSafeHtml?.prependHtml) window.PivotSafeHtml.prependHtml(element, markup);
        else element.prepend(document.createTextNode(String(markup || '')));
    }

    async function apiJson(path, options = {}) {
        const response = await apiFetch(path, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
        return data;
    }

    function renderSkills() {
        const list = document.getElementById('agent-harness-skill-list');
        const paginationContainer = document.getElementById('agent-harness-skill-pagination');
        if (!list) return;
        if (!state.skills.length) {
            if (paginationContainer) paginationContainer.replaceChildren();
            setMarkup(list, '<div class="agent-harness-empty-card"><svg class="agent-harness-empty-svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg><strong>暂无已安装技能包</strong><span>可通过右侧表单填入清单或导入 .skill.zip 离线包</span></div>');
            return;
        }
        const page = Math.max(1, Number(state.skillsPage || 1)), limit = Math.max(1, Number(state.skillsLimit || 8)), total = state.skills.length;
        const totalPages = Math.max(1, Math.ceil(total / limit)), currentPage = Math.min(page, totalPages);
        state.skillsPage = currentPage;
        const startIndex = (currentPage - 1) * limit, pageSkills = state.skills.slice(startIndex, startIndex + limit);
        const userId = String(getCurrentUser()?.id || '');
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:40px" class="tc">序号</th><th style="width:140px">技能名称</th><th style="width:56px" class="tc">范围</th><th style="width:70px" class="tc">状态</th><th style="width:120px" class="mono">包名 · 版本</th><th>说明</th><th style="width:90px" class="tc">更新时间</th><th style="width:100px" class="tc">操作</th></tr></thead><tbody>${pageSkills.map((skill, i) => {
            const own = String(skill.user_id || '') === userId, status = String(skill.status || '').toLowerCase();
            const organizationCandidate = state.organizationCandidateByVersion.get(String(skill.versionId || skill.release?.skill_version_id || skill.id || ''));
            const scopeLabel = ({ user: '个人', shared: '共享', global: '全局' })[skill.scope] || skill.scope || '个人';
            const statusBadge = organizationCandidate ? `<span class="agent-inbox-type-badge badge-approval">组织候选</span>` : status === 'enabled' ? `<span class="agent-inbox-type-badge badge-run">已启用</span>` : `<span class="agent-inbox-type-badge badge-event">已停用</span>`;
            const description = organizationCandidate ? `来自个人经验 · ${organizationCandidate.status === 'pending_review' ? '待管理员审批' : organizationCandidate.status === 'approved' ? '已审批，待验证' : '验证/发布中'} · ${skill.description || '脱敏受控候选'}` : skill.description || '未填写说明';
            return `<tr class="${status === 'disabled' ? 'is-muted' : ''}"><td class="tc">${startIndex + i + 1}</td><td title="${escapeAttr(skill.title || skill.name)}">${escape(shortText(skill.title || skill.name, 20))}</td><td class="tc">${escape(scopeLabel)}</td><td class="tc">${statusBadge}</td><td class="mono" title="${escapeAttr(`${skill.name} v${skill.version}`)}">${escape(shortText(`${skill.name || ''}`, 14))} · v${escape(skill.version || '')}</td><td title="${escapeAttr(description)}">${escape(shortText(description, 60))}</td><td class="tc">${escape(formatDate(skill.updated_at))}</td><td class="tc"><div class="aht-actions">${own ? `<button type="button" class="btn-secondary btn-xs" data-agent-skill-manage="${escapeAttr(skill.versionId || skill.release?.skill_version_id || skill.id)}">治理</button>` : ''}${own && status === 'enabled' ? `<button type="button" class="btn-secondary btn-xs" data-agent-harness-disable-skill="${escapeAttr(skill.name)}">停用</button>` : ''}${own && ['draft', 'validated'].includes(status) ? `<button type="button" class="btn-secondary btn-xs" data-agent-skill-validate="${escapeAttr(skill.id)}">验证</button>` : ''}${own && status === 'validated' ? `<button type="button" class="btn-primary btn-xs" data-agent-skill-publish="${escapeAttr(skill.id)}">发布</button>` : ''}</div></td></tr>`;
        }).join('')}</tbody></table></div>`);

        if (paginationContainer) {
            if (window.renderWorkspacePagination) {
                window.renderWorkspacePagination(paginationContainer, { total, limit, page: currentPage, onPageChange: newPage => { state.skillsPage = newPage; renderSkills(); } });
            } else { paginationContainer.replaceChildren(); }
        }
    }

    function populateSkillSelect() {
        const select = document.getElementById('agent-skill-select');
        if (!select) return;
        const previous = select.value;
        const options = ['<option value="">不指定技能</option>'].concat(state.skills.filter(skill => String(skill.status || 'enabled') === 'enabled').map(skill => `<option value="${escapeAttr(skill.id || skill.name)}">${escape(skill.title || skill.name)} · v${escape(skill.version || '')}</option>`));
        setMarkup(select, options.join(''));
        if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
    }

    async function loadSkills() {
        const [data, versions, releases, candidates] = await Promise.all([
            apiJson(`${API_BASE}/agents/skills?includeDisabled=true`, { cache: 'no-store' }),
            apiJson(`${API_BASE}/agents/skills/versions?limit=100`, { cache: 'no-store' }).catch(() => ({ data: [] })),
            apiJson(`${API_BASE}/agents/skills/releases?limit=100`, { cache: 'no-store' }).catch(() => ({ data: [] })),
            canReviewOrganizationExperience() ? apiJson(`${API_BASE}/agents/evolution/proposals?limit=100`, { cache: 'no-store' }).catch(() => ({ data: [] })) : Promise.resolve({ data: [] })
        ]);
        state.organizationCandidateByVersion = new Map((Array.isArray(candidates.data) ? candidates.data : [])
            .filter(item => item.scope === 'organization_candidate' && item.artifactType === 'skill')
            .map(item => [String(item.artifactVersionId || ''), item]));
        const published = Array.isArray(data.data) ? data.data : [];
        const drafts = (Array.isArray(versions.data) ? versions.data : []).filter(version => !published.some(skill => String(skill.name) === String(version.name) && String(skill.version) === String(version.version))).map(version => ({ ...version, title: version.name, scope: 'user', status: version.status === 'published' ? 'enabled' : 'draft', user_id: getCurrentUser()?.id }));
        const releaseMap = new Map((Array.isArray(releases.data) ? releases.data : []).map(release => [`${release.name}@${release.version}`, release]));
        state.skills = [...published, ...drafts].map(skill => {
            const release = releaseMap.get(`${skill.name}@${skill.version}`) || null;
            return { ...skill, release, releaseId: release?.id || null, versionId: skill.id || release?.skill_version_id || null };
        });
        renderSkills();
        populateSkillSelect();
        return state.skills;
    }

    async function registerSkill() {
        const manifest = document.getElementById('agent-harness-skill-manifest')?.value.trim();
        const instructions = document.getElementById('agent-harness-skill-instructions')?.value || '';
        if (!manifest) return setNotice('请填写 SKILL.md 内容。', 'error');
        if (!manifest.startsWith('---')) return setNotice('技能创作只接受以 --- Frontmatter 开头的 SKILL.md。', 'error');
        const markdown = instructions.trim() ? `${manifest}\n\n${instructions.trim()}\n` : manifest;
        const button = document.getElementById('agent-harness-skill-register');
        if (button) button.disabled = true;
        try {
            await apiJson(`${API_BASE}/agents/skills/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }) });
            setNotice('SKILL.md 已创建为个人草稿。', 'success');
            document.getElementById('agent-harness-skill-manifest').value = '';
            document.getElementById('agent-harness-skill-instructions').value = '';
            await loadSkills();
        } catch (error) { setNotice(error.message || '技能包注册失败。', 'error'); }
        finally { if (button) button.disabled = false; }
    }

    async function uploadSkillPackage(file) {
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        const input = document.getElementById('agent-harness-skill-file');
        if (input) input.disabled = true;
        try {
            await apiJson(`${API_BASE}/agents/skills/package`, { method: 'POST', body: formData });
            setNotice('技能包导入并校验成功。', 'success');
            await loadSkills();
        } catch (error) { setNotice(error.message || '技能包导入失败。', 'error'); }
        finally { if (input) { input.disabled = false; input.value = ''; } }
    }

    async function disableSkill(name) {
        try {
            await apiJson(`${API_BASE}/agents/skills/${encodeURIComponent(name)}/disable`, { method: 'POST' });
            setNotice('技能包已停用。', 'success');
            await loadSkills();
        } catch (error) { setNotice(error.message || '技能包停用失败。', 'error'); }
    }

    async function validateSkillVersion(id) {
        try { await apiJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(id)}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); setNotice('Skill 已通过验证。', 'success'); await loadSkills(); } catch (error) { setNotice(error.message || 'Skill 验证失败。', 'error'); }
    }

    async function publishSkillVersion(id) {
        try { await apiJson(`${API_BASE}/agents/skills/versions/${encodeURIComponent(id)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'personal' }) }); setNotice('Skill 已发布。', 'success'); await loadSkills(); } catch (error) { setNotice(error.message || 'Skill 发布失败。', 'error'); }
    }

    function renderResidents() {
        const list = document.getElementById('agent-harness-residency-list'), paginationContainer = document.getElementById('agent-harness-residency-pagination');
        if (!list) return;
        if (!state.residents.length) {
            if (paginationContainer) paginationContainer.replaceChildren();
            setMarkup(list, '<div class="agent-harness-empty-card agent-harness-empty-card--wide"><svg class="agent-harness-empty-svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg><strong>当前暂无活跃的常驻实例</strong><span>自主任务或复杂会话启用环境复用后，常驻实例将在此处展示运行租约、命中次数与生命周期状态。</span></div>');
            return;
        }
        const page = Math.max(1, Number(state.residentsPage || 1)), limit = Math.max(1, Number(state.residentsLimit || 8)), total = state.residents.length;
        const totalPages = Math.max(1, Math.ceil(total / limit)), currentPage = Math.min(page, totalPages);
        state.residentsPage = currentPage;
        const startIndex = (currentPage - 1) * limit, pageResidents = state.residents.slice(startIndex, startIndex + limit);
        const residentStatusBadge = (s) => s === 'active' ? `<span class="agent-inbox-type-badge badge-run">活跃中</span>` : s === 'evicted' ? `<span class="agent-inbox-type-badge badge-approval">已驱逐</span>` : `<span class="agent-inbox-type-badge badge-event">${({ idle: '空闲中', stopped: '已停止' })[s] || s || '空闲中'}</span>`;
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:48px" class="tc">序号</th><th>实例 Key</th><th style="width:80px" class="tc">状态</th><th style="width:70px" class="tc">命中数</th><th style="width:140px" class="mono">关联运行 ID</th><th style="width:125px" class="tc">最近访问</th><th style="width:125px" class="tc">过期时间</th><th style="width:70px" class="tc">操作</th></tr></thead><tbody>${pageResidents.map((item, i) => {
            const status = String(item.status || '').toLowerCase();
            return `<tr><td class="tc">${startIndex + i + 1}</td><td title="${escapeAttr(item.resident_key || item.resident_id)}">${escape(shortText(item.resident_key || item.resident_id, 24))}</td><td class="tc">${residentStatusBadge(status)}</td><td class="tc">${escape(item.hit_count || 0)}</td><td class="mono" title="${escapeAttr(item.run_id || '')}">${escape(shortText(item.run_id || '—', 12))}</td><td class="tc">${escape(formatDate(item.last_accessed_at))}</td><td class="tc">${escape(formatDate(item.expires_at))}</td><td class="tc"><div class="aht-actions"><button type="button" class="btn-secondary btn-xs" data-agent-harness-evict-resident="${escapeAttr(item.resident_id)}">驱逐</button></div></td></tr>`;
        }).join('')}</tbody></table></div>`);

        if (paginationContainer) {
            if (window.renderWorkspacePagination) {
                window.renderWorkspacePagination(paginationContainer, { total, limit, page: currentPage, onPageChange: newPage => { state.residentsPage = newPage; renderResidents(); } });
            } else { paginationContainer.replaceChildren(); }
        }
    }

    async function loadResidents() {
        const scope = document.getElementById('agent-harness-residency-scope')?.value || 'self';
        state.residentScope = scope;
        const query = scope === 'all' && isSuperAdminUser() ? '?scope=all&limit=200' : '?limit=200';
        const data = await apiJson(`${API_BASE}/agents/residencies${query}`, { cache: 'no-store' });
        state.residents = Array.isArray(data.data) ? data.data : [];
        renderResidents();
        return state.residents;
    }

    async function evictResident(residentId) {
        try {
            await apiJson(`${API_BASE}/agents/residencies/${encodeURIComponent(residentId)}/evict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: state.residentScope }) });
            setNotice('常驻实例已驱逐。', 'success');
            await loadResidents();
        } catch (error) { setNotice(error.message || '常驻实例驱逐失败。', 'error'); }
    }

    async function sweepResidents() {
        try {
            const data = await apiJson(`${API_BASE}/agents/residencies/sweep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: state.residentScope }) });
            setNotice(`已清理 ${Number(data.evicted || 0)} 个过期常驻实例。`, 'success');
            await loadResidents();
        } catch (error) { setNotice(error.message || '常驻实例清理失败。', 'error'); }
    }

    const splitLines = value => String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);

    function fillProfile(profile = {}) {
        const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
        setValue('agent-profile-display-name', profile.displayName);
        setValue('agent-profile-role', profile.role);
        setValue('agent-profile-preferences', jsonText(profile.preferences || {}));
        setValue('agent-profile-work-habits', (profile.workHabits || []).join('\n'));
        setValue('agent-profile-tools', (profile.frequentTools || []).join('\n'));
        setValue('agent-profile-tasks', (profile.commonTasks || []).join('\n'));
        setValue('agent-profile-tone', profile.communicationStyle?.tone || 'professional');
        setValue('agent-profile-verbosity', profile.communicationStyle?.verbosity || 'balanced');
    }

    async function loadProfile() {
        const data = await apiJson(`${API_BASE}/agents/profile`, { cache: 'no-store' });
        state.profile = data.profile || {};
        fillProfile(state.profile);
        return state.profile;
    }

    async function saveProfile() {
        let preferences = {};
        try { preferences = JSON.parse(document.getElementById('agent-profile-preferences')?.value || '{}'); } catch (_) { return setNotice('偏好必须是合法 JSON。', 'error'); }
        const payload = {
            displayName: document.getElementById('agent-profile-display-name')?.value || '',
            role: document.getElementById('agent-profile-role')?.value || '',
            preferences,
            workHabits: splitLines(document.getElementById('agent-profile-work-habits')?.value),
            frequentTools: splitLines(document.getElementById('agent-profile-tools')?.value),
            commonTasks: splitLines(document.getElementById('agent-profile-tasks')?.value),
            communicationStyle: {
                ...(state.profile?.communicationStyle || {}),
                tone: document.getElementById('agent-profile-tone')?.value || 'professional',
                verbosity: document.getElementById('agent-profile-verbosity')?.value || 'balanced'
            }
        };
        try {
            const data = await apiJson(`${API_BASE}/agents/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            state.profile = data.profile || payload;
            setNotice('个人 Agent 档案已保存。', 'success');
        } catch (error) { setNotice(error.message || '个人档案保存失败。', 'error'); }
    }

    function openProfileWizard() {
        const panel = document.getElementById('agent-profile-wizard-panel');
        if (!panel) return;
        panel.classList.toggle('hidden');
        const profile = state.profile || {};
        const name = document.getElementById('agent-wizard-name');
        const language = document.getElementById('agent-wizard-language');
        const verbosity = document.getElementById('agent-wizard-verbosity');
        if (name) name.value = profile.displayName || '';
        if (language) language.value = profile.communicationStyle?.language || 'zh-CN';
        if (verbosity) verbosity.value = profile.communicationStyle?.verbosity || 'balanced';
    }

    async function saveProfileWizard() {
        try {
            await apiJson(`${API_BASE}/agents/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: document.getElementById('agent-wizard-name')?.value || '', communicationStyle: { language: document.getElementById('agent-wizard-language')?.value || 'zh-CN', verbosity: document.getElementById('agent-wizard-verbosity')?.value || 'balanced' }, source: 'wizard' }) });
            setNotice('快速设置已完成。', 'success');
            document.getElementById('agent-profile-wizard-panel')?.classList.add('hidden');
            await loadProfile();
        } catch (error) { setNotice(error.message || '快速设置保存失败。', 'error'); }
    }

    async function loadMemoryPolicy() {
        const data = await apiJson(`${API_BASE}/memories/policy`, { cache: 'no-store' });
        state.memoryPolicy = data.policy || {};
        const autoCapture = document.getElementById('agent-memory-auto-capture');
        if (autoCapture) autoCapture.checked = state.memoryPolicy.autoCapture !== false;
        const blocked = new Set(state.memoryPolicy.blockedCategories || []);
        document.querySelectorAll('[data-agent-memory-blocked]').forEach(input => { input.checked = blocked.has(input.value); });
        return state.memoryPolicy;
    }

    async function saveMemoryPolicy() {
        const blockedCategories = [...document.querySelectorAll('[data-agent-memory-blocked]:checked')].map(input => input.value);
        try {
            const data = await apiJson(`${API_BASE}/memories/policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoCapture: document.getElementById('agent-memory-auto-capture')?.checked !== false, blockedCategories }) });
            state.memoryPolicy = data.policy;
            setNotice('记忆治理策略已保存。敏感信息始终不会持久化。', 'success');
        } catch (error) {
            setNotice(error.message || '记忆治理策略保存失败。', 'error');
        }
    }

    function renderFeedback() {
        const summary = document.getElementById('agent-feedback-summary');
        const list = document.getElementById('agent-feedback-list');
        const paginationContainer = document.getElementById('agent-feedback-pagination');
        if (summary) {
            if (state.feedbackSummary) {
                const s = state.feedbackSummary;
                const total = Number(s.total || 0), rate = Math.round(Number(s.successRate || 0) * 100);
                const avg = s.averageRating == null ? '—' : Number(s.averageRating).toFixed(1);
                const failTools = (s.frequentToolFailures || []).slice(0, 3).map(item => `${item.tool} (${item.count})`).join('、') || '无';
                setMarkup(summary, `<div class="agent-feedback-metrics"><div class="agent-feedback-metric-card"><span class="metric-label">近 ${escape(s.days || 30)} 天总反馈</span><strong class="metric-value">${total} <small>次</small></strong></div><div class="agent-feedback-metric-card"><span class="metric-label">任务执行成功率</span><strong class="metric-value ${rate >= 80 ? 'is-good' : rate >= 50 ? 'is-warn' : 'is-bad'}">${rate}%</strong></div><div class="agent-feedback-metric-card"><span class="metric-label">综合平均评分</span><strong class="metric-value">${avg} <small>${s.averageRating != null ? '分' : ''}</small></strong></div><div class="agent-feedback-metric-card"><span class="metric-label">高频失败工具</span><strong class="metric-value metric-tools" title="${escape(failTools)}">${escape(failTools)}</strong></div></div>`);
            } else {
                setMarkup(summary, '<div class="agent-feedback-empty">暂无统计指标。</div>');
            }
        }
        if (!list) return;
        if (!state.feedback.length) {
            if (paginationContainer) paginationContainer.replaceChildren();
            setMarkup(list, '<div class="agent-harness-empty-card"><strong>暂无结果反馈</strong><span>任务完成后可在任务详情提交成功、失败或修正意见。</span></div>');
            return;
        }
        const page = Math.max(1, Number(state.feedbackPage || 1)), limit = Math.max(1, Number(state.feedbackLimit || 15)), total = state.feedback.length;
        const totalPages = Math.max(1, Math.ceil(total / limit)), currentPage = Math.min(page, totalPages);
        state.feedbackPage = currentPage;
        const startIndex = (currentPage - 1) * limit, pageFeedback = state.feedback.slice(startIndex, startIndex + limit);
        const fbOutcomeBadge = (o) => o === 'success' ? `<span class="agent-inbox-type-badge badge-run">成功</span>` : o === 'failure' ? `<span class="agent-inbox-type-badge badge-approval">失败</span>` : `<span class="agent-inbox-type-badge badge-event">${escape(o || '反馈')}</span>`;
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:56px" class="tc">序号</th><th style="width:320px" class="tc">运行 ID</th><th style="width:80px" class="tc">结论</th><th style="width:70px" class="tc">评分</th><th>修正意见</th><th style="width:160px" class="tc">时间</th></tr></thead><tbody>${pageFeedback.map((item, i) => `<tr><td class="tc font-mono">${startIndex + i + 1}</td><td class="tc mono" title="${escapeAttr(item.runId)}">${escape(shortText(item.runId, 36))}</td><td class="tc">${fbOutcomeBadge(item.outcome)}</td><td class="tc">${item.rating ? `${item.rating}/5` : '—'}</td><td title="${escapeAttr(item.correction || item.modifiedAnswer || '')}">${escape(shortText(item.correction || item.modifiedAnswer || '—', 80))}</td><td class="tc">${escape(formatDate(item.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`);
        if (paginationContainer) {
            if (window.renderWorkspacePagination) {
                window.renderWorkspacePagination(paginationContainer, { total, limit, page: currentPage, onPageChange: newPage => { state.feedbackPage = newPage; renderFeedback(); } });
            } else { paginationContainer.replaceChildren(); }
        }
    }

    async function loadFeedback() {
        const [summary, list] = await Promise.all([
            apiJson(`${API_BASE}/agents/feedback/summary?days=30`, { cache: 'no-store' }),
            apiJson(`${API_BASE}/agents/feedback?limit=100`, { cache: 'no-store' })
        ]);
        state.feedbackSummary = summary.summary || null;
        state.feedback = Array.isArray(list.data) ? list.data : [];
        renderFeedback();
    }

    function renderProposals() {
        const list = document.getElementById('agent-evolution-list'), paginationContainer = document.getElementById('agent-evolution-pagination');
        if (!list) return;
        if (!state.proposals.length) {
            if (paginationContainer) paginationContainer.replaceChildren();
            setMarkup(list, '<div class="agent-harness-empty-card"><strong>暂无进化提议</strong><span>Agent 的 Skill、工作流和偏好调整建议都会先进入这里等待确认。</span></div>');
            return;
        }
        const kindLabels = { preference: '偏好调整', skill: '创建 Skill', workflow: '保存工作流' };
        const statusLabels = { draft: '草稿', approved: '已批准', pending_review: '待管理员审批', versioned_draft: '已验证待发布', published: '已发布', validation_failed: '验证失败', rolled_back: '已回滚', rejected: '已拒绝', pending: '待确认', candidate_created: '待确认', waiting_user_review: '待确认', personal_active: '个人已启用', paused: '已暂停', archived: '已归档', applied: '已应用' };
        const page = Math.max(1, Number(state.proposalsPage || 1)), limit = Math.max(1, Number(state.proposalsLimit || 8)), total = state.proposals.length;
        const totalPages = Math.max(1, Math.ceil(total / limit)), currentPage = Math.min(page, totalPages);
        state.proposalsPage = currentPage;
        const startIndex = (currentPage - 1) * limit, pageProposals = state.proposals.slice(startIndex, startIndex + limit);
        const propStatusBadge = (s) => s === 'approved' || s === 'applied' || s === 'published' ? `<span class="agent-inbox-type-badge badge-run">${escape(statusLabels[s] || s)}</span>` : s === 'pending' || s === 'pending_review' ? `<span class="agent-inbox-type-badge badge-approval">${escape(statusLabels[s] || s)}</span>` : `<span class="agent-inbox-type-badge badge-event">${escape(statusLabels[s] || s)}</span>`;
        const proposalDescription = item => item.scope === 'organization_candidate'
            ? `${item.description || '组织共享候选'} · 脱敏证据：${shortText(JSON.stringify(item.evidenceSummary || {}), 80)} · 权限差异：${shortText(JSON.stringify(item.permissionDiff || {}), 50)}`
            : item.description || '无详细说明';
        setMarkup(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th style="width:40px" class="tc">序号</th><th style="width:160px">提议标题</th><th style="width:90px" class="tc">类型</th><th style="width:90px" class="tc">状态</th><th>说明</th><th style="width:130px" class="tc">操作</th></tr></thead><tbody>${pageProposals.map((item, i) => `<tr><td class="tc">${startIndex + i + 1}</td><td title="${escapeAttr(item.title || '')}">${escape(shortText(item.title || '未命名提议', 22))}</td><td class="tc">${escape(kindLabels[item.kind] || item.kind || '提议')}</td><td class="tc">${propStatusBadge(item.status)}</td><td title="${escapeAttr(proposalDescription(item))}">${escape(shortText(proposalDescription(item), 100))}</td><td class="tc"><div class="aht-actions">${item.status === 'pending' || item.scope === 'organization_candidate' && item.status === 'pending_review' ? `<button type="button" class="btn-primary btn-xs" data-agent-evolution-decision="approve" data-agent-evolution-id="${escapeAttr(item.id)}">批准</button><button type="button" class="btn-secondary btn-xs" data-agent-evolution-decision="reject" data-agent-evolution-id="${escapeAttr(item.id)}">拒绝</button>` : ''}${item.status === 'approved' && item.kind === 'preference' ? `<button type="button" class="btn-primary btn-xs" data-agent-evolution-apply="${escapeAttr(item.id)}">应用</button>` : ''}${['pending_review', 'approved'].includes(item.status) && item.kind !== 'preference' ? `<button type="button" class="btn-secondary btn-xs" data-agent-evolution-validate="${escapeAttr(item.id)}">验证</button>` : ''}${item.status === 'versioned_draft' ? `<button type="button" class="btn-primary btn-xs" data-agent-evolution-publish="${escapeAttr(item.id)}">发布</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`);

        if (paginationContainer) {
            if (window.renderWorkspacePagination) {
                window.renderWorkspacePagination(paginationContainer, { total, limit, page: currentPage, onPageChange: newPage => { state.proposalsPage = newPage; renderProposals(); } });
            } else { paginationContainer.replaceChildren(); }
        }
    }

    async function loadProposals() {
        const data = await apiJson(`${API_BASE}/agents/evolution/proposals?limit=100`, { cache: 'no-store' });
        state.proposals = Array.isArray(data.data) ? data.data : [];
        renderProposals();
    }

    async function createProposal() {
        let proposedChange = {};
        try { proposedChange = JSON.parse(document.getElementById('agent-evolution-change')?.value || '{}'); } catch (_) { return setNotice('结构化变更必须是合法 JSON。', 'error'); }
        try {
            await apiJson(`${API_BASE}/agents/evolution/proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: document.getElementById('agent-evolution-kind')?.value, title: document.getElementById('agent-evolution-title-input')?.value, description: document.getElementById('agent-evolution-description')?.value, proposedChange }) });
            setNotice('进化提议已提交，等待用户确认。', 'success');
            await loadProposals();
        } catch (error) { setNotice(error.message || '进化提议提交失败。', 'error'); }
    }

    async function decideProposal(id, decision) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) }); await loadProposals(); } catch (error) { setNotice(error.message || '进化提议审批失败。', 'error'); }
    }

    async function applyProposal(id) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/apply`, { method: 'POST' }); setNotice('偏好提议已应用并生成新档案版本。', 'success'); await Promise.all([loadProposals(), loadProfile()]); } catch (error) { setNotice(error.message || '进化提议应用失败。', 'error'); }
    }

    async function validateProposal(id) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/validate`, { method: 'POST' }); setNotice('提议验证通过，可发布新版本。', 'success'); await loadProposals(); } catch (error) { setNotice(error.message || '提议验证失败。', 'error'); await loadProposals().catch(() => { }); }
    }

    async function publishProposal(id) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/publish`, { method: 'POST' }); setNotice('新版本已发布。', 'success'); await loadProposals(); } catch (error) { setNotice(error.message || '提议发布失败。', 'error'); }
    }

    async function loadHarnessManagement() {
        const packs = window.Pivot?.moduleApi?.('agent.runtimePacks');
        const packsAvailable = await packs?.refreshStatus?.() || false;
        document.querySelectorAll('#agent-harness-residency-scope').forEach(el => el.classList.toggle('hidden', !isSuperAdminUser()));
        document.querySelectorAll('[data-agent-harness-nav="evolution"]').forEach(el => { el.classList.toggle('hidden', !canReviewOrganizationExperience()); el.hidden = !canReviewOrganizationExperience(); });
        try {
            const learning = await loadLearningModule().catch(() => null);
            await Promise.all([loadSkills(), ...(packsAvailable ? [packs?.load?.()] : []), loadProfile(), loadMemoryPolicy(), loadFeedback(), loadControlPlane(), learning?.load?.()]);
        } catch (error) {
            setNotice(error.message || '底座数据加载失败。', 'error');
        }
    }

    function renderDiagnosticValue(value, maxChars = 12000) {
        const text = jsonText(value);
        return `<pre class="agent-harness-json">${escape(text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text)}</pre>`;
    }

    const diagnosticCache = new Map();

    function getDiagnosticCache(runId) {
        const key = String(runId || '');
        let item = diagnosticCache.get(key);
        if (!item) {
            item = {
                activeTab: state.diagnostics.get(key) || 'context',
                panels: { context: '', world: '', resources: '', control: '' },
                loaded: { context: false, world: false, resources: false, control: false },
                fetching: { context: false, world: false, resources: false, control: false },
                sequence: 0
            };
            diagnosticCache.set(key, item);
            if (diagnosticCache.size > 80) {
                const oldest = diagnosticCache.keys().next().value;
                if (oldest) diagnosticCache.delete(oldest);
            }
        }
        return item;
    }

    function formatDiagnosticHtml(type, data) {
        if (type === 'context') {
            const list = Array.isArray(data) ? data : [];
            return list.length
                ? list.map(item => `<article class="agent-harness-diagnostic-card"><strong>窗口 ${escape(item.window_version)}</strong><span>${escape(item.status)} · ${escape(item.opened_reason)}</span><small>${escape(formatDate(item.created_at))} → ${escape(formatDate(item.closed_at))}</small><code>${escape(item.initial_state_hash || '-')}</code></article>`).join('')
                : '<div class="empty-state">暂无上下文窗口记录。</div>';
        }
        if (type === 'world') {
            const list = Array.isArray(data) ? data : [];
            return list.length
                ? list.slice().reverse().map(item => `<details class="agent-harness-diagnostic-card"><summary><strong>快照 ${escape(item.snapshot_version)}</strong><span>${escape(item.injection_mode === 'diff' ? '增量更新' : '完整更新')} · ${escape(item.full_refresh_reason || '常规更新')}</span><small>${escape(formatDate(item.created_at))}</small></summary><div class="agent-harness-diagnostic-meta">上下文摘要 ${escape(shortText(item.context_hash, 18))} · 状态摘要 ${escape(shortText(item.state_hash, 18))}</div>${renderDiagnosticValue({ state: item.state, patch: item.patch }, 9000)}</details>`).join('')
                : '<div class="empty-state">暂无状态快照。</div>';
        }
        if (type === 'resources') {
            const obj = data && typeof data === 'object' ? data : {};
            const budget = Number(obj.token_budget || 0);
            const consumed = Number(obj.tokens_consumed || 0);
            return `<div class="agent-harness-resource-grid"><div><span>Token 预算</span><strong>${escape(budget > 0 ? budget.toLocaleString() : '不限')}</strong></div><div><span>已消耗</span><strong>${escape(consumed.toLocaleString())}</strong></div><div><span>已预留</span><strong>${escape(Number(obj.tokens_reserved || 0).toLocaleString())}</strong></div><div><span>子运行</span><strong>${escape(`${Number(obj.active_children || 0)} / ${Number(obj.max_children || 0) || '不限'}`)}</strong></div></div>${renderDiagnosticValue(obj, 6000)}`;
        }
        if (type === 'control') {
            const list = Array.isArray(data) ? data : [];
            return `<form class="agent-harness-control-form"><select class="form-input" data-agent-control-type><option value="steer">steer</option><option value="request">request</option><option value="reply">reply</option><option value="system">system</option></select><textarea class="form-input" rows="2" data-agent-control-payload placeholder="输入 JSON 载荷，例如 {&quot;message&quot;:&quot;请优先处理第二步&quot;}"></textarea><button class="btn-primary" type="submit">发送控制消息</button></form>${list.length ? list.map(item => `<article class="agent-harness-diagnostic-card"><div><strong>${escape(item.message_type)}</strong><span>${escape(item.status)}</span><small>${escape(formatDate(item.created_at))}</small></div>${renderDiagnosticValue(item.payload, 2600)}${['pending', 'delivered'].includes(String(item.status)) ? `<button type="button" class="btn-secondary btn-xs" data-agent-control-ack="${escapeAttr(item.message_id)}">确认</button>` : ''}</article>`).join('') : '<div class="empty-state">暂无控制消息。</div>'}`;
        }
        return '<div class="empty-state">暂无诊断数据。</div>';
    }

    function diagnosticTabMarkup(runId) {
        const cache = getDiagnosticCache(runId), activeTab = cache.activeTab || state.diagnostics.get(String(runId)) || 'context';
        cache.activeTab = activeTab;
        const tab = (key, label) => `<button class="agent-harness-diagnostic-tab${activeTab === key ? ' active' : ''}" type="button" data-agent-harness-diagnostic-tab="${key}" role="tab" aria-selected="${activeTab === key ? 'true' : 'false'}" tabindex="${activeTab === key ? '0' : '-1'}">${label}</button>`;
        const panelMarkup = (key, placeholder) => `<div class="agent-harness-diagnostic-panel${activeTab !== key ? ' hidden' : ''}" data-agent-harness-panel="${key}" role="tabpanel" aria-label="${key}">${cache.panels[key] || `<div class="empty-state">${placeholder}</div>`}</div>`;
        return `<details class="agent-run-harness-diagnostics" data-agent-harness-diagnostics="${escapeAttr(runId)}" data-agent-harness-active-tab="${escapeAttr(activeTab)}"><summary><span>运行诊断</span><em>上下文、状态快照、资源与控制消息</em></summary><div class="agent-harness-diagnostics-body"><div class="agent-harness-diagnostic-tabs" role="tablist" aria-label="运行诊断">${tab('context', '上下文窗口')}${tab('world', '状态快照')}${tab('resources', '资源用量')}${tab('control', '控制消息')}</div><div class="agent-harness-diagnostic-panels">${panelMarkup('context', '正在加载上下文窗口记录...')}${panelMarkup('world', '正在加载状态快照...')}${panelMarkup('resources', '正在加载资源用量...')}${panelMarkup('control', '正在加载控制消息...')}</div></div></details>`;
    }

    async function loadDiagnostic(runId, type, detail, options = {}) {
        const cache = getDiagnosticCache(runId), panel = detail?.querySelector?.(`[data-agent-harness-panel="${type}"]`);
        if (!panel) return;
        if (!cache.loaded[type] && !cache.panels[type] && !options.silent) setMarkup(panel, '<div class="empty-state">正在加载诊断数据...</div>');
        const seq = ++cache.sequence;
        cache.fetching[type] = true;
        try {
            let data;
            if (type === 'context') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/context-windows?limit=100`, { cache: 'no-store' })).data || [];
            if (type === 'world') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/world-states?limit=120`, { cache: 'no-store' })).data || [];
            if (type === 'resources') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resources`, { cache: 'no-store' })).data || {};
            if (type === 'control') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages?limit=100`, { cache: 'no-store' })).data || [];
            if (seq !== cache.sequence) return;
            const html = formatDiagnosticHtml(type, data);
            cache.panels[type] = html;
            cache.loaded[type] = true;
            setMarkup(panel, html);
        } catch (error) {
            if (seq !== cache.sequence) return;
            if (!cache.loaded[type] || !cache.panels[type]) setMarkup(panel, `<div class="empty-state agent-harness-error">${escape(error.message || '诊断数据加载失败。')}</div>`);
        } finally { cache.fetching[type] = false; }
    }

    function bindRunDiagnostics(root, runId) {
        const detail = root?.querySelector?.('.agent-run-harness-diagnostics');
        if (!detail || detail.dataset.bound === '1') return;
        detail.dataset.bound = '1';
        const cache = getDiagnosticCache(runId);
        let active = cache.activeTab || state.diagnostics.get(String(runId)) || 'context';
        cache.activeTab = active;
        state.diagnostics.set(String(runId), active);
        detail.dataset.agentHarnessActiveTab = active;

        const switchTab = (targetTab, shouldFetch = true) => {
            active = targetTab;
            cache.activeTab = active;
            state.diagnostics.set(String(runId), active);
            detail.dataset.agentHarnessActiveTab = active;

            // 1. 切换按钮常驻高亮状态，不发生 DOM 重建
            detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(item => {
                const selected = item.dataset.agentHarnessDiagnosticTab === active;
                item.classList.toggle('active', selected);
                item.setAttribute('aria-selected', selected ? 'true' : 'false');
                item.tabIndex = selected ? 0 : -1;
            });

            // 2. 切换子面板常驻显示，零延迟且无内容闪烁
            detail.querySelectorAll('[data-agent-harness-panel]').forEach(panelEl => {
                const isMatch = panelEl.dataset.agentHarnessPanel === active;
                panelEl.classList.toggle('hidden', !isMatch);
            });

            // 3. 静默或平滑更新数据
            if (shouldFetch && detail.open) {
                loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
            }
        };

        detail.addEventListener('toggle', () => {
            if (detail.open) {
                loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
            }
        });

        detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(button => {
            button.addEventListener('click', () => {
                const targetTab = button.dataset.agentHarnessDiagnosticTab || 'context';
                switchTab(targetTab, true);
            });
        });

        // 初始应用标签与常驻面板状态
        switchTab(active, false);
        if (detail.open) {
            loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
        }

        // 控制表单提交与确认按钮绑定（事件委托）
        detail.addEventListener('submit', async event => {
            const form = event.target.closest('.agent-harness-control-form');
            if (!form) return;
            event.preventDefault();
            let payload = {};
            try { payload = JSON.parse(form.querySelector('[data-agent-control-payload]')?.value || '{}'); } catch (_) { return setNotice('控制消息内容必须是合法 JSON。', 'error'); }
            try {
                await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: form.querySelector('[data-agent-control-type]')?.value, payload }) });
                form.reset();
                await loadDiagnostic(runId, 'control', detail, { silent: true });
            } catch (error) {
                const controlPanel = detail.querySelector('[data-agent-harness-panel="control"]');
                if (controlPanel) prependMarkup(controlPanel, `<div class="empty-state agent-harness-error">${escape(error.message || '控制消息发送失败。')}</div>`);
            }
        });

        detail.addEventListener('click', async event => {
            const ack = event.target.closest('[data-agent-control-ack]');
            if (!ack) return;
            try {
                await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages/${encodeURIComponent(ack.dataset.agentControlAck)}/ack`, { method: 'POST' });
                await loadDiagnostic(runId, 'control', detail, { silent: true });
            } catch (error) { setNotice(error.message || '控制消息确认失败。', 'error'); }
        });
    }

    function switchAgentCpSubview(subview = 'inbox') {
        try { sessionStorage.setItem('pivot.agent.cp_subview', subview); } catch (_) { }
        document.querySelectorAll('[data-agent-cp-subview]').forEach(t => {
            const active = t.dataset.agentCpSubview === subview;
            t.classList.toggle('active', active);
            t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('[data-agent-cp-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.agentCpPane !== subview));
        if (subview === 'quality') {
            loadFeedback().catch(() => {});
            window.Pivot?.moduleApi?.('agent.evaluations')?.bind?.();
            window.Pivot?.moduleApi?.('agent.evaluations')?.loadSuites?.({ silent: true })?.catch(() => {});
        } else if (subview === 'governance') {
            loadProfile().catch(() => {});
            loadSkills().catch(() => {});
            loadLearningModule().then(learning => learning?.load?.()).catch(() => {});
            const packs = window.Pivot?.moduleApi?.('agent.runtimePacks');
            packs?.refreshStatus?.().then(enabled => { if (enabled) return packs.load(); return null; }).catch(() => {});
            loadMemoryPolicy().catch(() => {});
        }
    }

    function bindManagement() {
        document.querySelectorAll('[data-agent-harness-nav]').forEach(button => {
            button.addEventListener('click', () => {
                const target = button.dataset.agentHarnessNav;
                if (target === 'packs' && !window.Pivot?.moduleApi?.('agent.runtimePacks')?.isAvailable?.()) return;
                const hiddenByDefaultNavs = ['residency'];
                if (hiddenByDefaultNavs.includes(target) && target === 'residency') return;
                document.querySelectorAll('[data-agent-harness-nav]').forEach(b => {
                    const active = b.dataset.agentHarnessNav === target;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                document.querySelectorAll('[data-agent-harness-section]').forEach(sec => {
                    const active = sec.dataset.agentHarnessSection === target;
                    sec.classList.toggle('hidden', !active);
                    if (sec.dataset.agentHarnessSection === 'packs') sec.hidden = !active;
                });
                if (target === 'learning') loadLearningModule().then(l => l?.load?.()).catch(() => {});
                if (target === 'skills') loadSkills().catch(() => {});
                if (target === 'memory') { loadMemoryPolicy().catch(() => {}); loadLearningModule().then(l => l?.loadMemories?.()).catch(() => {}); }
                if (target === 'profile') loadProfile().catch(() => {});
            });
        });

        // 质量与可靠性页面内部 Tab 切换
        document.querySelectorAll('[data-quality-tab]').forEach(button => {
            button.addEventListener('click', () => {
                const target = button.dataset.qualityTab;
                document.querySelectorAll('[data-quality-tab]').forEach(b => {
                    const active = b.dataset.qualityTab === target;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                document.querySelectorAll('[data-quality-panel]').forEach(panel => {
                    panel.classList.toggle('hidden', panel.dataset.qualityPanel !== target);
                });
            });
        });

        document.getElementById('agent-harness-skills-refresh')?.addEventListener('click', () => loadSkills().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-refresh')?.addEventListener('click', () => loadResidents().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-scope')?.addEventListener('change', () => loadResidents().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-sweep')?.addEventListener('click', () => sweepResidents());
        document.getElementById('agent-harness-skill-register')?.addEventListener('click', registerSkill);
        document.getElementById('agent-harness-skill-file')?.addEventListener('change', event => uploadSkillPackage(event.target.files?.[0]));
        document.getElementById('agent-harness-skill-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-harness-disable-skill]');
            if (button) disableSkill(button.dataset.agentHarnessDisableSkill);
            const validate = event.target.closest('[data-agent-skill-validate]');
            if (validate) validateSkillVersion(validate.dataset.agentSkillValidate);
            const publish = event.target.closest('[data-agent-skill-publish]');
            if (publish) publishSkillVersion(publish.dataset.agentSkillPublish);
            const manage = event.target.closest('[data-agent-skill-manage]');
            if (manage) {
                const skill = state.skills.find(item => String(item.versionId || item.id) === String(manage.dataset.agentSkillManage));
                if (skill) window.Pivot?.moduleApi?.('agent.skillManagement')?.open?.(skill);
            }
        });
        document.getElementById('agent-harness-residency-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-harness-evict-resident]');
            if (button) evictResident(button.dataset.agentHarnessEvictResident);
        });
        document.getElementById('agent-profile-refresh')?.addEventListener('click', () => loadProfile().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-profile-save')?.addEventListener('click', saveProfile);
        document.getElementById('agent-profile-wizard')?.addEventListener('click', openProfileWizard);
        document.getElementById('agent-wizard-save')?.addEventListener('click', saveProfileWizard);
        document.getElementById('agent-memory-policy-refresh')?.addEventListener('click', () => { loadMemoryPolicy().catch(error => setNotice(error.message, 'error')); loadLearningModule().then(l => l?.loadMemories?.()).catch(error => setNotice(error.message, 'error')); });
        document.getElementById('agent-memory-policy-save')?.addEventListener('click', saveMemoryPolicy);
        document.getElementById('agent-feedback-refresh')?.addEventListener('click', () => loadFeedback().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-evolution-refresh')?.addEventListener('click', () => loadProposals().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-evolution-create')?.addEventListener('click', createProposal);
        document.getElementById('agent-evolution-list')?.addEventListener('click', event => {
            const decision = event.target.closest('[data-agent-evolution-decision]');
            if (decision) return decideProposal(decision.dataset.agentEvolutionId, decision.dataset.agentEvolutionDecision);
            const apply = event.target.closest('[data-agent-evolution-apply]');
            if (apply) applyProposal(apply.dataset.agentEvolutionApply);
            const validate = event.target.closest('[data-agent-evolution-validate]');
            if (validate) validateProposal(validate.dataset.agentEvolutionValidate);
            const publish = event.target.closest('[data-agent-evolution-publish]');
            if (publish) publishProposal(publish.dataset.agentEvolutionPublish);
        });
        document.querySelectorAll('[data-agent-cp-subview]').forEach(tab => {
            tab.addEventListener('click', () => switchAgentCpSubview(tab.dataset.agentCpSubview));
        });
        let savedSubview = null;
        try { savedSubview = sessionStorage.getItem('pivot.agent.cp_subview'); } catch (_) { }
        if (savedSubview) switchAgentCpSubview(savedSubview);
        document.querySelectorAll('#agent-inbox-refresh').forEach(btn => btn.addEventListener('click', () => loadControlPlane().catch(error => setNotice(error.message, 'error'))));
        document.querySelectorAll('#agent-goal-create, #agent-goal-create-top-btn, [data-agent-goal-create]').forEach(el => el.addEventListener('click', () => openGoalModal()));
        document.getElementById('agent-goal-cancel')?.addEventListener('click', closeGoalModal);
        document.getElementById('agent-goal-modal-close')?.addEventListener('click', closeGoalModal);
        document.getElementById('agent-goal-modal')?.addEventListener('click', event => { if (event.target.id === 'agent-goal-modal') closeGoalModal(); });
        document.getElementById('agent-goal-editor')?.addEventListener('submit', saveAgentGoal);
        document.getElementById('agent-goal-trigger')?.addEventListener('change', event => {
            const type = event.target.value;
            document.getElementById('agent-goal-time-field')?.classList.toggle('hidden', type !== 'timer');
            document.getElementById('agent-goal-directory-field')?.classList.toggle('hidden', type !== 'file');
            document.getElementById('agent-goal-query-field')?.classList.toggle('hidden', type !== 'database');
        });
        document.getElementById('agent-inbox-panel')?.addEventListener('click', event => {
            const openRun = event.target.closest('[data-agent-inbox-open-run]');
            if (openRun) {
                const runId = openRun.dataset.agentInboxOpenRun;
                const sourceType = openRun.dataset.agentInboxType;
                const sourceId = openRun.dataset.agentInboxId;
                const isUnread = openRun.dataset.agentInboxUnread === '1';
                if (isUnread && sourceId && sourceType) {
                    const targetItem = state.inbox.find(i => String(i.sourceId) === String(sourceId) && i.sourceType === sourceType);
                    if (targetItem && targetItem.unread) {
                        targetItem.unread = false;
                        renderAgentControlPlane();
                    }
                    const isNotification = sourceType === 'notification';
                    const url = isNotification
                        ? `${API_BASE}/agents/inbox/notification/${encodeURIComponent(sourceId)}/read`
                        : `${API_BASE}/agents/inbox/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}/read`;
                    apiJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
                }
                if (runId && typeof globalThis['openAgentRun'] === 'function') {
                    globalThis['openAgentRun'](runId, { returnTab: 'workbench', returnSubview: 'inbox', returnLabel: '待办中心' });
                }
                return;
            }
            const button = event.target.closest('[data-agent-inbox-read]');
            if (button) apiJson(`${API_BASE}/agents/inbox/notification/${encodeURIComponent(button.dataset.agentInboxRead)}/read`, { method: 'POST' }).then(loadControlPlane).catch(error => setNotice(error.message, 'error'));
            const action = event.target.closest('[data-agent-inbox-action]');
            if (action) {
                const isRead = action.dataset.agentInboxAction === 'read';
                const url = isRead
                    ? `${API_BASE}/agents/inbox/notification/${encodeURIComponent(action.dataset.agentInboxId)}/read`
                    : `${API_BASE}/agents/inbox/${encodeURIComponent(action.dataset.agentInboxType)}/${encodeURIComponent(action.dataset.agentInboxId)}/${encodeURIComponent(action.dataset.agentInboxAction)}`;
                apiJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                    .then(() => { if (typeof showToast === 'function') showToast('收件箱状态已更新', 'success'); loadControlPlane(); })
                    .catch(error => { if (typeof showToast === 'function') showToast(error.message || '操作失败', 'error'); setNotice(error.message, 'error'); });
            }
        });
        document.getElementById('agent-goals-panel')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-goal-action]');
            if (!button) return;
            const action = button.dataset.agentGoalAction;
            const id = button.dataset.agentGoalId;
            if (action === 'edit') {
                const goal = state.goals.find(g => String(g.id) === String(id));
                if (goal) openGoalModal(goal);
            } else if (action === 'delete') {
                deleteAgentGoal(id);
            } else {
                changeAgentGoal(id, action);
            }
        });
        document.getElementById('agent-channels-panel')?.addEventListener('click', event => {
            const create = event.target.closest('[data-agent-channel-create]');
            if (create) apiJson(`${API_BASE}/agents/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelType: document.getElementById('agent-channel-type')?.value, channelKey: document.getElementById('agent-channel-key')?.value, credentialRef: document.getElementById('agent-channel-credential')?.value, config: { endpoint: document.getElementById('agent-channel-endpoint')?.value } }) }).then(() => loadControlPlane()).catch(error => setNotice(error.message, 'error'));
            const test = event.target.closest('[data-agent-channel-test]');
            if (test) apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(test.dataset.agentChannelTest)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Pivot 渠道连通性测试' }) }).then(() => setNotice('渠道测试已提交。', 'success')).catch(error => setNotice(error.message, 'error'));
        });
        loadControlPlane().catch(() => { });
    }

    window.Pivot?.exposeModule?.('agent.harness', {
        loadAgentHarnessManagement: loadHarnessManagement, loadAgentControlPlane: loadControlPlane,
        bindAgentRunHarnessDiagnostics: bindRunDiagnostics, renderAgentHarnessDiagnosticMarkup: diagnosticTabMarkup,
        loadAgentHarnessSkills: loadSkills, getAgentHarnessSkillId: () => document.getElementById('agent-skill-select')?.value || '',
        switchAgentCpSubview
    }, ['loadAgentHarnessManagement', 'loadAgentControlPlane', 'bindAgentRunHarnessDiagnostics', 'renderAgentHarnessDiagnosticMarkup', 'loadAgentHarnessSkills', 'getAgentHarnessSkillId', 'switchAgentCpSubview']);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindManagement, { once: true });
    else bindManagement();
})();
