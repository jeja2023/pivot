/* 智能体 DAG 可视化编辑器 Agent DAG Visual Editor
 *
 * 用法：
 *   window.PivotDagEditor.mount({
 *       canvas:    HTMLElement,    // SVG 容器
 *       textarea:  HTMLTextAreaElement, // 双向同步的 JSON textarea
 *       toolbar:   HTMLElement,    // 工具栏容器（[+节点] 等按钮注入到这里）
 *       inspector: HTMLElement,    // 节点详情面板
 *       getTools:  () => [{name, title}], // 可用工具列表
 *       onChange:  (spec) => void,
 *       onOpenJson: () => void, // 打开高级 JSON 弹窗
 *       onNodeSelectionChange: (node|null) => void // 控制节点属性抽屉
 *   })
 *
 * 数据格式与 server/services/agent-validators.js 中的 normalizeDagSpec 完全一致：
 *   { nodes: [{ id, title, tool, input, dependsOn: [], condition: 'always'|'success' }] }
 *
 * 节点坐标 (x, y) 仅在编辑器内部维护，写入 textarea 时不会保留（normalizeDagSpec 会丢弃），
 * 加载已有 JSON 时编辑器会用拓扑层次自动布局重新生成坐标。
 *
 * 设计原则：
 *   - 零依赖，纯原生 JS + SVG
 *   - 不破坏现有 textarea 的存在；textarea 仍可手动编辑作为"专家模式"
 *   - CSP 兼容：所有事件都用 addEventListener，无内联 onclick
 *   - 多次 mount 同一容器幂等：先 destroy 旧实例
 */
