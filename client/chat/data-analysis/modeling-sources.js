(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling, { esc } = app;
    const byId = id => document.getElementById(id);
    const pages = new Map(), searchTimers = new Map();
    let account = m.owner();
    async function mountSource(tab) {
        if (account !== m.owner()) { pages.clear(); searchTimers.forEach(clearTimeout); searchTimers.clear(); account = m.owner(); }
        if (!pages.has(tab)) pages.set(tab, { page: 1, search: '' });
        const page = pages.get(tab);
        const panel = byId(`data-analysis-${tab}-panel`);
        if (!panel) return;
        const id = `data-analysis-${tab}-semantic-source`;
        let toolbar = byId(id);
        if (!toolbar) {
            toolbar = document.createElement('div'); toolbar.id = id; toolbar.className = 'workspace-toolbar modeling-toolbar';
            m.html(toolbar, `<label>来源类型<select class="form-input" data-model-source-type="${tab}"><option value="dataset">数据集</option><option value="model">已发布模型</option></select></label><label class="hidden" data-model-source-label>模型<select class="form-input" data-model-source-id="${tab}"><option value="">请选择已发布模型</option></select></label><button class="btn-secondary hidden" type="button" data-model-source-open="${tab}">使用模型维度与指标</button><span class="text-muted hidden" data-model-source-hint>模型分析使用统一口径区，支持同一运行的表格、图表和透视。</span>`);
            panel.prepend(toolbar);
        }
        const current = m.capture(`source-${tab}`), userId = m.owner();
        if (!toolbar.querySelector('[data-model-source-search]')) {
            const controls = document.createElement('div');
            controls.className = 'modeling-row-actions hidden';
            controls.setAttribute('data-model-source-label', '');
            m.html(controls, `<input class="form-input" type="search" maxlength="120" data-model-source-search="${tab}" placeholder="搜索全部已发布模型" aria-label="搜索全部已发布模型"><button class="btn-secondary" type="button" data-model-source-page="${tab}" data-page-delta="-1">上一页</button><span data-model-source-page-info></span><button class="btn-secondary" type="button" data-model-source-page="${tab}" data-page-delta="1">下一页</button>`);
            toolbar.appendChild(controls);
        }
        const params = new URLSearchParams({ page: String(page.page), limit: '50', search: page.search, lifecycle: 'published' });
        const data = await m.request(`/models?${params}`);
        if (!current() || m.owner() !== userId) return;
        const select = toolbar.querySelector('[data-model-source-id]'), previous = select.value;
        m.html(select, `<option value="">请选择已发布模型</option>${data.models.filter(model => model.modelKind === 'production' && model.publishedVersion && model.lifecycle !== 'archived').map(model => `<option value="${esc(model.id)}">${esc(model.name)} · v${esc(model.publishedVersion)}${model.availability === 'available' ? '' : '（请核对数据状态）'}</option>`).join('')}`);
        if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
        toolbar.querySelector('[data-model-source-page-info]').textContent = `第 ${page.page} 页，共 ${data.total} 个模型`;
        toolbar.querySelectorAll('[data-model-source-page]').forEach(button => { button.disabled = Number(button.dataset.pageDelta) < 0 ? page.page <= 1 : page.page * 50 >= data.total; });
    }
    const onTab = app.onDataAnalysisTabActivated;
    app.onDataAnalysisTabActivated = tab => { onTab?.(tab); if (['chart', 'pivot', 'query'].includes(tab)) void mountSource(tab).catch(error => app.toast(error.message, 'error')); };
    document.addEventListener('change', event => {
        if (!event.target.matches('[data-model-source-type]')) return;
        const toolbar = event.target.closest('.modeling-toolbar'), model = event.target.value === 'model';
        toolbar.querySelectorAll('[data-model-source-label],[data-model-source-open],[data-model-source-hint]').forEach(node => node.classList.toggle('hidden', !model));
    });
    document.addEventListener('click', event => {
        const paging = event.target.closest('[data-model-source-page]');
        if (paging && !paging.disabled) {
            const tab = paging.dataset.modelSourcePage;
            pages.get(tab).page += Number(paging.dataset.pageDelta);
            void mountSource(tab).catch(error => app.toast(error.message, 'error'));
            return;
        }
        const button = event.target.closest('[data-model-source-open]');
        if (!button) return;
        const select = button.closest('.modeling-toolbar').querySelector('[data-model-source-id]');
        if (!select.value) { app.toast('请选择一个已发布模型。', 'warning'); return; }
        const userId = m.owner();
        void (async () => {
            if (!await m.canLeave() || m.owner() !== userId) return;
            app.activateTab('modeling'); await m.loadModel(select.value, { force: true });
            if (m.owner() !== userId) return;
            m.state.queryMode = 'published'; m.state.drawerMode = 'trial'; m.state.drawerOpen = true; m.render();
        })().catch(error => { if (m.owner() === userId) app.toast(error.message, 'error'); });
    });
    document.addEventListener('input', event => {
        if (!event.target.matches('[data-model-source-search]')) return;
        const tab = event.target.dataset.modelSourceSearch;
        pages.set(tab, { page: 1, search: event.target.value });
        m.capture(`source-${tab}`);
        clearTimeout(searchTimers.get(tab));
        searchTimers.set(tab, setTimeout(() => { void mountSource(tab).catch(error => app.toast(error.message, 'error')); }, 250));
    });
})();
