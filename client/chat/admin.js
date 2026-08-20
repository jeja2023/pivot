// --- 管理员面板核心逻辑 ---
/* exported formatDateToCN, escapeHtml, renderTableMessage, escapeCsvValue, formatTokenAmount, formatTokenCount, formatTokenInputValue, parseTokenAmount, encodeActionArg, downloadFileByFetch, renderPagination */
const formatDateToCN = (dateStr) => {
    if (!dateStr) return '-';
    const text = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');
};
const escapeHtml = (str) => {
    if (window.PivotSafeHtml) return window.PivotSafeHtml.escapeHtml(str);
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

function renderTableMessage(tbody, colspan, message, options = {}) {
    if (!tbody) return;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colspan;
    td.className = options.className || 'text-center';
    td.style.padding = options.padding || '28px';
    if (options.color) td.style.color = options.color;
    td.textContent = message || '';
    tr.appendChild(td);
    tbody.replaceChildren(tr);
}

const escapeCsvValue = (value) => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

function formatTokenAmount(value, options = {}) {
    const { emptyText = '不限', suffix = '' } = options;
    const n = Number(value) || 0;
    if (n <= 0) return emptyText;
    if (n >= 1000000000) return `${(n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1)}B${suffix}`;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M${suffix}`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K${suffix}`;
    return `${n.toLocaleString()}${suffix}`;
}

const formatTokenCount = (value, emptyText = '0') => formatTokenAmount(value, { emptyText });

function formatTokenInputValue(value) {
    const n = Number(value) || 0;
    if (n <= 0) return '';
    if (n >= 1000000000) return `${(n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1)}B`;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
}

function parseTokenAmount(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const match = text.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB万亿]?)\s*(?:tokens?)?$/);
    if (!match) return Number(text.replace(/[^\d.]/g, '')) || 0;
    const num = Number(match[1]) || 0;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'k' ? 1000
        : unit === '万' ? 10000
        : unit === 'm' ? 1000000
        : unit === '亿' ? 100000000
        : unit === 'b' ? 1000000000
        : 1;
    return Math.round(num * multiplier);
}

const encodeActionArg = (value) => encodeURIComponent(JSON.stringify(value))
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');

const downloadFileByFetch = async (url, filename) => {
    showToast('正在准备导出文件...', 'info');
    try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error('下载失败');
        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename || 'export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(downloadUrl);
        a.remove();
        showToast('导出成功');
    } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
    }
};

let pageState = { models: 1, users: 1, logs: 1, stats: 1, details: 1, attachments: 1, memories: 1, announcements: 1, apiCallLogs: 1, userRecords: 1, limit: 15 };

const SETTINGS_TABS = ['users', 'models', 'global-params', 'tool-policy', 'logs', 'monitor', 'usage', 'keys', 'memories', 'attachments', 'announcements', 'ops', 'account'];
const LEGACY_SETTINGS_TAB_ALIASES = new Set(['stats', 'details', 'report']);
const ADMIN_ONLY_SETTINGS_TABS = new Set(['ops', 'global-params', 'users', 'tool-policy', 'logs', 'monitor', 'announcements']);
const SETTINGS_USAGE_SUBTAB_STORAGE_KEY = 'pivot_settings_usage_subtab';

function normalizeUsageSubtab(subtab) {
    const target = String(subtab || '').trim();
    if (target === 'report' && !isAdminUser()) return 'stats';
    return ['stats', 'details', 'report'].includes(target) ? target : 'stats';
}

function getUsageSubtab() {
    try {
        return normalizeUsageSubtab(sessionStorage.getItem(SETTINGS_USAGE_SUBTAB_STORAGE_KEY));
    } catch (e) {
        return 'stats';
    }
}

function getActiveUsageSubtab() {
    const activeButton = document.querySelector('[data-usage-subtab].active');
    return normalizeUsageSubtab(activeButton?.dataset.usageSubtab || getUsageSubtab());
}

function persistUsageSubtab(subtab) {
    try {
        sessionStorage.setItem(SETTINGS_USAGE_SUBTAB_STORAGE_KEY, normalizeUsageSubtab(subtab));
    } catch (e) {
        // 浏览器禁用 sessionStorage 时仅退回默认子页。
    }
}

const USAGE_SUBTAB_METAS = {
    stats: {
        title: '用量统计',
        desc: '按用户与模型汇总消息、Token、费用估算和最后活跃时间。'
    },
    details: {
        title: '用量明细',
        desc: '查看每条消息的时间、用户、模型、角色和 Token 消耗明细。'
    },
    report: {
        title: '审计报表',
        desc: '按部门、用户和时间范围生成 Token 趋势、用户排行和部门消耗对比。'
    }
};

