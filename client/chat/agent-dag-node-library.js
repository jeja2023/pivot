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
if (window.PivotDagNodeLibrary) return;

// ────────────────────────────────────────────────────────────
// 节点类型目录（与工具栏 preset 格式一致）
// ────────────────────────────────────────────────────────────
const NODE_PRESETS = [
    {
        group: '智能体',
        items: [
            {
                base: 'llm',
                title: '大模型',
                svgIcon: 'bot',
                theme: 'llm',
                desc: '调用大模型分析、生成或改写内容',
                patterns: ['agent.llm'],
                getInput: () => typeof defaultLlmInput === 'function' ? defaultLlmInput(null) : { model: '', prompt: '{{goal}}', responseFormat: 'markdown', temperature: 0.2, maxTokens: 1200 }
            },
            {
                base: 'delegate',
                title: '委派智能体',
                svgIcon: 'users',
                theme: 'delegate',
                desc: '调用一次独立模型，返回专家结果并自动生成交接信息',
                patterns: ['agent.delegate'],
                input: { agentName: '领域专家', role: 'analyst', model: '', task: '{{goal}}', context: '{{goal}}', responseFormat: 'markdown', temperature: 0.2, maxTokens: 1200 },
                outputSchema: { type: 'object', required: ['content', 'agent', 'handoff'], properties: { content: { type: 'string' }, agent: { type: 'object' }, handoff: { type: 'object' } } }
            },
            {
                base: 'handoff',
                title: '智能体交接',
                svgIcon: 'shuffle',
                theme: 'handoff',
                desc: '仅整理已有结果，不调用模型；用于统一传给下游智能体',
                patterns: ['agent.handoff'],
                input: { fromAgent: '上游智能体', toAgent: 'Supervisor', summary: '', findings: [], evidence: [], risks: [], openQuestions: [], confidence: 0.7 }
            }
        ]
    },
    {
        group: '逻辑控制',
        items: [
            {
                base: 'code',
                title: '代码执行',
                svgIcon: 'code',
                theme: 'code',
                desc: '在沙箱中执行 JS，对数据做转换/计算',
                patterns: ['agent.code'],
                input: { code: '// 用 return 返回结果\nreturn vars.input;', vars: {} },
                outputSchema: { type: 'object', properties: { output: {}, text: { type: 'string' } } }
            },
            {
                base: 'http',
                title: 'HTTP 请求',
                svgIcon: 'globe',
                theme: 'http',
                desc: '调用外部 REST API，支持 GET/POST 等',
                patterns: ['agent.http'],
                input: { url: '', method: 'GET', headers: {}, body: null },
                outputSchema: { type: 'object', properties: { statusCode: { type: 'integer' }, ok: { type: 'boolean' }, data: {}, text: { type: 'string' } } }
            },
            {
                base: 'merge',
                title: '变量聚合',
                iconText: '⊕',
                theme: 'merge',
                desc: '把多个上游输出合并为单一对象',
                patterns: ['agent.merge'],
                input: { fields: {} },
                outputSchema: { type: 'object', properties: { merged: { type: 'object' }, keys: { type: 'array' } } }
            }
        ]
    },
    {
        group: '数据与检索',
        items: [
            {
                base: 'search',
                title: '知识检索',
                svgIcon: 'search',
                theme: 'rag',
                desc: '从知识库按语义检索相关片段',
                patterns: ['rag.search', 'knowledge', 'search'],
                input: { query: '' }
            },
            {
                base: 'data',
                title: '数据查询',
                svgIcon: 'database',
                theme: 'db',
                desc: '可视化选择表、字段和筛选条件，自动生成只读查询',
                patterns: ['db.run_readonly_query', 'db.list_tables', 'database'],
                input: {}
            }
        ]
    },
    {
        group: '可视化与报告',
        items: [
            {
                base: 'chart',
                title: '图表生成',
                svgIcon: 'chart',
                theme: 'viz',
                desc: '基于数据行生成可渲染图表',
                patterns: ['viz.build_chart', 'chart'],
                input: {}
            },
            {
                base: 'report',
                title: '报告编排',
                svgIcon: 'file-text',
                theme: 'report',
                desc: '聚合多节点结果生成结构化报告',
                patterns: ['report.compose', 'report'],
                input: {}
            }
        ]
    }
];

// ────────────────────────────────────────────────────────────
// 挂载函数
// ────────────────────────────────────────────────────────────
function mount({ container, onAddNode, onToggleCollapse }) {
    if (!container) return null;
    if (container._pivotNodeLibDestroy) container._pivotNodeLibDestroy();

    let searchQuery = '';

    function buildPreset(item) {
        const input = typeof item.getInput === 'function' ? item.getInput() : (item.input || {});
        return {
            base: item.base,
            title: item.title,
            patterns: item.patterns || [],
            input: typeof input === 'function' ? input : { ...input },
            inputSchema: item.inputSchema || {},
            outputSchema: item.outputSchema || {}
        };
    }

    function filteredGroups() {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return NODE_PRESETS;
        return NODE_PRESETS.map(group => ({
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

        // 面板标题
        const header = document.createElement('div');
        header.className = 'pivot-node-library-header';
        const headerTitle = document.createElement('span');
        headerTitle.className = 'pivot-node-library-title';
        headerTitle.textContent = '节点';
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

        // 分组列表容器先声明，供搜索框回调引用
        const groupsContainer = document.createElement('div');
        groupsContainer.className = 'pivot-node-library-groups';

        // 搜索框
        const searchWrap = document.createElement('div');
        searchWrap.className = 'pivot-node-library-search-wrap';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'pivot-node-library-search';
        searchInput.placeholder = '搜索节点类型…';
        searchInput.value = searchQuery;
        searchInput.addEventListener('input', e => {
            searchQuery = e.target.value;
            renderGroups(groupsContainer);
        });
        searchWrap.appendChild(searchInput);
        panel.appendChild(searchWrap);

        renderGroups(groupsContainer);
        panel.appendChild(groupsContainer);

        container.appendChild(panel);
    }

    function renderGroups(groupsContainer) {
        groupsContainer.replaceChildren();
        const groups = filteredGroups();
        if (!groups.length) {
            const empty = document.createElement('div');
            empty.className = 'pivot-node-library-empty';
            empty.textContent = '未找到匹配的节点类型';
            groupsContainer.appendChild(empty);
            return;
        }
        groups.forEach(group => {
            const groupEl = document.createElement('div');
            groupEl.className = 'pivot-node-library-group';

            const groupLabel = document.createElement('div');
            groupLabel.className = 'pivot-node-library-group-label';
            groupLabel.textContent = group.group;
            groupEl.appendChild(groupLabel);

            const itemsEl = document.createElement('div');
            itemsEl.className = 'pivot-node-library-items';

            group.items.forEach(item => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = `pivot-node-library-card is-${item.theme}`;
                card.title = `添加「${item.title}」节点 — ${item.desc}`;

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
                descEl.textContent = item.desc;

                card.appendChild(iconEl);
                card.appendChild(labelEl);
                card.appendChild(descEl);

                card.addEventListener('click', () => {
                    if (typeof onAddNode === 'function') {
                        onAddNode(buildPreset(item));
                    }
                });

                itemsEl.appendChild(card);
            });
            groupEl.appendChild(itemsEl);
            groupsContainer.appendChild(groupEl);
        });
    }

    render();

    const destroy = () => {
        container.replaceChildren();
        container._pivotNodeLibDestroy = null;
    };
    container._pivotNodeLibDestroy = destroy;
    return { destroy };
}

window.PivotDagNodeLibrary = { mount, NODE_PRESETS };
})();
