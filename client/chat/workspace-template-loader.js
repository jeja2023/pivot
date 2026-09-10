// 大型工作区模板的同源按需加载器。模板只来自服务端白名单端点，
// 挂载前统一经过 Pivot.html 的 DOMPurify 安全插入点。
const workspaceMarkupPromises = {};
const workspaceMarkupFetchPromises = {};
const workspaceMarkupCache = {};
const LAZY_WORKSPACE_HTML = Object.freeze({
    apps: { endpoint: '/chat/workspaces/apps', slotId: 'workspace-lazy-slot-apps', panelId: 'apps-workbench-modal' },
    agent: { endpoint: '/chat/workspaces/agent', slotId: 'workspace-lazy-slot-agent', panelId: 'agent-workbench-modal' },
    'agent-dag': { endpoint: '/chat/workspaces/agent-dag', slotId: 'workspace-lazy-slot-agent-dag', panelId: 'agent-dag-workbench-modal' },
    knowledge: { endpoint: '/chat/workspaces/knowledge', slotId: 'workspace-lazy-slot-knowledge', panelId: 'knowledge-workbench-modal' },
    mcp: { endpoint: '/chat/workspaces/mcp', slotId: 'workspace-lazy-slot-mcp', panelId: 'mcp-workbench-modal' },
    settings: { endpoint: '/chat/workspaces/settings', slotId: 'workspace-lazy-slot-settings', panelId: 'admin-container' }
});

function fetchWorkspaceMarkup(name, definition) {
    if (workspaceMarkupCache[name]) return Promise.resolve(workspaceMarkupCache[name]);
    if (!workspaceMarkupFetchPromises[name]) {
        workspaceMarkupFetchPromises[name] = fetch(definition.endpoint, {
            credentials: 'same-origin',
            headers: { Accept: 'text/html' }
        }).then(async response => {
            if (!response.ok) throw new Error(`${name} 工作区模板加载失败（HTTP ${response.status}）`);
            const markup = await response.text();
            if (!markup.trim()) throw new Error(`${name} 工作区模板为空`);
            workspaceMarkupCache[name] = markup;
            return markup;
        }).catch(error => {
            delete workspaceMarkupFetchPromises[name];
            throw error;
        });
    }
    return workspaceMarkupFetchPromises[name];
}

function preloadWorkspaceMarkup(name) {
    const definition = LAZY_WORKSPACE_HTML[name];
    if (!definition || document.getElementById(definition.panelId)) return Promise.resolve();
    return fetchWorkspaceMarkup(name, definition);
}

async function ensureWorkspaceMarkup(name) {
    const definition = LAZY_WORKSPACE_HTML[name];
    if (!definition || document.getElementById(definition.panelId)) return;
    if (!workspaceMarkupPromises[name]) {
        workspaceMarkupPromises[name] = (async () => {
            const slot = document.getElementById(definition.slotId);
            if (!slot) throw new Error(`${name} 工作区挂载点不存在`);
            const markup = await fetchWorkspaceMarkup(name, definition);
            const safeHtml = window.Pivot?.html;
            if (!safeHtml?.setHtml) throw new Error('安全 HTML 组件尚未就绪，拒绝挂载工作区模板');
            safeHtml.setHtml(slot, markup);
            if (!document.getElementById(definition.panelId)) throw new Error(`${name} 工作区模板缺少预期根节点`);
            document.dispatchEvent(new window.CustomEvent('pivot:workspace-mounted', { detail: { name } }));
        })().catch(error => {
            delete workspaceMarkupPromises[name];
            throw error;
        });
    }
    return workspaceMarkupPromises[name];
}

window.Pivot?.exposeModule?.('workspaces.templateLoader', {
    ensureWorkspaceMarkup,
    preloadWorkspaceMarkup
});
