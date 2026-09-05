/* 组织 Skill 共享签名密钥管理。私钥只可提交，绝不读取或回显。 */
/* global Pivot */
(() => {
    const apiBase = () => window.Pivot.legacy.API_BASE || '/api';
    const fetchApi = () => window.Pivot.legacy.apiFetch || window.fetch.bind(window);
    const toast = (message, type) => window.Pivot.legacy.showToast?.(message, type);

    function elements() {
        return {
            status: document.getElementById('skill-signing-config-status'),
            detail: document.getElementById('skill-signing-config-detail'),
            history: document.getElementById('skill-signing-config-history'),
            generate: document.getElementById('skill-signing-generate'),
            disable: document.getElementById('skill-signing-disable'),
            importButton: document.getElementById('skill-signing-import'),
            importKeyId: document.getElementById('skill-signing-import-key-id'),
            importPrivateKey: document.getElementById('skill-signing-import-private-key')
        };
    }

    async function request(path, options = {}) {
        const response = await fetchApi()(`${apiBase()}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '组织签名密钥请求失败。');
        return data;
    }

    function render(status = {}) {
        const el = elements();
        if (!el.status) return;
        const source = status.source === 'environment' ? '已配置（环境变量）'
            : status.source === 'managed' ? '已配置（服务器加密存储）'
                : '未配置';
        el.status.textContent = source;
        el.status.style.color = status.configured ? 'var(--color-success, #10b981)' : 'var(--color-warning, #d97706)';
        const fragments = [];
        if (status.activeKeyId) fragments.push(`活动密钥：${status.activeKeyId}`);
        if (status.fingerprint) fragments.push(`指纹：${String(status.fingerprint).slice(0, 16)}…`);
        if (status.environmentManaged) fragments.push('由部署环境接管，页面不可修改');
        if (!status.encryptionReady) fragments.push('缺少 DATA_ENCRYPTION_KEY/JWT_SECRET，不能保存私钥');
        if (status.keyringError) fragments.push(`密钥环错误：${status.keyringError}`);
        el.detail.textContent = fragments.join(' · ') || '生成服务器密钥后，管理员即可一键共享发布。';
        if (el.history) {
            el.history.replaceChildren();
            (status.keys || []).forEach(key => {
                const chip = document.createElement('span');
                chip.className = `skill-signing-key-chip${key.status === 'active' ? ' is-active' : ''}`;
                chip.textContent = `${key.keyId} · ${key.status}`;
                chip.title = key.fingerprint ? `SHA-256: ${key.fingerprint}` : key.keyId;
                el.history.appendChild(chip);
            });
        }
        const locked = Boolean(status.environmentManaged || !status.encryptionReady);
        [el.generate, el.disable, el.importButton].filter(Boolean).forEach(button => { button.disabled = locked; });
    }

    async function load() {
        const el = elements();
        if (!el.status) return null;
        try {
            const data = await request('/settings/skill-signing');
            render(data);
            return data;
        } catch (error) {
            el.status.textContent = error.message || '组织签名状态读取失败。';
            el.status.style.color = 'var(--color-danger, #dc2626)';
            return null;
        }
    }

    async function generate() {
        if (!window.confirm('生成并启用新组织签名密钥？这会轮换当前密钥，但保留历史公钥以验证已发布版本。')) return;
        try {
            const data = await request('/settings/skill-signing/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            render(data);
            toast('组织签名密钥已生成并启用。', 'success');
        } catch (error) { toast(error.message, 'error'); }
    }

    async function disable() {
        if (!window.confirm('停用后，新的团队或组织 Skill 将无法发布；已发布版本仍可验证。确定继续吗？')) return;
        try {
            const data = await request('/settings/skill-signing/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            render(data);
            toast('组织共享签名已停用。', 'success');
        } catch (error) { toast(error.message, 'error'); }
    }

    async function importKey() {
        const el = elements();
        const privateKey = String(el.importPrivateKey?.value || '').trim();
        if (!privateKey) return toast('请粘贴要导入的 RSA 私钥 PEM。', 'warning');
        try {
            const data = await request('/settings/skill-signing/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyId: String(el.importKeyId?.value || '').trim(), privateKey, activate: true })
            });
            if (el.importPrivateKey) el.importPrivateKey.value = '';
            if (el.importKeyId) el.importKeyId.value = '';
            render(data);
            toast('组织签名密钥已加密保存并启用。', 'success');
        } catch (error) { toast(error.message, 'error'); }
    }

    function init() {
        const el = elements();
        el.generate?.addEventListener('click', generate);
        el.disable?.addEventListener('click', disable);
        el.importButton?.addEventListener('click', importKey);
        load();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.Pivot?.exposeModule?.('settings.skillSigning', { load });
})();