(function () {
    if (window.PivotDagEditor) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_WIDTH = 160;
    const NODE_HEIGHT = 56;
    const NODE_GAP_X = 60;
    const NODE_GAP_Y = 36;
    const PADDING = 24;
    const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (cb => setTimeout(cb, 16));
    const caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;
    const cssEscape = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape.bind(window.CSS)
        : (value) => String(value ?? '').replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, ch => `\\${ch}`);

    const escapeHtml = (window.PivotSafeHtml && window.PivotSafeHtml.escapeHtml)
        || ((value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const escapeAttr = (window.PivotSafeHtml && window.PivotSafeHtml.escapeAttr)
        || ((value) => escapeHtml(value).replace(/"/g, '&quot;'));

    function uniqueId(existing, base = 'node') {
        let i = existing.length + 1;
        const set = new Set(existing);
        while (set.has(`${base}_${i}`)) i += 1;
        return `${base}_${i}`;
    }

    function clampDependsOn(nodes) {
        const ids = new Set(nodes.map(n => n.id));
        nodes.forEach(node => {
            node.dependsOn = (node.dependsOn || []).filter(dep => ids.has(dep) && dep !== node.id);
        });
    }

    function toolValue(tool) {
        return tool?.name || tool?.fullName || '';
    }

    const TOOL_DISPLAY_OVERRIDES = {
        'rag.search': ['知识库检索', '检索当前用户知识库，返回相关片段和来源。'],
        'sessions.search': ['会话检索', '按关键词检索当前用户历史会话。'],
        'sessions.recent': ['最近会话', '列出最近未删除会话。'],
        'knowledge.list': ['知识库文档', '查看知识库文档及索引状态。'],
        'models.list': ['可用模型', '列出当前用户可用模型。'],
        'system.health': ['系统健康检查', '查看数据库、存储、内存和磁盘健康状态。'],
        'system.modelRuntime': ['模型运行状态', '查看模型端点队列、熔断器和监控状态。'],
        'db.list_tables': ['列出数据表', '列出当前数据库中可查询的表和视图。'],
        'db.describe_table': ['查看表结构', '查看表字段、类型和可空性。'],
        'db.run_readonly_query': ['只读 SQL 查询', '执行 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等只读查询。'],
        'db.list_collections': ['列出集合', '列出 MongoDB 数据库集合。'],
        'db.sample_collection': ['读取集合样本', '读取集合小样本，辅助理解字段结构。'],
        'db.aggregate': ['Mongo 聚合查询', '执行只读统计分析聚合管道。'],
        'reports.list_files': ['列出报表文件', '列出可访问的报表或数据文件。'],
        'reports.read_file_summary': ['读取报表摘要', '读取报表文件元数据、工作表和样本行。'],
        'reports.query_table': ['查询报表表格', '按列筛选 CSV/XLS/XLSX 表格行。'],
        'reports.compare_files': ['对比报表文件', '对比两个报表文件的工作表、表头和样本行。'],
        'report.compose': ['组合报告', '将摘要、表格、图表和 Markdown 片段组合成报告。'],
        'report.validate_template': ['校验报告模板', '在执行编排前验证报告模板结构。'],
        'viz.build_chart': ['生成图表', '基于表格行生成可渲染图表配置。'],
        'viz.build_table': ['生成表格', '基于表格行生成 Markdown 表格。'],
        'data.profile_rows': ['分析表格字段', '分析字段类型、填充率和样本值。'],
        'data.filter_rows': ['筛选表格行', '按精确匹配或包含关系筛选行。'],
        'data.group_summary': ['分组汇总', '按字段分组并计算数量、求和、均值、最小值或最大值。'],
        'data.normalize_fields': ['规范字段', '重命名字段并清理字符串值。'],
        'doc.extract_outline': ['提取文档大纲', '从文本或 Markdown 中提取轻量大纲。'],
        'doc.extract_key_values': ['提取键值信息', '从文档文本中抽取键值样式信息。'],
        'doc.chunk_text': ['拆分长文本', '按段落拆分长文本供后续分析。'],
        'format.to_markdown_table': ['转 Markdown 表格', '将行数据转换为 Markdown 表格。'],
        'format.to_json': ['转 JSON', '将值序列化为紧凑或美化 JSON。'],
        'format.extract_json': ['提取 JSON', '从文本中提取并解析第一个 JSON 对象或数组。'],
        'format.normalize_text': ['规范文本', '清理空白并可选转换大小写。'],
        'im.list_allowed_targets': ['列出通知目标', '列出当前允许通知的 LAN IM 目标。'],
        'im.send_user_message': ['发送用户消息', '向允许的 LAN IM 用户发送纯文本消息。'],
        'im.send_group_message': ['发送群组消息', '向允许的 LAN IM 群组发送纯文本消息。'],
        'im.send_markdown': ['发送 Markdown 消息', '向允许的 LAN IM 目标发送 Markdown 消息。']
    };

    const TOOL_GROUPS = [
        { key: 'knowledge', label: '知识与会话', test: name => /^(rag|sessions|knowledge)\./.test(name) },
        { key: 'database', label: '数据库', test: name => /(^|\.)(db)\./.test(name) },
        { key: 'reports', label: '报表与文件', test: name => /^(reports|report)\./.test(name) },
        { key: 'visual', label: '图表与展示', test: name => /^viz\./.test(name) },
        { key: 'data', label: '数据处理', test: name => /^data\./.test(name) },
        { key: 'document', label: '文档处理', test: name => /^doc\./.test(name) },
        { key: 'format', label: '格式转换', test: name => /^format\./.test(name) },
        { key: 'notify', label: '消息通知', test: name => /^im\./.test(name) },
        { key: 'system', label: '系统诊断', test: name => /^(models|system)\./.test(name) },
        { key: 'external', label: '外部能力', test: name => /^mcp\./.test(name) },
        { key: 'other', label: '其他工具', test: () => true }
    ];

    function toolShortName(tool) {
        const value = String(toolValue(tool) || '');
        const match = value.match(/^mcp\.\d+\.(.+)$/);
        return match ? match[1] : value;
    }

    function friendlyToolTitle(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[0] || tool?.title || shortName || toolValue(tool) || '未命名工具';
    }

    function friendlyToolDescription(tool) {
        const shortName = toolShortName(tool);
        const override = TOOL_DISPLAY_OVERRIDES[shortName] || TOOL_DISPLAY_OVERRIDES[toolValue(tool)];
        return override?.[1] || tool?.description || '暂无说明。';
    }

    function toolGroupLabel(tool) {
        const shortName = toolShortName(tool);
        const group = TOOL_GROUPS.find(item => item.test(shortName) || item.test(String(toolValue(tool) || '')));
        return group?.label || '其他工具';
    }

    function renderToolOptions(tools, selectedValue) {
        const buckets = new Map();
        TOOL_GROUPS.forEach(group => buckets.set(group.label, []));
        (Array.isArray(tools) ? tools : []).forEach(tool => {
            const value = toolValue(tool);
            if (!value) return;
            const label = toolGroupLabel(tool);
            if (!buckets.has(label)) buckets.set(label, []);
            buckets.get(label).push(tool);
        });
        const groups = [...buckets.entries()]
            .map(([label, items]) => [label, items.sort((a, b) => friendlyToolTitle(a).localeCompare(friendlyToolTitle(b), 'zh-Hans-CN'))])
            .filter(([, items]) => items.length);
        const optionGroups = groups.map(([label, items]) => `
            <optgroup label="${escapeAttr(label)}">
                ${items.map(tool => {
        const value = toolValue(tool);
        const title = friendlyToolTitle(tool);
        const idSuffix = title === value ? '' : ` · ${toolShortName(tool)}`;
        return `<option value="${escapeAttr(value)}" ${selectedValue === value ? 'selected' : ''} title="${escapeAttr(friendlyToolDescription(tool))}">${escapeHtml(title)}${escapeHtml(idSuffix)}</option>`;
    }).join('')}
            </optgroup>
        `).join('');
        return ['<option value="">— 选择工具 —</option>', optionGroups].join('');
    }

    function renderSelectedToolMeta(tool) {
        if (!tool) {
            return '<div class="pivot-dag-tool-meta is-empty">选择工具后显示用途、来源和内部标识。</div>';
        }
        const source = tool.source === 'builtin'
            ? '系统内置'
            : tool.serverName
                ? `能力库 · ${tool.serverName}`
                : '能力库';
        const badges = [
            toolGroupLabel(tool),
            source,
            tool.requiresApproval ? '需审批' : '',
            tool.admin ? '管理员' : ''
        ].filter(Boolean);
        return `
            <div class="pivot-dag-tool-meta">
                <div class="pivot-dag-tool-meta-head">
                    <strong>${escapeHtml(friendlyToolTitle(tool))}</strong>
                    <span>${badges.map(item => `<em>${escapeHtml(item)}</em>`).join('')}</span>
                </div>
                <p>${escapeHtml(friendlyToolDescription(tool))}</p>
                <code>${escapeHtml(toolValue(tool))}</code>
            </div>
        `;
    }

    function findPreferredTool(tools, patterns) {
        const list = Array.isArray(tools) ? tools : [];
        return list.find(tool => {
            const value = String(toolValue(tool)).toLowerCase();
            const title = String(tool?.title || '').toLowerCase();
            return patterns.some(pattern => value.includes(pattern) || title.includes(pattern));
        }) || list[0] || null;
    }

    // 按拓扑层次分层（Kahn 风格）；环边视作"已满足"避免死循环
    function autoLayout(nodes) {
        const remaining = new Map(nodes.map(n => [n.id, new Set(n.dependsOn || [])]));
        const layers = [];
        const placed = new Set();
        // 兜底：节点数 <= 50 时层次清晰；更多节点也接受较粗略布局
        while (placed.size < nodes.length) {
            const layer = [];
            nodes.forEach(node => {
                if (placed.has(node.id)) return;
                const deps = remaining.get(node.id);
                const ready = [...deps].every(dep => placed.has(dep));
                if (ready) layer.push(node);
            });
            if (layer.length === 0) {
                // 出现环时把还没排的节点全部放到下一层，避免死循环
                nodes.forEach(node => {
                    if (!placed.has(node.id)) layer.push(node);
                });
            }
            layers.push(layer);
            layer.forEach(node => placed.add(node.id));
        }
        layers.forEach((layer, layerIndex) => {
            layer.forEach((node, slot) => {
                node._x = PADDING + layerIndex * (NODE_WIDTH + NODE_GAP_X);
                node._y = PADDING + slot * (NODE_HEIGHT + NODE_GAP_Y);
            });
        });
    }

    function ensureDefaults(spec) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes.map(n => ({
            id: String(n.id || '').trim() || 'node',
            title: String(n.title || n.id || '').trim() || '未命名',
            tool: String(n.tool || '').trim(),
            input: n.input && typeof n.input === 'object' ? n.input : {},
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.slice() : [],
            condition: ['always', 'success'].includes(n.condition) ? n.condition : 'success',
            retryLimit: Math.max(0, Math.min(Number.parseInt(n.retryLimit ?? n.retry_limit ?? 0, 10) || 0, 5)),
            timeoutMs: Math.max(0, Math.min(Number.parseInt(n.timeoutMs ?? n.timeout_ms ?? 0, 10) || 0, 600000)),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(n.onError || n.on_error || 'skip_dependents')) ? String(n.onError || n.on_error || 'skip_dependents') : 'skip_dependents'
        })) : [];
        clampDependsOn(nodes);
        autoLayout(nodes);
        return { nodes };
    }

    // 把内部带 _x/_y 的 spec 序列化为 normalizeDagSpec 接受的最小形态
    function serialize(spec) {
        return {
            nodes: spec.nodes.map(({ id, title, tool, input, dependsOn, condition, retryLimit, timeoutMs, onError }) => ({
                id,
                title,
                tool,
                input,
                dependsOn: [...(dependsOn || [])],
                condition,
                retryLimit: Number(retryLimit || 0),
                timeoutMs: Number(timeoutMs || 0),
                onError: onError || 'skip_dependents'
            }))
        };
    }

    function readJson(text) {
        const raw = String(text || '').trim();
        if (!raw) return { nodes: [] };
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return { nodes: value };
            if (value && typeof value === 'object') return value;
        } catch (e) {
            // 静默 — 编辑器会保留上次成功的快照
        }
        return null;
    }

    function writeJson(textarea, spec) {
        if (!textarea) return;
        textarea.value = JSON.stringify(serialize(spec), null, 2);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function getToolSchema(tool) {
        const schema = tool?.input_schema || tool?.inputSchema || tool?.parameters || {};
        return schema && typeof schema === 'object' ? schema : {};
    }

    function schemaExampleValue(schema = {}, key = '') {
        if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default;
        if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        if (type === 'integer' || type === 'number') return schema.minimum || 0;
        if (type === 'boolean') return false;
        if (type === 'array') return [];
        if (type === 'object') {
            const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            return Object.fromEntries(Object.entries(props).slice(0, 6).map(([name, child]) => [name, schemaExampleValue(child, name)]));
        }
        if (/query|keyword|prompt|text|title|name/i.test(key)) return '';
        return '';
    }

    function buildToolInputTemplate(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
        const entries = Object.entries(props).filter(([name, child]) => required.has(name) || Object.prototype.hasOwnProperty.call(child || {}, 'default'));
        const selected = entries.length ? entries : Object.entries(props).slice(0, 8);
        return Object.fromEntries(selected.map(([name, child]) => [name, schemaExampleValue(child, name)]));
    }

    function renderToolSchemaHint(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const rows = Object.entries(props).slice(0, 8).map(([name, item]) => {
            const type = Array.isArray(item?.type) ? item.type.join('|') : (item?.type || 'value');
            const mark = required.has(name) ? '必填' : '可选';
            return `<span><strong>${escapeHtml(name)}</strong>${escapeHtml(type)} · ${mark}</span>`;
        });
        if (!rows.length) return '<div class="pivot-dag-schema-hint is-empty">当前工具不需要输入参数</div>';
        return `<div class="pivot-dag-schema-hint">${rows.join('')}</div>`;
    }

    function createEdgePath(fromNode, toNode) {
        const startX = fromNode._x + NODE_WIDTH;
        const startY = fromNode._y + NODE_HEIGHT / 2;
        const endX = toNode._x;
        const endY = toNode._y + NODE_HEIGHT / 2;
        const c1x = startX + Math.max(40, (endX - startX) / 2);
        const c2x = endX - Math.max(40, (endX - startX) / 2);
        return `M ${startX},${startY} C ${c1x},${startY} ${c2x},${endY} ${endX},${endY}`;
    }

    function makeSvgEl(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
        return el;
    }

    function makeButton(label, title, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-secondary pivot-dag-toolbar-btn';
        btn.textContent = label;
        if (title) btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function mount({ canvas, textarea, toolbar, inspector, getTools, onChange, onOpenJson, onNodeSelectionChange }) {
        if (!canvas) return null;

        // 幂等：如果已有实例先销毁
        if (canvas._pivotDagDestroy) canvas._pivotDagDestroy();

        let spec = ensureDefaults(readJson(textarea ? textarea.value : ''));
        let selectedId = null;
        let connecting = null; // { fromId, ghost: <path> }
        let pendingFlush = null;
        let suppressTextareaSync = false;
        let toolbarStatus = null;
        // v0.0.51 缩放与平移状态：内容坐标原点固定，通过 viewBox 偏移 + 缩放呈现
        const viewState = { x: 0, y: 0, scale: 1 };
        const SCALE_MIN = 0.3;
        const SCALE_MAX = 2.5;
        let panning = null; // { startX, startY, originX, originY }

        const root = makeSvgEl('svg', {
            class: 'pivot-dag-svg',
            xmlns: SVG_NS,
            preserveAspectRatio: 'xMinYMin meet'
        });
        const defs = makeSvgEl('defs');
        const marker = makeSvgEl('marker', {
            id: 'pivot-dag-arrow',
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 6,
            markerHeight: 6,
            orient: 'auto-start-reverse'
        });
        marker.appendChild(makeSvgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#94a3b8' }));
        defs.appendChild(marker);
        root.appendChild(defs);
        const edgesLayer = makeSvgEl('g', { class: 'pivot-dag-edges' });
        const nodesLayer = makeSvgEl('g', { class: 'pivot-dag-nodes' });
        root.appendChild(edgesLayer);
        root.appendChild(nodesLayer);
        canvas.replaceChildren(root);

        // 小地图 overlay：固定在 canvas 右下角，独立 SVG，点击跳转视口
        const minimap = (() => {
            const wrap = document.createElement('div');
            wrap.className = 'pivot-dag-minimap';
            const mini = makeSvgEl('svg', { class: 'pivot-dag-minimap-svg', xmlns: SVG_NS });
            const miniNodes = makeSvgEl('g', { class: 'pivot-dag-minimap-nodes' });
            const viewport = makeSvgEl('rect', { class: 'pivot-dag-minimap-viewport', fill: 'rgba(59,130,246,0.18)', stroke: '#3b82f6', 'stroke-width': 1.5 });
            mini.appendChild(miniNodes);
            mini.appendChild(viewport);
            wrap.appendChild(mini);
            canvas.appendChild(wrap);
            return { wrap, svg: mini, nodesLayer: miniNodes, viewport };
        })();

        const updateMinimap = () => {
            if (!minimap) return;
            const { width, height } = contentBounds();
            minimap.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
            minimap.nodesLayer.replaceChildren();
            spec.nodes.forEach(node => {
                const rect = makeSvgEl('rect', {
                    x: node._x,
                    y: node._y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 4,
                    ry: 4,
                    fill: selectedId === node.id ? '#3b82f6' : '#cbd5e1',
                    opacity: '0.7'
                });
                minimap.nodesLayer.appendChild(rect);
            });
            // 视口框：viewState 对应内容坐标系下的矩形
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            minimap.viewport.setAttribute('x', viewState.x);
            minimap.viewport.setAttribute('y', viewState.y);
            minimap.viewport.setAttribute('width', vbWidth);
            minimap.viewport.setAttribute('height', vbHeight);
        };

        // 点击小地图：把视口中心移到点击位置
        const minimapClickHandler = (event) => {
            const rect = minimap.svg.getBoundingClientRect();
            const { width, height } = contentBounds();
            const contentX = (event.clientX - rect.left) * width / rect.width;
            const contentY = (event.clientY - rect.top) * height / rect.height;
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            viewState.x = Math.max(0, contentX - vbWidth / 2);
            viewState.y = Math.max(0, contentY - vbHeight / 2);
            updateViewBox();
        };
        minimap.svg.addEventListener('click', minimapClickHandler);

        const flushOut = () => {
            if (pendingFlush) caf(pendingFlush);
            pendingFlush = raf(() => {
                pendingFlush = null;
                suppressTextareaSync = true;
                writeJson(textarea, spec);
                suppressTextareaSync = false;
                if (typeof onChange === 'function') onChange(serialize(spec));
            });
        };

        // 计算内容包围盒；保证空 DAG 也有合理底盘
        const contentBounds = () => {
            const w = Math.max(640, ...spec.nodes.map(n => n._x + NODE_WIDTH)) + PADDING;
            const h = Math.max(280, ...spec.nodes.map(n => n._y + NODE_HEIGHT)) + PADDING;
            return { width: w, height: h };
        };

        const updateViewBox = () => {
            const { width, height } = contentBounds();
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            root.setAttribute('viewBox', `${viewState.x} ${viewState.y} ${vbWidth} ${vbHeight}`);
            root.setAttribute('width', '100%');
            root.setAttribute('height', '100%');
            root.style.minHeight = '100%';
            updateMinimap();
        };

        // 重置缩放/平移到完整内容可见
        const fitToContent = () => {
            viewState.x = 0;
            viewState.y = 0;
            viewState.scale = 1;
            updateViewBox();
        };

        const currentTools = () => typeof getTools === 'function' ? (getTools() || []) : [];

        const wouldCreateCycle = (dependencyId, targetId) => {
            if (!dependencyId || !targetId || dependencyId === targetId) return true;
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            const visit = (id, seen = new Set()) => {
                if (id === targetId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const node = byId.get(id);
                return Boolean(node?.dependsOn?.some(dep => visit(dep, seen)));
            };
            return visit(dependencyId);
        };

        const validateWorkflow = () => {
            const tools = currentTools();
            const toolNames = new Set(tools.map(toolValue).filter(Boolean));
            const errors = [];
            const warnings = [];
            const byId = new Map(spec.nodes.map(node => [node.id, node]));
            const edgeCount = spec.nodes.reduce((sum, node) => sum + (node.dependsOn || []).length, 0);
            if (!spec.nodes.length) errors.push('至少需要 1 个节点');
            spec.nodes.forEach(node => {
                if (!node.tool) errors.push(`${node.title || node.id} 未选择工具`);
                if (node.tool && toolNames.size && !toolNames.has(node.tool)) warnings.push(`${node.title || node.id} 使用的工具当前不可用`);
                (node.dependsOn || []).forEach(dep => {
                    if (!byId.has(dep)) errors.push(`${node.title || node.id} 依赖了不存在的节点 ${dep}`);
                });
            });
            const visiting = new Set();
            const visited = new Set();
            const hasCycle = (id) => {
                if (visiting.has(id)) return true;
                if (visited.has(id)) return false;
                visiting.add(id);
                const node = byId.get(id);
                const cyclic = Boolean(node?.dependsOn?.some(dep => byId.has(dep) && hasCycle(dep)));
                visiting.delete(id);
                visited.add(id);
                return cyclic;
            };
            if (spec.nodes.some(node => hasCycle(node.id))) errors.push('存在循环依赖');
            const dependencyTargets = new Set(spec.nodes.flatMap(node => node.dependsOn || []));
            const startCount = spec.nodes.filter(node => !(node.dependsOn || []).length).length;
            const endCount = spec.nodes.filter(node => !dependencyTargets.has(node.id)).length;
            if (spec.nodes.length > 1 && startCount === 0) errors.push('缺少起始节点');
            if (spec.nodes.length > 1 && endCount === 0) warnings.push('缺少结束节点');
            return { errors, warnings, nodeCount: spec.nodes.length, edgeCount, startCount, endCount };
        };

        const renderToolbarStatus = () => {
            if (!toolbarStatus) return;
            const report = validateWorkflow();
            const state = report.errors.length ? 'error' : report.warnings.length ? 'warn' : 'ok';
            toolbarStatus.className = `pivot-dag-toolbar-status ${state}`;
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            toolbarStatus.textContent = `${report.nodeCount} 节点 · ${report.edgeCount} 依赖 · ${message}`;
            toolbarStatus.title = [...report.errors, ...report.warnings].join('\n') || '工作流校验通过';
        };

        const showValidationResult = () => {
            const report = validateWorkflow();
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            window.showToast?.(message, report.errors.length ? 'error' : report.warnings.length ? 'warning' : 'success');
            renderToolbarStatus();
        };

        const notifySelectionChange = (node) => {
            if (typeof onNodeSelectionChange !== 'function') return;
            onNodeSelectionChange(node ? {
                id: node.id,
                title: node.title,
                tool: node.tool
            } : null);
        };

        const renderInspector = () => {
            if (!inspector) return;
            const node = spec.nodes.find(n => n.id === selectedId);
            const active = document.activeElement;
            const focusSnapshot = active && inspector.contains(active) ? {
                field: active.dataset?.pivotDagField || '',
                depend: active.dataset?.pivotDagDepend || '',
                start: null,
                end: null
            } : null;
            if (focusSnapshot) {
                try {
                    focusSnapshot.start = active.selectionStart;
                    focusSnapshot.end = active.selectionEnd;
                } catch (e) {
                    // Some input types do not expose text selection.
                }
            }
            if (!node) {
                inspector.innerHTML = '<div class="pivot-dag-inspector-empty">选中节点后可在此编辑标题、工具与输入。</div>';
                notifySelectionChange(null);
                return;
            }
            notifySelectionChange(node);
            const tools = currentTools();
            const selectedTool = tools.find(t => toolValue(t) === node.tool);
            const otherIds = spec.nodes.filter(n => n.id !== node.id).map(n => n.id);
            const dependsChecks = otherIds.map(id => `
                <label class="pivot-dag-depends-item">
                    <input type="checkbox" data-pivot-dag-depend="${escapeHtml(id)}" ${node.dependsOn.includes(id) ? 'checked' : ''}>
                    <span>${escapeHtml(id)}</span>
                </label>
            `).join('') || '<span class="pivot-dag-inspector-empty">暂无其他节点可依赖</span>';
            const variableTokens = [
                { label: '任务目标', token: '{{goal}}' },
                ...(node.dependsOn || []).flatMap(dep => ([
                    { label: `${dep} 输出`, token: `{{nodes.${dep}.output}}` },
                    { label: `${dep} 状态`, token: `{{nodes.${dep}.status}}` },
                    { label: `${dep} 错误`, token: `{{nodes.${dep}.error}}` }
                ]))
            ];
            const variableButtons = variableTokens.map(item => `
                <button type="button" class="pivot-dag-token-btn" data-pivot-dag-insert-token="${escapeHtml(item.token)}" title="${escapeHtml(item.token)}">${escapeHtml(item.label)}</button>
            `).join('');
            const toolOptions = renderToolOptions(tools, node.tool);
            inspector.innerHTML = `
                <div class="pivot-dag-inspector-actions pivot-dag-inspector-actions-top">
                    <button type="button" class="btn-secondary btn-red-outline" data-pivot-dag-delete="1">删除节点</button>
                </div>
                <div class="pivot-dag-inspector-row">
                    <label><span>节点 ID</span><input type="text" data-pivot-dag-field="id" value="${escapeHtml(node.id)}" maxlength="60"></label>
                    <label><span>标题</span><input type="text" data-pivot-dag-field="title" value="${escapeHtml(node.title)}" maxlength="120"></label>
                </div>
                <div class="pivot-dag-inspector-row">
                    <label><span>工具</span>
                        <select data-pivot-dag-field="tool">${toolOptions}</select>
                        ${renderSelectedToolMeta(selectedTool)}
                    </label>
                    <label><span>条件</span>
                        <select data-pivot-dag-field="condition">
                            <option value="success" ${node.condition === 'success' ? 'selected' : ''}>依赖成功后执行</option>
                            <option value="always" ${node.condition === 'always' ? 'selected' : ''}>始终执行</option>
                        </select>
                    </label>
                </div>
                <div class="pivot-dag-inspector-row">
                    <label><span>失败策略</span>
                        <select data-pivot-dag-field="onError">
                            <option value="skip_dependents" ${node.onError === 'skip_dependents' ? 'selected' : ''}>失败后跳过下游</option>
                            <option value="continue" ${node.onError === 'continue' ? 'selected' : ''}>失败后继续下游</option>
                            <option value="stop" ${node.onError === 'stop' ? 'selected' : ''}>失败后停止工作流</option>
                        </select>
                    </label>
                    <label><span>重试次数</span><input type="number" min="0" max="5" data-pivot-dag-field="retryLimit" value="${Number(node.retryLimit || 0)}"></label>
                    <label><span>超时 ms</span><input type="number" min="0" max="600000" step="1000" data-pivot-dag-field="timeoutMs" value="${Number(node.timeoutMs || 0)}" placeholder="默认"></label>
                </div>
                <label class="pivot-dag-inspector-input">
                    <span>输入参数 (JSON)</span>
                    <textarea data-pivot-dag-field="input" rows="3" spellcheck="false">${escapeHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
                </label>
                <div class="pivot-dag-input-tools">
                    <button type="button" class="btn-secondary" data-pivot-dag-apply-template="1">套用工具参数模板</button>
                    ${renderToolSchemaHint(selectedTool)}
                    <div class="pivot-dag-token-group">
                        <div class="pivot-dag-token-head">插入变量</div>
                        <div class="pivot-dag-token-list">${variableButtons}</div>
                    </div>
                </div>
                <div class="pivot-dag-inspector-depends">
                    <div class="pivot-dag-inspector-depends-head">依赖节点</div>
                    <div class="pivot-dag-inspector-depends-list">${dependsChecks}</div>
                </div>
            `;
            inspector.querySelectorAll('[data-pivot-dag-field]').forEach(input => {
                input.addEventListener('input', (e) => handleInspectorEdit(e.target));
                input.addEventListener('change', (e) => handleInspectorEdit(e.target));
            });
            inspector.querySelectorAll('[data-pivot-dag-depend]').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => handleDependsToggle(e.target));
            });
            inspector.querySelector('[data-pivot-dag-apply-template]')?.addEventListener('click', () => applyToolInputTemplate(node.id));
            inspector.querySelectorAll('[data-pivot-dag-insert-token]').forEach(btn => {
                btn.addEventListener('click', () => insertInputToken(btn.dataset.pivotDagInsertToken || ''));
            });
            inspector.querySelector('[data-pivot-dag-delete]')?.addEventListener('click', () => deleteNode(node.id));
            if (focusSnapshot?.field) {
                const next = inspector.querySelector(`[data-pivot-dag-field="${cssEscape(focusSnapshot.field)}"]`);
                next?.focus?.({ preventScroll: true });
                if (next && focusSnapshot.start !== null && typeof next.setSelectionRange === 'function') {
                    try {
                        next.setSelectionRange(focusSnapshot.start, focusSnapshot.end ?? focusSnapshot.start);
                    } catch (e) {
                        // Ignore controls that cannot restore a cursor range.
                    }
                }
            } else if (focusSnapshot?.depend) {
                inspector.querySelector(`[data-pivot-dag-depend="${cssEscape(focusSnapshot.depend)}"]`)?.focus?.({ preventScroll: true });
            }
        };

        const applyToolInputTemplate = (nodeId) => {
            const node = spec.nodes.find(n => n.id === nodeId);
            if (!node) return;
            const tool = currentTools().find(t => toolValue(t) === node.tool);
            const template = buildToolInputTemplate(tool);
            node.input = { ...template, ...(node.input || {}) };
            render();
            flushOut();
            window.showToast?.('已套用工具参数模板', 'success');
        };

        const insertInputToken = (token) => {
            if (!token) return;
            const node = spec.nodes.find(n => n.id === selectedId);
            const textarea = inspector?.querySelector('[data-pivot-dag-field="input"]');
            if (!node || !textarea) return;
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            const before = textarea.value.slice(0, start);
            const quoteCount = (before.match(/(?<!\\)"/g) || []).length;
            const insideString = quoteCount % 2 === 1;
            const insertText = insideString ? token : JSON.stringify(token);
            textarea.value = `${before}${insertText}${textarea.value.slice(end)}`;
            textarea.selectionStart = start + insertText.length;
            textarea.selectionEnd = start + insertText.length;
            textarea.focus();
            handleInspectorEdit(textarea);
        };

        const handleInspectorEdit = (input) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const field = input.dataset.pivotDagField;
            if (field === 'id') {
                const next = String(input.value || '').trim().replace(/[^\w.-]/g, '_').slice(0, 60);
                if (!next || next === node.id) return;
                if (spec.nodes.some(n => n.id === next)) return;
                spec.nodes.forEach(n => {
                    n.dependsOn = (n.dependsOn || []).map(dep => dep === node.id ? next : dep);
                });
                node.id = next;
                selectedId = next;
            } else if (field === 'title') {
                node.title = String(input.value || '').slice(0, 120);
            } else if (field === 'tool') {
                node.tool = String(input.value || '');
            } else if (field === 'condition') {
                node.condition = ['always', 'success'].includes(input.value) ? input.value : 'success';
            } else if (field === 'onError') {
                node.onError = ['skip_dependents', 'continue', 'stop'].includes(input.value) ? input.value : 'skip_dependents';
            } else if (field === 'retryLimit') {
                node.retryLimit = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 5));
            } else if (field === 'timeoutMs') {
                node.timeoutMs = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 600000));
            } else if (field === 'input') {
                try {
                    const parsed = JSON.parse(input.value || '{}');
                    node.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                    input.classList.remove('is-invalid');
                } catch (e) {
                    input.classList.add('is-invalid');
                    return;
                }
            }
            render();
            flushOut();
        };

        const handleDependsToggle = (checkbox) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const dep = checkbox.dataset.pivotDagDepend;
            const deps = new Set(node.dependsOn || []);
            if (checkbox.checked) {
                if (wouldCreateCycle(dep, node.id)) {
                    checkbox.checked = false;
                    window.showToast?.('不能添加循环依赖', 'error');
                    return;
                }
                deps.add(dep);
            } else {
                deps.delete(dep);
            }
            node.dependsOn = [...deps];
            clampDependsOn(spec.nodes);
            render();
            flushOut();
        };

        const deleteNode = (id) => {
            spec.nodes = spec.nodes.filter(n => n.id !== id);
            clampDependsOn(spec.nodes);
            if (selectedId === id) selectedId = null;
            autoLayout(spec.nodes);
            render();
            flushOut();
        };

        const addNode = () => {
            const baseId = uniqueId(spec.nodes.map(n => n.id));
            const tools = currentTools();
            const node = {
                id: baseId,
                title: '新节点',
                tool: toolValue(tools[0]),
                input: {},
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
        };

        const addPresetNode = (preset) => {
            const tools = currentTools();
            const preferred = findPreferredTool(tools, preset.patterns || []);
            const baseId = uniqueId(spec.nodes.map(n => n.id), preset.base || 'node');
            const node = {
                id: baseId,
                title: preset.title,
                tool: toolValue(preferred),
                input: { ...(preset.input || {}) },
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
        };

        const resetLayout = () => {
            autoLayout(spec.nodes);
            render();
        };

        const renderEdges = () => {
            edgesLayer.replaceChildren();
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            spec.nodes.forEach(node => {
                (node.dependsOn || []).forEach(depId => {
                    const from = byId.get(depId);
                    if (!from) return;
                    const path = makeSvgEl('path', {
                        class: 'pivot-dag-edge',
                        d: createEdgePath(from, node),
                        'marker-end': 'url(#pivot-dag-arrow)'
                    });
                    edgesLayer.appendChild(path);
                });
            });
        };

        const renderNodes = () => {
            nodesLayer.replaceChildren();
            spec.nodes.forEach(node => {
                const group = makeSvgEl('g', {
                    class: `pivot-dag-node ${selectedId === node.id ? 'is-selected' : ''} ${node.tool ? '' : 'has-warning'}`,
                    transform: `translate(${node._x}, ${node._y})`,
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(makeSvgEl('rect', {
                    class: 'pivot-dag-node-body',
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 8,
                    ry: 8
                }));
                const title = makeSvgEl('text', { class: 'pivot-dag-node-title', x: 12, y: 22 });
                title.textContent = node.title || node.id;
                group.appendChild(title);
                const tool = makeSvgEl('text', { class: 'pivot-dag-node-tool', x: 12, y: 42 });
                tool.textContent = node.tool ? `→ ${node.tool}` : '未选择工具';
                group.appendChild(tool);
                // 出端口（拖出去创建依赖）
                const outPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-out',
                    cx: NODE_WIDTH,
                    cy: NODE_HEIGHT / 2,
                    r: 6,
                    'data-pivot-dag-port': 'out',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(outPort);
                // 入端口（接收依赖的连接落点）
                const inPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-in',
                    cx: 0,
                    cy: NODE_HEIGHT / 2,
                    r: 6,
                    'data-pivot-dag-port': 'in',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(inPort);
                nodesLayer.appendChild(group);
            });
        };

        const render = () => {
            updateViewBox();
            renderEdges();
            renderNodes();
            renderInspector();
            renderToolbarStatus();
        };

        // —— 交互：节点拖拽、端口连线、选中 ——
        let dragging = null;
        const pointFromEvent = (event) => {
            const rect = root.getBoundingClientRect();
            const vb = root.viewBox.baseVal || { x: 0, y: 0, width: rect.width, height: rect.height };
            const scaleX = vb.width / rect.width;
            const scaleY = vb.height / rect.height;
            return {
                x: (event.clientX - rect.left) * scaleX + vb.x,
                y: (event.clientY - rect.top) * scaleY + vb.y
            };
        };

        const onPointerDown = (event) => {
            const target = event.target;
            if (target.dataset.pivotDagPort === 'out') {
                event.preventDefault();
                const node = spec.nodes.find(n => n.id === target.dataset.pivotDagId);
                if (!node) return;
                const ghost = makeSvgEl('path', { class: 'pivot-dag-edge pivot-dag-edge-ghost' });
                edgesLayer.appendChild(ghost);
                connecting = { fromId: node.id, ghost };
                root.setPointerCapture?.(event.pointerId);
                return;
            }
            const nodeGroup = target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) {
                selectedId = null;
                render();
                // 空白处按下：开始平移
                panning = {
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    originX: viewState.x,
                    originY: viewState.y
                };
                root.classList.add('is-panning');
                root.setPointerCapture?.(event.pointerId);
                return;
            }
            const id = nodeGroup.dataset.pivotDagId;
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return;
            selectedId = id;
            render();
            const pointer = pointFromEvent(event);
            dragging = { id, offsetX: pointer.x - node._x, offsetY: pointer.y - node._y };
            root.setPointerCapture?.(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (connecting) {
                const node = spec.nodes.find(n => n.id === connecting.fromId);
                if (!node) return;
                const pointer = pointFromEvent(event);
                const startX = node._x + NODE_WIDTH;
                const startY = node._y + NODE_HEIGHT / 2;
                connecting.ghost.setAttribute('d', `M ${startX},${startY} C ${startX + 60},${startY} ${pointer.x - 60},${pointer.y} ${pointer.x},${pointer.y}`);
                return;
            }
            if (dragging) {
                const node = spec.nodes.find(n => n.id === dragging.id);
                if (!node) return;
                const pointer = pointFromEvent(event);
                node._x = Math.max(0, pointer.x - dragging.offsetX);
                node._y = Math.max(0, pointer.y - dragging.offsetY);
                renderEdges();
                const group = nodesLayer.querySelector(`[data-pivot-dag-id="${cssEscape(dragging.id)}"]`);
                if (group) group.setAttribute('transform', `translate(${node._x}, ${node._y})`);
                updateViewBox();
                return;
            }
            if (panning) {
                // 把屏幕像素位移转回内容坐标位移：屏幕 px / (canvas px) * viewBox 宽 = 内容单位
                const rect = root.getBoundingClientRect();
                const { width, height } = contentBounds();
                const dxContent = (event.clientX - panning.startClientX) * (width / viewState.scale) / rect.width;
                const dyContent = (event.clientY - panning.startClientY) * (height / viewState.scale) / rect.height;
                viewState.x = panning.originX - dxContent;
                viewState.y = panning.originY - dyContent;
                updateViewBox();
            }
        };

        const onPointerUp = (event) => {
            if (connecting) {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                const inPort = target?.closest?.('[data-pivot-dag-port="in"]');
                const targetId = inPort?.dataset?.pivotDagId;
                if (targetId && targetId !== connecting.fromId) {
                    const targetNode = spec.nodes.find(n => n.id === targetId);
                    if (targetNode && !targetNode.dependsOn.includes(connecting.fromId)) {
                        if (wouldCreateCycle(connecting.fromId, targetId)) {
                            window.showToast?.('不能添加循环依赖', 'error');
                            connecting.ghost.remove();
                            connecting = null;
                            render();
                            return;
                        }
                        targetNode.dependsOn.push(connecting.fromId);
                        clampDependsOn(spec.nodes);
                        flushOut();
                    }
                }
                connecting.ghost.remove();
                connecting = null;
                render();
                return;
            }
            if (dragging) {
                dragging = null;
                flushOut();
            }
            if (panning) {
                panning = null;
                root.classList.remove('is-panning');
            }
        };

        // 滚轮缩放：以光标位置为锚点
        const onWheel = (event) => {
            event.preventDefault();
            const factor = event.deltaY > 0 ? 0.9 : 1.1;
            const nextScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, viewState.scale * factor));
            if (nextScale === viewState.scale) return;
            const anchor = pointFromEvent(event); // 缩放前光标所在内容坐标
            viewState.scale = nextScale;
            // 缩放后保持光标对应同一内容点：anchor 在新视口中仍位于相同屏幕位置
            const rect = root.getBoundingClientRect();
            const { width, height } = contentBounds();
            const newVbWidth = width / viewState.scale;
            const newVbHeight = height / viewState.scale;
            const offsetX = (event.clientX - rect.left) / rect.width;
            const offsetY = (event.clientY - rect.top) / rect.height;
            viewState.x = anchor.x - offsetX * newVbWidth;
            viewState.y = anchor.y - offsetY * newVbHeight;
            updateViewBox();
        };

        const onDoubleClick = (event) => {
            const nodeGroup = event.target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) return;
            selectedId = nodeGroup.dataset.pivotDagId;
            render();
            // 把焦点放到 inspector 第一个输入，便于直接改名
            inspector?.querySelector('input[data-pivot-dag-field="title"]')?.focus();
        };

        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        root.addEventListener('dblclick', onDoubleClick);
        root.addEventListener('wheel', onWheel, { passive: false });

        // —— 工具栏 ——
        if (toolbar) {
            toolbar.replaceChildren();
            toolbar.appendChild(makeButton('+ 节点', '新增工作流节点', addNode));
            toolbar.appendChild(makeButton('+ 检索', '添加知识检索节点', () => addPresetNode({
                base: 'search',
                title: '知识检索',
                patterns: ['rag.search', 'knowledge', 'search'],
                input: { query: '' }
            })));
            toolbar.appendChild(makeButton('+ 数据', '添加数据查询节点', () => addPresetNode({
                base: 'data',
                title: '数据查询',
                patterns: ['db.run_readonly_query', 'db.list_tables', 'database'],
                input: {}
            })));
            toolbar.appendChild(makeButton('+ 图表', '添加图表生成节点', () => addPresetNode({
                base: 'chart',
                title: '图表生成',
                patterns: ['viz.build_chart', 'chart'],
                input: {}
            })));
            toolbar.appendChild(makeButton('+ 报告', '添加报告编排节点', () => addPresetNode({
                base: 'report',
                title: '报告编排',
                patterns: ['report.compose', 'report'],
                input: {}
            })));
            toolbar.appendChild(makeButton('校验', '校验节点、依赖和工具可用性', showValidationResult));
            toolbar.appendChild(makeButton('自动布局', '按依赖层次重新排列', resetLayout));
            toolbar.appendChild(makeButton('适配画布', '重置缩放和平移到默认视角', fitToContent));
            toolbar.appendChild(makeButton('JSON 视图', '打开高级 JSON 编辑弹窗', () => {
                if (typeof onOpenJson === 'function') onOpenJson();
            }));
            toolbar.appendChild(makeButton('从 JSON 同步', '把 JSON 文本应用到画布', () => {
                const parsed = readJson(textarea ? textarea.value : '');
                if (!parsed) {
                    if (typeof onChange === 'function') onChange({ error: 'invalid_json' });
                    return;
                }
                spec = ensureDefaults(parsed);
                selectedId = null;
                render();
            }));
            toolbarStatus = document.createElement('div');
            toolbarStatus.className = 'pivot-dag-toolbar-status';
            toolbar.appendChild(toolbarStatus);
        }

        // —— textarea 外部改动同步回画布 ——
        const onTextareaInput = () => {
            if (suppressTextareaSync) return;
            const parsed = readJson(textarea.value);
            if (!parsed) return;
            spec = ensureDefaults(parsed);
            selectedId = null;
            render();
        };
        if (textarea) textarea.addEventListener('input', onTextareaInput);

        render();

        const destroy = () => {
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('pointerup', onPointerUp);
            root.removeEventListener('pointercancel', onPointerUp);
            root.removeEventListener('dblclick', onDoubleClick);
            root.removeEventListener('wheel', onWheel);
            if (minimap?.svg && typeof minimapClickHandler === 'function') {
                minimap.svg.removeEventListener('click', minimapClickHandler);
            }
            if (textarea) textarea.removeEventListener('input', onTextareaInput);
            canvas.replaceChildren();
            if (minimap?.wrap?.parentNode === canvas) {
                // canvas.replaceChildren 已清空
            }
            if (inspector) inspector.replaceChildren();
            if (toolbar) toolbar.replaceChildren();
            canvas._pivotDagDestroy = null;
        };
        canvas._pivotDagDestroy = destroy;

        return {
            destroy,
            getValue: () => serialize(spec),
            setValue: (value) => {
                spec = ensureDefaults(value || { nodes: [] });
                selectedId = null;
                render();
                flushOut();
            },
            clearSelection: () => {
                selectedId = null;
                render();
            },
            syncFromJson: () => {
                const parsed = readJson(textarea ? textarea.value : '');
                if (!parsed) {
                    if (typeof onChange === 'function') onChange({ error: 'invalid_json' });
                    return false;
                }
                spec = ensureDefaults(parsed);
                selectedId = null;
                render();
                return true;
            },
            refresh: () => render()
        };
    }

    window.PivotDagEditor = { mount };
})();
