(function (factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        window.Pivot.presentationGraphics = api;
        window.Pivot.exposeModule?.('apps.presentations.graphics', api);
    }
})(function () {
    'use strict';

    // 编辑器、演讲者视图及服务端导出共用的纯场景计算。
    const VERSION = '2.0.0';
    const PALETTE = ['#1769AA', '#5B8FF9', '#2E8B57', '#D89827', '#7A5AF8', '#C84A4A'];
    const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const color = (value, fallback = '#1769AA') => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
    const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const rounded = value => Math.round(n(value) * 1000) / 1000;
    const formatNumber = value => Math.abs(value) >= 1e6 ? `${rounded(value / 1e6)}M` : Math.abs(value) >= 1e4 ? `${rounded(value / 1e3)}k` : String(rounded(value));
    const text = (x, y, value, size, fill = '#475467', anchor = 'middle') => `<text x="${rounded(x)}" y="${rounded(y)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${size}" text-anchor="${anchor}" fill="${color(fill, '#475467')}">${xml(value)}</text>`;

    function chartScene(element, width = element.width, height = element.height) {
        width = Math.max(1, n(width, 640)); height = Math.max(1, n(height, 360));
        const rows = element.data?.rows || [], columns = element.data?.columns || [];
        const palette = element.options?.colors?.length ? element.options.colors.map(value => color(value)) : PALETTE;
        const size = Math.max(10, Math.min(32, n(element.options?.labelFontSize, 14)));
        const legend = element.options?.showLegend === true && columns.length > 2;
        const pad = { left: Math.min(70, Math.max(42, width * 0.1)), right: 18, top: (element.title ? size + 14 : 8) + (element.options?.showLabels ? size + 4 : 0), bottom: size * (legend ? 4 : 2) + 12 };
        const plot = { x: pad.left, y: pad.top, width: Math.max(1, width - pad.left - pad.right), height: Math.max(1, height - pad.top - pad.bottom) };
        const series = columns.slice(1).map((name, index) => ({ name: String(name), index, color: palette[index % palette.length], values: rows.map(row => n(row[index + 1])) }));
        const values = series.flatMap(item => item.values);
        let min = Math.min(0, ...values), max = Math.max(0, ...values);
        if (min === max) max = min + 1;
        const range = max - min;
        const y = value => plot.y + (max - value) / range * plot.height;
        const zero = y(0);
        const marks = [];
        series.forEach(item => item.values.forEach((value, row) => {
            const group = plot.width / Math.max(1, rows.length);
            const barWidth = group * 0.72 / Math.max(1, series.length);
            const x = element.chartType === 'bar' ? plot.x + group * row + group * 0.14 + item.index * barWidth
                : plot.x + (rows.length <= 1 ? plot.width / 2 : row * plot.width / (rows.length - 1));
            marks.push({ series: item.index, row, value, x, y: y(value), width: barWidth, height: Math.abs(zero - y(value)), zero, color: item.color });
        }));
        return { width, height, rows, series, plot, min, max, zero, size, legend, marks, palette };
    }

    function chartSvg(element, width, height) {
        const scene = chartScene(element, width, height);
        const { rows, series, plot, zero, size, palette } = scene;
        const pieces = [`<rect width="${scene.width}" height="${scene.height}" fill="#FFFFFF"/>`];
        if (element.title) pieces.push(text(plot.x, size + 3, element.title, size, '#1F2937', 'start'));
        if (['pie', 'doughnut'].includes(element.chartType)) {
            const values = series[0]?.values || [], total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
            const cx = plot.x + plot.width / 2, cy = plot.y + plot.height / 2, radius = Math.min(plot.width, plot.height) * 0.39;
            let start = -Math.PI / 2;
            values.forEach((value, index) => {
                const fraction = total > 0 ? Math.max(0, value) / total : 0, angle = fraction * Math.PI * 2, end = start + angle;
                const fill = color(palette[index % palette.length]);
                if (fraction >= 1 - 1e-10) pieces.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}"/>`);
                else if (fraction > 0) pieces.push(`<path d="M ${cx} ${cy} L ${cx + radius * Math.cos(start)} ${cy + radius * Math.sin(start)} A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} 1 ${cx + radius * Math.cos(end)} ${cy + radius * Math.sin(end)} Z" fill="${fill}"/>`);
                const middle = start + angle / 2;
                if (fraction > 0) pieces.push(text(cx + radius * 1.15 * Math.cos(middle), cy + radius * 1.15 * Math.sin(middle), `${rows[index][0]}${element.options?.showLabels ? ` ${formatNumber(value)}` : ''}`, size));
                start = end;
            });
            if (element.chartType === 'doughnut') pieces.push(`<circle cx="${cx}" cy="${cy}" r="${radius * 0.55}" fill="#FFFFFF"/>`);
        } else {
            for (let i = 0; i <= 4; i++) {
                const value = scene.min + (scene.max - scene.min) * i / 4, y = plot.y + plot.height - i * plot.height / 4;
                pieces.push(`<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="#E4E7EC"/>`, text(plot.x - 8, y + size * 0.35, formatNumber(value), size, '#667085', 'end'));
            }
            pieces.push(`<line x1="${plot.x}" y1="${zero}" x2="${plot.x + plot.width}" y2="${zero}" stroke="#98A2B3"/>`);
            series.forEach(item => {
                const marks = scene.marks.filter(mark => mark.series === item.index);
                if (element.chartType === 'bar') marks.forEach(mark => pieces.push(`<rect data-series="${mark.series}" data-row="${mark.row}" x="${rounded(mark.x)}" y="${rounded(Math.min(mark.zero, mark.y))}" width="${rounded(mark.width * 0.9)}" height="${rounded(mark.height)}" fill="${color(mark.color)}"/>`));
                else if (marks.length) {
                    const points = marks.map(mark => `${rounded(mark.x)},${rounded(mark.y)}`).join(' ');
                    if (element.chartType === 'area') pieces.push(`<polygon points="${marks[0].x},${zero} ${points} ${marks.at(-1).x},${zero}" fill="${color(item.color)}" fill-opacity="0.18"/>`);
                    pieces.push(`<polyline data-series="${item.index}" points="${points}" fill="none" stroke="${color(item.color)}" stroke-width="2.5"/>`);
                    marks.forEach(mark => pieces.push(`<circle data-series="${mark.series}" data-row="${mark.row}" cx="${rounded(mark.x)}" cy="${rounded(mark.y)}" r="3.5" fill="${color(mark.color)}"/>`));
                }
                if (element.options?.showLabels) marks.forEach(mark => pieces.push(text(mark.x + (element.chartType === 'bar' ? mark.width * 0.45 : 0), mark.y + (mark.value < 0 ? size + 3 : -6), formatNumber(mark.value), size)));
            });
            rows.forEach((row, index) => {
                const x = element.chartType === 'bar' ? plot.x + (index + 0.5) * plot.width / Math.max(1, rows.length) : plot.x + (rows.length <= 1 ? plot.width / 2 : index * plot.width / (rows.length - 1));
                pieces.push(text(x, plot.y + plot.height + size + 7, row[0], size));
            });
            if (scene.legend) series.forEach((item, index) => {
                const x = plot.x + index * plot.width / Math.max(1, series.length), y = scene.height - size;
                pieces.push(`<rect x="${x}" y="${y - size * 0.7}" width="${size * 0.7}" height="${size * 0.7}" fill="${color(item.color)}"/>`, text(x + size, y, item.name, size, '#475467', 'start'));
            });
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img">${pieces.join('')}</svg>`;
    }

    function diagramScene(element) {
        const width = Math.max(1, n(element.width, 800)), height = Math.max(1, n(element.height, 300));
        const source = element.graph?.nodes?.length ? element.graph.nodes : (element.items || []).map((label, index) => ({ id: `node_${index + 1}`, label }));
        const count = source.length, kind = element.diagramType || 'process';
        const generated = [];
        if (!element.graph?.edges) {
            if (kind === 'hierarchy' || kind === 'relationship') source.slice(1).forEach(node => generated.push({ from: source[0].id, to: node.id }));
            else source.slice(1).forEach((node, index) => generated.push({ from: source[index].id, to: node.id }));
            if (kind === 'cycle' && count > 1) generated.push({ from: source[count - 1].id, to: source[0].id });
        }
        const edges = (element.graph?.edges || generated).map((edge, index) => ({ ...edge, id: edge.id || `edge_${index + 1}` }));
        const inset = 12, size = Math.max(10, n(element.style?.fontSize, 16));
        let nodeWidth, nodeHeight;
        const nodes = source.map(node => ({ ...node, label: String(node.label ?? ''), x: 0, y: 0, width: 0, height: 0 }));
        if (kind === 'cycle' || kind === 'relationship') {
            nodeWidth = Math.min(width * 0.28, Math.max(64, width / Math.max(3, Math.ceil(count / 2) + 1)));
            nodeHeight = Math.min(height * 0.24, Math.max(30, size * 2.8));
            const rx = Math.max(0, (width - nodeWidth) / 2 - inset), ry = Math.max(0, (height - nodeHeight) / 2 - inset);
            nodes.forEach((node, index) => {
                const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, count);
                node.x = width / 2 + rx * Math.cos(angle) - nodeWidth / 2; node.y = height / 2 + ry * Math.sin(angle) - nodeHeight / 2;
            });
        } else if (kind === 'hierarchy') {
            const incoming = new Map(nodes.map(node => [node.id, 0])), depth = new Map(nodes.map(node => [node.id, 0]));
            const children = new Map(nodes.map(node => [node.id, []]));
            edges.forEach(edge => { if (incoming.has(edge.to) && children.has(edge.from)) { incoming.set(edge.to, incoming.get(edge.to) + 1); children.get(edge.from).push(edge.to); } });
            const queue = nodes.filter(node => !incoming.get(node.id)).map(node => node.id);
            let visited = 0;
            while (queue.length) {
                const id = queue.shift(); visited++;
                children.get(id).forEach(next => { depth.set(next, Math.max(depth.get(next), depth.get(id) + 1)); incoming.set(next, incoming.get(next) - 1); if (!incoming.get(next)) queue.push(next); });
            }
            if (visited !== nodes.length) throw new Error('层级图包含循环，请改用关系图或修正连接。');
            const levels = Math.max(0, ...depth.values()) + 1;
            const widest = Math.max(1, ...Array.from({ length: levels }, (_, level) => nodes.filter(node => depth.get(node.id) === level).length));
            nodeWidth = Math.min(240, Math.max(1, (width - inset * 2) / widest - 16));
            nodeHeight = Math.min(size * 3, Math.max(1, (height - inset * 2) / levels - 16));
            for (let level = 0; level < levels; level++) {
                const row = nodes.filter(node => depth.get(node.id) === level);
                row.forEach((node, index) => { node.x = (index + 0.5) * width / row.length - nodeWidth / 2; node.y = inset + level * (height - inset * 2 - nodeHeight) / Math.max(1, levels - 1); });
            }
        } else {
            const columns = Math.max(1, Math.min(count, Math.floor(width / Math.max(130, size * 6))));
            const rows = Math.ceil(count / columns);
            nodeWidth = Math.max(1, (width - inset * 2 - 24 * (columns - 1)) / columns);
            nodeHeight = Math.min(size * 3.5, Math.max(1, (height - inset * 2 - 26 * (rows - 1)) / Math.max(1, rows)));
            nodes.forEach((node, index) => {
                const row = Math.floor(index / columns), col = row % 2 ? columns - 1 - index % columns : index % columns;
                node.x = inset + col * (nodeWidth + 24); node.y = rows === 1 ? (height - nodeHeight) / 2 : inset + row * (height - inset * 2 - nodeHeight) / Math.max(1, rows - 1);
            });
        }
        nodes.forEach(node => { node.width = nodeWidth; node.height = nodeHeight; });
        const byId = new Map(nodes.map(node => [node.id, node]));
        const boundary = (from, to) => {
            const dx = to.x + to.width / 2 - from.x - from.width / 2, dy = to.y + to.height / 2 - from.y - from.height / 2;
            const scale = 1 / Math.max(Math.abs(dx) / Math.max(0.001, from.width / 2), Math.abs(dy) / Math.max(0.001, from.height / 2), 0.001);
            return { x: from.x + from.width / 2 + dx * scale, y: from.y + from.height / 2 + dy * scale };
        };
        return { width, height, nodes, edges: edges.flatMap(edge => {
            const from = byId.get(edge.from), to = byId.get(edge.to);
            return from && to ? [{ ...edge, start: boundary(from, to), end: boundary(to, from) }] : [];
        }) };
    }

    function diagramSvg(element) {
        const scene = diagramScene(element), style = element.style || {}, stroke = color(style.stroke), fill = color(style.fill, '#EFF6FF'), font = color(style.textColor, '#1E3A8A'), size = Math.max(10, n(style.fontSize, 16));
        const marker = 'arrow_' + String(element.id || 'diagram').replace(/[^A-Za-z0-9_-]/g, '_');
        const pieces = [`<defs><marker id="${marker}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L0,7 L7,3.5 z" fill="${stroke}"/></marker></defs>`];
        scene.edges.forEach(edge => {
            pieces.push(`<line data-edge="${xml(edge.id)}" x1="${rounded(edge.start.x)}" y1="${rounded(edge.start.y)}" x2="${rounded(edge.end.x)}" y2="${rounded(edge.end.y)}" stroke="${stroke}" stroke-width="1.5"${edge.directed === false ? '' : ` marker-end="url(#${marker})"`}/>`);
            if (edge.label) pieces.push(text((edge.start.x + edge.end.x) / 2, (edge.start.y + edge.end.y) / 2 - 5, edge.label, size * 0.8, font));
        });
        scene.nodes.forEach(node => {
            pieces.push(`<rect data-node="${xml(node.id)}" x="${rounded(node.x)}" y="${rounded(node.y)}" width="${rounded(node.width)}" height="${rounded(node.height)}" rx="8" fill="${fill}" stroke="${stroke}"/>`);
            const chars = Math.max(1, Math.floor((node.width - 12) / size)), lines = [];
            String(node.label).split('\n').forEach(paragraph => {
                let current = '', units = 0;
                for (const char of paragraph) {
                    const advance = /[\u0000-\u00ff]/.test(char) ? 0.55 : 1;
                    if (units + advance > chars && current) { lines.push(current); current = ''; units = 0; }
                    current += char; units += advance;
                }
                lines.push(current);
            });
            const top = node.y + node.height / 2 - (lines.length - 1) * size * 0.65 + size * 0.35;
            lines.forEach((line, index) => pieces.push(text(node.x + node.width / 2, top + index * size * 1.3, line, size, font)));
        });
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img">${pieces.join('')}</svg>`;
    }

    function mountSvg(node, svg, label = '') {
        const image = node.ownerDocument.createElement('img');
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        image.alt = label; image.draggable = false;
        Object.assign(image.style, { width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none', display: 'block' });
        node.replaceChildren(image);
    }

    return Object.freeze({ VERSION, PALETTE: Object.freeze(PALETTE), chartScene, chartSvg, diagramScene, diagramSvg, mountSvg });
});
