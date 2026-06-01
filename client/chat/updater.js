let updaterPollTimer = null;
let updaterLastStatus = null;

function normalizeUpdaterLogTimestamp(line) {
    return String(line || '').replace(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/, (_match, timestamp) => {
        const formatted = formatDateToCN(timestamp);
        if (!formatted) return `[${timestamp}]`;
        return `[${formatted.replace(' ', 'T')}+08:00]`;
    });
}

function updaterBadge(text, type = 'muted') {
    const className = {
        success: 'text-success',
        danger: 'text-danger',
        warning: 'text-warning',
        muted: 'text-muted'
    }[type] || 'text-muted';
    return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function renderUpdaterRows(rows) {
    return rows.map(([label, value, cls = '']) => `
        <div class="monitor-row updater-row${cls ? ` ${cls}` : ''}">
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
    if (monitor.switchEnabled === false) return updaterBadge('已关闭');
    if (!monitor.enabled) return updaterBadge('未启用');
    if (monitor.checking) return updaterBadge('检查中');
    if (monitor.error) return updaterBadge('检查失败', 'danger');
    if (monitor.updateAvailable) return updaterBadge('发现新版本', 'success');
    if (monitor.lastCheckedAt) return updaterBadge('已是最新');
    return updaterBadge('等待检查');
}

function getUpdaterDiagnosis({ config = {}, sidecarConnected = false, updater = {}, monitor = {}, running = false } = {}) {
    if (!config.switchEnabled) {
        return {
            tone: 'muted',
            title: '在线更新已关闭',
            message: '当前部署不会连接 Git 仓库，也不会启动自动检查。适合纯局域网或高安全部署。',
            commands: [
                'PIVOT_ONLINE_UPDATE_ENABLED=true',
                'docker compose --profile online-update up -d --build pivot-updater',
                'docker compose up -d'
            ]
        };
    }
    if (!config.configured) {
        return {
            tone: 'danger',
            title: '在线更新配置不完整',
            message: '请先配置 PIVOT_UPDATER_TOKEN、PIVOT_UPDATER_URL 和 Git 仓库地址。',
            commands: ['PIVOT_UPDATER_URL=http://pivot-updater:3300', 'PIVOT_UPDATE_REPO=https://github.com/your-org/pivot.git']
        };
    }
    if (!sidecarConnected) {
        return {
            tone: 'danger',
            title: 'Updater sidecar 未连接',
            message: updater.error || monitor.error || '请确认 pivot-updater 容器已启动，并与主应用位于同一 Docker 网络。',
            commands: [
                'docker compose --profile online-update up -d --build pivot-updater',
                'docker compose ps pivot-updater',
                'docker logs pivot-updater --tail=100'
            ]
        };
    }
    if (monitor.error) {
        return {
            tone: 'danger',
            title: '自动检查失败',
            message: monitor.error,
            commands: ['docker logs pivot-updater --tail=100']
        };
    }
    if (running) {
        return {
            tone: 'warning',
            title: '更新正在执行',
            message: '正在拉取代码、构建镜像或重建容器。过程中 Pivot 服务可能短暂中断。',
            commands: []
        };
    }
    if (monitor.updateAvailable) {
        return {
            tone: 'success',
            title: '发现可用更新',
            message: `远端版本 ${monitor.latestVersion || '-'}，可由 admin 点击“开始更新”。`,
            commands: []
        };
    }
    return {
        tone: 'success',
        title: '在线更新服务正常',
        message: monitor.lastCheckedAt ? '当前没有发现新版本。' : '可点击“检查更新”立即检查远端仓库。',
        commands: []
    };
}

function renderUpdaterDiagnosis(diagnosis) {
    const box = document.getElementById('updater-diagnosis');
    if (!box) return;
    box.className = `updater-diagnosis is-${diagnosis.tone || 'muted'}`;
    const commands = (diagnosis.commands || []).map(cmd => `<code>${escapeHtml(cmd)}</code>`).join('');
    box.innerHTML = `
        <div class="updater-diagnosis-main">
            <strong>${escapeHtml(diagnosis.title)}</strong>
            <p>${escapeHtml(diagnosis.message)}</p>
        </div>
        ${commands ? `<div class="updater-commands">${commands}</div>` : ''}
    `;
}

function renderUpdaterStatus(data = updaterLastStatus) {
    updaterLastStatus = data || {};
    const config = updaterLastStatus.config || {};
    const updater = updaterLastStatus.updater || {};
    const monitor = updaterLastStatus.monitor || {};
    const state = updater.state || {};
    const statusEl = document.getElementById('updater-status-list');
    const detailEl = document.getElementById('updater-detail-list');
    const logEl = document.getElementById('updater-log');
    const checkBtn = document.getElementById('updater-check-btn');
    const startBtn = document.getElementById('updater-start-btn');
    if (!statusEl || !detailEl || !logEl) return;

    const enabled = !!config.enabled;
    const running = !!updater.running || state.status === 'running';
    const sidecarConnected = enabled && updater.available === true;
    if (checkBtn) checkBtn.disabled = !enabled || running;
    if (startBtn) startBtn.disabled = !enabled || running || !sidecarConnected || currentUser?.username !== 'admin';

    renderUpdaterDiagnosis(getUpdaterDiagnosis({ config, sidecarConnected, updater, monitor, running }));

    statusEl.innerHTML = renderUpdaterRows([
        ['当前版本', escapeHtml(updaterLastStatus.currentVersion || APP_VERSION || '-')],
        ['功能开关', config.switchEnabled ? updaterBadge('已开启', 'success') : updaterBadge('已关闭')],
        ['配置状态', config.configured ? updaterBadge('已配置', 'success') : updaterBadge('未配置')],
        ['Sidecar', enabled ? (sidecarConnected ? updaterBadge('已连接', 'success') : updaterBadge('未连接', 'danger')) : updaterBadge('未启用')],
        ['自动检查', formatUpdateAvailability({ ...monitor, enabled: sidecarConnected })],
        ['状态', escapeHtml(formatUpdaterStatus(state.status || (sidecarConnected ? 'idle' : '')))]
    ]);

    detailEl.innerHTML = renderUpdaterRows([
        ['仓库', escapeHtml(config.repository || updater.repository || '-')],
        ['分支', escapeHtml(config.branch || updater.branch || '-')],
        ['最新版本', escapeHtml(monitor.latestVersion || updater.latestVersion || state.targetVersion || '-')],
        ['远端提交', escapeHtml(monitor.latestRevision || updater.revision || '-')],
        ['上次检查', escapeHtml(formatDateToCN(monitor.lastCheckedAt || ''))],
        ['下次检查', escapeHtml(formatDateToCN(monitor.nextCheckAt || ''))],
        ['步骤', escapeHtml(state.step || updater.error || monitor.error || '-')],
        ['更新时间', escapeHtml(formatDateToCN(state.updatedAt || updaterLastStatus.updatedAt || ''))]
    ]);

    const logs = (state.logs || []).slice(-120).map(normalizeUpdaterLogTimestamp);
    logEl.textContent = logs.length ? logs.join('\n') : (updater.error || monitor.error || '暂无日志');
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
            monitor: { error: e.message },
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
        const checkFailed = Boolean(data.error);
        updaterLastStatus = {
            ...(updaterLastStatus || {}),
            monitor: data.updateAvailable !== undefined ? data : updaterLastStatus?.monitor,
            updater: {
                ...(updaterLastStatus?.updater || {}),
                available: checkFailed ? false : (updaterLastStatus?.updater?.available === true),
                error: checkFailed ? data.error : '',
                latestVersion: data.latestVersion,
                revision: data.latestRevision || data.revision,
                repository: data.repository,
                branch: data.branch,
                state: data.state || updaterLastStatus?.updater?.state || {}
            }
        };
        renderUpdaterStatus(updaterLastStatus);
        if (checkFailed) throw new Error(data.error);
        showToast(data.updateAvailable ? `发现新版本：${data.latestVersion || '-'}` : `已是最新版本：${data.latestVersion || APP_VERSION || '-'}`, 'success');
    } catch (e) {
        showToast(e.message || '检查更新失败', 'error');
        await window.loadUpdaterStatus?.();
    }
};

window.startPivotUpdate = async function() {
    if (currentUser?.username !== 'admin') return showToast('只有 admin 超级管理员可以执行在线更新', 'error');
    const confirmed = typeof window.showConfirm === 'function'
        ? await window.showConfirm('开始在线更新', '即将拉取代码、构建镜像并重建 Pivot 容器。更新过程中服务会短暂中断，是否继续？')
        : false;
    if (!confirmed) return;
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
                error: '',
                state: data.state || { status: 'running', step: '已提交更新任务', logs: [] }
            }
        });
        scheduleUpdaterPoll();
    } catch (e) {
        showToast(e.message || '启动更新失败', 'error');
        await window.loadUpdaterStatus?.();
    }
};
