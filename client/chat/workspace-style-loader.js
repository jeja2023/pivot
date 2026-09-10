/* 工作区样式按需加载器：避免首屏加载所有业务工作区 CSS。 */

const WORKSPACE_STYLE_GROUPS = Object.freeze({
    apps: ['/chat/chat.workspace.apps.css'],
    agent: ['/chat/chat.workspace.agent.css'],
    'agent-dag': ['/chat/chat.workspace.agent.css'],
    knowledge: ['/chat/chat.workspace.knowledge.css'],
    mcp: ['/chat/chat.workspace.mcp.css'],
    settings: ['/chat/chat.workspace.settings.css']
});

const workspaceStylePromises = {};
const workspaceStylePreloadPromises = {};
const WORKSPACE_STYLE_WAIT_TIMEOUT_MS = 2500;

function workspaceStyleSelectorValue(href) {
    return String(href || '').trim().replace(/"/g, '\\"');
}

function preloadWorkspaceStyleOnce(href) {
    const rawHref = String(href || '').trim();
    if (!rawHref) return Promise.resolve();
    const versionedHref = window.Pivot.versionedAssetUrl?.(rawHref) || rawHref;
    const selectorValue = workspaceStyleSelectorValue(rawHref);
    const loadedStyle = document.querySelector(`link[data-pivot-workspace-style="${selectorValue}"][data-loaded="true"]`);
    if (loadedStyle) return Promise.resolve();
    if (workspaceStylePreloadPromises[rawHref]) return workspaceStylePreloadPromises[rawHref];
    const existing = document.querySelector(`link[data-pivot-workspace-style-preload="${selectorValue}"]`);
    const preload = existing || document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'style';
    preload.dataset.pivotWorkspaceStylePreload = rawHref;
    preload.href = versionedHref;
    workspaceStylePreloadPromises[rawHref] = new Promise(resolve => {
        preload.onload = () => resolve();
        preload.onerror = () => resolve();
    });
    if (!existing) document.head.appendChild(preload);
    return workspaceStylePreloadPromises[rawHref];
}

function loadWorkspaceStyleOnce(href) {
    const rawHref = String(href || '').trim();
    if (!rawHref) return Promise.resolve();
    const versionedHref = window.Pivot.versionedAssetUrl?.(rawHref) || rawHref;
    const selectorValue = workspaceStyleSelectorValue(rawHref);
    const existing = document.querySelector(`link[data-pivot-workspace-style="${selectorValue}"]`);
    if (existing?.dataset.loaded === 'true') return Promise.resolve();
    if (existing?.dataset.loading === 'true' && existing._pivotLoadPromise) return existing._pivotLoadPromise;
    const link = existing || document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.pivotWorkspaceStyle = rawHref;
    link.dataset.loading = 'true';
    link.href = versionedHref;
    link._pivotLoadPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            link.remove();
            reject(new Error(`工作区样式加载超时：${rawHref}`));
        }, 15_000);
        link.onload = () => {
            clearTimeout(timer);
            link.dataset.loading = 'false';
            link.dataset.loaded = 'true';
            resolve();
            try {
                if (typeof window.CustomEvent === 'function') {
                    globalThis.dispatchEvent(new window.CustomEvent('pivot:workspace-style-loaded', { detail: { href: rawHref } }));
                }
                window.Pivot?.moduleApi?.('settings.scale')?.scheduleSettingsWorkspaceScale?.();
            } catch (e) {
                // 忽略事件抛发异常
            }
        };
        link.onerror = () => {
            clearTimeout(timer);
            link.remove();
            reject(new Error(`工作区样式加载失败：${rawHref}`));
        };
    });
    if (!existing) document.head.appendChild(link);
    return link._pivotLoadPromise;
}

function preloadWorkspaceStyles(name) {
    const styles = WORKSPACE_STYLE_GROUPS[name] || [];
    if (!styles.length) return Promise.resolve();
    return Promise.all(styles.map(preloadWorkspaceStyleOnce));
}

function isWorkspaceStyleLoaded(name) {
    const styles = WORKSPACE_STYLE_GROUPS[name] || [];
    if (!styles.length) return true;
    return styles.every(href => {
        const selectorValue = workspaceStyleSelectorValue(href);
        const link = document.querySelector(`link[data-pivot-workspace-style="${selectorValue}"]`);
        return link?.dataset.loaded === 'true';
    });
}

async function whenWorkspaceStylesLoaded(name) {
    if (isWorkspaceStyleLoaded(name)) return;
    return ensureWorkspaceStyles(name);
}

// 工作区入口在显示首帧前给 CSS 一个短暂的到达窗口，避免用户先看到无样式壳。
// 样式服务异常时仍然按时放行，不能让功能入口被 CSS 请求永久阻塞。
async function waitForWorkspaceStyles(name, timeoutMs = WORKSPACE_STYLE_WAIT_TIMEOUT_MS) {
    if (isWorkspaceStyleLoaded(name)) return true;
    const timeout = Math.max(0, Number(timeoutMs) || WORKSPACE_STYLE_WAIT_TIMEOUT_MS);
    try {
        const loaded = await Promise.race([
            ensureWorkspaceStyles(name).then(() => true).catch(() => false),
            new Promise(resolve => setTimeout(() => resolve(false), timeout))
        ]);
        return loaded === true && isWorkspaceStyleLoaded(name);
    } catch (_error) {
        return false;
    }
}

async function ensureWorkspaceStyles(name) {
    const styles = WORKSPACE_STYLE_GROUPS[name] || [];
    if (!styles.length) return;
    if (!workspaceStylePromises[name]) {
        workspaceStylePromises[name] = Promise.all(styles.map(loadWorkspaceStyleOnce)).catch(error => {
            delete workspaceStylePromises[name];
            throw error;
        });
    }
    return workspaceStylePromises[name];
}

window.Pivot?.exposeModule?.('workspaces.styleLoader', {
    ensureWorkspaceStyles,
    preloadWorkspaceStyles,
    loadWorkspaceStyleOnce,
    isWorkspaceStyleLoaded,
    waitForWorkspaceStyles,
    whenWorkspaceStylesLoaded
});
