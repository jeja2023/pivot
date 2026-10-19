/* 对话质量与模型评测导航：复用现有审核组件，兼容旧设置入口。 */
(function installSettingsQualityNavigation() {
    const groups = {
        monitor: { key: 'pivot_settings_monitor_section', fallback: 'overview', sections: ['overview', 'quality'] },
        models: { key: 'pivot_settings_models_section', fallback: 'configuration', sections: ['configuration', 'evaluation'] }
    };
    const admin = () => typeof isAdminUser === 'function' && isAdminUser();
    function read(key, fallback) { try { return sessionStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
    function write(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* 禁用存储时保留当前页状态。 */ } }
    function normalize(tab, section) {
        const group = groups[tab];
        return group && group.sections.includes(section) && (admin() || tab === 'models' && section === 'configuration') ? section : group?.fallback;
    }
    function getSection(tab) {
        const group = groups[tab];
        if (!group) return '';
        const active = document.querySelector(`[data-quality-tab="${tab}"].active`);
        return normalize(tab, active?.dataset.qualitySection || read(group.key, group.fallback));
    }
    function resolveTab(requested) {
        let section = '';
        let tab = requested;
        if (requested === 'route-feedback') { tab = 'monitor'; section = 'quality'; }
        if (requested === 'decision-gold-review') { tab = 'models'; section = 'evaluation'; }
        if (requested === 'decision-review') {
            const gold = read('pivot_settings_decision_review_subtab', 'feedback') === 'gold';
            tab = gold ? 'models' : 'monitor'; section = gold ? 'evaluation' : 'quality';
        }
        if (section && admin()) write(groups[tab].key, section);
        return tab;
    }
    function prepare(tab, requested) {
        const group = groups[tab];
        if (!group) return;
        const section = normalize(tab, requested || read(group.key, group.fallback));
        document.querySelectorAll(`[data-quality-tab="${tab}"]`).forEach(button => {
            const active = button.dataset.qualitySection === section;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
            if (tab === 'models' && button.dataset.qualitySection === 'evaluation') button.classList.toggle('hidden', !admin());
        });
        document.querySelectorAll(`[data-quality-panels="${tab}"]`).forEach(panel => {
            const active = panel.dataset.qualityPanel === section;
            panel.classList.toggle('hidden', !active);
            panel.setAttribute('aria-hidden', String(!active));
        });
        write(group.key, section);
        if (tab === 'monitor') {
            const overview = section === 'overview';
            document.getElementById('tab-content-monitor')?.classList.toggle('is-quality-view', !overview);
            document.querySelector('.settings-workspace-view .admin-content')?.classList.toggle('is-monitor-tab-active', overview);
            if (!overview) {
                window.Pivot.legacy.cancelMonitorSummaryLoad?.();
                window.Pivot.legacy.clearMonitorRefreshTimer?.();
            }
        }
    }
    async function load(tab, page = 1) {
        const section = getSection(tab);
        if (tab === 'monitor' && section === 'quality' && admin()) return window.Pivot.moduleApi('decision.feedbackReview').loadRouteFeedbackReviewQueue(page);
        if (tab === 'models' && section === 'evaluation' && admin()) return window.Pivot.moduleApi('decision.goldReview').loadDecisionGoldReviewQueue();
        if (tab === 'monitor' && admin()) return window.Pivot.legacy.loadMonitorSummary?.({ propagateErrors: true });
        if (tab === 'models') return window.Pivot.legacy.loadModels?.(page);
    }
    document.addEventListener('click', event => {
        const button = event.target.closest?.('[data-quality-tab][data-quality-section]');
        if (!button || button.classList.contains('hidden')) return;
        window.Pivot.legacy.switchTab(button.dataset.qualityTab, { subtab: button.dataset.qualitySection });
    });
    document.addEventListener('keydown', event => {
        const button = event.target.closest?.('[data-quality-tab][data-quality-section]');
        if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const items = [...document.querySelectorAll(`[data-quality-tab="${button.dataset.qualityTab}"]`)].filter(item => !item.classList.contains('hidden'));
        const index = items.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); items[next]?.focus(); items[next]?.click();
    });
    window.Pivot.exposeModule('settings.quality', { resolveTab, prepare, load, getSection });
    window.Pivot.exposeModule('settings.decisionReview', {
        switchSubtab: subtab => window.Pivot.legacy.switchTab(subtab === 'gold' ? 'decision-gold-review' : 'route-feedback')
    });
}());
