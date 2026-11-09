/* 应用服务配置目录，复用各服务既有配置和测试入口。 */
/* global API_BASE, apiFetch, PivotSafeHtml, escapeHtml, isSuperAdminUser */
(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    let settings = {}, sequence = 0, controller = null;
    const active = () => byId('tab-content-app-services') && !byId('tab-content-app-services').classList.contains('hidden') && !byId('admin-container')?.classList.contains('hidden');
    const account = () => window.Pivot?.legacy?.currentUser?.id;
    function ocrCard() {
        const ocr = settings.ocrConfig || {}, engine = settings.ocrEngineStatus?.http;
        const ready = engine ? engine.available === true : null, manager = isSuperAdminUser();
        const address = manager ? ocr.serviceUrl || '未配置服务地址' : ocr.configured || ocr.serviceUrl ? '********' : '未配置服务地址';
        const status = ready === true ? '服务可用' : ready === false ? '服务未就绪，请测试连接或检查运行状态' : '已保存的连接将在识别时使用';
        return `<article class="retrieval-model-service-card ${ready === true ? 'is-ready' : ready === false ? 'is-warning' : ''}">
            <strong>OCR识别服务</strong><span title="${escapeHtml(address)}">${escapeHtml(address)}</span><small>${escapeHtml(status)}</small>
            <div class="retrieval-model-service-actions">${manager ? '<button class="btn-secondary" type="button" data-retrieval-model-test="ocr">测试</button><button class="btn-secondary" type="button" data-retrieval-model-config-open="ocr">配置</button>' : '<small>由系统admin账号统一维护</small>'}</div></article>`;
    }
    const services = [
        { id: 'ocr', name: '文字识别 OCR', description: '扫描材料、图片和文档识别共用。', render: ocrCard },
        { id: 'speech', name: '语音识别', description: '语音输入与实时语音共用。', render: () => window.Pivot.moduleApi('settings.speech', {}).renderCard?.(settings.speechConfig) || '' },
        { id: 'ppt-master', name: 'PPT Master', description: '完整PPT制作、原稿编辑和页面视频；标准制作可独立使用。', render: () => window.Pivot.moduleApi('settings.pptMaster', {}).renderCard?.(settings.pptMasterConfig) || '' }
    ];
    function render(value = settings) {
        if (!active()) return;
        const target = byId('application-services-body');
        for (const service of services) {
            let entry = target.querySelector(`[data-application-service="${service.id}"]`);
            const fresh = !entry;
            if (!entry) { entry = document.createElement('section'); entry.className = 'settings-service-entry'; entry.dataset.applicationService = service.id; target.appendChild(entry); }
            if (fresh || (service.id === 'ocr' ? value.ocrConfig || value.ocrEngineStatus : service.id === 'speech' ? value.speechConfig : value.pptMasterConfig)) {
                PivotSafeHtml.setHtml(entry, `<h4>${escapeHtml(service.name)}</h4><p class="model-modal-desc">${escapeHtml(service.description)}</p>${service.render()}`);
            }
        }
        window.Pivot.legacy.bindEmbeddingModalEvents?.();
        if (value.speechConfig) void window.Pivot.moduleApi('settings.speech', {}).refreshStatus?.();
    }
    function renderFromSettings(value = {}) {
        settings = { ...settings, ...value };
        if (value.ocrConfig) window.Pivot.ocrConfig = value.ocrConfig;
        if (value.ocrEngineStatus) window.Pivot.ocrEngineStatus = value.ocrEngineStatus;
        render(value);
    }
    function leave() { ++sequence; controller?.abort(); controller = null; }
    async function load() {
        leave(); const requestId = sequence, owner = account(); controller = new AbortController(); const signal = controller.signal;
        const panel = byId('tab-content-app-services'); if (!panel) return;
        settings = {};
        const loading = document.createElement('p'); loading.id = 'application-services-loading'; loading.className = 'model-modal-desc'; loading.textContent = '正在读取应用服务配置…';
        byId('application-services-body').replaceChildren(loading);
        if (!panel.dataset.boundApplicationServices) {
            panel.dataset.boundApplicationServices = '1';
            byId('application-services-refresh').addEventListener('click', () => void window.Pivot.legacy.loadTabData?.('app-services'));
        }
        const current = () => requestId === sequence && owner === account() && active();
        try {
            const engines = apiFetch(`${API_BASE}/apps/ocr/engines`, { signal, cache: 'no-store' }).then(result => result.ok ? result.json() : null).catch(() => null);
            const response = await apiFetch(`${API_BASE}/settings`, { signal, cache: 'no-store' });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || '应用服务配置读取失败，请重试。');
            if (!current()) return;
            settings = {};
            byId('application-services-loading')?.remove();
            renderFromSettings(data);
            const status = await engines;
            if (current() && status?.engines && settings.ocrConfig?.serviceUrl === data.ocrConfig?.serviceUrl) renderFromSettings({ ocrEngineStatus: status.engines });
        } catch (error) { if (!signal.aborted && current()) throw error; }
    }
    window.Pivot.exposeModule('settings.applicationServices', { load, leave, renderFromSettings });
})();
