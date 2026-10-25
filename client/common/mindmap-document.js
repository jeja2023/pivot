/* 导图的规范格式与纯数据适配；浏览器和服务端共享同一份校验规则。 */
(function (scope) {
    'use strict';
    const LIMITS = Object.freeze({ nodes: 5000, depth: 12, text: 120, note: 2000, bytes: 4 * 1024 * 1024, relations: 120 });
    const LAYOUTS = Object.freeze({ mindMap: '思维导图', logicalStructure: '向右逻辑图', logicalStructureLeft: '向左逻辑图', organizationStructure: '组织结构图', catalogOrganization: '目录组织图', timeline: '时间轴', fishbone: '鱼骨图' });
    const THEMES = Object.freeze({ indigo: { label: '商务靛蓝', root: '#4338ca', line: '#6366f1', background: '#ffffff', ink: '#111827' }, forest: { label: '森林绿', root: '#065f46', line: '#059669', background: '#ffffff' }, ocean: { label: '海洋蓝', root: '#0369a1', line: '#0284c7', background: '#ffffff' }, sunset: { label: '暖阳橙', root: '#c2410c', line: '#ea580c', background: '#ffffff' }, custom: { label: '自定义主题', root: '#4338ca', line: '#6366f1', background: '#ffffff' } });
    const COLOR_FIELDS = ['color', 'fillColor', 'borderColor', 'lineColor'];
    const STYLE_FIELDS = [...COLOR_FIELDS, 'fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'textAlign', 'textDecoration', 'shape', 'borderWidth', 'borderDasharray', 'lineWidth', 'paddingX', 'paddingY', 'note', 'expanded', 'hyperlink'];
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const validId = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
    function error(message, code = 'MINDMAP_INVALID', status = 422) {
        return Object.assign(new Error(message), { code, status, statusCode: status, expose: true });
    }
    function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
    function bytes(value) { return new globalThis.TextEncoder().encode(value).length; }
    function text(value, max, label, empty = false) {
        if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (!empty && !value.trim())) throw error(`${label}无效或超过 ${max} 字符，请修改后重试。`);
        return value.trim();
    }
    function checkUnsafe(value, seen = new WeakSet(), depth = 0) {
        if (!value || typeof value !== 'object') return;
        if (depth > 2 * LIMITS.depth + 10 || seen.has(value)) throw error('导图包含循环引用或过深的数据结构。');
        seen.add(value);
        for (const key of Object.keys(value)) {
            if (['__proto__', 'prototype', 'constructor', 'dangerouslySetInnerHTML', 'innerHTML'].includes(key) || (key === 'richText' && value[key] === true)) throw error('暂不支持导入富文本或可执行内容，请使用纯文本导图。');
            if (['image', 'imageUrl', 'backgroundImage'].includes(key) && value[key] && value[key] !== 'none') throw error('暂不支持导入图片或背景资源，请移除后重试。');
            checkUnsafe(value[key], seen, depth + 1);
        }
        seen.delete(value);
    }
    function style(input = {}) {
        if (!object(input)) throw error('节点样式格式无效。');
        const output = {};
        for (const field of Object.keys(input).sort()) {
            if (!STYLE_FIELDS.includes(field)) throw error('节点样式包含不支持的字段。');
            const value = input[field];
            if (COLOR_FIELDS.includes(field)) {
                if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw error('颜色必须使用六位十六进制色值。');
                output[field] = value.toLowerCase();
            } else if (field === 'note') { if (value) output.note = text(value, LIMITS.note, '节点备注', true); }
            else if (field === 'expanded') { if (typeof value !== 'boolean') throw error('节点折叠状态无效。'); if (!value) output.expanded = false; }
            else if (field === 'fontSize') { if (!Number.isInteger(value) || value < 10 || value > 36) throw error('节点字号应为 10–36 的整数。'); output.fontSize = value; }
            else if (field === 'borderWidth') { if (!Number.isInteger(value) || value < 0 || value > 4) throw error('节点边框宽度无效。'); output.borderWidth = value; }
            else if (field === 'fontWeight') { if (!['normal', 'bold'].includes(value)) throw error('节点字重无效。'); output.fontWeight = value; }
            else if (field === 'fontStyle') { if (!['normal', 'italic'].includes(value)) throw error('节点文字样式无效。'); output.fontStyle = value; }
            else if (field === 'fontFamily') { if (!['Arial', 'Microsoft YaHei', 'SimSun', 'Noto Sans SC', 'sans-serif', 'serif', 'monospace'].includes(value)) throw error('节点字体不在可用字体列表。'); output.fontFamily = value; }
            else if (field === 'textAlign') { if (!['left', 'center', 'right'].includes(value)) throw error('文字对齐方式无效。'); output.textAlign = value; }
            else if (field === 'textDecoration') { if (!['none', 'underline', 'line-through'].includes(value)) throw error('文字装饰无效。'); output.textDecoration = value; }
            else if (field === 'borderDasharray') { if (!['none', '5,5', '2,2'].includes(value)) throw error('边框线型无效。'); output.borderDasharray = value; }
            else if (['paddingX', 'paddingY', 'lineWidth'].includes(field)) { if (!Number.isInteger(value) || value < 0 || value > (field === 'lineWidth' ? 8 : 60)) throw error('间距或连线宽度超出范围。'); output[field] = value; }
            else if (field === 'shape') { if (!['rectangle', 'roundedRectangle', 'ellipse', 'diamond'].includes(value)) throw error('节点形状无效。'); output.shape = value; }
            else if (field === 'hyperlink' && value) {
                const url = text(value, 2048, '节点链接');
                if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) throw error('节点链接仅支持 HTTP 或 HTTPS 地址。');
                try { if (!['http:', 'https:'].includes(new globalThis.URL(url).protocol)) throw new Error(); } catch (_) { throw error('节点链接地址无效，请检查后重试。'); }
                output.hyperlink = url;
            }
        }
        return output;
    }
    function themePack(input) {
        if (!object(input) || input.version !== 1 || Object.keys(input).some(key => !['version', 'label', 'root', 'line', 'background', 'styles'].includes(key))) throw error('主题包格式无效，只支持受控颜色与节点样式。');
        const result = { version: 1, label: text(input.label, 40, '主题名称') };
        for (const key of ['root', 'line', 'background']) { if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) throw error('主题包颜色必须使用六位十六进制值，不能包含样式或外部资源。'); result[key] = input[key].toLowerCase(); }
        if (input.styles !== undefined) {
            if (!object(input.styles) || Object.keys(input.styles).some(key => !['root', 'second', 'node'].includes(key))) throw error('主题节点样式分组无效。');
            result.styles = {};
            for (const [key, value] of Object.entries(input.styles)) { if (!object(value) || ['note', 'hyperlink', 'expanded'].some(field => own(value, field))) throw error('主题不能包含节点内容或外部资源。'); result.styles[key] = style(value); }
        }
        return result;
    }
    function palette(document) { return document.presentation.themeId === 'custom' && document.presentation.customTheme ? themePack(document.presentation.customTheme) : THEMES[document.presentation.themeId]; }
    function foreground(color) {
        function linearChannel(channel) {
            if (channel <= 0.04045) return channel / 12.92;
            return ((channel + 0.055) / 1.055) ** 2.4;
        }
        function luminance(value) {
            const channels = [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255).map(linearChannel);
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        }
        const light = luminance(color); const dark = luminance(THEMES.indigo.ink);
        return (light + 0.05) / (dark + 0.05) >= 1.05 / (light + 0.05) ? THEMES.indigo.ink : THEMES.indigo.background;
    }
    function normalize(input) {
        if (typeof input === 'string') {
            if (bytes(input) > LIMITS.bytes) throw error('导图超过大小上限，请减少节点或备注。', 'MINDMAP_TOO_LARGE', 413);
            try { input = JSON.parse(input); } catch (_) { throw error('导图 JSON 无效，请检查文件内容。'); }
        }
        if (!object(input)) throw error('请提供有效的导图文档。');
        checkUnsafe(input);
        if (own(input, 'root') && input.root?.data) return fromEngine(input);
        const canonical = own(input, 'schemaVersion');
        if (canonical && input.schemaVersion !== 1) throw error('导图版本不受支持，请先升级应用。');
        const source = canonical ? input.tree : (input.tree || input);
        const ids = new Set(); const treeNodes = new Map();
        const nodes = {};
        let count = 0;
        function visit(node, depth) {
            if (!object(node) || depth > LIMITS.depth || ++count > LIMITS.nodes || !validId(node.id) || ids.has(node.id)) throw error(`导图节点或标识无效，最多 ${LIMITS.nodes} 个节点，根节点深度为 0、最大深度为 ${LIMITS.depth}。`);
            ids.add(node.id);
            if (node.children !== undefined && !Array.isArray(node.children)) throw error('节点的子节点必须为数组。');
            const normalized = { id: node.id, text: text(node.text, LIMITS.text, '节点文本'), children: (node.children || []).map(child => visit(child, depth + 1)) };
            treeNodes.set(node.id, normalized); return normalized;
        }
        const tree = visit(source, 0);
        const presentation = canonical ? input.presentation || {} : {};
        if (!object(presentation)) throw error('导图布局配置无效。');
        const layout = presentation.layout || 'mindMap';
        const themeId = presentation.themeId || 'indigo';
        if (!own(LAYOUTS, layout) || !own(THEMES, themeId)) throw error('请选择受支持的导图布局与主题。');
        if (presentation.nodes !== undefined && !object(presentation.nodes)) throw error('节点样式列表无效。');
        for (const id of Object.keys(presentation.nodes || {}).sort()) {
            if (!ids.has(id)) throw error('节点样式引用了不存在的节点。');
            const checked = style(presentation.nodes[id]);
            if (Object.keys(checked).length) nodes[id] = checked;
        }
        const relations = input.relations || [];
        if (!Array.isArray(relations) || relations.length > LIMITS.relations) throw error('关联线数量或格式无效。');
        const pairs = new Set();
        const checkedRelations = relations.map(relation => {
            if (!object(relation) || !ids.has(relation.from) || !ids.has(relation.to) || relation.from === relation.to) throw error('关联线必须连接两个不同的有效节点。');
            const pair = `${relation.from}:${relation.to}`;
            if (pairs.has(pair)) throw error('不能重复连接相同的节点。');
            pairs.add(pair);
            return { from: relation.from, to: relation.to, text: text(relation.text || '', LIMITS.text, '关联线说明', true) };
        }).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
        if (input.summaries !== undefined && (!Array.isArray(input.summaries) || input.summaries.length > 60)) throw error('概要节点格式或数量无效。');
        const summaryIds = new Set(ids); const ranges = new Set();
        const summaries = (input.summaries || []).map(summary => {
            const parent = treeNodes.get(summary?.parentId);
            if (!object(summary) || !validId(summary.id) || summaryIds.has(summary.id) || !parent || !Number.isInteger(summary.start) || !Number.isInteger(summary.end) || summary.start < 0 || summary.end < summary.start || summary.end >= parent.children.length) throw error('概要节点的标识、父节点或范围无效。');
            const range = `${summary.parentId}:${summary.start}:${summary.end}`; if (ranges.has(range)) throw error('不能为同一范围添加重复概要。'); ranges.add(range); summaryIds.add(summary.id);
            return { id: summary.id, parentId: summary.parentId, start: summary.start, end: summary.end, text: text(summary.text, LIMITS.text, '概要文字') };
        }).sort((a, b) => a.id.localeCompare(b.id));
        const document = { schemaVersion: 1, tree, presentation: { layout, themeId, nodes }, relations: checkedRelations, summaries };
        if (presentation.customTheme !== undefined) document.presentation.customTheme = themePack(presentation.customTheme);
        if (input.source !== undefined) {
            if (!object(input.source)) throw error('导图数据来源无效。');
            document.source = { datasetId: text(input.source.datasetId, 96, '数据集标识'), viewId: text(input.source.viewId, 96, '分析视图标识'), viewVersion: Number(input.source.viewVersion), generatedAt: text(input.source.generatedAt, 64, '生成时间'), description: text(input.source.description, 2000, '统计口径') };
            if (!Number.isSafeInteger(document.source.viewVersion) || document.source.viewVersion < 1 || !Number.isFinite(Date.parse(document.source.generatedAt))) throw error('导图来源版本或时间无效。');
            if (input.source.mapping !== undefined) {
                const mapping = input.source.mapping;
                const aggregations = ['count', 'sum', 'avg', 'min', 'max'];
                if (!object(mapping) || !Array.isArray(mapping.dimensions) || mapping.dimensions.length < 1
                    || mapping.dimensions.length > 5 || new Set(mapping.dimensions).size !== mapping.dimensions.length
                    || !aggregations.includes(mapping.aggregation) || !Number.isInteger(mapping.limit) || mapping.limit < 1
                    || mapping.limit > 500) throw error('数据层级映射无效。');
                document.source.mapping = { dimensions: mapping.dimensions.map(key => text(key, 96, '维度字段')), metric: mapping.metric ? text(mapping.metric, 96, '度量字段') : '', aggregation: mapping.aggregation, limit: mapping.limit };
                if (mapping.aggregation !== 'count' && !document.source.mapping.metric) throw error('请选择度量字段。');
                document.source.datasetRevision = text(input.source.datasetRevision, 96, '数据版本');
                document.source.refreshMode = input.source.refreshMode === 'auto' ? 'auto' : 'manual';
            }
        }
        if (bytes(JSON.stringify(document)) > LIMITS.bytes) throw error('导图超过大小上限，请减少节点或备注。', 'MINDMAP_TOO_LARGE', 413);
        return document;
    }
    function fromEngine(native, base = null) {
        checkUnsafe(native);
        const nodes = {};
        const relations = []; const summaries = []; const ids = new Set();
        function visit(node, depth = 0) {
            if (depth > LIMITS.depth || !object(node?.data)) throw error('导图层级或节点数据无效。');
            const data = node.data;
            if (!validId(data.uid)) throw error('导图节点标识无效。');
            ids.add(data.uid);
            for (const summary of (Array.isArray(data.generalization) ? data.generalization : data.generalization ? [data.generalization] : [])) {
                const range = summary.range || [0, (node.children || []).length - 1];
                if ((node.children || []).length && range[1] < node.children.length) summaries.push({ id: summary.uid, parentId: data.uid, start: range[0], end: range[1], text: summary.text });
            }
            if (data.icon?.length || data.tag?.length || data.image?.url || data.attachment) throw error('当前版本不支持导入图标、标签或附件，请先导出纯文本兼容版本。');
            const nodeStyle = {};
            for (const field of STYLE_FIELDS.filter(name => !['expanded', 'hyperlink'].includes(name))) if (data[field] !== undefined && data[field] !== '') nodeStyle[field] = data[field];
            if (data.expand === false) nodeStyle.expanded = false;
            if (data.hyperlink) nodeStyle.hyperlink = data.hyperlink;
            nodes[data.uid] = nodeStyle;
            for (const to of data.associativeLineTargets || []) relations.push({ from: data.uid, to, text: data.associativeLineText?.[to] || '' });
            return { id: data.uid, text: data.text, children: (node.children || []).map(child => visit(child, depth + 1)) };
        }
        const tree = visit(native.root || native);
        return normalize({ schemaVersion: 1, tree, presentation: { layout: native.layout || base?.presentation?.layout || 'mindMap', themeId: native.pivotThemeId || base?.presentation?.themeId || 'indigo', nodes, ...(base?.presentation?.customTheme ? { customTheme: base.presentation.customTheme } : {}) }, relations: relations.filter(line => ids.has(line.from) && ids.has(line.to)), summaries, ...(base?.source ? { source: base.source } : {}) });
    }
    function toEngine(input) {
        const document = normalize(input);
        function visit(node) {
            const nodeStyle = document.presentation.nodes[node.id] || {};
            const data = { uid: node.id, text: node.text, expand: nodeStyle.expanded !== false, richText: false };
            for (const key of STYLE_FIELDS.filter(name => name !== 'expanded')) if (nodeStyle[key] !== undefined) data[key] = nodeStyle[key];
            const relations = document.relations.filter(relation => relation.from === node.id);
            if (relations.length) { data.associativeLineTargets = relations.map(relation => relation.to); data.associativeLineText = Object.fromEntries(relations.map(relation => [relation.to, relation.text])); }
            const summaries = document.summaries.filter(summary => summary.parentId === node.id);
            if (summaries.length) data.generalization = summaries.map(summary => ({ uid: summary.id, text: summary.text, range: [summary.start, summary.end], richText: false }));
            return { data, children: node.children.map(visit) };
        }
        return { root: visit(document.tree), layout: document.presentation.layout, pivotThemeId: document.presentation.themeId };
    }
    function mergeLegacy(input, previous) {
        const tree = normalize(input).tree;
        const base = normalize(previous);
        const ids = new Set(); const nodes = new Map();
        (function visit(node) { ids.add(node.id); nodes.set(node.id, node); node.children.forEach(visit); })(tree);
        return normalize({ ...base, tree, presentation: { ...base.presentation, nodes: Object.fromEntries(Object.entries(base.presentation.nodes).filter(([id]) => ids.has(id))) }, relations: base.relations.filter(line => ids.has(line.from) && ids.has(line.to)), summaries: base.summaries.filter(summary => nodes.get(summary.parentId)?.children.length > summary.end) });
    }
    function markdown(input) {
        const document = normalize(input);
        const lines = [`# ${document.tree.text.replace(/[\r\n]/g, ' ')}`, ''];
        function visit(node, depth) { lines.push(`${'  '.repeat(depth)}- ${node.text.replace(/[\r\n]/g, ' ')}`); node.children.forEach(child => visit(child, depth + 1)); }
        document.tree.children.forEach(node => visit(node, 0));
        return lines.join('\n') + '\n';
    }
    function parseMarkdown(value) {
        text(value, 30000, '导入文本');
        const lines = value.split(/\r?\n/).filter(line => line.trim());
        let sequence = 0;
        let root = null;
        const stack = [];
        for (const line of lines) {
            const heading = /^(#{1,6})\s+(.+)$/.exec(line);
            const list = /^( *)(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
            if (!heading && !list) throw error('Markdown 仅支持标题和缩进列表，请移除正文或代码块后重试。');
            let depth = heading ? heading[1].length - 1 : 1 + Math.floor(list[1].length / 2);
            const label = heading ? heading[2] : list[2];
            if (!root) { root = { id: 'root', text: label, children: [] }; stack[0] = root; continue; }
            if (depth === 0) throw error('导入文本只能包含一个一级标题。');
            if (!stack[depth - 1]) throw error('Markdown 层级不能跳级，请检查缩进。');
            const node = { id: `node-${++sequence}`, text: label, children: [] };
            stack[depth - 1].children.push(node); stack[depth] = node; stack.length = depth + 1;
        }
        return normalize(root);
    }
    function count(input) { let result = 0; (function visit(node) { result++; node.children.forEach(visit); })(normalize(input).tree); return result; }
    const api = { LIMITS, LAYOUTS, THEMES, STYLE_FIELDS, error, normalize, fromEngine, toEngine, mergeLegacy, markdown, parseMarkdown, count, themePack, palette, foreground };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.Pivot.exposeModule('mindmaps.document', api);
})(globalThis);
