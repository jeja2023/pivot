/* global window, document, apiFetch, API_BASE */
(function () {
    'use strict';
    let inFlight = null;
    let previousFocus = null;
    const views = new Set();
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    const steps = [
        '下载并安装 Windows 本机助手，启动后保持运行。',
        '在“工具库 → 本机授权中心”生成配对码，复制到助手中。',
        '填写与浏览器相同的服务根地址，包括协议、主机和端口。远程 HTTP 须先在本机确认该地址。',
        '确认账号后，在助手中授权目标应用。每次操作仍需本机确认。',
        '升级前退出旧助手；安装新版后重新配对和授权。'
    ];
    function update(view, data) {
        const value = data?.[view.kind];
        const helper = view.kind === 'localHelper';
        const prefix = helper ? '/downloads/local-helper/' : '/downloads/';
        const ready = value?.available === true && typeof value.url === 'string' && value.url.startsWith(prefix)
            && !value.url.includes('..') && !/[\\?#]/.test(value.url);
        view.link.hidden = !ready;
        view.link.removeAttribute('href');
        if (ready) view.link.href = value.url;
        view.link.textContent = helper ? '下载 Windows 本机助手' : '下载完整桌面客户端';
        view.state.textContent = ready ? helper
            ? `v${value.version} · ${value.platform || 'Windows x64'} · ${value.channel === 'development' ? '开发验证版（未签名）' : '正式版'}${value.size ? ` · ${(value.size / 1048576).toFixed(1)} MB` : ''}`
            : '完整 Pivot 桌面客户端，安装后可使用客户端提供的本机能力。'
            : '暂未发布';
        view.state.setAttribute('role', 'status');
    }
    async function refresh() {
        if (!inFlight) inFlight = (async () => {
            const response = await apiFetch(API_BASE + '/auth/config');
            if (!response.ok) throw new Error('读取下载信息失败');
            return (await response.json()).clientDownloads || {};
        })().finally(() => { inFlight = null; });
        try {
            const data = await inFlight;
            for (const view of views) {
                if (!view.root.isConnected) { views.delete(view); continue; }
                update(view, data);
            }
        } catch (_) {
            for (const view of views) {
                if (!view.root.isConnected) { views.delete(view); continue; }
                view.link.hidden = true;
                view.link.removeAttribute('href');
                view.state.textContent = '下载信息暂时不可用，请稍后重试。';
            }
        }
    }
    function mount(root, kind) {
        for (const view of views) if (view.root === root || !view.root.isConnected) views.delete(view);
        root.replaceChildren();
        root.classList.add('client-download-card');
        const title = node('h4', kind === 'localHelper' ? 'Windows 本机助手' : '完整桌面客户端');
        const description = node('p', kind === 'localHelper' ? '在浏览器中操作当前电脑时使用，安装后继续在此配对。' : '使用独立桌面窗口访问 Pivot。');
        const state = node('p', '正在读取下载信息…', 'client-download-meta');
        const actions = node('div', '', 'client-download-actions');
        const link = node('a', '', 'btn-primary'); link.hidden = true; link.setAttribute('download', '');
        actions.append(link);
        root.append(title, description, state, actions);
        if (kind === 'localHelper') {
            const details = node('details');
            details.append(node('summary', '安装说明'));
            const list = node('ol'); for (const step of steps) list.append(node('li', step));
            details.append(list); root.append(details);
        }
        const retry = node('button', '刷新下载信息', 'btn-secondary'); retry.type = 'button'; retry.onclick = () => { void refresh(); };
        actions.append(retry);
        views.add({ root, kind, state, link });
        void refresh();
    }
    function mountHelper(root) { mount(root, 'localHelper'); }
    function close() {
        const modal = document.getElementById('client-downloads-modal');
        modal?.classList.add('hidden'); modal?.setAttribute('aria-hidden', 'true');
        if (previousFocus?.isConnected) previousFocus.focus();
    }
    function open() {
        const modal = document.getElementById('client-downloads-modal');
        if (!modal) return;
        if (!modal.classList.contains('hidden')) { void refresh(); return; }
        previousFocus = document.activeElement;
        modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
        mountHelper(document.getElementById('client-downloads-helper'));
        mount(document.getElementById('client-downloads-desktop'), 'desktop');
        document.getElementById('client-downloads-close').focus();
    }
    const modal = document.getElementById('client-downloads-modal');
    document.getElementById('desktop-download-link')?.addEventListener('click', open);
    document.getElementById('client-downloads-close')?.addEventListener('click', close);
    modal?.addEventListener('click', event => { if (event.target === modal) close(); });
    modal?.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button,a[href],summary')].filter(element => !element.disabled && element.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    window.Pivot.exposeModule('client.downloads', { mountHelper, open });
})();
