(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const m = app.modeling;
    const { state } = m;
    const { esc } = app;
    const byId = id => document.getElementById(id);

    const OPERATOR_SPECS = [
        { kind: 'source', label: '数据输入', badge: '输入', acceptsInput: false, maxInputs: 0, desc: '引入额外数据集作为算子流起点' },
        { kind: 'join', label: '多表关联', badge: '关联', acceptsInput: true, maxInputs: 2, desc: '按关联字段横向拼接两路输入表' },
        { kind: 'filter', label: '数据筛选', badge: '筛选', acceptsInput: true, maxInputs: 1, desc: '按多条件过滤保留符合要求的行' },
        { kind: 'formula', label: '函数计算', badge: '计算', acceptsInput: true, maxInputs: 1, desc: '使用内置函数与四则逻辑派生新列' },
        { kind: 'aggregate', label: '分组聚合', badge: '聚合', acceptsInput: true, maxInputs: 1, desc: '按维度分组计算求和、均值与去重数' },
        { kind: 'select', label: '字段清洗', badge: '清洗', acceptsInput: true, maxInputs: 1, desc: '勾选保留列、字段重命名、去重与排序' },
        { kind: 'union', label: '上下合并', badge: '合并', acceptsInput: true, maxInputs: 8, desc: '将多路同结构或同名列数据纵向追加' },
        { kind: 'sql', label: '自定义 SQL', badge: 'SQL', acceptsInput: true, maxInputs: 8, desc: '编写只读 DuckDB SQL 查询上游节点' }
    ];

    const OPERATOR_MAP = new Map(OPERATOR_SPECS.map(spec => [spec.kind, spec]));

    const BUILTIN_FUNCTIONS = [
        { category: 'math', name: 'ROUND', label: '四舍五入', template: 'ROUND(TRY_CAST("字段名" AS DOUBLE), 2)', description: '将数值保留指定小数位' },
        { category: 'math', name: 'ABS', label: '绝对值', template: 'ABS(TRY_CAST("字段名" AS DOUBLE))', description: '返回数值的非负绝对值' },
        { category: 'math', name: 'CEIL', label: '向上取整', template: 'CEIL(TRY_CAST("字段名" AS DOUBLE))', description: '返回不小于该数的最小整数' },
        { category: 'math', name: 'FLOOR', label: '向下取整', template: 'FLOOR(TRY_CAST("字段名" AS DOUBLE))', description: '返回不大于该数的最大整数' },
        { category: 'math', name: 'COALESCE', label: '空值替补', template: 'COALESCE("字段名", \'默认值\')', description: '返回第一个非空参数值' },
        { category: 'math', name: 'NULLIF', label: '安全分母', template: 'NULLIF(TRY_CAST("字段名" AS DOUBLE), 0)', description: '相等时转为空值，避免除以零' },
        { category: 'text', name: 'TRIM', label: '去空格', template: 'TRIM(CAST("字段名" AS VARCHAR))', description: '清除文本首尾空白字符' },
        { category: 'text', name: 'UPPER', label: '转大写', template: 'UPPER(CAST("字段名" AS VARCHAR))', description: '将英文字母转换为大写' },
        { category: 'text', name: 'LOWER', label: '转小写', template: 'LOWER(CAST("字段名" AS VARCHAR))', description: '将英文字母转换为小写' },
        { category: 'text', name: 'CONCAT', label: '拼接文本', template: 'CONCAT("字段名", \'-\', \'后缀\')', description: '将多个字段或文本拼接为一列' },
        { category: 'text', name: 'SUBSTR', label: '截取子串', template: 'SUBSTR(CAST("字段名" AS VARCHAR), 1, 4)', description: '从第 1 位开始截取指定长度字符' },
        { category: 'text', name: 'REPLACE', label: '文本替换', template: 'REPLACE(CAST("字段名" AS VARCHAR), \'旧词\', \'新词\')', description: '替换字符串中的指定片段' },
        { category: 'text', name: 'LENGTH', label: '字符长度', template: 'LENGTH(CAST("字段名" AS VARCHAR))', description: '统计文本字符长度' },
        { category: 'date', name: 'YEAR', label: '提取年份', template: 'YEAR(TRY_CAST("字段名" AS DATE))', description: '提取日期的四位年份' },
        { category: 'date', name: 'MONTH', label: '提取月份', template: 'MONTH(TRY_CAST("字段名" AS DATE))', description: '提取日期的月份（1—12）' },
        { category: 'date', name: 'DAY', label: '提取日', template: 'DAY(TRY_CAST("字段名" AS DATE))', description: '提取日期的日（1—31）' },
        { category: 'date', name: 'DATE_TRUNC', label: '日期归整', template: 'DATE_TRUNC(\'month\', TRY_CAST("字段名" AS DATE))', description: '按年、季、月或日截断归整' },
        { category: 'date', name: 'DATE_DIFF', label: '日期相减', template: 'DATE_DIFF(\'day\', TRY_CAST("字段名" AS DATE), CURRENT_DATE)', description: '计算两个日期相差天数' },
        { category: 'date', name: 'STRFTIME', label: '日期格式化', template: 'STRFTIME(TRY_CAST("字段名" AS DATE), \'%Y-%m\')', description: '将日期格式化为年月等文本' },
        { category: 'logic', name: 'IF', label: '条件 IF', template: 'IF(TRY_CAST("字段名" AS DOUBLE) >= 60, \'达标\', \'未达标\')', description: '按条件成立与否返回不同值' },
        { category: 'logic', name: 'CASE', label: '多分支 CASE', template: 'CASE WHEN TRY_CAST("字段名" AS DOUBLE) >= 90 THEN \'优秀\' WHEN TRY_CAST("字段名" AS DOUBLE) >= 60 THEN \'合格\' ELSE \'待提升\' END', description: '多区间分级映射表达式' },
        { category: 'logic', name: 'TRY_CAST_NUM', label: '安全转数值', template: 'TRY_CAST("字段名" AS DOUBLE)', description: '安全转为浮点数，异常值自动转空' },
        { category: 'logic', name: 'TRY_CAST_DATE', label: '安全转日期', template: 'TRY_CAST("字段名" AS DATE)', description: '安全转为标准日期类型' },
        { category: 'logic', name: 'TRY_CAST_TEXT', label: '转文本', template: 'TRY_CAST("字段名" AS VARCHAR)', description: '将任意值转换为字符串' }
    ];

    const FUNCTION_CATEGORIES = [
        ['all', '全部函数'],
        ['math', '数学'],
        ['text', '文本'],
        ['date', '日期'],
        ['logic', '条件与转换']
    ];

    const FILTER_OPERATOR_OPTIONS = [
        ['eq', '等于 (=)'],
        ['neq', '不等于 (≠)'],
        ['gt', '大于 (>)'],
        ['gte', '大于等于 (≥)'],
        ['lt', '小于 (<)'],
        ['lte', '小于等于 (≤)'],
        ['contains', '包含文本'],
        ['starts_with', '开头为'],
        ['ends_with', '结尾为'],
        ['in', '属于多个值'],
        ['is_null', '为空值'],
        ['is_not_null', '非空值']
    ];

    const AGG_FN_OPTIONS = [
        ['sum', '求和 (SUM)'],
        ['avg', '平均值 (AVG)'],
        ['count', '记录行数 (COUNT)'],
        ['count_distinct', '去重计数 (DISTINCT)'],
        ['max', '最大值 (MAX)'],
        ['min', '最小值 (MIN)']
    ];

    let activeExpressionInputId = '';

    function ensureFlowGraph() {
        if (!state.flowGraph || typeof state.flowGraph !== 'object') {
            state.flowGraph = { nodes: [], edges: [] };
        }
        if (!Array.isArray(state.flowGraph.nodes)) state.flowGraph.nodes = [];
        if (!Array.isArray(state.flowGraph.edges)) state.flowGraph.edges = [];
        return state.flowGraph;
    }

    function getFlowNode(nodeId) {
        return (state.flowGraph?.nodes || []).find(item => item.id === nodeId) || null;
    }

    function getAnyNodeName(nodeId) {
        const defNode = state.draft?.nodes?.find(item => item.id === nodeId);
        if (defNode) return defNode.name;
        const flowNode = getFlowNode(nodeId);
        return flowNode?.name || nodeId;
    }

    function getIncomingNodeIds(nodeId) {
        return (state.flowGraph?.edges || [])
            .filter(edge => edge.toNodeId === nodeId)
            .map(edge => edge.fromNodeId);
    }

    function inferNodeColumns(nodeId, visited = new Set()) {
        if (!nodeId || visited.has(nodeId)) return [];
        visited.add(nodeId);
        if (Array.isArray(state.schemaCache?.[nodeId]) && state.schemaCache[nodeId].length) {
            return state.schemaCache[nodeId];
        }
        const defNode = state.draft?.nodes?.find(item => item.id === nodeId);
        if (defNode) {
            return m.columns(nodeId).map(col => col.name || col.key).filter(Boolean);
        }
        const flowNode = getFlowNode(nodeId);
        if (!flowNode) return [];
        const cfg = flowNode.config || {};
        if (flowNode.kind === 'source') {
            const ds = (app.state.datasets || []).find(item => item.id === cfg.datasetId);
            return (ds?.columns || []).map(col => col.name || col.key).filter(Boolean);
        }
        const upIds = getIncomingNodeIds(nodeId);
        const firstCols = upIds[0] ? inferNodeColumns(upIds[0], new Set(visited)) : [];
        if (flowNode.kind === 'filter') return firstCols;
        if (flowNode.kind === 'formula') {
            const added = (cfg.fields || []).map(item => String(item?.name || '').trim()).filter(Boolean);
            if (cfg.keepAll === false) return added;
            const merged = [...firstCols];
            for (const name of added) {
                if (!merged.includes(name)) merged.push(name);
            }
            return merged;
        }
        if (flowNode.kind === 'join') {
            const secondCols = upIds[1] ? inferNodeColumns(upIds[1], new Set(visited)) : [];
            const rightTitle = upIds[1] ? getAnyNodeName(upIds[1]) : '右表';
            const leftSet = new Set(firstCols);
            return [
                ...firstCols,
                ...secondCols.map(col => leftSet.has(col) ? `${rightTitle}_${col}` : col)
            ];
        }
        if (flowNode.kind === 'aggregate') {
            const groups = (cfg.groupBy || []).filter(Boolean);
            const aggs = (cfg.aggregations || [])
                .filter(item => item?.fn === 'count' || item?.field)
                .map(item => item.alias || (item.fn === 'count' ? '记录条数' : `${item.field}_${item.fn}`));
            return [...groups, ...aggs];
        }
        if (flowNode.kind === 'select') {
            const active = (cfg.columns || []).filter(col => col.enabled !== false && col.field);
            return active.length ? active.map(col => col.alias || col.field) : firstCols;
        }
        if (flowNode.kind === 'union') {
            const unionSet = new Set();
            for (const upId of upIds) {
                for (const col of inferNodeColumns(upId, new Set(visited))) unionSet.add(col);
            }
            return [...unionSet];
        }
        return firstCols;
    }

    function defaultOperatorConfig(kind, preset = {}, upstreamCols = []) {
        const firstCol = upstreamCols[0] || '';
        if (kind === 'source') {
            return { datasetId: preset.datasetId || app.state.datasets?.[0]?.id || '' };
        }
        if (kind === 'filter') {
            return { match: 'all', conditions: [{ field: firstCol, operator: 'is_not_null', value: '' }] };
        }
        if (kind === 'formula') {
            const sampleExpr = firstCol ? `COALESCE("${firstCol.replace(/"/g, '""')}", '')` : '';
            return { keepAll: true, fields: [{ name: '计算新列', expression: sampleExpr }] };
        }
        if (kind === 'join') {
            return { joinType: 'left', keyPairs: [{ leftField: firstCol, rightField: '' }] };
        }
        if (kind === 'aggregate') {
            return {
                groupBy: firstCol ? [firstCol] : [],
                aggregations: [{ field: upstreamCols[1] || firstCol, fn: 'count', alias: '记录条数' }]
            };
        }
        if (kind === 'select') {
            return {
                columns: upstreamCols.slice(0, 60).map(col => ({ field: col, alias: '', enabled: true })),
                deduplicate: false,
                sortField: '',
                sortDirection: 'asc'
            };
        }
        if (kind === 'union') {
            return { mode: 'all', byName: true };
        }
        if (kind === 'sql') {
            return { sql: 'SELECT * FROM input_1 LIMIT 100' };
        }
        return {};
    }

    function operatorSummary(node) {
        const cfg = node.config || {};
        if (node.kind === 'source') {
            const ds = (app.state.datasets || []).find(item => item.id === cfg.datasetId);
            return ds ? `${ds.name} · ${(ds.columns || []).length} 列` : '待选择输入数据集';
        }
        if (node.kind === 'filter') {
            const validCount = (cfg.conditions || []).filter(item => item?.field).length;
            return validCount ? `${validCount} 条条件 · ${cfg.match === 'any' ? '任一满足' : '全部满足'}` : '点击配置筛选条件';
        }
        if (node.kind === 'formula') {
            const validCount = (cfg.fields || []).filter(item => item?.name && item?.expression).length;
            return validCount ? `${validCount} 个计算字段${cfg.keepAll === false ? ' · 仅新列' : ''}` : '点击配置函数表达式';
        }
        if (node.kind === 'join') {
            const joinLabel = ({ left: '左关联', inner: '内关联', right: '右关联', full: '全外关联' })[cfg.joinType] || '左关联';
            const pairCount = (cfg.keyPairs || []).filter(item => item?.leftField && item?.rightField).length;
            return pairCount ? `${joinLabel} · ${pairCount} 对关联键` : `${joinLabel} · 待选关联键`;
        }
        if (node.kind === 'aggregate') {
            const gCount = (cfg.groupBy || []).length;
            const aCount = (cfg.aggregations || []).filter(item => item?.fn === 'count' || item?.field).length;
            return `${gCount} 个分组 · ${aCount} 项汇总`;
        }
        if (node.kind === 'select') {
            const activeCount = (cfg.columns || []).filter(item => item?.enabled !== false && item?.field).length;
            const parts = [activeCount ? `保留 ${activeCount} 列` : '全部字段'];
            if (cfg.deduplicate) parts.push('去重');
            if (cfg.sortField) parts.push('已排序');
            return parts.join(' · ');
        }
        if (node.kind === 'union') {
            return `${cfg.mode === 'distinct' ? '合并去重' : '追加全部'} · ${cfg.byName !== false ? '按列名' : '按顺序'}`;
        }
        if (node.kind === 'sql') {
            const clean = String(cfg.sql || '').replace(/\s+/g, ' ').trim();
            return clean ? clean.slice(0, 24) : '编写 SELECT 查询';
        }
        return '点击配置算子';
    }

    function hasCycleIfAdded(fromNodeId, toNodeId) {
        const edges = state.flowGraph?.edges || [];
        const pending = [toNodeId];
        const visited = new Set();
        while (pending.length) {
            const current = pending.pop();
            if (current === fromNodeId) return true;
            if (visited.has(current)) continue;
            visited.add(current);
            for (const edge of edges) {
                if (edge.fromNodeId === current) pending.push(edge.toNodeId);
            }
        }
        return false;
    }

    function connectFlowEdge(fromNodeId, toNodeId) {
        const fg = ensureFlowGraph();
        if (fromNodeId === toNodeId) throw new Error('节点不能连接到自身。');
        const targetFlow = getFlowNode(toNodeId);
        if (!targetFlow) throw new Error('连线终点必须是算子节点，或连接到维度表建立模型关联。');
        const spec = OPERATOR_MAP.get(targetFlow.kind);
        if (!spec?.acceptsInput) throw new Error(`「${spec?.label || targetFlow.name}」是独立输入节点，不接收上游连线。`);
        if (fg.edges.some(edge => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId)) {
            throw new Error('这两个节点之间已经存在连线。');
        }
        const currentInputs = fg.edges.filter(edge => edge.toNodeId === toNodeId);
        if (spec.maxInputs && currentInputs.length >= spec.maxInputs) {
            throw new Error(`「${targetFlow.name}」最多支持连接 ${spec.maxInputs} 个上游输入节点。`);
        }
        if (fg.edges.length >= 32) throw new Error('当前画布算子连线最多支持 32 条。');
        if (hasCycleIfAdded(fromNodeId, toNodeId)) {
            throw new Error('该连线会造成循环依赖，请调整连接方向。');
        }
        const edge = {
            id: `fedge_${m.key().replaceAll('-', '').slice(0, 12)}`,
            fromNodeId,
            toNodeId
        };
        fg.edges.push(edge);
        delete state.schemaCache[toNodeId];

        if (targetFlow.kind === 'select' && !(targetFlow.config.columns || []).length) {
            const cols = inferNodeColumns(fromNodeId);
            targetFlow.config.columns = cols.slice(0, 60).map(col => ({ field: col, alias: '', enabled: true }));
        }
        if (targetFlow.kind === 'join' && currentInputs.length === 1) {
            const leftCols = inferNodeColumns(currentInputs[0].fromNodeId);
            const rightCols = inferNodeColumns(fromNodeId);
            const shared = leftCols.find(col => rightCols.includes(col));
            if (shared && !(targetFlow.config.keyPairs?.[0]?.rightField)) {
                targetFlow.config.keyPairs = [{ leftField: shared, rightField: shared }];
            }
        }

        state.selectedNodeId = toNodeId;
        state.selectedRelationId = '';
        state.selectedFlowEdgeId = '';
        state.drawerMode = 'node';
        state.drawerOpen = true;
        m.changed();
        m.render();
        return edge;
    }

    function addFlowOperator(kind, preset = {}) {
        const spec = OPERATOR_MAP.get(kind);
        if (!spec) throw new Error('未知的内置算子类型。');
        const fg = ensureFlowGraph();
        if (fg.nodes.length >= 24) throw new Error('单个模型画布最多添加 24 个算子节点。');

        const selectedId = state.selectedNodeId;
        const canAutoLink = !preset.fromDrag
            && spec.acceptsInput
            && selectedId
            && (state.draft?.nodes?.some(n => n.id === selectedId) || fg.nodes.some(n => n.id === selectedId));

        const upstreamCols = canAutoLink ? inferNodeColumns(selectedId) : [];
        const sameKindCount = fg.nodes.filter(item => item.kind === kind).length + 1;
        const baseLayout = preset.layout || (() => {
            if (canAutoLink && typeof m.getNodeCanvasPosition === 'function') {
                const p = m.getNodeCanvasPosition(selectedId);
                return { x: Math.min(5600, p.x + 290), y: Math.min(5600, p.y + (sameKindCount - 1) % 3 * 36) };
            }
            const totalCount = (state.draft?.nodes?.length || 1) + fg.nodes.length;
            return { x: 60 + totalCount % 3 * 300, y: 150 + Math.floor(totalCount / 3) * 140 };
        })();

        const node = {
            id: `flow_${kind}_${m.key().replaceAll('-', '').slice(0, 10)}`,
            kind,
            name: preset.name || `${spec.label} ${sameKindCount}`,
            layout: {
                x: Math.round(Math.max(20, Math.min(6000, baseLayout.x))),
                y: Math.round(Math.max(20, Math.min(6000, baseLayout.y)))
            },
            config: defaultOperatorConfig(kind, preset, upstreamCols)
        };
        fg.nodes.push(node);

        if (canAutoLink && spec.maxInputs >= 1) {
            try {
                fg.edges.push({
                    id: `fedge_${m.key().replaceAll('-', '').slice(0, 12)}`,
                    fromNodeId: selectedId,
                    toNodeId: node.id
                });
            } catch (_ignore) {
                // 自动连线失败时仅放置算子节点，由用户手动连线
            }
        }

        state.selectedNodeId = node.id;
        state.selectedRelationId = '';
        state.selectedFlowEdgeId = '';
        state.drawerMode = 'node';
        state.drawerOpen = true;
        m.changed();
        m.render();
        return node;
    }

    function removeFlowNode(nodeId) {
        const fg = ensureFlowGraph();
        const target = getFlowNode(nodeId);
        if (!target) return;
        fg.nodes = fg.nodes.filter(item => item.id !== nodeId);
        fg.edges = fg.edges.filter(edge => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId);
        delete state.schemaCache[nodeId];
        if (state.selectedNodeId === nodeId) {
            state.selectedNodeId = state.draft?.nodes?.[0]?.id || '';
            state.drawerOpen = false;
        }
        if (state.previewNodeId === nodeId) {
            state.previewNodeId = '';
            state.previewData = null;
        }
        m.changed();
        m.render();
    }

    function removeFlowEdge(edgeId) {
        const fg = ensureFlowGraph();
        const edge = fg.edges.find(item => item.id === edgeId);
        if (!edge) return;
        fg.edges = fg.edges.filter(item => item.id !== edgeId);
        delete state.schemaCache[edge.toNodeId];
        if (state.selectedFlowEdgeId === edgeId) {
            state.selectedFlowEdgeId = '';
            if (state.drawerMode === 'relation') state.drawerOpen = false;
        }
        m.changed();
        m.render();
    }

    function renderFunctionAssistant(upstreamCols, defaultSampleCol = '') {
        const filteredFns = BUILTIN_FUNCTIONS.filter(fn => state.fnCategory === 'all' || fn.category === state.fnCategory);
        const colChips = upstreamCols.slice(0, 40).map(col => {
            return `<button class="btn-secondary modeling-chip-btn" type="button" data-flow-insert-col="${esc(col)}" title="点击插入字段引用">${esc(col)}</button>`;
        }).join('');
        const fnItems = filteredFns.map(fn => {
            const tpl = defaultSampleCol ? fn.template.replaceAll('字段名', defaultSampleCol.replace(/"/g, '""')) : fn.template;
            return `<button class="btn-secondary modeling-fn-card" type="button" data-flow-insert-fn="${esc(tpl)}" title="${esc(`${fn.description}：${tpl}`)}">
                <strong>${esc(fn.name)}</strong>
                <span>${esc(fn.label)}</span>
            </button>`;
        }).join('');
        return `<div class="modeling-fn-box">
            <div class="modeling-drawer-subhead">
                <span>可用上游字段（点击插入到公式或 SQL）</span>
                <span class="modeling-rail-count">${upstreamCols.length} 列</span>
            </div>
            <div class="modeling-chip-wrap">${colChips || '<span class="text-muted">请先连接上游节点或运行一次上游预览以获取字段列表</span>'}</div>
            <div class="modeling-drawer-subhead">
                <span>内置函数库（点击直接插入模板）</span>
                <div class="modeling-fn-tabs">${FUNCTION_CATEGORIES.map(([cat, label]) => {
                    return `<button class="btn-secondary modeling-mini-btn${state.fnCategory === cat ? ' is-selected' : ''}" type="button" data-flow-fn-cat="${cat}">${esc(label)}</button>`;
                }).join('')}</div>
            </div>
            <div class="modeling-fn-grid">${fnItems}</div>
        </div>`;
    }

    function renderColumnSelectOptions(cols, currentVal, placeholder = '请选择字段') {
        const list = currentVal && !cols.includes(currentVal) ? [currentVal, ...cols] : cols;
        return `<option value="">${esc(placeholder)}</option>${list.map(col => {
            return `<option value="${esc(col)}"${col === currentVal ? ' selected' : ''}>${esc(col)}</option>`;
        }).join('')}`;
    }

    function renderOperatorBody(node, upstreamIds, editable) {
        const cfg = node.config || {};
        const dis = editable ? '' : ' disabled';
        const firstCols = upstreamIds[0] ? inferNodeColumns(upstreamIds[0]) : [];
        const secondCols = upstreamIds[1] ? inferNodeColumns(upstreamIds[1]) : [];

        if (node.kind === 'source') {
            const options = (app.state.datasets || []).map(ds => {
                return `<option value="${esc(ds.id)}"${ds.id === cfg.datasetId ? ' selected' : ''}>${esc(ds.name)}（${(ds.columns || []).length} 列）</option>`;
            }).join('');
            return `<label class="modeling-drawer-field">
                <span class="modeling-field-label">选择输入数据集</span>
                <select class="form-input" data-flow-prop="datasetId"${dis}>
                    <option value="">请选择数据集</option>${options}
                </select>
            </label>`;
        }

        if (node.kind === 'filter') {
            const conds = cfg.conditions?.length ? cfg.conditions : [{ field: '', operator: 'eq', value: '' }];
            return `<label class="modeling-drawer-field">
                <span class="modeling-field-label">多条件组合关系</span>
                <select class="form-input" data-flow-prop="match"${dis}>
                    <option value="all"${cfg.match !== 'any' ? ' selected' : ''}>满足全部条件 (AND)</option>
                    <option value="any"${cfg.match === 'any' ? ' selected' : ''}>满足任一条件 (OR)</option>
                </select>
            </label>
            <div class="modeling-flow-list">
                ${conds.map((cond, idx) => {
                    const hideVal = ['is_null', 'is_not_null'].includes(cond.operator);
                    const valPlaceholder = cond.operator === 'in' ? '多个值用逗号分隔' : '输入比较值';
                    return `<div class="modeling-flow-row-card">
                        <div class="modeling-flow-row-top">
                            <select class="form-input" data-flow-cond-field="${idx}" aria-label="筛选字段"${dis}>${renderColumnSelectOptions(firstCols, cond.field, '选择或输入字段')}</select>
                            <select class="form-input" data-flow-cond-op="${idx}" aria-label="筛选条件"${dis}>${FILTER_OPERATOR_OPTIONS.map(([k, lbl]) => `<option value="${k}"${k === cond.operator ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
                            <button class="btn-secondary modeling-mini-btn" type="button" data-flow-remove-cond="${idx}"${dis}>删除</button>
                        </div>
                        ${hideVal ? '' : `<input class="form-input" data-flow-cond-val="${idx}" value="${esc(cond.value ?? '')}" placeholder="${valPlaceholder}" maxlength="1000"${dis}>`}
                    </div>`;
                }).join('')}
            </div>
            <button class="btn-secondary" type="button" data-flow-add-cond${dis}>+ 添加筛选条件</button>`;
        }

        if (node.kind === 'formula') {
            const fields = cfg.fields?.length ? cfg.fields : [{ name: '计算新列', expression: '' }];
            return `<label class="modeling-checkbox">
                <input type="checkbox" data-flow-prop="keepAll"${cfg.keepAll !== false ? ' checked' : ''}${dis}>
                <span>保留上游全部原有字段（取消勾选则仅输出下方计算列）</span>
            </label>
            <div class="modeling-flow-list">
                ${fields.map((item, idx) => {
                    const exprId = `modeling-flow-expr-${idx}`;
                    return `<div class="modeling-flow-row-card">
                        <div class="modeling-flow-row-top">
                            <input class="form-input" data-flow-formula-name="${idx}" value="${esc(item.name || '')}" placeholder="新字段名称（如：折后金额）" maxlength="80"${dis}>
                            <button class="btn-secondary modeling-mini-btn" type="button" data-flow-remove-formula="${idx}"${dis}>删除</button>
                        </div>
                        <textarea id="${exprId}" class="form-input modeling-code-input" rows="2" data-flow-formula-expr="${idx}" placeholder="输入函数表达式，例如：ROUND(TRY_CAST(&quot;金额&quot; AS DOUBLE) * 0.9, 2)" maxlength="2000"${dis}>${esc(item.expression || '')}</textarea>
                    </div>`;
                }).join('')}
            </div>
            <button class="btn-secondary" type="button" data-flow-add-formula${dis}>+ 添加计算字段</button>
            ${renderFunctionAssistant(firstCols, firstCols[0] || '')}`;
        }

        if (node.kind === 'join') {
            const pairs = cfg.keyPairs?.length ? cfg.keyPairs : [{ leftField: '', rightField: '' }];
            const leftName = upstreamIds[0] ? getAnyNodeName(upstreamIds[0]) : '待连接左表（第1条连线）';
            const rightName = upstreamIds[1] ? getAnyNodeName(upstreamIds[1]) : '待连接右表（第2条连线）';
            return `<div class="modeling-notice is-info">左表：<strong>${esc(leftName)}</strong> · 右表：<strong>${esc(rightName)}</strong></div>
            <label class="modeling-drawer-field">
                <span class="modeling-field-label">关联方式</span>
                <select class="form-input" data-flow-prop="joinType"${dis}>
                    <option value="left"${cfg.joinType === 'left' || !cfg.joinType ? ' selected' : ''}>左关联 (LEFT JOIN · 保留左表全部行)</option>
                    <option value="inner"${cfg.joinType === 'inner' ? ' selected' : ''}>内关联 (INNER JOIN · 仅保留匹配行)</option>
                    <option value="right"${cfg.joinType === 'right' ? ' selected' : ''}>右关联 (RIGHT JOIN)</option>
                    <option value="full"${cfg.joinType === 'full' ? ' selected' : ''}>全外关联 (FULL OUTER JOIN)</option>
                </select>
            </label>
            <div class="modeling-flow-list">
                ${pairs.map((pair, idx) => {
                    return `<div class="modeling-flow-row-card">
                        <div class="modeling-flow-row-top">
                            <select class="form-input" data-flow-join-left="${idx}" aria-label="左表关联字段"${dis}>${renderColumnSelectOptions(firstCols, pair.leftField, '左表字段')}</select>
                            <span class="text-muted">=</span>
                            <select class="form-input" data-flow-join-right="${idx}" aria-label="右表关联字段"${dis}>${renderColumnSelectOptions(secondCols, pair.rightField, '右表字段')}</select>
                            <button class="btn-secondary modeling-mini-btn" type="button" data-flow-remove-join="${idx}"${dis}>删除</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
            <button class="btn-secondary" type="button" data-flow-add-join${dis}>+ 添加复合关联键</button>`;
        }

        if (node.kind === 'aggregate') {
            const aggs = cfg.aggregations?.length ? cfg.aggregations : [{ field: '', fn: 'sum', alias: '' }];
            return `<div class="modeling-multi-group" data-modeling-multi-group>
                <div class="modeling-multi-head">
                    <span class="modeling-field-label">分组字段 (GROUP BY，可多选，不选则汇总全表)</span>
                    <div class="modeling-multi-actions">
                        <button class="btn-secondary" type="button" data-modeling-multi-action="all" data-modeling-multi-limit="12"${dis}>全选</button>
                        <button class="btn-secondary" type="button" data-modeling-multi-action="clear"${dis}>清空</button>
                    </div>
                </div>
                <select class="form-input modeling-multi-select" multiple data-flow-agg-groups aria-label="分组字段"${dis}>
                    ${firstCols.map(col => `<option value="${esc(col)}"${(cfg.groupBy || []).includes(col) ? ' selected' : ''}>${esc(col)}</option>`).join('')}
                </select>
            </div>
            <div class="modeling-drawer-subhead"><span>汇总统计指标</span></div>
            <div class="modeling-flow-list">
                ${aggs.map((agg, idx) => {
                    return `<div class="modeling-flow-row-card">
                        <div class="modeling-flow-row-top">
                            <select class="form-input" data-flow-agg-fn="${idx}" aria-label="聚合函数"${dis}>${AGG_FN_OPTIONS.map(([k, lbl]) => `<option value="${k}"${k === agg.fn ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
                            ${agg.fn === 'count' ? '' : `<select class="form-input" data-flow-agg-field="${idx}" aria-label="聚合字段"${dis}>${renderColumnSelectOptions(firstCols, agg.field, '选择统计字段')}</select>`}
                            <button class="btn-secondary modeling-mini-btn" type="button" data-flow-remove-agg="${idx}"${dis}>删除</button>
                        </div>
                        <input class="form-input" data-flow-agg-alias="${idx}" value="${esc(agg.alias || '')}" placeholder="输出列名（留空自动生成）" maxlength="80"${dis}>
                    </div>`;
                }).join('')}
            </div>
            <button class="btn-secondary" type="button" data-flow-add-agg${dis}>+ 添加汇总指标</button>`;
        }

        if (node.kind === 'select') {
            const knownMap = new Map((cfg.columns || []).map(item => [item.field, item]));
            const mergedList = [
                ...(cfg.columns || []),
                ...firstCols.filter(col => !knownMap.has(col)).map(col => ({ field: col, alias: '', enabled: true }))
            ];
            return `<div class="modeling-checkbox-row">
                <label class="modeling-checkbox"><input type="checkbox" data-flow-prop="deduplicate"${cfg.deduplicate ? ' checked' : ''}${dis}><span>整行去重 (DISTINCT)</span></label>
            </div>
            <div class="modeling-inline-pair">
                <label class="modeling-drawer-field">
                    <span class="modeling-field-label">排序字段（可选）</span>
                    <select class="form-input" data-flow-prop="sortField"${dis}>${renderColumnSelectOptions(firstCols, cfg.sortField, '不排序')}</select>
                </label>
                <label class="modeling-drawer-field">
                    <span class="modeling-field-label">排序方向</span>
                    <select class="form-input" data-flow-prop="sortDirection"${dis}>
                        <option value="asc"${cfg.sortDirection !== 'desc' ? ' selected' : ''}>升序 (ASC)</option>
                        <option value="desc"${cfg.sortDirection === 'desc' ? ' selected' : ''}>降序 (DESC)</option>
                    </select>
                </label>
            </div>
            <div class="modeling-drawer-subhead">
                <span>输出列勾选与重命名</span>
                <button class="btn-secondary modeling-mini-btn" type="button" data-flow-sync-cols${dis}>同步上游字段</button>
            </div>
            <div class="modeling-flow-list modeling-select-col-list">
                ${mergedList.length ? mergedList.map((col, idx) => {
                    return `<div class="modeling-select-col-row">
                        <label class="modeling-checkbox"><input type="checkbox" data-flow-sel-on="${idx}" data-flow-sel-field="${esc(col.field)}"${col.enabled !== false ? ' checked' : ''}${dis}><span>${esc(col.field)}</span></label>
                        <input class="form-input" data-flow-sel-alias="${idx}" data-flow-sel-field="${esc(col.field)}" value="${esc(col.alias || '')}" placeholder="重命名（可选）" maxlength="80"${dis}>
                    </div>`;
                }).join('') : '<span class="text-muted">连接上游节点后自动列出可勾选字段</span>'}
            </div>`;
        }

        if (node.kind === 'union') {
            return `<label class="modeling-drawer-field">
                <span class="modeling-field-label">上下合并策略</span>
                <select class="form-input" data-flow-prop="mode"${dis}>
                    <option value="all"${cfg.mode !== 'distinct' ? ' selected' : ''}>保留全部记录 (UNION ALL)</option>
                    <option value="distinct"${cfg.mode === 'distinct' ? ' selected' : ''}>合并并去除重复行 (UNION)</option>
                </select>
            </label>
            <label class="modeling-checkbox">
                <input type="checkbox" data-flow-prop="byName"${cfg.byName !== false ? ' checked' : ''}${dis}>
                <span>按相同字段名自动对齐列（推荐，缺失列自动补空值）</span>
            </label>`;
        }

        if (node.kind === 'sql') {
            const aliasTips = upstreamIds.length
                ? upstreamIds.map((upId, idx) => `<code>input_${idx + 1}</code> = ${esc(getAnyNodeName(upId))}`).join('；')
                : '请先从左侧表或上游算子连线到此节点，SQL 中使用 <code>input_1</code>、<code>input_2</code> 引用上游输出表';
            const allUpCols = [...new Set(upstreamIds.flatMap(upId => inferNodeColumns(upId)))];
            return `<div class="modeling-notice is-info">上游视图别名：${aliasTips}${upstreamIds.length === 1 ? '（也可直接写 <code>输入表 input</code>）' : ''}</div>
            <label class="modeling-drawer-field">
                <span class="modeling-field-label">自定义只读 SQL（支持 SELECT / WITH、窗口函数、多表 JOIN 与全部内置函数）</span>
                <textarea id="modeling-flow-sql-editor" class="form-input modeling-code-input modeling-sql-textarea" rows="6" data-flow-prop="sql" maxlength="6000" placeholder="示例：SELECT * FROM input_1 WHERE ... LIMIT 100"${dis}>${esc(cfg.sql || '')}</textarea>
            </label>
            ${renderFunctionAssistant(allUpCols, allUpCols[0] || '')}`;
        }

        return '';
    }

    function renderOperatorInspector(node, editable) {
        const spec = OPERATOR_MAP.get(node.kind);
        const inEdges = (state.flowGraph?.edges || []).filter(edge => edge.toNodeId === node.id);
        const upstreamIds = inEdges.map(edge => edge.fromNodeId);
        const dis = editable ? '' : ' disabled';
        const upstreamMarkup = spec?.acceptsInput
            ? `<div class="modeling-drawer-section">
                <div class="modeling-drawer-subhead">
                    <span>上游输入连线</span>
                    <span class="modeling-rail-count">${inEdges.length}${spec.maxInputs ? ` / ${spec.maxInputs}` : ''}</span>
                </div>
                ${inEdges.length ? `<div class="modeling-chip-wrap">${inEdges.map((edge, idx) => {
                    return `<span class="modeling-edge-chip">输入${idx + 1}：<strong>${esc(getAnyNodeName(edge.fromNodeId))}</strong>${editable ? `<button class="btn-secondary modeling-mini-btn" type="button" data-flow-remove-edge="${esc(edge.id)}" title="断开此输入连线">×</button>` : ''}</span>`;
                }).join('')}</div>` : '<p class="modeling-rail-tip">尚未连接上游节点：请从画布上游节点右侧圆点拖线至本节点左侧圆点。</p>'}
            </div>`
            : '';

        return `<div class="modeling-drawer-section">
                <label class="modeling-drawer-field">
                    <span class="modeling-field-label">节点名称</span>
                    <input class="form-input" data-flow-node-name value="${esc(node.name)}" maxlength="120"${dis}>
                </label>
                <div class="modeling-drawer-actions">
                    <button class="btn-primary" type="button" data-modeling-action="preview-node" data-modeling-id="${esc(node.id)}">运行数据预览</button>
                    <button class="btn-secondary" type="button" data-modeling-action="materialize-node" data-modeling-id="${esc(node.id)}"${dis}>保存输出为数据集</button>
                    <button class="btn-danger" type="button" data-modeling-action="remove-flow-node" data-modeling-id="${esc(node.id)}"${dis}>删除节点</button>
                </div>
            </div>
            ${upstreamMarkup}
            <div class="modeling-drawer-section">
                <div class="modeling-drawer-subhead"><span>算子参数配置</span></div>
                ${renderOperatorBody(node, upstreamIds, editable)}
            </div>`;
    }

    function updateCanvasNodeSummaryDom(node) {
        const g = byId('modeling-graph')?.querySelector(`[data-modeling-graph-node="${CSS.escape(node.id)}"]`);
        if (!g) return;
        const titleEl = g.querySelector('.modeling-canvas-heading');
        if (titleEl) titleEl.textContent = node.name.slice(0, 16);
        const subEl = g.querySelector('.modeling-canvas-subtext');
        if (subEl) subEl.textContent = operatorSummary(node).slice(0, 24);
    }

    function syncSelectColumnsFromDom(container, node) {
        const rows = Array.from(container.querySelectorAll('.modeling-select-col-row'));
        if (!rows.length) return;
        node.config.columns = rows.map(row => {
            const check = row.querySelector('[data-flow-sel-on]');
            const alias = row.querySelector('[data-flow-sel-alias]');
            return {
                field: check?.dataset.flowSelField || '',
                alias: alias?.value?.trim() || '',
                enabled: Boolean(check?.checked)
            };
        }).filter(item => item.field);
    }

    function insertTextIntoActiveEditor(snippet) {
        const drawer = byId('modeling-drawer');
        if (!drawer) return;
        let target = activeExpressionInputId ? byId(activeExpressionInputId) : null;
        if (!target || !drawer.contains(target)) {
            target = drawer.querySelector('#modeling-flow-sql-editor, [data-flow-formula-expr]');
        }
        if (!target || target.disabled) return;
        const start = Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
        const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : target.value.length;
        target.value = `${target.value.slice(0, start)}${snippet}${target.value.slice(end)}`;
        target.focus();
        const cursor = start + snippet.length;
        target.setSelectionRange?.(cursor, cursor);
        target.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function handleOperatorInput(event) {
        const drawer = byId('modeling-drawer');
        if (!drawer?.contains(event.target)) return false;
        if (event.target.matches('#modeling-flow-sql-editor, [data-flow-formula-expr]')) {
            activeExpressionInputId = event.target.id || '';
        }
        const node = getFlowNode(state.selectedNodeId);
        if (!node) return false;
        const t = event.target;
        let handled = false;
        let needsRerender = false;

        if (t.hasAttribute('data-flow-node-name')) {
            node.name = t.value.trim() || node.name;
            handled = true;
        } else if (t.hasAttribute('data-flow-prop')) {
            const prop = t.dataset.flowProp;
            node.config[prop] = t.type === 'checkbox' ? t.checked : t.value;
            handled = true;
            if (prop === 'datasetId') needsRerender = true;
        } else if (t.hasAttribute('data-flow-cond-field') || t.hasAttribute('data-flow-cond-op') || t.hasAttribute('data-flow-cond-val')) {
            const idx = Number(t.dataset.flowCondField ?? t.dataset.flowCondOp ?? t.dataset.flowCondVal);
            if (!Array.isArray(node.config.conditions)) node.config.conditions = [];
            node.config.conditions[idx] = node.config.conditions[idx] || { field: '', operator: 'eq', value: '' };
            if (t.hasAttribute('data-flow-cond-field')) node.config.conditions[idx].field = t.value;
            if (t.hasAttribute('data-flow-cond-op')) {
                const prevHide = ['is_null', 'is_not_null'].includes(node.config.conditions[idx].operator);
                node.config.conditions[idx].operator = t.value;
                if (prevHide !== ['is_null', 'is_not_null'].includes(t.value)) needsRerender = true;
            }
            if (t.hasAttribute('data-flow-cond-val')) node.config.conditions[idx].value = t.value;
            handled = true;
        } else if (t.hasAttribute('data-flow-formula-name') || t.hasAttribute('data-flow-formula-expr')) {
            const idx = Number(t.dataset.flowFormulaName ?? t.dataset.flowFormulaExpr);
            if (!Array.isArray(node.config.fields)) node.config.fields = [];
            node.config.fields[idx] = node.config.fields[idx] || { name: '', expression: '' };
            if (t.hasAttribute('data-flow-formula-name')) node.config.fields[idx].name = t.value;
            if (t.hasAttribute('data-flow-formula-expr')) node.config.fields[idx].expression = t.value;
            handled = true;
        } else if (t.hasAttribute('data-flow-join-left') || t.hasAttribute('data-flow-join-right')) {
            const idx = Number(t.dataset.flowJoinLeft ?? t.dataset.flowJoinRight);
            if (!Array.isArray(node.config.keyPairs)) node.config.keyPairs = [];
            node.config.keyPairs[idx] = node.config.keyPairs[idx] || { leftField: '', rightField: '' };
            if (t.hasAttribute('data-flow-join-left')) node.config.keyPairs[idx].leftField = t.value;
            if (t.hasAttribute('data-flow-join-right')) node.config.keyPairs[idx].rightField = t.value;
            handled = true;
        } else if (t.hasAttribute('data-flow-agg-groups')) {
            node.config.groupBy = Array.from(t.selectedOptions || [], opt => opt.value);
            handled = true;
        } else if (t.hasAttribute('data-flow-agg-fn') || t.hasAttribute('data-flow-agg-field') || t.hasAttribute('data-flow-agg-alias')) {
            const idx = Number(t.dataset.flowAggFn ?? t.dataset.flowAggField ?? t.dataset.flowAggAlias);
            if (!Array.isArray(node.config.aggregations)) node.config.aggregations = [];
            node.config.aggregations[idx] = node.config.aggregations[idx] || { field: '', fn: 'sum', alias: '' };
            if (t.hasAttribute('data-flow-agg-fn')) {
                const wasCount = node.config.aggregations[idx].fn === 'count';
                node.config.aggregations[idx].fn = t.value;
                if (wasCount !== (t.value === 'count')) needsRerender = true;
            }
            if (t.hasAttribute('data-flow-agg-field')) node.config.aggregations[idx].field = t.value;
            if (t.hasAttribute('data-flow-agg-alias')) node.config.aggregations[idx].alias = t.value;
            handled = true;
        } else if (t.hasAttribute('data-flow-sel-on') || t.hasAttribute('data-flow-sel-alias')) {
            syncSelectColumnsFromDom(drawer, node);
            handled = true;
        }

        if (handled) {
            delete state.schemaCache[node.id];
            m.changed();
            if (needsRerender) m.render();
            else updateCanvasNodeSummaryDom(node);
        }
        return handled;
    }

    function handleOperatorClick(event) {
        const addOpBtn = event.target.closest('[data-canvas-operator]');
        if (addOpBtn && !addOpBtn.disabled) {
            addFlowOperator(addOpBtn.dataset.canvasOperator);
            return true;
        }
        const fnCatBtn = event.target.closest('[data-flow-fn-cat]');
        if (fnCatBtn) {
            state.fnCategory = fnCatBtn.dataset.flowFnCat;
            m.render();
            return true;
        }
        const insertColBtn = event.target.closest('[data-flow-insert-col]');
        if (insertColBtn) {
            const col = insertColBtn.dataset.flowInsertCol;
            insertTextIntoActiveEditor(`"${col.replace(/"/g, '""')}"`);
            return true;
        }
        const insertFnBtn = event.target.closest('[data-flow-insert-fn]');
        if (insertFnBtn) {
            insertTextIntoActiveEditor(insertFnBtn.dataset.flowInsertFn);
            return true;
        }
        const removeEdgeBtn = event.target.closest('[data-flow-remove-edge]');
        if (removeEdgeBtn) {
            removeFlowEdge(removeEdgeBtn.dataset.flowRemoveEdge);
            return true;
        }

        const node = getFlowNode(state.selectedNodeId);
        if (!node) return false;
        if (event.target.closest('[data-flow-add-cond]')) {
            node.config.conditions = [...(node.config.conditions || []), { field: '', operator: 'eq', value: '' }];
            m.changed(); m.render(); return true;
        }
        const rmCond = event.target.closest('[data-flow-remove-cond]');
        if (rmCond) {
            node.config.conditions = (node.config.conditions || []).filter((_, i) => i !== Number(rmCond.dataset.flowRemoveCond));
            if (!node.config.conditions.length) node.config.conditions = [{ field: '', operator: 'eq', value: '' }];
            m.changed(); m.render(); return true;
        }
        if (event.target.closest('[data-flow-add-formula]')) {
            const idx = (node.config.fields || []).length + 1;
            node.config.fields = [...(node.config.fields || []), { name: `计算列_${idx}`, expression: '' }];
            m.changed(); m.render(); return true;
        }
        const rmFormula = event.target.closest('[data-flow-remove-formula]');
        if (rmFormula) {
            node.config.fields = (node.config.fields || []).filter((_, i) => i !== Number(rmFormula.dataset.flowRemoveFormula));
            if (!node.config.fields.length) node.config.fields = [{ name: '计算新列', expression: '' }];
            m.changed(); m.render(); return true;
        }
        if (event.target.closest('[data-flow-add-join]')) {
            node.config.keyPairs = [...(node.config.keyPairs || []), { leftField: '', rightField: '' }];
            m.changed(); m.render(); return true;
        }
        const rmJoin = event.target.closest('[data-flow-remove-join]');
        if (rmJoin) {
            node.config.keyPairs = (node.config.keyPairs || []).filter((_, i) => i !== Number(rmJoin.dataset.flowRemoveJoin));
            if (!node.config.keyPairs.length) node.config.keyPairs = [{ leftField: '', rightField: '' }];
            m.changed(); m.render(); return true;
        }
        if (event.target.closest('[data-flow-add-agg]')) {
            node.config.aggregations = [...(node.config.aggregations || []), { field: '', fn: 'sum', alias: '' }];
            m.changed(); m.render(); return true;
        }
        const rmAgg = event.target.closest('[data-flow-remove-agg]');
        if (rmAgg) {
            node.config.aggregations = (node.config.aggregations || []).filter((_, i) => i !== Number(rmAgg.dataset.flowRemoveAgg));
            if (!node.config.aggregations.length) node.config.aggregations = [{ field: '', fn: 'count', alias: '记录条数' }];
            m.changed(); m.render(); return true;
        }
        if (event.target.closest('[data-flow-sync-cols]')) {
            const upCols = inferNodeColumns(getIncomingNodeIds(node.id)[0] || '');
            node.config.columns = upCols.slice(0, 120).map(col => ({ field: col, alias: '', enabled: true }));
            m.changed(); m.render(); return true;
        }
        return false;
    }

    Object.assign(m, {
        OPERATOR_SPECS,
        OPERATOR_MAP,
        BUILTIN_FUNCTIONS,
        ensureFlowGraph,
        getFlowNode,
        getAnyNodeName,
        inferNodeColumns,
        operatorSummary,
        connectFlowEdge,
        addFlowOperator,
        removeFlowNode,
        removeFlowEdge,
        renderOperatorInspector,
        handleOperatorInput,
        handleOperatorClick
    });
})();
