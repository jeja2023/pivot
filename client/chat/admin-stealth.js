/* 客户端独占隐身模式管理模块 */
(function() {
    async function loadStealthSettings() {
        const toggle = document.getElementById('runtime-setting-stealth-mode-enabled');
        const statusLabel = document.getElementById('runtime-setting-stealth-mode-status-label');
        const secretInput = document.getElementById('runtime-setting-stealth-secret');
        if (!toggle) return;

        try {
            const apiBase = window.API_BASE || '/api';
            const apiFetchFn = window.apiFetch || fetch;
            const res = await apiFetchFn(`${apiBase}/settings/stealth`);
            if (!res.ok) return;
            const data = await res.json();

            toggle.checked = Boolean(data.enabled);
            if (statusLabel) {
                statusLabel.textContent = data.enabled ? '已开启（隐身中）' : '已关闭';
                statusLabel.style.color = data.enabled ? 'var(--color-success, #10b981)' : '';
            }
            if (secretInput) {
                secretInput.value = data.secret || '';
            }
            if (data.envOverridden) {
                toggle.disabled = true;
                if (statusLabel) {
                    statusLabel.textContent += '（受环境变量覆盖）';
                }
            }
        } catch (_) {}
    }

    async function updateStealthMode(enabled) {
        const toggle = document.getElementById('runtime-setting-stealth-mode-enabled');
        const statusLabel = document.getElementById('runtime-setting-stealth-mode-status-label');
        const isDesktop = Boolean(window.electronAPI || window.pivotDesktop || window.isDesktopApp);

        if (enabled && !isDesktop) {
            const confirmed = window.confirm(
                '【防锁死警告】\n\n' +
                '您当前正在通过普通 Web 浏览器访问系统。\n' +
                '开启「客户端独占隐身模式」后，服务端将立即对所有非官方桌面客户端的请求物理断开连接（ERR_EMPTY_RESPONSE），您当前的 Web 页面将无法继续连接！\n\n' +
                '后续只有使用官方 Pivot 桌面客户端（并配置对应通信密钥）才可访问。\n' +
                '如需紧急恢复，可在服务器启动环境添加环境变量 PIVOT_STEALTH_MODE=false。\n\n' +
                '确定要现在开启隐身模式吗？'
            );
            if (!confirmed) {
                if (toggle) toggle.checked = false;
                return;
            }
        }

        try {
            const apiBase = window.API_BASE || '/api';
            const apiFetchFn = window.apiFetch || fetch;
            const res = await apiFetchFn(`${apiBase}/settings/stealth`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || '保存隐身模式设置失败');
            }
            if (statusLabel) {
                statusLabel.textContent = data.enabled ? '已开启（隐身中）' : '已关闭';
                statusLabel.style.color = data.enabled ? 'var(--color-success, #10b981)' : '';
            }
            if (typeof showToast === 'function') {
                showToast(data.enabled ? '隐身模式已开启' : '隐身模式已关闭', 'success');
            }
        } catch (error) {
            if (toggle) toggle.checked = !enabled;
            if (typeof showToast === 'function') {
                showToast(error.message || '操作失败', 'error');
            }
        }
    }

    async function regenerateStealthSecret() {
        const confirmed = window.confirm(
            '重新生成密钥后，已连接的远程桌面客户端需要同步更新密钥配置方可继续访问，确定重新生成吗？'
        );
        if (!confirmed) return;

        try {
            const apiBase = window.API_BASE || '/api';
            const apiFetchFn = window.apiFetch || fetch;
            const res = await apiFetchFn(`${apiBase}/settings/stealth`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ regenerateSecret: true })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || '重新生成密钥失败');
            }
            const secretInput = document.getElementById('runtime-setting-stealth-secret');
            if (secretInput) secretInput.value = data.secret || '';
            if (typeof showToast === 'function') {
                showToast('密钥已重新生成', 'success');
            }
        } catch (error) {
            if (typeof showToast === 'function') {
                showToast(error.message || '操作失败', 'error');
            }
        }
    }

    function initStealthControls() {
        const toggle = document.getElementById('runtime-setting-stealth-mode-enabled');
        const secretInput = document.getElementById('runtime-setting-stealth-secret');
        const toggleSecretBtn = document.getElementById('runtime-setting-stealth-secret-toggle');
        const copySecretBtn = document.getElementById('runtime-setting-stealth-secret-copy');
        const refreshSecretBtn = document.getElementById('runtime-setting-stealth-secret-refresh');

        if (toggle) {
            toggle.addEventListener('change', () => {
                updateStealthMode(toggle.checked);
            });
        }

        if (toggleSecretBtn && secretInput) {
            toggleSecretBtn.addEventListener('click', () => {
                if (secretInput.type === 'password') {
                    secretInput.type = 'text';
                    toggleSecretBtn.textContent = '隐藏密钥';
                } else {
                    secretInput.type = 'password';
                    toggleSecretBtn.textContent = '显示密钥';
                }
            });
        }

        if (copySecretBtn && secretInput) {
            copySecretBtn.addEventListener('click', async () => {
                if (!secretInput.value) return;
                try {
                    await navigator.clipboard.writeText(secretInput.value);
                    if (typeof showToast === 'function') {
                        showToast('密钥已复制到剪贴板', 'success');
                    }
                } catch (_) {
                    secretInput.select();
                    document.execCommand('copy');
                    if (typeof showToast === 'function') {
                        showToast('密钥已复制到剪贴板', 'success');
                    }
                }
            });
        }

        if (refreshSecretBtn) {
            refreshSecretBtn.addEventListener('click', regenerateStealthSecret);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initStealthControls();
            loadStealthSettings();
        });
    } else {
        initStealthControls();
        loadStealthSettings();
    }

    window.Pivot?.exposeModule?.('settings.stealth', {
        loadStealthSettings,
        updateStealthMode,
        regenerateStealthSecret
    });
})();
