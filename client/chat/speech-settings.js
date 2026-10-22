/* 全站语音识别服务设置；密钥只写入，不从服务端读取。 */
/* global API_BASE, apiFetch, showToast, PivotSafeHtml, escapeHtml */
(function () {
    let config = null; let status = null; let epoch = 0; let controller = null; let refreshing = null;
    let dirty = false; let saving = false; let editVersion = 0; let poll = null; let returnFocus = null; let formRevision = null;
    const labels = { embedded: '内置中文识别 · CPU', gateway: '内网语音网关', openai: '音频转写兼容 API', qwen: 'Qwen 音频接口', local: '系统或 Vosk 识别' };
    const byId = id => document.getElementById(id);
    const modal = () => byId('speech-service-modal');
    const visible = () => modal() && !modal().classList.contains('hidden');

    function summary() {
        if (config?.error) return config.error;
        if (!config?.enabled) return '语音识别已关闭';
        if (status?.available) return status.streaming ? '服务已就绪 · 双遍流式识别' : '服务已就绪 · 句级识别';
        if (status?.reason) return status.reason;
        return config?.configured ? '已配置，等待检查运行状态' : '尚未配置完整';
    }
    function cardBody() {
        return `<strong>语音识别服务</strong><span>${escapeHtml(labels[config?.provider] || '待配置')}</span>
            <small>${escapeHtml(summary())}</small><div class="retrieval-model-service-actions">
            ${config?.canManage ? '<button class="btn-secondary" type="button" data-speech-card-test>测试</button><button class="btn-secondary" type="button" data-speech-config-open>配置</button>' : '<small>由系统管理员统一维护</small>'}</div>`;
    }
    function renderCard(value) {
        if (value && !visible() && !saving) config = value;
        return `<article id="speech-model-service-card" class="retrieval-model-service-card ${status?.available ? 'is-ready' : 'is-warning'}">${cardBody()}</article>`;
    }
    function updateCard() {
        const card = byId('speech-model-service-card');
        if (!card) return;
        card.classList.toggle('is-ready', status?.available === true);
        card.classList.toggle('is-warning', status?.available !== true);
        PivotSafeHtml.setHtml(card, cardBody());
    }
    async function request(path, options = {}) {
        const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15000);
        controller = abort;
        try {
            const response = await apiFetch(`${API_BASE}/settings/speech${path}`, { ...options, signal: abort.signal, cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '语音设置请求失败，请稍后重试。');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('语音设置请求已取消或超时，请重试。');
            throw error;
        } finally { clearTimeout(timer); if (controller === abort) controller = null; }
    }
    function message(text, error = false) {
        const target = byId('speech-config-status');
        if (target) { target.textContent = text; target.classList.toggle('is-error', error); }
    }
    function setBusy(busy, { lockClose = false } = {}) {
        byId('speech-service-form')?.querySelectorAll('input,select,textarea').forEach(element => { element.disabled = busy; });
        for (const id of ['speech-config-save', 'speech-config-test']) if (byId(id)) byId(id).disabled = busy;
        modal()?.querySelectorAll('[data-speech-close]').forEach(button => { button.disabled = busy && lockClose; });
    }
    function syncMode() {
        const provider = byId('speech-provider')?.value;
        byId('speech-embedded-fields')?.classList.toggle('hidden', provider !== 'embedded');
        byId('speech-remote-fields')?.classList.toggle('hidden', !['gateway', 'openai', 'qwen'].includes(provider));
        byId('speech-stream-field')?.classList.toggle('hidden', provider !== 'gateway');
        byId('speech-model-field')?.classList.toggle('hidden', provider === 'gateway');
    }
    function fill() {
        formRevision = config?.revision;
        const fields = { provider: 'speech-provider', endpoint: 'speech-endpoint', streamEndpoint: 'speech-stream-endpoint', model: 'speech-model',
            cpuThreads: 'speech-cpu-threads', timeoutMs: 'speech-timeout', endSilenceMs: 'speech-end-silence',
            maxConcurrent: 'speech-max-concurrent', minConfidence: 'speech-min-confidence', hotwords: 'speech-hotwords' };
        for (const [name, id] of Object.entries(fields)) if (byId(id)) byId(id).value = config?.[name] ?? '';
        byId('speech-enabled').checked = config?.enabled === true;
        byId('speech-allow-external').checked = config?.allowExternal === true;
        byId('speech-api-key').value = ''; byId('speech-clear-key').checked = false;
        byId('speech-api-key').placeholder = config?.hasApiKey ? '已配置密钥，留空保留；输入新密钥可替换' : '服务要求鉴权时填写';
        byId('speech-config-source').textContent = config?.source === 'settings' ? '当前使用页面保存的全站配置，优先于服务器环境变量。' : '当前使用服务器默认配置，保存后由此页面统一管理。';
        dirty = false; syncMode(); message(summary(), status?.available === false && status?.readiness !== 'starting');
    }
    function payload() {
        return { revision: formRevision, enabled: byId('speech-enabled').checked, provider: byId('speech-provider').value,
            endpoint: byId('speech-endpoint').value.trim(), streamEndpoint: byId('speech-stream-endpoint').value.trim(),
            model: byId('speech-model').value.trim(), apiKey: byId('speech-api-key').value, clearApiKey: byId('speech-clear-key').checked,
            allowExternal: byId('speech-allow-external').checked, cpuThreads: Number(byId('speech-cpu-threads').value),
            timeoutMs: Number(byId('speech-timeout').value), endSilenceMs: Number(byId('speech-end-silence').value),
            maxConcurrent: Number(byId('speech-max-concurrent').value), minConfidence: Number(byId('speech-min-confidence').value),
            hotwords: byId('speech-hotwords').value };
    }
    function scheduleRefresh() {
        clearTimeout(poll);
        if (status?.readiness === 'starting' && document.visibilityState !== 'hidden' && byId('speech-model-service-card')?.getClientRects().length) poll = setTimeout(() => refreshStatus(), 3000);
    }
    async function fetchStatus() {
        if (config?.canManage) return request('');
        const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15000);
        controller = abort;
        try {
            const response = await apiFetch(`${API_BASE}/chat/voice-recognition`, { signal: abort.signal, cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '语音服务状态检查失败。');
            return { config, status: data };
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('语音服务状态检查已取消或超时。');
            throw error;
        } finally { clearTimeout(timer); if (controller === abort) controller = null; }
    }
    async function refreshStatus() {
        if (refreshing) return;
        const generation = epoch;
        refreshing = fetchStatus().then(data => {
            if (generation !== epoch) return;
            if (data?.config) config = data.config;
            status = data?.status || null;
            updateCard();
            if (visible() && !dirty && !saving) message(summary(), status?.available === false && status?.readiness !== 'starting');
            scheduleRefresh();
        }).catch(() => {}).finally(() => { refreshing = null; });
        await refreshing;
    }
    async function open() {
        if (!config?.canManage || !modal()) return;
        const generation = ++epoch; clearTimeout(poll); controller?.abort();
        returnFocus = document.activeElement;
        modal().classList.remove('hidden'); modal().setAttribute('aria-hidden', 'false');
        setBusy(true); message('正在读取语音配置…');
        try {
            const data = await request('');
            if (generation !== epoch || !visible()) return;
            config = data.config; status = data.status; fill(); updateCard(); scheduleRefresh();
            byId('speech-provider')?.focus();
        } catch (error) { if (generation === epoch && visible()) message(error.message, true); }
        finally { if (generation === epoch) { setBusy(false); if (visible()) byId('speech-provider')?.focus(); } }
    }
    function close() {
        if (saving) return;
        epoch++; controller?.abort(); clearTimeout(poll);
        modal()?.classList.add('hidden'); modal()?.setAttribute('aria-hidden', 'true');
        if (byId('speech-api-key')) byId('speech-api-key').value = '';
        returnFocus?.focus?.();
    }
    async function save() {
        if (saving || !config || !byId('speech-service-form').reportValidity()) return;
        const generation = ++epoch; controller?.abort(); saving = true; setBusy(true, { lockClose: true });
        message('正在保存并应用；当前语音连接将结束…');
        try {
            const data = await request('', { method: 'PUT', body: JSON.stringify(payload()) });
            if (generation !== epoch) return;
            config = data.config; status = data.status; fill(); updateCard();
            window.Pivot.moduleApi('chat.serverVoiceRecognition', {}).invalidate?.();
            message(`已保存并应用。${summary()}`); showToast('统一语音配置已保存并生效', 'success'); scheduleRefresh();
        } catch (error) { if (generation === epoch) message(error.message, true); }
        finally { if (generation === epoch) { saving = false; setBusy(false); } }
    }
    async function testConnection({ fromCard = false, button } = {}) {
        if (!config?.canManage || saving) return;
        if (!fromCard && !byId('speech-service-form').reportValidity()) return;
        const generation = epoch; const version = editVersion;
        const target = button || byId('speech-config-test'); if (target) target.disabled = true;
        if (!fromCard) message('正在测试语音服务连接…');
        try {
            const patch = fromCard ? { revision: config.revision } : payload();
            const data = await request('/test', { method: 'POST', body: JSON.stringify(patch) });
            if (generation !== epoch || !fromCard && version !== editVersion) return;
            if (!fromCard) message(data.message, !data.success && data.state !== 'starting');
            showToast(data.message, data.success ? 'success' : data.state === 'starting' ? 'info' : 'error');
            if (fromCard) { status = { available: data.success, readiness: data.state, streaming: data.streaming, reason: data.message }; updateCard(); scheduleRefresh(); }
        } catch (error) { if (generation === epoch) { if (!fromCard) message(error.message, true); showToast(error.message, 'error'); } }
        finally { if (target?.isConnected) target.disabled = false; }
    }
    document.addEventListener('click', event => {
        if (event.target.closest('[data-speech-config-open]')) { open(); return; }
        const test = event.target.closest('[data-speech-card-test]');
        if (test) { testConnection({ fromCard: true, button: test }); return; }
        if (event.target.closest('[data-speech-close]') || event.target === modal()) { close(); return; }
        if (event.target.closest('#speech-config-save')) save();
        if (event.target.closest('#speech-config-test')) testConnection();
    });
    document.addEventListener('change', event => {
        if (!event.target.closest('#speech-service-form')) return;
        dirty = true; editVersion++; syncMode(); message('配置尚未保存，测试不会修改当前服务。');
    });
    document.addEventListener('input', event => { if (event.target.closest('#speech-service-form')) { dirty = true; editVersion++; } });
    document.addEventListener('submit', event => { if (event.target.id === 'speech-service-form') { event.preventDefault(); save(); } });
    document.addEventListener('keydown', event => {
        if (!visible()) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...modal().querySelectorAll('button,input,select,textarea')].filter(element => !element.disabled && element.getClientRects().length);
            const first = focusable[0]; const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    window.Pivot.exposeModule('settings.speech', { renderCard, refreshStatus });
}());
