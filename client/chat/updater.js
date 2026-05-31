let updaterPollTimer = null;
let updaterLastStatus = null;

function renderUpdaterRows(rows) {
    return rows.map(([label, value, cls = '']) => `
        <div class="monitor-row${cls ? ` ${cls}` : ''}">
            <span>${escapeHtml(label)}</span>
            <strong>${value}</strong>
        </div>
    `).join('');
}

function formatUpdaterStatus(status) {
    const map = {
        idle: '等待操作',
        running: '更新中',
        success: '更新完成',
        failed: '更新失败'
    };
    return map[status] || status || '-';
}

function formatUpdateAvailability(monitor = {}) {
    if (monitor.switchEnabled === false) return '<span class="text-muted">已关闭</span>';
    if (!monitor.enabled) return '<span class="text-muted">未启用</span>';
    if (monitor.checking) return '<span class="text-muted">检查中</span>';
    if (monitor.error) return '<span class="text-danger">检查失败</span>';
    if (monitor.updateAvailable) return '<span class="text-success">发现新版本</span>';
    if (monitor.lastCheckedAt) return '<span class="text-muted">已是最新</span>';
    return '<span class="text-muted">等待自动检查</span>';
}

function renderUpdaterStatus(data = updaterLastStatus) {
    updaterLastStatus = data || {};
    const config = updaterLastStatus.config || {};
    const updater = updaterLastStatus.updater || {};
    const monitor = updaterLastStatus.monitor || {};
    const state = updater.state || {};
    const statusEl = document.getElementById('updater-status-list');
    const logEl = document.getElementById('updater-log');
    const checkBtn = document.getElementById('updater-check-btn');
    const startBtn = document.getElementById('updater-start-btn');
    if (!statusEl || !logEl) return;

    const enabled = !!config.enabled;
    const running = !!updater.running || state.status === 'running';
    if (checkBtn) checkBtn.disabled = !enabled || running;
    if (startBtn) startBtn.disabled = !enabled || running || currentUser?.username !== 'admin';

    statusEl.innerHTML = renderUpdaterRows([
        ['当前版本', escapeHtml(updaterLastStatus.currentVersion || APP_VERSION || '-')],
        ['功能开关', config.switchEnabled ? '<span class="text-success">已开启</span>' : '<span class="text-muted">已关闭</span>'],
        ['配置状态', config.configured ? '<span class="text-success">已配置</span>' : '<span class="text-muted">未配置</span>'],
        ['更新服务', enabled ? (updater.available === false ? '<span class="text-danger">不可用</span>' : '<span class="text-success">已启用</span>') : '<span class="text-muted">未启用</span>'],
        ['自动检查', formatUpdateAvailability(monitor)],
        ['仓库', escapeHtml(config.repository || updater.repository || '-')],
        ['分支', escapeHtml(config.branch || updater.branch || '-')],
        ['最新版本', escapeHtml(monitor.latestVersion || updater.latestVersion || state.targetVersion || '-')],
        ['远端提交', escapeHtml(monitor.latestRevision || updater.revision || '-')],
        ['上次检查', escapeHtml(formatDateToCN(monitor.lastCheckedAt || ''))],
        ['下次检查', escapeHtml(formatDateToCN(monitor.nextCheckAt || ''))],
        ['状态', escapeHtml(formatUpdaterStatus(state.status || (updater.available ? 'idle' : '')))],
        ['步骤', escapeHtml(state.step || updater.error || '-')],
        ['更新时间', escapeHtml(formatDateToCN(state.updatedAt || updaterLastStatus.updatedAt || ''))]
    ]);
    logEl.textContent = (state.logs || []).slice(-120).join('\n') || updater.error || '暂无日志';
}

async function fetchUpdaterStatus() {
    const res = await apiFetch(`${API_BASE}/admin/updater/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '更新状态加载失败');
    renderUpdaterStatus(data);
    const state = data.updater?.state || {};
    if (state.status === 'running') scheduleUpdaterPoll();
    return data;
}

function scheduleUpdaterPoll() {
    clearTimeout(updaterPollTimer);
    updaterPollTimer = setTimeout(() => window.loadUpdaterStatus?.(), 5000);
}

window.loadUpdaterStatus = async function() {
    try {
        await fetchUpdaterStatus();
    } catch (e) {
        renderUpdaterStatus({
            currentVersion: APP_VERSION,
            config: { enabled: false, switchEnabled: false, configured: false },
            updater: { available: false, error: e.message, state: { status: 'failed', step: e.message, logs: [] } }
        });
    }
};

window.checkPivotUpdate = async function() {
    try {
        showToast('正在检查更新...', 'info');
        const res = await apiFetch(`${API_BASE}/admin/updater/check`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '检查更新失败');
        updaterLastStatus = {
            ...(updaterLastStatus || {}),
            monitor: data.updateAvailable !== undefined ? data : updaterLastStatus?.monitor,
            updater: {
                ...(updaterLastStatus?.updater || {}),
                available: true,
                latestVersion: data.latestVersion,
                revision: data.latestRevision || data.revision,
                repository: data.repository,
                branch: data.branch,
                state: data.state || updaterLastStatus?.updater?.state || {}
            }
        };
        renderUpdaterStatus(updaterLastStatus);
        showToast(data.updateAvailable ? `发现新版本：${data.latestVersion || '-'}` : `已是最新版本：${data.latestVersion || APP_VERSION || '-'}`, 'success');
    } catch (e) {
        showToast(e.message || '检查更新失败', 'error');
        await window.loadUpdaterStatus?.();
    }
};

window.startPivotUpdate = async function() {
    if (currentUser?.username !== 'admin') return showToast('只有 admin 超级管理员可以执行在线更新', 'error');
    if (!confirm('即将拉取代码、构建镜像并重建 Pivot 容器。更新过程中服务会短暂中断，是否继续？')) return;
    try {
        showToast('已提交更新任务，正在后台执行...', 'info');
        const res = await apiFetch(`${API_BASE}/admin/updater/start`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '启动更新失败');
        renderUpdaterStatus({
            ...(updaterLastStatus || {}),
            updater: {
                ...(updaterLastStatus?.updater || {}),
                available: true,
                running: true,
                state: data.state || { status: 'running', step: '已提交更新任务', logs: [] }
            }
        });
        scheduleUpdaterPoll();
    } catch (e) {
        showToast(e.message || '启动更新失败', 'error');
        await window.loadUpdaterStatus?.();
    }
};
