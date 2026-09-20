/* 首次个人 Agent 设置：只写入档案 API 和受限体验事件，不保存提示词正文。 */
(function () {
    const API_ROOT = typeof API_BASE === 'string' ? API_BASE : '/api';
    const state = { step: 1, profile: null, checked: false };

    async function request(path, options = {}) {
        const response = await fetch(`${API_ROOT}${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '设置暂时无法保存。');
        return data;
    }
    function modal() { return document.getElementById('personal-agent-onboarding'); }
    function isConfigured(profile) { return Boolean(profile?.displayName || profile?.role || (profile?.commonTasks || []).length); }
    function event(type, metadata = {}) { return request('/agents/experience/events', { method: 'POST', body: JSON.stringify({ type, metadata }) }).catch(() => null); }
    function populate(profile = {}) {
        document.getElementById('onboarding-display-name').value = profile.displayName || '';
        document.getElementById('onboarding-role').value = profile.role || '';
        document.getElementById('onboarding-tone').value = profile.communicationStyle?.tone || 'professional';
        document.getElementById('onboarding-verbosity').value = profile.communicationStyle?.verbosity || 'balanced';
        document.getElementById('onboarding-common-tasks').value = (profile.commonTasks || []).join('，');
    }
    function render() {
        const root = modal(); if (!root) return;
        root.querySelectorAll('[data-onboarding-step]').forEach(item => item.classList.toggle('hidden', Number(item.dataset.onboardingStep) !== state.step));
        root.querySelectorAll('[data-onboarding-progress]').forEach(item => item.classList.toggle('active', Number(item.dataset.onboardingProgress) <= state.step));
        root.querySelector('[data-onboarding-action="back"]').disabled = state.step === 1;
        root.querySelector('[data-onboarding-action="next"]').textContent = state.step === 4 ? '完成设置' : '下一步';
    }
    async function saveCurrentStep() {
        const profile = state.profile || {};
        let patch = {};
        if (state.step === 1) patch = { displayName: document.getElementById('onboarding-display-name').value, role: document.getElementById('onboarding-role').value };
        if (state.step === 2) patch = { communicationStyle: { ...(profile.communicationStyle || {}), tone: document.getElementById('onboarding-tone').value, verbosity: document.getElementById('onboarding-verbosity').value } };
        if (state.step === 3) patch = { commonTasks: document.getElementById('onboarding-common-tasks').value.split(/[,，]/).map(item => item.trim()).filter(Boolean).slice(0, 24) };
        if (Object.keys(patch).length) {
            const data = await request('/agents/profile', { method: 'PUT', body: JSON.stringify({ profile: patch, expectedVersion: profile.version, source: 'onboarding' }) });
            state.profile = data.profile;
        }
        await event('onboarding_step_saved', { stage: String(state.step), channelSelected: Boolean(document.getElementById('onboarding-channel')?.checked) });
    }
    async function open(force = false) {
        const root = modal(); if (!root) return;
        if (!state.profile || force) {
            const data = await request('/agents/profile'); state.profile = data.profile; populate(state.profile);
        }
        state.step = 1; render(); root.classList.remove('hidden'); root.setAttribute('aria-hidden', 'false');
        await event('onboarding_started', { source: force ? 'resume' : 'personal_workbench' });
    }
    function close() { const root = modal(); root?.classList.add('hidden'); root?.setAttribute('aria-hidden', 'true'); }
    async function next() {
        await saveCurrentStep();
        if (state.step < 4) { state.step += 1; render(); return; }
        await event('onboarding_completed', { channelSelected: Boolean(document.getElementById('onboarding-channel')?.checked) });
        close();
        window.Pivot?.legacy?.showToast?.('个人 Agent 设置已保存，下一次任务立即生效。', 'success');
        if (document.getElementById('onboarding-channel')?.checked) window.Pivot?.moduleApi?.('workspaces.navigation')?.openAgentWorkbench?.({ tab: 'workbench' });
    }
    async function maybeShow() {
        if (state.checked) return; state.checked = true;
        await event('personal_entry_opened', { source: 'personal_workbench' });
        const data = await request('/agents/profile'); state.profile = data.profile;
        if (!isConfigured(state.profile) && !sessionStorage.getItem('pivot.agent.onboarding.dismissed')) await open();
    }
    document.addEventListener('click', eventObject => {
        const action = eventObject.target.closest('[data-onboarding-action]')?.dataset.onboardingAction;
        if (!action) return;
        if (action === 'skip') { sessionStorage.setItem('pivot.agent.onboarding.dismissed', '1'); event('onboarding_skipped', { stage: String(state.step) }); close(); return; }
        if (action === 'back') { if (state.step > 1) { state.step -= 1; render(); } return; }
        if (action === 'next') next().catch(error => window.Pivot?.legacy?.showToast?.(error.message || '设置保存失败。', 'error'));
    });
    window.Pivot?.exposeModule?.('personal.agentOnboarding', { maybeShow, open: () => open(true) });
})();
