/* 全站PPT服务连接设置，密钥只写入且不回显。 */
/* global API_BASE, apiFetch, showToast, PivotSafeHtml, escapeHtml */
(function () {
    'use strict';
    const byId = id => document.getElementById(id), modal = () => byId('ppt-master-service-modal');
    let config = null, result = null, generation = 0, controller = null, saving = false, returnFocus = null;
    const owner = () => window.Pivot?.legacy?.currentUser?.id;
    const current = (sequence, account) => sequence === generation && owner() === account;
    const ready = () => config?.enabled === true && config?.configured === true && !config?.error && result?.success !== false;
    function summary() { return config?.error || (!config?.enabled ? '完整制作服务已停用，标准PPT制作继续可用' : result?.message || (config?.configured ? '已配置，制作时通过内网服务连接' : '服务地址或访问密钥待配置')); }
    function body() {
        return `<strong>PPT Master制作服务</strong><span>${escapeHtml(config?.endpoint || '尚未配置独立服务')}</span><small>${escapeHtml(summary())}</small>
            <div class="retrieval-model-service-actions">${config?.canManage ? '<button class="btn-secondary" type="button" data-ppt-service-test-card>测试</button><button class="btn-secondary" type="button" data-ppt-service-config-open>配置</button>' : '<small>由系统admin账号统一维护</small>'}</div>`;
    }
    function renderCard(value) {
        if (value && (!modal() || modal().classList.contains('hidden')) && !saving) { config = value; result = null; }
        return `<article id="ppt-master-service-card" class="retrieval-model-service-card ${ready() ? 'is-ready' : 'is-warning'}">${body()}</article>`;
    }
    function updateCard() {
        const card = byId('ppt-master-service-card'); if (!card) return;
        card.classList.toggle('is-ready', ready()); card.classList.toggle('is-warning', !ready());
        PivotSafeHtml.setHtml(card, body());
    }
    function message(text, failed = false) { const target = byId('ppt-master-config-status'); if (target) { target.textContent = text; target.classList.toggle('is-error', failed); } }
    function setBusy(busy, lockClose = false) {
        byId('ppt-master-service-form')?.querySelectorAll('input').forEach(input => { input.disabled = busy; });
        for (const id of ['ppt-master-config-save', 'ppt-master-config-test']) if (byId(id)) byId(id).disabled = busy;
        modal()?.querySelectorAll('[data-ppt-service-close]').forEach(button => { button.disabled = lockClose; });
    }
    function fill() {
        byId('ppt-master-enabled').checked = config?.enabled === true; byId('ppt-master-endpoint').value = config?.endpoint || '';
        byId('ppt-master-token').value = ''; byId('ppt-master-clear-token').checked = false;
        byId('ppt-master-token').placeholder = config?.hasToken ? '已配置，留空保留；填写新值可替换' : '填写PPT Master服务的访问密钥';
        byId('ppt-master-config-source').textContent = config?.source === 'settings' ? '当前使用页面保存的全站配置，优先于服务器环境变量；保存后无需重启Pivot。' : '当前沿用服务器默认配置，保存后由此页面统一管理。';
        message(summary(), Boolean(config?.error));
    }
    async function request(suffix = '', options = {}) {
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 12000); controller = abort;
        try {
            const response = await apiFetch(`${API_BASE}/settings/ppt-master${suffix}`, { ...options, signal: abort.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || 'PPT服务设置请求失败，请重试。'); return data;
        } catch (error) { if (error.name === 'AbortError') throw new Error('PPT服务设置请求已取消或超时。'); throw error; }
        finally { clearTimeout(timeout); if (controller === abort) controller = null; }
    }
    async function open() {
        if (!config?.canManage || !modal() || saving) return;
        const sequence = ++generation, account = owner(); controller?.abort(); returnFocus = document.activeElement;
        modal().classList.remove('hidden'); modal().setAttribute('aria-hidden', 'false'); setBusy(true); message('正在读取PPT服务配置…');
        try { const data = await request(); if (!current(sequence, account)) return; config = data.config; result = null; fill(); updateCard(); }
        catch (error) { if (current(sequence, account)) message(error.message, true); }
        finally { if (current(sequence, account)) { setBusy(false); byId('ppt-master-endpoint')?.focus(); } }
    }
    function close() {
        if (saving) return;
        ++generation; controller?.abort(); byId('ppt-master-token').value = '';
        modal()?.classList.add('hidden'); modal()?.setAttribute('aria-hidden', 'true'); if (returnFocus?.isConnected) returnFocus.focus();
    }
    function payload() { return { revision: config?.revision, enabled: byId('ppt-master-enabled').checked, endpoint: byId('ppt-master-endpoint').value.trim(), token: byId('ppt-master-token').value, clearToken: byId('ppt-master-clear-token').checked }; }
    async function act(testing = false) {
        if (!config?.canManage || saving) return;
        const sequence = ++generation, account = owner(), input = payload(); controller?.abort(); saving = !testing;
        setBusy(true, !testing); message(testing ? '正在检查服务连接与协议…' : '正在加密保存并应用配置…');
        try {
            const data = await request(testing ? '/test' : '', { method: testing ? 'POST' : 'PUT', body: JSON.stringify(input) });
            if (!current(sequence, account)) return;
            if (testing) { result = data; message(data.message, !data.success); }
            else { config = data.config; result = null; fill(); message('已保存并立即应用，无需重启Pivot。'); showToast('PPT Master服务配置已保存。', 'success'); }
            updateCard();
        } catch (error) { if (current(sequence, account)) message(error.message, true); }
        finally { if (current(sequence, account)) { setBusy(false); saving = false; } }
    }
    async function testCard() {
        if (!config?.canManage || saving) return;
        const sequence = ++generation, account = owner(); controller?.abort();
        result = { message: '正在检查PPT服务连接…' }; updateCard();
        try {
            const data = await request('/test', { method: 'POST', body: JSON.stringify({ revision: config.revision, enabled: config.enabled, endpoint: config.endpoint }) });
            if (!current(sequence, account)) return;
            result = data; updateCard(); showToast(data.message, data.success ? 'success' : 'error');
        } catch (error) { if (current(sequence, account)) { result = { success: false, message: error.message }; updateCard(); } }
    }
    document.addEventListener('click', event => {
        if (event.target.closest('[data-ppt-service-config-open]')) void open();
        if (event.target.closest('[data-ppt-service-close]') || event.target === modal()) close();
        if (event.target.closest('#ppt-master-config-save')) void act();
        if (event.target.closest('#ppt-master-config-test')) void act(true);
        if (event.target.closest('[data-ppt-service-test-card]')) void testCard();
    });
    document.addEventListener('submit', event => { if (event.target.id === 'ppt-master-service-form') { event.preventDefault(); void act(); } });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && modal() && !modal().classList.contains('hidden')) { event.preventDefault(); event.stopPropagation(); close(); } });
    window.Pivot.exposeModule('settings.pptMaster', { renderCard });
})();
