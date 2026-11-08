(function (factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        window.Pivot.presentationGeometry = api;
        window.Pivot.exposeModule?.('apps.presentations.geometry', api);
    }
})(function () {
    'use strict';
    // DrawingML 公式与圆弧语义；数据来源和许可见 vendor/presentation/NOTICE.md。
    const CIRCLE = 21600000, RAD = Math.PI / 10800000;
    let presets = null, loading = null;
    const finite = value => { if (!Number.isFinite(value)) throw new Error('形状几何产生了非有限数值。'); return value; };
    const fmt = value => String(Math.round(finite(value) * 10000) / 10000);
    const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeColor = (value, fallback = '#FFFFFF') => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const LABELS = {
        rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆', line: '直线', lineInv: '反向直线', triangle: '三角形', rtTriangle: '直角三角形',
        diamond: '菱形', parallelogram: '平行四边形', trapezoid: '梯形', nonIsoscelesTrapezoid: '不等腰梯形', pentagon: '五边形', hexagon: '六边形', heptagon: '七边形', octagon: '八边形', decagon: '十边形', dodecagon: '十二边形',
        arc: '圆弧', blockArc: '空心弧', chord: '弦形', pie: '饼形', pieWedge: '扇形', donut: '圆环', plus: '十字形', teardrop: '水滴', heart: '心形', moon: '月亮', sun: '太阳', cloud: '云朵',
        can: '圆柱', cube: '立方体', bevel: '棱台', frame: '相框', halfFrame: '半框', corner: '直角', foldedCorner: '折角', plaque: '铭牌', plaqueTabs: '铭牌边框', squareTabs: '方形边框', cornerTabs: '角部边框',
        bracePair: '大括号对', bracketPair: '中括号对', leftBrace: '左大括号', rightBrace: '右大括号', leftBracket: '左中括号', rightBracket: '右中括号',
        funnel: '漏斗', lightningBolt: '闪电', noSmoking: '禁止符号', smileyFace: '笑脸', diagStripe: '斜纹带', wave: '波浪', doubleWave: '双波浪', horizontalScroll: '横向卷轴', verticalScroll: '纵向卷轴',
        ribbon: '向下绶带', ribbon2: '向上绶带', ellipseRibbon: '下弯绶带', ellipseRibbon2: '上弯绶带', leftRightRibbon: '双向绶带', irregularSeal1: '不规则爆炸形一', irregularSeal2: '不规则爆炸形二',
        round1Rect: '单圆角矩形', round2DiagRect: '对角圆角矩形', round2SameRect: '同侧圆角矩形', snip1Rect: '单切角矩形', snip2DiagRect: '对角切角矩形', snip2SameRect: '同侧切角矩形', snipRoundRect: '切角圆角矩形',
        rightArrow: '向右箭头', leftArrow: '向左箭头', upArrow: '向上箭头', downArrow: '向下箭头', leftRightArrow: '左右箭头', upDownArrow: '上下箭头', quadArrow: '四向箭头', leftRightUpArrow: '左右上箭头', leftUpArrow: '左上箭头',
        bentArrow: '肘形箭头', bentUpArrow: '上折箭头', uturnArrow: '回转箭头', circularArrow: '环形箭头', leftCircularArrow: '左环形箭头', leftRightCircularArrow: '双向环形箭头', swooshArrow: '弧尾箭头',
        curvedDownArrow: '下弯箭头', curvedLeftArrow: '左弯箭头', curvedRightArrow: '右弯箭头', curvedUpArrow: '上弯箭头', notchedRightArrow: '燕尾箭头', stripedRightArrow: '条纹箭头', chevron: 'V形箭头', homePlate: '五角箭头',
        cloudCallout: '云形标注', wedgeEllipseCallout: '椭圆标注', wedgeRectCallout: '矩形标注', wedgeRoundRectCallout: '圆角矩形标注',
        chartPlus: '图表加号', chartStar: '图表星号', chartX: '图表叉号', mathDivide: '除号', mathEqual: '等号', mathMinus: '减号', mathMultiply: '乘号', mathNotEqual: '不等号', mathPlus: '加号', straightConnector1: '直线连接线'
    };
    const FLOW = { AlternateProcess: '可选流程', Collate: '整理', Connector: '连接点', Decision: '判断', Delay: '延迟', Display: '显示', Document: '文档', Extract: '提取', InputOutput: '输入输出', InternalStorage: '内部存储',
        MagneticDisk: '磁盘', MagneticDrum: '磁鼓', MagneticTape: '磁带', ManualInput: '人工输入', ManualOperation: '人工操作', Merge: '合并', Multidocument: '多文档', OfflineStorage: '离线存储', OffpageConnector: '跨页连接', OnlineStorage: '在线存储', Or: '或', PredefinedProcess: '子流程', Preparation: '准备', Process: '流程', PunchedCard: '穿孔卡', PunchedTape: '穿孔带', Sort: '排序', SummingJunction: '汇合', Terminator: '起止' };
    const ACTION = { BackPrevious: '上一页', Beginning: '起始页', Blank: '空白', Document: '文档', End: '结束页', ForwardNext: '下一页', Help: '帮助', Home: '主页', Information: '信息', Movie: '影片', Return: '返回', Sound: '声音' };
    function label(type) {
        if (LABELS[type]) return LABELS[type];
        if (type.startsWith('flowChart')) return '流程图 · ' + FLOW[type.slice(9)];
        if (type.startsWith('actionButton')) return '动作按钮 · ' + ACTION[type.slice(12)];
        if (/^star\d+$/.test(type)) return type.slice(4) + '角星';
        if (/^gear\d+$/.test(type)) return type.slice(4) + '齿齿轮';
        if (/^bentConnector\d+$/.test(type)) return type.slice(13) + '段折线连接';
        if (/^curvedConnector\d+$/.test(type)) return type.slice(15) + '段曲线连接';
        if (/ArrowCallout$/.test(type)) return label(type.replace('Callout', '')) + '标注';
        const callout = /^(accentBorderCallout|accentCallout|borderCallout|callout)([1-3])$/.exec(type);
        if (callout) return ({ accentBorderCallout: '带边框强调标注', accentCallout: '强调标注', borderCallout: '带边框标注', callout: '折线标注' })[callout[1]] + callout[2];
        return type;
    }
    function category(type) {
        if (type.startsWith('flowChart')) return '流程图';
        if (type.startsWith('actionButton')) return '动作按钮';
        if (/Connector/.test(type) || ['line', 'lineInv'].includes(type)) return '连接线';
        if (/Callout|callout/.test(type)) return '标注';
        if (/Arrow|arrow|chevron|homePlate/.test(type)) return '箭头';
        if (/star|Seal|sun/.test(type)) return '星形与徽章';
        return '基础与装饰';
    }

    function loadCatalog(data) {
        if (data?.schemaVersion !== 1 || !data.presets || Object.keys(data.presets).length !== 187) throw new Error('形状目录无效，请重新加载应用。');
        presets = data.presets;
        return Object.keys(presets);
    }
    async function loadDefaultCatalog() {
        if (presets) return;
        if (!loading) loading = fetch('/vendor/presentation/preset-shapes.json').then(response => {
            if (!response.ok) throw new Error('无法加载原生形状目录。');
            return response.json();
        }).then(loadCatalog).catch(error => { loading = null; throw error; });
        await loading;
    }
    function variables(width, height) {
        return { l: 0, t: 0, r: width, b: height, w: width, h: height, hc: width / 2, vc: height / 2, ss: Math.min(width, height), ls: Math.max(width, height) };
    }
    function resolve(token, values) {
        if (Object.prototype.hasOwnProperty.call(values, token)) return values[token];
        if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return finite(Number(token));
        const dimension = /^(wd|hd|ssd)([1-9]\d*)$/.exec(token);
        if (dimension) return values[dimension[1] === 'wd' ? 'w' : dimension[1] === 'hd' ? 'h' : 'ss'] / Number(dimension[2]);
        const angle = /^(\d*)cd([1-9]\d*)$/.exec(token);
        if (angle) return CIRCLE * Number(angle[1] || 1) / Number(angle[2]);
        throw new Error(`形状引用了未知几何参数：${token}`);
    }
    function formula(expression, values) {
        const [operator, ...tokens] = expression.trim().split(/\s+/), args = tokens.map(token => resolve(token, values));
        const [a, b, c] = args;
        const arity = { val: 1, '*/': 3, '+-': 3, '+/': 3, '?:': 3, abs: 1, at2: 2, cat2: 3, cos: 2, max: 2, min: 2, mod: 3, pin: 3, sat2: 3, sin: 2, sqrt: 1, tan: 2 };
        if (!(operator in arity) || (args.length !== arity[operator] && !(operator === '+-' && args.length === 4 && args[3] === 0))) throw new Error('形状几何公式或参数数量不受支持。');
        const divide = (x, y) => y === 0 ? 0 : x / y;
        const operations = {
            val: () => a, '*/': () => divide(a * b, c), '+-': () => a + b - c, '+/': () => divide(a + b, c), '?:': () => a > 0 ? b : c,
            abs: () => Math.abs(a), at2: () => Math.atan2(b, a) / RAD, cat2: () => a * Math.cos(Math.atan2(c, b)), cos: () => a * Math.cos(b * RAD),
            max: () => Math.max(a, b), min: () => Math.min(a, b), mod: () => Math.hypot(a, b, c), pin: () => Math.min(Math.max(b, a), c),
            sat2: () => a * Math.sin(Math.atan2(c, b)), sin: () => a * Math.sin(b * RAD), sqrt: () => Math.sqrt(Math.max(0, a)), tan: () => a * Math.tan(b * RAD)
        };
        return finite(operations[operator]());
    }
    function evaluatePaths(definition, values, width, height) {
        return definition.paths.map(path => {
            const sx = path.w ? width / Number(path.w) : 1, sy = path.h ? height / Number(path.h) : 1;
            const point = (x, y) => [resolve(x, values) * sx, resolve(y, values) * sy];
            let current = [0, 0], start = [0, 0];
            const parts = [];
            for (const [name, ...args] of path.commands) {
                if (name === 'moveTo' || name === 'lnTo') {
                    current = point(args[0], args[1]);
                    if (name === 'moveTo') start = current;
                    parts.push(`${name === 'moveTo' ? 'M' : 'L'} ${current.map(fmt).join(' ')}`);
                } else if (name === 'quadBezTo' || name === 'cubicBezTo') {
                    const points = [];
                    for (let index = 0; index < args.length; index += 2) points.push(point(args[index], args[index + 1]));
                    current = points.at(-1);
                    parts.push(`${name === 'quadBezTo' ? 'Q' : 'C'} ${points.flat().map(fmt).join(' ')}`);
                } else if (name === 'arcTo') {
                    const [rx, ry, angle, sweep] = args.map(token => resolve(token, values));
                    if (Math.abs(sweep) > CIRCLE * 2) throw new Error('形状圆弧超出支持范围。');
                    if (!rx || !ry || !sweep) continue;
                    const radiusX = Math.abs(rx), radiusY = Math.abs(ry), scaledX = radiusX * sx, scaledY = radiusY * sy;
                    const parameter = value => Math.atan2(radiusX * Math.sin(value * RAD), radiusY * Math.cos(value * RAD));
                    const startAngle = parameter(angle), center = [current[0] - scaledX * Math.cos(startAngle), current[1] - scaledY * Math.sin(startAngle)];
                    let remaining = sweep, active = angle;
                    while (Math.abs(remaining) > 1e-7) {
                        const step = Math.sign(remaining) * Math.min(Math.abs(remaining), CIRCLE / 2); active += step;
                        const end = parameter(active); current = [center[0] + scaledX * Math.cos(end), center[1] + scaledY * Math.sin(end)];
                        parts.push(`A ${fmt(scaledX)} ${fmt(scaledY)} 0 0 ${step >= 0 ? 1 : 0} ${current.map(fmt).join(' ')}`);
                        remaining -= step;
                    }
                } else if (name === 'close') { parts.push('Z'); current = start; }
                else throw new Error(`形状路径命令不受支持：${name}`);
            }
            return { d: parts.join(' '), fill: path.fill || 'norm', stroke: path.stroke !== 'false' && path.stroke !== '0' };
        });
    }
    function shapeScene(type, width, height, overrides = {}) {
        if (!presets?.[type]) throw new Error(`原生形状不可用：${type}`);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('形状尺寸必须是正数。');
        const definition = presets[type], values = variables(width, height), adjustments = {};
        const allowed = new Set(definition.adjustments.map(item => item[0]));
        for (const [key, value] of Object.entries(overrides)) if (!allowed.has(key) || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2147483647) throw new Error(`形状调整参数无效：${key}`);
        for (const [name, expression] of definition.adjustments) values[name] = adjustments[name] = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : formula(expression, values);
        for (const [name, expression] of definition.guides) values[name] = formula(expression, values);
        const handles = definition.handles.map(handle => ({ ...handle, x: resolve(handle.position[0], values), y: resolve(handle.position[1], values) }));
        const controls = new Map();
        for (const handle of handles) for (const [reference, minKey, maxKey, label, scale] of [['gdRefX', 'minX', 'maxX', '水平调整', 1000], ['gdRefY', 'minY', 'maxY', '垂直调整', 1000], ['gdRefR', 'minR', 'maxR', '半径调整', 1000], ['gdRefAng', 'minAng', 'maxAng', '角度调整', 60000]]) {
            if (handle[reference] && !controls.has(handle[reference])) controls.set(handle[reference], { name: handle[reference], label, scale, value: adjustments[handle[reference]],
                min: handle[minKey] ? resolve(handle[minKey], values) : -2147483647, max: handle[maxKey] ? resolve(handle[maxKey], values) : 2147483647 });
        }
        const textRect = Object.fromEntries(Object.entries(definition.textRect).map(([key, token]) => [key, resolve(token, values)]));
        return { type, width, height, adjustments, handles, controls: [...controls.values()], textRect, paths: evaluatePaths(definition, values, width, height),
            connections: definition.connections.map(item => ({ angle: resolve(item.angle, values), x: resolve(item.position[0], values), y: resolve(item.position[1], values) })) };
    }
    function effectiveAdjustments(element) {
        const values = { ...(element.adjustments || {}) };
        if (element.shapeType === 'roundRect' && values.adj === undefined && element.style?.radius !== undefined) values.adj = Math.min(50000, Math.max(0, element.style.radius / Math.min(element.width, element.height) * 100000));
        return values;
    }
    function shade(fill, modifier) {
        const factor = modifier === 'darken' ? 0.5 : modifier === 'darkenLess' ? 0.8 : 1;
        const lighten = modifier === 'lighten' ? 0.5 : modifier === 'lightenLess' ? 0.2 : 0;
        const channels = [1, 3, 5].map(index => parseInt(fill.slice(index, index + 2), 16));
        return '#' + channels.map(value => Math.round(value * factor + (255 - value) * lighten).toString(16).padStart(2, '0')).join('');
    }
    function shapeSvg(element) {
        const scene = shapeScene(element.shapeType, element.width, element.height, effectiveAdjustments(element)), style = element.style || {};
        const fill = safeColor(style.fill), stroke = safeColor(style.stroke, '#CBD5E1'), opacity = Math.max(0, Math.min(1, Number(style.opacity ?? 1))), strokeWidth = Math.max(0, Math.min(20, Number(style.strokeWidth ?? 1)));
        const paths = scene.paths.map(path => `<path d="${xml(path.d)}" fill="${path.fill === 'none' ? 'none' : shade(fill, path.fill)}" fill-opacity="${opacity}" stroke="${path.stroke && strokeWidth ? stroke : 'none'}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`).join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${element.width}" height="${element.height}" viewBox="0 0 ${element.width} ${element.height}" role="img">${paths}</svg>`;
    }
    return Object.freeze({ loadCatalog, loadDefaultCatalog, list: () => presets ? Object.keys(presets) : [], definition: type => presets?.[type], label, category, shapeScene, shapeSvg, effectiveAdjustments, shade });
});
