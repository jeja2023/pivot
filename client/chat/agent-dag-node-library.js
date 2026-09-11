/* Dify 风格左侧节点类型库面板
 *
 * 用法：
 *   const lib = window.PivotDagNodeLibrary.mount({ container, onAddNode })
 *   lib.destroy()
 *
 * onAddNode(preset) 格式与 agents-dag-editor.js 中 addPresetNode 的 preset 参数完全一致。
 * 点击节点类型卡片 → 调用 onAddNode(preset)，由画布实例处理插入逻辑。
 */
/* global createDagIcon */
(function () {
if (window.Pivot.legacy.PivotDagNodeLibrary) return;

const NODE_PRESETS = window.Pivot.moduleApi('agent.dagNodePresets').groups || [];

// ────────────────────────────────────────────────────────────
// 挂载函数
// ────────────────────────────────────────────────────────────
function mount({ container, onAddNode, onToggleCollapse, getTools }) {
    if (!container) return null;
    if (container._pivotNodeLibDestroy) container._pivotNodeLibDestroy();

    let searchQuery = '';
    let showAdvanced = false;
    let activeCategory = 'all';
    const collapsedGroups = new Set();

    function filteredGroups() {
        const q = searchQuery.trim().toLowerCase();
        let groups = NODE_PRESETS;
        if (activeCategory !== 'all') {
            groups = groups.filter(group => group.group === activeCategory);
        }
        if (!q) return groups;
        return groups.map(group => ({
            ...group,
            items: group.items.filter(item =>
                item.title.toLowerCase().includes(q)
                || item.desc.toLowerCase().includes(q)
                || (item.patterns || []).some(p => p.toLowerCase().includes(q))
            )
        })).filter(group => group.items.length > 0);
    }

    function render() {
        container.replaceChildren();

        const panel = document.createElement('div');
        panel.className = 'pivot-node-library';

        // 面板标题栏
        const header = document.createElement('div');
        header.className = 'pivot-node-library-header';
        const headerTitle = document.createElement('span');
        headerTitle.className = 'pivot-node-library-title';
        headerTitle.textContent = '节点库';
        header.appendChild(headerTitle);
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'pivot-node-library-collapse';
        collapseBtn.title = '收起节点面板';
        collapseBtn.setAttribute('aria-label', '收起节点面板');
        collapseBtn.textContent = '«';
        collapseBtn.addEventListener('click', () => {
            if (typeof onToggleCollapse === 'function') onToggleCollapse(true);
        });
        header.appendChild(collapseBtn);
        panel.appendChild(header);

        // 分组列表容器先声明，供搜索与分类筛选回调引用
        const groupsContainer = document.createElement('div');
        groupsContainer.className = 'pivot-node-library-groups';

        // 搜索框
        const searchWrap = document.createElement('div');
        searchWrap.className = 'pivot-node-library-search-wrap';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'pivot-node-library-search';
        searchInput.placeholder = '搜索节点名称或说明…';
        searchInput.value = searchQuery;
        searchInput.addEventListener('input', e => {
            searchQuery = e.target.value;
            renderGroups(groupsContainer);
        });
        searchWrap.appendChild(searchInput);
        panel.appendChild(searchWrap);

        // 6 大分类快捷筛选标签栏
        const filterBar = document.createElement('div');
        filterBar.className = 'pivot-node-library-filter-chips';
        filterBar.setAttribute('role', 'tablist');
        filterBar.setAttribute('aria-label', '节点分类筛选');

        const categories = [{ id: 'all', label: '全部' }, ...NODE_PRESETS.map(g => ({ id: g.group, label: g.group }))];
        categories.forEach(cat => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `pivot-node-library-filter-chip${activeCategory === cat.id ? ' is-active' : ''}`;
            chip.textContent = cat.label;
            chip.setAttribute('role', 'tab');
            chip.setAttribute('aria-selected', activeCategory === cat.id ? 'true' : 'false');
            chip.addEventListener('click', () => {
                if (activeCategory === cat.id) return;
                activeCategory = cat.id;
                filterBar.querySelectorAll('.pivot-node-library-filter-chip').forEach(btn => {
                    const selected = btn === chip;
                    btn.classList.toggle('is-active', selected);
                    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
                });
                renderGroups(groupsContainer);
            });
            filterBar.appendChild(chip);
        });
        panel.appendChild(filterBar);

        renderGroups(groupsContainer);
        panel.appendChild(groupsContainer);

        container.appendChild(panel);
    }

    function renderGroups(groupsContainer) {
        groupsContainer.replaceChildren();
        const groups = filteredGroups();
        const isSearching = Boolean(searchQuery.trim());
        const includeAdvanced = showAdvanced || isSearching;
        if (!groups.length) {
            const empty = document.createElement('div');
            empty.className = 'pivot-node-library-empty';
            empty.textContent = '未找到匹配的节点类型';
            groupsContainer.appendChild(empty);
            return;
        }
        groups.forEach(group => {
            const visibleItems = group.items.filter(item => includeAdvanced || !item.advanced);
            if (!visibleItems.length) return;

            // 搜索中自动展开；非搜索状态根据 collapsedGroups 判断
            const isCollapsed = !isSearching && collapsedGroups.has(group.group);

            const groupEl = document.createElement('div');
            groupEl.className = `pivot-node-library-group${isCollapsed ? ' is-collapsed' : ''}`;

            // 手风琴分类标头（可点击折叠/展开）
            const groupHeader = document.createElement('button');
            groupHeader.type = 'button';
            groupHeader.className = 'pivot-node-library-group-header';
            groupHeader.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

            const groupArrow = document.createElement('span');
            groupArrow.className = 'pivot-node-library-group-arrow';
            groupArrow.setAttribute('aria-hidden', 'true');
            groupArrow.textContent = '▾';

            const groupLabel = document.createElement('span');
            groupLabel.className = 'pivot-node-library-group-label';
            groupLabel.textContent = group.group;

            const groupBadge = document.createElement('span');
            groupBadge.className = 'pivot-node-library-group-badge';
            groupBadge.textContent = String(visibleItems.length);

            groupHeader.appendChild(groupArrow);
            groupHeader.appendChild(groupLabel);
            groupHeader.appendChild(groupBadge);

            groupHeader.addEventListener('click', () => {
                if (isSearching) return; // 搜索时锁定全展开
                if (collapsedGroups.has(group.group)) {
                    collapsedGroups.delete(group.group);
                } else {
                    collapsedGroups.add(group.group);
                }
                const nowCollapsed = collapsedGroups.has(group.group);
                groupEl.classList.toggle('is-collapsed', nowCollapsed);
                groupHeader.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
            });

            groupEl.appendChild(groupHeader);

            const itemsEl = document.createElement('div');
            itemsEl.className = 'pivot-node-library-items';

            visibleItems.forEach(item => {
                const availability = window.Pivot.moduleApi('agent.dagNodePresets').availability?.(item, typeof getTools === 'function' ? getTools() : [])
                    || { available: true, reason: '' };
                const card = document.createElement('button');
                card.type = 'button';
                card.className = `pivot-node-library-card is-${item.theme}`;
                card.disabled = !availability.available;
                card.title = availability.available
                    ? `添加「${item.title}」节点 - ${item.desc}`
                    : availability.reason;

                const iconEl = document.createElement('span');
                iconEl.className = `pivot-node-library-card-icon is-${item.theme}`;
                iconEl.setAttribute('aria-hidden', 'true');
                if (item.svgIcon) iconEl.appendChild(createDagIcon(item.svgIcon));
                else iconEl.textContent = item.iconText || '';

                const labelEl = document.createElement('span');
                labelEl.className = 'pivot-node-library-card-label';
                labelEl.textContent = item.title;

                const descEl = document.createElement('span');
                descEl.className = 'pivot-node-library-card-desc';
                descEl.textContent = availability.available ? item.desc : availability.reason;

                card.appendChild(iconEl);
                card.appendChild(labelEl);
                card.appendChild(descEl);

                card.addEventListener('click', () => {
                    if (typeof onAddNode === 'function') {
                        onAddNode(item);
                    }
                });

                itemsEl.appendChild(card);
            });
            groupEl.appendChild(itemsEl);
            groupsContainer.appendChild(groupEl);
        });
        const advancedCount = NODE_PRESETS.reduce((count, group) => count + group.items.filter(item => item.advanced).length, 0);
        if (advancedCount && !isSearching) {
            const advancedToggle = document.createElement('button');
            advancedToggle.type = 'button';
            advancedToggle.className = 'pivot-node-library-advanced-toggle';
            advancedToggle.setAttribute('aria-expanded', showAdvanced ? 'true' : 'false');
            advancedToggle.textContent = showAdvanced ? '收起高级节点' : `显示高级节点（${advancedCount}）`;
            advancedToggle.addEventListener('click', () => {
                showAdvanced = !showAdvanced;
                renderGroups(groupsContainer);
            });
            groupsContainer.appendChild(advancedToggle);
        }
    }

    render();

    const destroy = () => {
        container.replaceChildren();
        container._pivotNodeLibDestroy = null;
    };
    container._pivotNodeLibDestroy = destroy;
    return { destroy };
}

window.Pivot?.exposeModule?.('agent.dagNodeLibrary', {
    mount,
    NODE_PRESETS,
    legacyApi: { mount, NODE_PRESETS }
}, { PivotDagNodeLibrary: 'legacyApi' });
})();
