/* 工作区样式按需加载器：避免首屏加载所有业务工作区 CSS。 */
(() => {
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

const WORKSPACE_PANEL_IDS = Object.freeze({
    personal: 'personal-workbench-modal',
    chat: 'chat-workspace-view',
    apps: 'apps-workbench-modal',
    agent: 'agent-workbench-modal',
    'agent-dag': 'agent-dag-workbench-modal',
    knowledge: 'knowledge-workbench-modal',
    mcp: 'mcp-workbench-modal',
    manual: 'manual-workbench-modal',
    print: 'print-workbench-modal',
    settings: 'admin-container'
});
const AUTOMATION_WORKSPACES = Object.freeze(['agent', 'agent-dag']);
let automationWorkspacePrewarmScheduled = false;

function createWorkspaceStyleGate(panel) {
    if (!panel) return null;
    const gate = panel.querySelector(':scope > .workspace-style-gate') || document.createElement('div');
    if (!gate.isConnected) {
        gate.className = 'workspace-style-gate';
        gate.setAttribute('role', 'status');
        gate.setAttribute('aria-live', 'polite');
        panel.appendChild(gate);
    }
    panel.classList.add('workspace-style-gated');
    return gate;
}

function renderWorkspaceStyleGate(gate, name, error = null) {
    if (!gate) return;
    const isError = Boolean(error);
    gate.classList.toggle('is-error', isError);
    gate.replaceChildren();
    const card = document.createElement('div');
    card.className = 'workspace-style-gate-card';
    if (!isError) {
        const spinner = document.createElement('i');
        spinner.className = 'workspace-style-gate-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        card.appendChild(spinner);
    }
    const title = document.createElement('strong');
    title.textContent = isError ? '自动化样式加载失败' : '正在准备自动化工作台';
    const copy = document.createElement('span');
    copy.textContent = isError
        ? '页面内容已安全保留。请重试加载样式后继续。'
        : (name === 'agent-dag' ? '正在加载工作流编排器的界面资源…' : '正在加载任务与控制台的界面资源…');
    card.append(title, copy);
    if (isError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn-secondary';
        retry.textContent = '重试';
        retry.addEventListener('click', () => showWorkspaceWithStyleGate(name, { forceRetry: true }));
        card.appendChild(retry);
    }
    gate.appendChild(card);
}

function clearWorkspaceStyleGate(panel) {
    if (!panel) return;
    delete panel.dataset.workspaceStyleGateId;
    panel.classList.remove('workspace-style-gated');
    panel.querySelector(':scope > .workspace-style-gate')?.remove();
}

function showWorkspaceWithStyleGate(name, options = {}) {
    const panelId = WORKSPACE_PANEL_IDS[name];
    const panel = panelId ? document.getElementById(panelId) : null;
    const styleLoader = window.Pivot.moduleApi?.('workspaces.styleLoader');
    const stylesLoaded = (styleLoader?.isWorkspaceStyleLoaded ? styleLoader.isWorkspaceStyleLoaded(name) : isWorkspaceStyleLoaded(name)) === true;
    const triggerMainWorkspace = () => (window.Pivot.moduleApi?.('workspaces.navigation')?.showMainWorkspace
        || window.Pivot.legacy.showMainWorkspace)?.(name);
    if (!panel || stylesLoaded) {
        if (panel) clearWorkspaceStyleGate(panel);
        return triggerMainWorkspace();
    }
    const gate = createWorkspaceStyleGate(panel);
    renderWorkspaceStyleGate(gate, name);
    const gateId = `${Date.now()}-${Math.random()}`;
    panel.dataset.workspaceStyleGateId = gateId;
    const whenLoaded = styleLoader?.whenWorkspaceStylesLoaded ? styleLoader.whenWorkspaceStylesLoaded(name) : whenWorkspaceStylesLoaded(name);
    const ensureStyles = styleLoader?.ensureWorkspaceStyles ? styleLoader.ensureWorkspaceStyles(name) : ensureWorkspaceStyles(name);
    const loadStyles = options.forceRetry === true
        ? ensureStyles
        : (whenLoaded || ensureStyles);
    Promise.resolve(loadStyles).then(() => {
        if (panel.dataset.workspaceStyleGateId !== gateId) return;
        clearWorkspaceStyleGate(panel);
    }).catch(error => {
        if (panel.dataset.workspaceStyleGateId !== gateId) return;
        console.warn(`工作区 ${name} 样式加载失败，已保留加载页：`, error);
        renderWorkspaceStyleGate(gate, name, error);
    });
    return triggerMainWorkspace();
}

function prewarmAutomationWorkspaces() {
    const templateLoader = window.Pivot.moduleApi?.('workspaces.templateLoader');
    preloadWorkspaceStyles('agent').catch(() => {});
    AUTOMATION_WORKSPACES.forEach(name => templateLoader?.preloadWorkspaceMarkup?.(name)?.catch?.(() => {}));
}

function scheduleAutomationWorkspacePrewarm() {
    if (automationWorkspacePrewarmScheduled) return;
    automationWorkspacePrewarmScheduled = true;
    const run = () => {
        automationWorkspacePrewarmScheduled = false;
        prewarmAutomationWorkspaces();
    };
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1500 });
    } else {
        setTimeout(run, 700);
    }
}

function isAutomationWorkspaceTrigger(target) {
    const trigger = target?.closest?.('[data-personal-action], [data-workspace-view], [data-automation-section], [data-automation-jump]');
    if (!trigger) return false;
    return trigger.dataset.personalAction === 'open-automation'
        || trigger.dataset.personalAction === 'open-goals'
        || trigger.dataset.personalAction === 'open-completed-tasks'
        || trigger.dataset.personalAction === 'open-inbox'
        || trigger.dataset.workspaceView === 'automation'
        || Boolean(trigger.dataset.automationSection)
        || trigger.dataset.automationJump === 'workbench';
}

if (typeof document !== 'undefined') {
    document.addEventListener('pointerover', event => {
        if (isAutomationWorkspaceTrigger(event.target)) prewarmAutomationWorkspaces();
    }, { passive: true });
    document.addEventListener('focusin', event => {
        if (isAutomationWorkspaceTrigger(event.target)) prewarmAutomationWorkspaces();
    });
    document.addEventListener('pivot:app-shown', scheduleAutomationWorkspacePrewarm);
}

window.Pivot?.exposeModule?.('workspaces.styleLoader', {
    ensureWorkspaceStyles,
    preloadWorkspaceStyles,
    loadWorkspaceStyleOnce,
    isWorkspaceStyleLoaded,
    waitForWorkspaceStyles,
    whenWorkspaceStylesLoaded,
    createWorkspaceStyleGate,
    renderWorkspaceStyleGate,
    clearWorkspaceStyleGate,
    showWorkspaceWithStyleGate,
    prewarmAutomationWorkspaces,
    WORKSPACE_PANEL_IDS
});
})();
