/* 默认收起的运行资源包内部控制台。仅当服务端开关和系统最高管理员同时允许时显示。 */
/* global Pivot */
(() => {
    const state = { available: false, packs: [], page: 1, limit: 8 };
    const apiBase = () => window.API_BASE || '/api';
    const escape = value => window.PivotSafeHtml?.escapeHtml ? window.PivotSafeHtml.escapeHtml(value) : String(value ?? '');
    const escapeAttr = value => window.PivotSafeHtml?.escapeAttr ? window.PivotSafeHtml.escapeAttr(value) : escape(value);
    const short = (value, max = 20) => { const text = String(value || ''); return text.length > max ? `${text.slice(0, max)}...` : text; };
    const notice = (message, tone = '') => {
        const target = document.getElementById('agent-harness-notice');
        if (!target) return;
        target.textContent = message;
        target.className = `agent-harness-notice${tone ? ` is-${tone}` : ''}`;
    };
    const setHtml = (element, html) => {
        if (window.PivotSafeHtml?.setHtml) window.PivotSafeHtml.setHtml(element, html);
        else element.textContent = String(html || '');
    };
    const formatDate = value => {
        const date = new Date(String(value || '').replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    };
    async function request(path, options = {}) {
        const response = await (window.apiFetch || window.fetch.bind(window))(`${apiBase()}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '运行资源包请求失败。');
        return data;
    }
    function applyVisibility(enabled) {
        state.available = enabled === true;
        const tab = document.querySelector('[data-agent-harness-nav="packs"]');
        const panel = document.querySelector('[data-agent-harness-section="packs"]');
        if (tab) {
            tab.hidden = !state.available;
            tab.classList.toggle('hidden', !state.available);
            tab.setAttribute('aria-hidden', state.available ? 'false' : 'true');
        }
        if (panel && !state.available) {
            panel.hidden = true;
            panel.classList.add('hidden');
        }
        document.querySelectorAll('.agent-harness-pack-sync').forEach(element => element.classList.toggle('hidden', !state.available));
    }
    function render() {
        const list = document.getElementById('agent-harness-pack-list');
        const pagination = document.getElementById('agent-harness-pack-pagination');
        if (!list) return;
        if (!state.packs.length) {
            pagination?.replaceChildren();
            return setHtml(list, '<div class="agent-harness-empty-card"><strong>暂无已安装运行资源包</strong><span>内部试验控制台仅展示已校验的缓存资源。</span></div>');
        }
        const total = state.packs.length;
        const pages = Math.max(1, Math.ceil(total / state.limit));
        state.page = Math.min(Math.max(1, state.page), pages);
        const start = (state.page - 1) * state.limit;
        const rows = state.packs.slice(start, start + state.limit);
        setHtml(list, `<div class="aht-wrap"><table class="aht"><thead><tr><th class="tc">序号</th><th>包 ID</th><th class="tc">类型</th><th class="tc">版本</th><th class="tc">大小</th><th class="mono">SHA256</th><th class="tc">安装时间</th></tr></thead><tbody>${rows.map((pack, index) => `<tr><td class="tc">${start + index + 1}</td><td title="${escapeAttr(pack.id)}">${escape(pack.id || '运行资源')}</td><td class="tc">${escape(pack.type === 'browser' ? '浏览器' : '数据处理')}</td><td class="tc mono">v${escape(pack.version || '1.0.0')}</td><td class="tc">${escape(pack.size || 0)}</td><td class="mono" title="${escapeAttr(pack.sha256 || '')}">${escape(short(pack.sha256 || '—'))}</td><td class="tc">${escape(formatDate(pack.installedAt || pack.installed_at))}</td></tr>`).join('')}</tbody></table></div>`);
        if (pagination && window.renderWorkspacePagination) {
            window.renderWorkspacePagination(pagination, { total, limit: state.limit, page: state.page, onPageChange: page => { state.page = page; render(); } });
        }
    }
    async function refreshStatus() {
        try {
            const data = await request('/agents/runtime-packs/console', { cache: 'no-store' });
            applyVisibility(data.available === true);
            return state.available;
        } catch (_) {
            applyVisibility(false);
            return false;
        }
    }
    async function load() {
        if (!state.available) return [];
        const data = await request('/agents/runtime-packs', { cache: 'no-store' });
        state.packs = Array.isArray(data.data) ? data.data : [];
        render();
        return state.packs;
    }
    async function sync() {
        if (!state.available) return notice('运行资源包控制台当前未启用。', 'warning');
        const origins = String(document.getElementById('agent-harness-pack-origins')?.value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
        const manifest = {
            type: document.getElementById('agent-harness-pack-type')?.value || 'data',
            id: document.getElementById('agent-harness-pack-id')?.value.trim(),
            version: document.getElementById('agent-harness-pack-version')?.value.trim(),
            size: Number(document.getElementById('agent-harness-pack-size')?.value || 0) || 0,
            url: document.getElementById('agent-harness-pack-url')?.value.trim(),
            sha256: document.getElementById('agent-harness-pack-sha256')?.value.trim()
        };
        if (!manifest.id || !manifest.version || !manifest.url || !manifest.sha256 || !origins.length) return notice('资源包 ID、版本、地址、摘要和来源白名单均为必填。', 'error');
        let allowedPorts = [80, 443, 8080];
        try { const url = new URL(manifest.url); allowedPorts = [...new Set([...allowedPorts, Number(url.port) || (url.protocol === 'https:' ? 443 : 80)])]; } catch (_) { return notice('运行资源包地址无效。', 'error'); }
        const button = document.getElementById('agent-harness-pack-sync');
        if (button) button.disabled = true;
        try {
            await request('/agents/runtime-packs/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest, networkPolicy: { allowed_origins: origins, allowed_ports: allowedPorts, allow_redirect: false } }) });
            notice('运行资源包同步完成并通过完整性校验。', 'success');
            await load();
        } catch (error) { notice(error.message || '运行资源包同步失败。', 'error'); }
        finally { if (button) button.disabled = false; }
    }
    function bind() {
        document.getElementById('agent-harness-packs-refresh')?.addEventListener('click', () => load().catch(error => notice(error.message, 'error')));
        document.getElementById('agent-harness-pack-sync')?.addEventListener('click', sync);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
    window.Pivot?.exposeModule?.('agent.runtimePacks', { isAvailable: () => state.available, load, refreshStatus });
})();