function switchUsageSubtab(subtab, options = {}) {
    const target = normalizeUsageSubtab(subtab);
    document.querySelectorAll('[data-usage-subtab]').forEach(button => {
        const active = button.dataset.usageSubtab === target;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-usage-panel]').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.usagePanel !== target);
    });
    document.querySelectorAll('[data-usage-actions]').forEach(actions => {
        actions.classList.toggle('hidden', actions.dataset.usageActions !== target);
    });
    const meta = USAGE_SUBTAB_METAS[target];
    const titleEl = document.getElementById('usage-title');
    const descEl = document.getElementById('usage-desc');
    if (titleEl && meta) titleEl.textContent = meta.title;
    if (descEl && meta) descEl.textContent = meta.desc;
    if (!options.skipPersist) persistUsageSubtab(target);
    if (!options.skipLoad) loadTabData(target, options.page || pageState[target] || 1);
    window.scheduleSettingsWorkspaceScale?.();
    setTimeout(() => window.scheduleSettingsWorkspaceScale?.(), 0);
    return target;
}

window.Pivot?.exposeModule?.('settings.usage', {
    switchSubtab: switchUsageSubtab,
    getSubtab: getActiveUsageSubtab
});

function getDefaultSettingsTab() {
    return isAdminUser() ? 'ops' : 'models';
}

function normalizeSettingsTab(tab) {
    const requested = String(tab || '').trim();
    let target = SETTINGS_TABS.includes(requested) ? requested : getDefaultSettingsTab();
    if (LEGACY_SETTINGS_TAB_ALIASES.has(requested)) {
        target = 'usage';
        persistUsageSubtab(requested);
    }
    if (ADMIN_ONLY_SETTINGS_TABS.has(target) && !isAdminUser()) target = 'models';
    return target;
}

const adminFeatureScripts = [
    '/chat/models.js',
    '/chat/models-actions.js',
    '/chat/users.js',
    '/chat/stats.js',
    '/chat/stats-monitor-utils.js',
    '/chat/stats-monitor.js',
    '/chat/admin-settings.js',
    '/chat/announcements-admin.js',
    '/chat/tool-policy.js',
    '/chat/extra.js'
];

let adminFeatureLoadPromise = null;

const loadScriptOnce = (src) => {
    if (window.Pivot?.loadScriptOnce) return window.Pivot.loadScriptOnce(src);
    return Promise.reject(new Error(`脚本加载器不可用: ${src}`));
};

window.ensureAdminSettingsScript = () => loadScriptOnce('/chat/admin-settings.js');

window.ensureAdminFeatureScripts = async () => {
    if (adminFeatureLoadPromise) return adminFeatureLoadPromise;
    adminFeatureLoadPromise = (async () => {
        if (window.Pivot?.loadScripts) {
            await window.Pivot.loadScripts(adminFeatureScripts);
            return;
        }
        for (const src of adminFeatureScripts) {
            await loadScriptOnce(src);
        }
    })();
    try {
        await adminFeatureLoadPromise;
    } catch (e) {
        adminFeatureLoadPromise = null;
        throw e;
    }
};

window.openAdminPanel = async (options = {}) => {
    await window.ensureAdminFeatureScripts();
    const adminContainer = document.getElementById('admin-container');
    window.showMainWorkspace?.('settings');
    adminContainer?.classList.remove('hidden');
    const isAdmin = isAdminUser();
    const isSuperAdmin = isSuperAdminUser();
    const titleEl = adminContainer?.querySelector('.settings-workspace-header h3');
    const descEl = adminContainer?.querySelector('.settings-workspace-header p');
    if (titleEl) titleEl.innerText = isAdmin ? '系统设置' : '个人设置';
    if (descEl) descEl.innerText = isAdmin
        ? '集中管理模型、用户、审计、监控、用量审计、API 接入与账号安全。'
        : '管理你的模型、附件、用量审计、API 接入与账号安全。';

    if (isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    }
    document.querySelectorAll('.super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdmin);
    });
    await loadSettings();
    const targetTab = options.restore ? normalizeSettingsTab(window.getStoredSettingsTab?.()) : getDefaultSettingsTab();
    await window.switchTab(targetTab);
};

window.closeModal = () => window.showMainWorkspace?.('chat');

