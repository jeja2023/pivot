(function () {
    'use strict';
    let state, helpers, bound = false, catalog = null;
    const byId = id => document.getElementById(id);
    function node(tag, className = '', text = '') { const item = document.createElement(tag); if (className) item.className = className; if (text) item.textContent = text; return item; }
    function svgIcon(paths, size = 18) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
        el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
        for (const [tag, attrs] of paths) {
            const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
            el.appendChild(child);
        }
        return el;
    }
    function action(label, operation, primary = false) { const button = node('button', primary ? 'btn-primary' : 'btn-secondary', label); button.type = 'button'; button.addEventListener('click', () => Promise.resolve(operation()).catch(showError)); return button; }
    function showError(error) { const message = error.message || '模板操作失败，请重试。'; const status = byId('presentation-catalog-status'); if (status) status.textContent = message; helpers.toast(message, 'error'); }
    const legacy = template => ['business-blue', 'forest-green'].includes(template.id);
    function createChoices(templates) { return templates.filter(item => !legacy(item) || item.id === state.active?.template?.id); }
    function populate(select, selected = '') {
        select.replaceChildren();
        const groups = [['用途模板', item => item.ownerType === 'system' && !legacy(item)], ['单位与个人模板', item => item.ownerType !== 'system'], ['历史主题配色', legacy]];
        for (const [name, match] of groups) {
            const choices = state.templates.filter(item => match(item) && (!legacy(item) || item.id === selected));
            if (!choices.length) continue;
            const group = node('optgroup'); group.label = name; choices.forEach(template => group.appendChild(new Option(template.name, template.id))); select.appendChild(group);
        }
        if (selected) select.value = selected;
        if (!select.value && select.options.length) select.value = select.options[0].value;
    }
    async function free() {
        const { engine } = await helpers.requestJson('/api/apps/presentations/master/info');
        if (engine.enabled) return window.Pivot.moduleApi('apps.presentations.master').open({ operation: 'generate', profile: 'default', template: null });
        helpers.openCreateModal('executive-clean');
        const note = byId('presentation-create-design-note');
        if (note) { note.textContent = '当前使用标准AI工作台设计，默认采用通用用途布局；完整制作引擎尚未配置。可按需选择单位模板。'; note.classList.remove('hidden'); }
    }
    async function preserve() {
        const { engine } = await helpers.requestJson('/api/apps/presentations/master/info');
        if (engine.enabled) return window.Pivot.moduleApi('apps.presentations.master').open({ operation: 'edit_native', profile: 'default', template: null });
        return window.Pivot.moduleApi('apps.presentations.native').open();
    }
    function updateTabs(activeGroup) {
        byId('presentation-catalog-tabs')?.querySelectorAll('.presentation-catalog-tab').forEach(tab => {
            tab.classList.toggle('is-active', tab.dataset.catalogGroup === activeGroup);
        });
    }
    function ensureModal() {
        if (byId('presentation-catalog-modal')) return;
        const overlay = node('div', 'modal-overlay hidden'); overlay.id = 'presentation-catalog-modal';
        const modal = node('section', 'workspace-modal presentation-catalog-dialog');
        modal.id = 'presentation-catalog-dialog';
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '演示模板库');

        const head = node('div', 'presentation-create-dialog-head');
        const titleRow = node('div', 'presentation-create-dialog-title-row');
        const titleGroup = node('div', 'presentation-create-dialog-title-group');
        titleGroup.append(
            node('h3', '', '演示模板库'),
            node('p', '', '内置标准模板、单位品牌规范与制作主题；支持按模板直接创建或套用到当前文稿。')
        );
        const closeBtn = node('button', 'btn-secondary workspace-modal-close', '关闭');
        closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
        titleRow.append(titleGroup, closeBtn);
        head.appendChild(titleRow);

        const body = node('div', 'workspace-modal-body presentation-catalog-body-wrap');

        const tip = node('div', 'presentation-catalog-tip');
        tip.append(
            svgIcon([['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '16', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '8', x2: '12.01', y2: '8' }]], 15),
            node('span', '', '自由设计无需先挑模板。单位模板用于固定品牌和版式，通用模板只保留汇报、正式材料、培训三类；历史主题按需显示，已有文稿仍引用原版本。')
        );
        body.appendChild(tip);

        const tabs = node('div', 'presentation-catalog-tabs');
        tabs.id = 'presentation-catalog-tabs';
        const tabDefs = [
            ['all', '全部模板'],
            ['organization', '单位与个人'],
            ['starter', '通用用途'],
            ['engine', 'PPT Master'],
            ['theme', '历史主题']
        ];
        tabDefs.forEach(([val, label]) => {
            const tab = node('button', 'presentation-catalog-tab' + (val === 'all' ? ' is-active' : ''), label);
            tab.type = 'button';
            tab.dataset.catalogGroup = val;
            tab.addEventListener('click', () => {
                const filter = byId('presentation-catalog-filter');
                if (filter) { filter.value = val; filter.dispatchEvent(new Event('change')); }
            });
            tabs.appendChild(tab);
        });

        const bar = node('div', 'presentation-catalog-toolbar');
        const filter = node('select', 'form-input presentation-catalog-filter-hidden');
        filter.id = 'presentation-catalog-filter'; filter.setAttribute('aria-label', '模板来源');
        for (const [value, label] of Object.entries({ all: '全部模板', organization: '单位与个人', starter: '通用用途', engine: 'PPT Master', theme: '历史主题配色' })) {
            filter.appendChild(new Option(label, value));
        }
        filter.addEventListener('change', () => {
            updateTabs(filter.value);
            render();
        });

        const searchWrap = node('div', 'presentation-catalog-search-wrap');
        searchWrap.appendChild(svgIcon([['circle', { cx: '11', cy: '11', r: '8' }], ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }]], 14));
        const search = node('input', 'form-input presentation-catalog-search-input');
        search.id = 'presentation-catalog-search'; search.type = 'search'; search.placeholder = '搜索模板名称或用途…'; search.setAttribute('aria-label', '搜索模板');
        search.addEventListener('input', render);
        searchWrap.appendChild(search);

        const file = node('input', 'hidden'); file.type = 'file'; file.accept = '.pptx,.json'; file.id = 'presentation-catalog-import-file';
        const upload = action('+ 导入单位模板', () => file.click(), true);
        upload.id = 'presentation-catalog-import'; upload.classList.add('hidden', 'btn-primary', 'presentation-catalog-import-btn');
        file.addEventListener('change', async () => {
            if (!file.files?.[0]) return; upload.disabled = true;
            try {
                await helpers.importTemplate(file.files[0]);
                await helpers.reloadTemplates();
                catalog = await helpers.requestJson('/api/apps/presentations/template-catalog');
                render();
                helpers.toast('单位模板导入成功。');
            } catch (error) { showError(error); }
            finally { upload.disabled = false; file.value = ''; }
        });

        bar.append(tabs, searchWrap, upload, file, filter);

        const status = node('p', 'presentation-empty-note presentation-catalog-status');
        status.id = 'presentation-catalog-status'; status.setAttribute('aria-live', 'polite');

        const scroll = node('div', 'table-container presentation-catalog-table-wrap');
        const table = node('table', 'data-table compact-table presentation-catalog-table');
        const headRow = node('tr'), thead = node('thead'), tbody = node('tbody');
        tbody.id = 'presentation-catalog-body';
        for (const title of ['模板', '来源', '版本', '可用方式', '操作']) headRow.appendChild(node('th', '', title));
        thead.appendChild(headRow); table.append(thead, tbody); scroll.appendChild(table);

        const emptyBox = node('div', 'presentation-catalog-empty hidden');
        emptyBox.id = 'presentation-catalog-empty';

        body.append(bar, status, scroll, emptyBox);
        modal.append(head, body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }
    async function use(template, engine = 'structured', blank = false) {
        if (engine === 'master' && !catalog.engine.enabled) throw new Error(catalog.engine.message);
        if (state.dirty && !await helpers.flush()) return;
        byId('presentation-catalog-modal').classList.add('hidden');
        if (engine === 'master') {
            return window.Pivot.moduleApi('apps.presentations.master').open({ operation: template.ownerType === 'engine' ? 'generate' : 'edit_native', profile: 'default',
                template: template.ownerType === 'engine' ? { type: 'runtime', id: template.id, name: template.name } : { type: 'organization', id: template.id, version: template.version, name: template.name } });
        }
        if (state.active) return helpers.applyTemplate(template.id);
        if (blank) return helpers.createBlank(template.id);
        helpers.openCreateModal(template.id);
    }
    function render() {
        const host = byId('presentation-catalog-body');
        if (!host || !catalog) return;
        host.replaceChildren();
        const group = byId('presentation-catalog-filter')?.value || 'all';
        const query = (byId('presentation-catalog-search')?.value || '').trim().toLowerCase();
        updateTabs(group);

        if (catalog.templates) {
            byId('presentation-catalog-tabs')?.querySelectorAll('.presentation-catalog-tab').forEach(tab => {
                const g = tab.dataset.catalogGroup;
                let count = 0;
                if (g === 'all') count = catalog.templates.filter(item => !item.legacyTheme).length;
                else if (g === 'organization') count = catalog.templates.filter(item => item.catalogGroup === 'organization').length;
                else if (g === 'starter') count = catalog.templates.filter(item => item.catalogGroup === 'starter').length;
                else if (g === 'engine') count = catalog.templates.filter(item => item.catalogGroup === 'engine').length;
                else if (g === 'theme') count = catalog.templates.filter(item => item.catalogGroup === 'theme').length;
                const labels = { all: '全部模板', organization: '单位与个人', starter: '通用用途', engine: 'PPT Master', theme: '历史主题' };
                tab.textContent = `${labels[g] || g} (${count})`;
            });
        }

        const choices = catalog.templates.filter(item => (group === 'all' ? !item.legacyTheme : item.catalogGroup === group) && `${item.name} ${item.description || ''}`.toLowerCase().includes(query));
        const status = byId('presentation-catalog-status');
        const tableWrap = document.querySelector('.presentation-catalog-table-wrap');
        const emptyBox = byId('presentation-catalog-empty');

        if (choices.length) {
            if (tableWrap) tableWrap.classList.remove('hidden');
            if (emptyBox) emptyBox.classList.add('hidden');
            if (status) status.textContent = `${choices.length}个可见模板。PPT Master模板通过完整制作流程使用；单位PPTX模板可选择保留原稿设计。`;
            for (const template of choices) {
                const tr = node('tr'), name = node('td'), source = node('td'), version = node('td'), supported = node('td'), controls = node('td');
                const titleWrap = node('div', 'presentation-catalog-template-info');
                titleWrap.appendChild(node('strong', '', template.name));
                if (template.description) {
                    titleWrap.appendChild(node('small', 'presentation-catalog-template-desc', template.description));
                }
                name.appendChild(titleWrap);
                name.title = template.description || template.name;

                const badgeClass = template.sourceLabel === '内置' ? 'is-system' : template.sourceLabel === 'PPT Master' ? 'is-engine' : 'is-org';
                const badge = node('span', 'presentation-source-badge ' + badgeClass, template.sourceLabel);
                source.appendChild(badge);

                version.textContent = String(template.version);
                version.className = 'presentation-catalog-version-cell';

                if (template.supportedEngines.includes('structured')) {
                    supported.textContent = '在线编辑';
                }
                if (template.supportedEngines.includes('master')) {
                    supported.textContent += (supported.textContent ? '、' : '') + '完整制作';
                }

                const buttons = node('div', 'presentation-catalog-actions'); controls.appendChild(buttons);
                if (template.supportedEngines.includes('structured')) {
                    buttons.appendChild(action(state.active ? '应用到当前文稿' : '按此模板创建', () => use(template), true));
                    if (!state.active) buttons.appendChild(action('空白创建', () => use(template, 'structured', true)));
                }
                if (template.supportedEngines.includes('master')) {
                    const button = action(template.ownerType === 'engine' ? '使用此制作模板' : '保留单位模板设计', () => use(template, 'master'), template.ownerType === 'engine');
                    button.disabled = !catalog.engine.enabled; if (button.disabled) button.title = catalog.engine.message; buttons.appendChild(button);
                }
                tr.append(name, source, version, supported, controls); host.appendChild(tr);
            }
        } else {
            if (tableWrap) tableWrap.classList.add('hidden');
            if (emptyBox) {
                emptyBox.classList.remove('hidden');
                emptyBox.replaceChildren();
                const icon = svgIcon([['path', { d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z' }]], 38);
                const title = node('h4', 'presentation-empty-title', group === 'organization' ? '暂无单位与个人模板' : '当前没有匹配模板');
                const desc = node('p', 'presentation-empty-desc', group === 'organization' ? '单位规范模板由管理员导入和发布后全员可见，支持锁定统一品牌标识、规范字体与版式。' : '请尝试切换其他分类或清除搜索关键词。');
                emptyBox.append(icon, title, desc);
                if (group === 'organization' && catalog.canManageTemplates) {
                    const uploadBtn = action('立即导入单位模板', () => byId('presentation-catalog-import-file')?.click(), true);
                    emptyBox.appendChild(uploadBtn);
                }
            }
            if (status) status.textContent = '当前没有匹配模板。单位模板由管理员导入和发布后显示。';
        }
    }
    async function open(group = 'all') {
        ensureModal(); byId('presentation-catalog-modal').classList.remove('hidden');
        const status = byId('presentation-catalog-status');
        if (status) status.textContent = '正在加载当前账号可用模板。';
        catalog = await helpers.requestJson('/api/apps/presentations/template-catalog');
        const filter = byId('presentation-catalog-filter');
        if (filter) filter.value = group;
        updateTabs(group);
        byId('presentation-catalog-import').classList.toggle('hidden', !catalog.canManageTemplates);
        render();
    }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers; if (bound) return; bound = true;
        document.addEventListener('click', event => {
            if (event.target.closest?.('[data-presentation-catalog-open]')) void open(event.target.closest('[data-presentation-catalog-open]').dataset.presentationCatalogOpen || 'all').catch(showError);
            if (event.target.closest?.('[data-presentation-preserve]')) void preserve().catch(error => helpers.toast(error.message, 'error'));
        });
    }
    window.Pivot.exposeModule('apps.presentations.catalog', { bind, open, free, populate, createChoices });
})();
