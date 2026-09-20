/* 个人 Agent 的目标草案、能力目录和双向渠道交互。 */
/* global API_BASE, apiJson */
(function () {
    function create(deps = {}) {
        const { state, escape, escapeAttr, formatDate, setMarkup, setNotice, renderAgentControlPlane } = deps;
        state.capabilities = Array.isArray(state.capabilities) ? state.capabilities : [];
        state.capabilityQuery = String(state.capabilityQuery || '');
        state.channelGatewayDetails = state.channelGatewayDetails instanceof Map ? state.channelGatewayDetails : new Map();

        function clearGoalDraft() {
            const token = document.getElementById('agent-goal-draft-token');
            const preview = document.getElementById('agent-goal-draft-preview');
            const submit = document.getElementById('agent-goal-submit');
            if (token) token.value = '';
            if (preview) {
                preview.replaceChildren();
                preview.classList.add('hidden');
            }
            if (submit && !document.getElementById('agent-goal-edit-id')?.value) submit.textContent = '保存持续目标';
        }

        function setGoalModalMode(goal) {
            const panel = document.getElementById('agent-goal-natural-panel');
            panel?.classList.toggle('hidden', Boolean(goal));
            clearGoalDraft();
        }

        function renderGoalDraftPreview(draft = {}) {
            const preview = document.getElementById('agent-goal-draft-preview');
            if (!preview) return;
            const missing = Array.isArray(draft.missingFields) ? draft.missingFields : [];
            const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
            const title = draft.canConfirm ? '草案已就绪，确认后才会创建目标。' : '草案还需要补充信息，尚不会创建目标。';
            const missingMarkup = missing.length ? `<ul class="agent-goal-draft-list is-missing">${missing.map(item => `<li><strong>${escape(item.label || item.key || '待补充信息')}</strong><span>${escape(item.hint || '')}</span></li>`).join('')}</ul>` : '';
            const warningMarkup = warnings.length ? `<ul class="agent-goal-draft-list">${warnings.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
            setMarkup(preview, `<div class="agent-goal-draft-title"><strong>${title}</strong><span>触发：${escape(draft.scheduleLabel || '待确认')}</span></div><div class="agent-goal-draft-summary"><span>默认权限：仅内置能力，高风险动作仍需审批</span><span>结果：${escape(draft.deliveryHint?.label || '进入待办中心')}</span></div>${missingMarkup}${warningMarkup}`);
            preview.classList.remove('hidden');
        }

        function applyGoalDraft(draft = {}, confirmationToken = '') {
            const fields = { title: 'agent-goal-title', goal: 'agent-goal-goal', trigger: 'agent-goal-trigger', time: 'agent-goal-time', directory: 'agent-goal-directory', query: 'agent-goal-query' };
            const spec = draft.triggerSpec || {};
            document.getElementById(fields.title).value = draft.title || '';
            document.getElementById(fields.goal).value = draft.goal || '';
            const trigger = document.getElementById(fields.trigger);
            if (trigger) { trigger.value = spec.type || 'timer'; trigger.dispatchEvent(new Event('change')); }
            if (spec.timeOfDay && document.getElementById(fields.time)) document.getElementById(fields.time).value = spec.timeOfDay;
            if (spec.directory && document.getElementById(fields.directory)) document.getElementById(fields.directory).value = spec.directory;
            if (spec.query && document.getElementById(fields.query)) document.getElementById(fields.query).value = spec.query;
            const token = document.getElementById('agent-goal-draft-token');
            if (token) token.value = draft.canConfirm === true ? String(confirmationToken || '') : '';
            const submit = document.getElementById('agent-goal-submit');
            if (submit && !document.getElementById('agent-goal-edit-id')?.value) submit.textContent = draft.canConfirm === true ? '确认并创建目标' : '补充后手动创建';
            renderGoalDraftPreview(draft);
        }

        async function parseNaturalGoalDraft() {
            const input = document.getElementById('agent-goal-natural-input');
            const button = document.getElementById('agent-goal-draft-parse');
            const prompt = String(input?.value || '').trim();
            if (!prompt) return setNotice('请先输入希望 Agent 持续完成的工作。', 'error');
            if (button) button.disabled = true;
            try {
                const response = await apiJson(`${API_BASE}/agents/goals/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
                applyGoalDraft(response.draft || {}, response.confirmationToken || '');
                setNotice(response.draft?.canConfirm ? '持续目标草案已生成，请核对后确认。' : '草案已生成，请补充标记的信息。', response.draft?.canConfirm ? 'success' : 'warn');
            } catch (error) { setNotice(error.message || '生成持续目标草案失败。', 'error'); }
            finally { if (button) button.disabled = false; }
        }

        function goalPayload(editId, fallback) {
            const confirmationToken = String(document.getElementById('agent-goal-draft-token')?.value || '').trim();
            return { draftToken: confirmationToken, payload: confirmationToken && !editId ? { confirmationToken, goalOverrides: fallback } : fallback };
        }

        function goalFormPayload() {
            const triggerType = document.getElementById('agent-goal-trigger')?.value || 'timer';
            const triggerSpec = triggerType === 'timer' ? { type: 'timer', frequency: 'daily', timeOfDay: document.getElementById('agent-goal-time')?.value || '09:00' } : triggerType === 'file' ? { type: 'file', directory: document.getElementById('agent-goal-directory')?.value || '' } : triggerType === 'database' ? { type: 'database', query: document.getElementById('agent-goal-query')?.value || '' } : { type: triggerType };
            return { title: document.getElementById('agent-goal-title')?.value, goal: document.getElementById('agent-goal-goal')?.value, triggerSpec, authorizationSpec: { timezone: document.getElementById('agent-goal-timezone')?.value || 'Asia/Shanghai', modelRouter: document.getElementById('agent-goal-model-router')?.value || 'fixed', deliveryBindingIds: document.getElementById('agent-goal-delivery-channel')?.value ? [document.getElementById('agent-goal-delivery-channel').value] : [], resultRetentionDays: document.getElementById('agent-goal-retention-days')?.value || 30 } };
        }

        async function saveGoal(event, handlers = {}) {
            event.preventDefault();
            const editId = document.getElementById('agent-goal-edit-id')?.value;
            const { draftToken, payload } = goalPayload(editId, goalFormPayload());
            try {
                if (editId) {
                    await apiJson(`${API_BASE}/agents/goals/${encodeURIComponent(editId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    handlers.close?.(); setNotice('持续目标已修改。', 'success');
                } else {
                    const response = await apiJson(`${API_BASE}/agents/goals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const tokenNotice = document.getElementById('agent-goal-token-notice');
                    if (tokenNotice && response.token) { tokenNotice.textContent = `Webhook 令牌（仅展示一次，请妥善保存）：${response.token}`; tokenNotice.classList.remove('hidden'); } else handlers.close?.();
                    setNotice(draftToken ? '已确认并创建持续目标。' : '持续目标已创建。', 'success');
                }
                handlers.reload?.();
            } catch (error) { setNotice(error.message || `持续目标${editId ? '修改' : '创建'}失败。`, 'error'); }
        }

        async function previewGoal(handlers = {}) {
            const button = document.getElementById('agent-goal-preview');
            if (button) button.disabled = true;
            try {
                const result = await apiJson(`${API_BASE}/agents/goals/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(goalFormPayload()) });
                setNotice('预览任务已入队；它不会创建或启用持续目标。', 'success');
                if (result.run?.id && typeof window.Pivot.legacy.openAgentRun === 'function') { handlers.close?.(); await window.Pivot.legacy.openAgentRun(result.run.id); }
            } catch (error) { setNotice(error.message || '目标测试运行失败。', 'error'); }
            finally { if (button) button.disabled = false; }
        }

        function capabilityKindLabel(kind = '') {
            return ({ skill: 'Skill', builtin_tool: '内置工具', mcp_server: 'MCP 服务', database_connection: '数据库连接' })[String(kind)] || '能力';
        }

        function renderCapabilityCatalog() {
            const target = document.getElementById('agent-capability-catalog-list');
            if (!target) return;
            const query = String(state.capabilityQuery || '').trim().toLowerCase();
            const rows = state.capabilities.filter(item => !query || [item.title, item.description, item.source, item.kind, ...(item.capabilities || []), ...(item.tools || [])].join(' ').toLowerCase().includes(query));
            if (!rows.length) return setMarkup(target, '<div class="agent-capability-catalog-empty">当前没有匹配的可用能力。已停用或未发布的能力不会出现在这里。</div>');
            setMarkup(target, rows.slice(0, 60).map(item => `<article class="agent-capability-catalog-item ${item.status === 'disabled' ? 'is-disabled' : ''}"><div class="agent-capability-catalog-item-head"><strong>${escape(item.title || '未命名能力')}</strong><span class="agent-inbox-type-badge ${item.status === 'disabled' ? 'badge-event' : 'badge-run'}">${escape(capabilityKindLabel(item.kind))}</span></div><p>${escape(String(item.description || '未填写用途说明。').slice(0, 140))}</p><footer><span>${escape(item.source || '受控能力')}</span><span>${escape(item.scope || 'personal')}${item.version ? ` · v${escape(item.version)}` : ''}</span></footer></article>`).join(''));
        }

        async function loadCapabilityCatalog() {
            const data = await apiJson(`${API_BASE}/agents/capabilities/catalog?limit=300`, { cache: 'no-store' });
            state.capabilities = Array.isArray(data.data) ? data.data : [];
            renderCapabilityCatalog();
            return state.capabilities;
        }

        function renderGatewayDetails(channels = []) {
            return channels.map(channel => {
                const detail = state.channelGatewayDetails.get(String(channel.id));
                if (!detail) return '';
                const pairings = Array.isArray(detail.pairings) ? detail.pairings : [];
                const sessions = Array.isArray(detail.sessions) ? detail.sessions : [];
                const code = String(detail.code || '');
                return `<section class="agent-channel-gateway-card" data-agent-channel-detail="${escapeAttr(channel.id)}"><div class="agent-channel-gateway-card-head"><strong>${escape(channel.channelKey)} 的双向会话</strong><span>入站地址：/hooks/channel/${escape(channel.id)}/message</span></div>${code ? `<div class="agent-channel-pair-code"><span>一次性配对码（仅展示本次）：</span><code>${escape(code)}</code><small>请从外部平台的已签名消息中提交此码；${escape(detail.expiresAt ? `过期：${formatDate(detail.expiresAt)}` : '默认 15 分钟失效')}。</small></div>` : ''}<div class="agent-channel-gateway-columns"><div><strong>配对身份</strong>${pairings.length ? `<ul>${pairings.map(item => `<li><span>${escape(item.identityHint || '待配对')} · ${escape(item.status || '')}</span>${item.status === 'paired' ? `<button type="button" class="btn-danger-outline btn-xs" data-agent-channel-pairing-revoke="${escapeAttr(item.id)}" data-agent-channel-id="${escapeAttr(channel.id)}">撤销</button>` : ''}</li>`).join('')}</ul>` : '<p>尚未创建或读取配对记录。</p>'}</div><div><strong>外部会话</strong>${sessions.length ? `<ul>${sessions.map(item => `<li><span>${escape(item.conversationHint || '已配对会话')} · ${escape(formatDate(item.lastInboundAt || item.createdAt))}</span><button type="button" class="btn-secondary btn-xs" data-agent-channel-session-link="${escapeAttr(item.id)}" data-agent-channel-id="${escapeAttr(channel.id)}">接续到会话</button></li>`).join('')}</ul>` : '<p>尚无双向消息会话。</p>'}</div></div></section>`;
            }).join('');
        }

        async function refreshGatewayDetails(channelId, options = {}) {
            const [pairings, sessions] = await Promise.all([
                apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(channelId)}/pairings?limit=20`, { cache: 'no-store' }),
                apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(channelId)}/sessions?limit=20`, { cache: 'no-store' })
            ]);
            const existing = state.channelGatewayDetails.get(String(channelId)) || {};
            state.channelGatewayDetails.set(String(channelId), { ...existing, ...options, pairings: pairings.data || [], sessions: sessions.data || [] });
            renderAgentControlPlane();
        }

        function handleGatewayAction(event) {
            const pair = event.target.closest('[data-agent-channel-pair]');
            if (pair) {
                const channelId = pair.dataset.agentChannelPair;
                apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(channelId)}/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                    .then(result => refreshGatewayDetails(channelId, { code: result.code, expiresAt: result.pairing?.expiresAt }))
                    .then(() => setNotice('已生成一次性配对码，请仅在可信渠道中使用。', 'success'))
                    .catch(error => setNotice(error.message, 'error'));
                return true;
            }
            const sessions = event.target.closest('[data-agent-channel-sessions]');
            if (sessions) { refreshGatewayDetails(sessions.dataset.agentChannelSessions).catch(error => setNotice(error.message, 'error')); return true; }
            const revoke = event.target.closest('[data-agent-channel-pairing-revoke]');
            const link = event.target.closest('[data-agent-channel-session-link]');
            if (link) {
                const pivotSessionId = window.prompt('输入要接续到的 Pivot 会话 ID（仅限你自己的会话）：');
                if (!pivotSessionId) return true;
                apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(link.dataset.agentChannelId)}/sessions/${encodeURIComponent(link.dataset.agentChannelSessionLink)}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pivotSessionId }) })
                    .then(() => refreshGatewayDetails(link.dataset.agentChannelId))
                    .then(() => setNotice('渠道会话已接续到指定 Pivot 会话。', 'success'))
                    .catch(error => setNotice(error.message, 'error'));
                return true;
            }
            if (!revoke) return false;
            const channelId = revoke.dataset.agentChannelId;
            apiJson(`${API_BASE}/agents/channels/${encodeURIComponent(channelId)}/pairings/${encodeURIComponent(revoke.dataset.agentChannelPairingRevoke)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                .then(() => refreshGatewayDetails(channelId, { code: '' }))
                .then(() => setNotice('已撤销该外部身份，后续消息将被拒绝。', 'success'))
                .catch(error => setNotice(error.message, 'error'));
            return true;
        }

        function bindControls() {
            document.getElementById('agent-capability-catalog-refresh')?.addEventListener('click', () => loadCapabilityCatalog().catch(error => setNotice(error.message, 'error')));
            document.getElementById('agent-capability-catalog-search')?.addEventListener('input', event => { state.capabilityQuery = event.target.value || ''; renderCapabilityCatalog(); });
            document.getElementById('agent-goal-draft-parse')?.addEventListener('click', parseNaturalGoalDraft);
            document.getElementById('agent-goal-natural-input')?.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); parseNaturalGoalDraft(); } });
            document.getElementById('agent-goal-trigger')?.addEventListener('change', event => {
                const type = event.target.value;
                document.getElementById('agent-goal-time-field')?.classList.toggle('hidden', type !== 'timer');
                document.getElementById('agent-goal-directory-field')?.classList.toggle('hidden', type !== 'file');
                document.getElementById('agent-goal-query-field')?.classList.toggle('hidden', type !== 'database');
                if (event.isTrusted) clearGoalDraft();
            });
            ['agent-goal-title', 'agent-goal-goal', 'agent-goal-time', 'agent-goal-directory', 'agent-goal-query'].forEach(id => document.getElementById(id)?.addEventListener('input', event => { if (event.isTrusted) clearGoalDraft(); }));
        }

        return { bindControls, clearGoalDraft, goalPayload, handleGatewayAction, loadCapabilityCatalog, previewGoal, renderCapabilityCatalog, renderGatewayDetails, saveGoal, setGoalModalMode };
    }

    window.Pivot?.exposeModule?.('agent.personalExperience', { create });
})();