window.switchTab = async (tab, options = {}) => {
    await window.ensureAdminFeatureScripts();
    const requestedTab = String(tab || '').trim();
    tab = normalizeSettingsTab(requestedTab);
    const tabs = SETTINGS_TABS;
    tabs.forEach(t => document.getElementById(`tab-content-${t}`)?.classList.add('hidden'));
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.settings-workspace-view .admin-content')?.classList.toggle('is-monitor-tab-active', tab === 'monitor');

    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.getElementById(`tab-content-${tab}`)?.classList.remove('hidden');
    window.persistSettingsTab?.(tab);
    if (tab === 'usage') {
        const usageSubtab = switchUsageSubtab(options.subtab || (LEGACY_SETTINGS_TAB_ALIASES.has(requestedTab) ? requestedTab : getUsageSubtab()), {
            skipPersist: false,
            skipLoad: true
        });
        if (options.page) pageState[usageSubtab] = Math.max(parseInt(options.page, 10) || 1, 1);
    }
    window.scheduleSettingsWorkspaceScale?.();
    loadTabData(tab);
    setTimeout(() => window.scheduleSettingsWorkspaceScale?.(), 0);
};

async function loadTabData(tab, page = 1) {
    if (LEGACY_SETTINGS_TAB_ALIASES.has(tab)) {
        if (document.getElementById('tab-content-usage') && document.getElementById('tab-content-usage').classList.contains('hidden')) {
            await window.switchTab('usage', { subtab: tab, page });
            return;
        }
        const usageSubtab = normalizeUsageSubtab(tab);
        pageState[usageSubtab] = page;
        if (usageSubtab === 'stats' && window.loadStats) loadStats(page);
        if (usageSubtab === 'details' && window.loadDetails) loadDetails(page);
        if (usageSubtab === 'report' && window.loadReport) loadReport();
        return;
    }
    pageState[tab] = page;
    if (tab === 'models' && window.loadModels) loadModels(page);
    if (tab === 'users' && window.loadUsers) {
        loadUsers(page);
        setTimeout(() => window.ensureUserRecordButtons?.(), 0);
    }
    if (tab === 'logs' && window.loadLogs) loadLogs(page);
    if (tab === 'monitor' && window.loadMonitorSummary) loadMonitorSummary();
    if (tab === 'usage') {
        const usageSubtab = getActiveUsageSubtab();
        if (usageSubtab === 'stats' && window.loadStats) loadStats(pageState.stats || page);
        if (usageSubtab === 'details' && window.loadDetails) loadDetails(pageState.details || page);
        if (usageSubtab === 'report' && window.loadReport) loadReport();
    }
    if (tab === 'memories' && window.loadMemories) window.loadMemories(page);
    if (tab === 'attachments' && window.loadAttachments) loadAttachments(page);
    if (tab === 'announcements' && window.loadAnnouncementsAdmin) window.loadAnnouncementsAdmin(page);
    if (tab === 'tool-policy' && window.loadToolPolicy) window.loadToolPolicy();
    if (tab === 'ops' && window.loadOpsSummary) loadOpsSummary();
    if (tab === 'details' && window.loadDetails) loadDetails(page);
    if (tab === 'apiCallLogs' && window.loadApiCallLogs) loadApiCallLogs(page);
    if (tab === 'userRecords' && window.loadUserRecordMessages) loadUserRecordMessages(page);
    if (tab === 'keys' && window.loadApiKeys) {
        loadApiKeys();
        const displayEl = document.getElementById('api-base-url-display');
        if (displayEl) {
            // 优先使用后端配置的公网 URL，否则根据当前访问地址智能生成
            const origin = window.publicUrl || window.location.origin;
            displayEl.innerText = `${origin}/v1`;
        }
    }
}
window.loadTabData = loadTabData;

// 智能获取远程模型列表
window.fetchRemoteModels = async function() {
    const url = document.getElementById('m-url').value;
    const apiKey = document.getElementById('m-key').value;
    const id = document.getElementById('m-id').value;
    const selectContainer = document.getElementById('m-model-select-container');
    const selectEl = document.getElementById('m-model-select');

    if (!url) return showToast('请先填写接口地址', 'error');

    try {
        showToast('正在获取模型列表...', 'info');
        const res = await apiFetch(`${API_BASE}/models/fetch-remote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, api_key: apiKey, id })
        });
        const data = await res.json();

        if (!data.success) throw new Error(data.error);
        if (!data.models || data.models.length === 0) throw new Error('未获取到可用模型');

        // 填充下拉框
        PivotSafeHtml.setHtml(selectEl, '<option value="">-- 请选择获取到的模型 --</option>' +
            data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join(''));

        selectContainer.classList.remove('hidden');
        showToast(`成功获取 ${data.models.length} 个模型`);

        // 绑定选择事件
        selectEl.onchange = (e) => {
            if (e.target.value) {
                document.getElementById('m-model').value = e.target.value;
                // 尝试自动填充显示名称 (如果是空的)
                const nameInput = document.getElementById('m-name');
                if (!nameInput.value) {
                    nameInput.value = e.target.value;
                }
            }
        };
    } catch (e) {
        showToast(e.message, 'error');
    }
};
