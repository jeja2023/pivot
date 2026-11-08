(function () {
    'use strict';
    function render(container, object, { node, field }) {
        container.replaceChildren();
        if (!object) { container.appendChild(node('p', 'presentation-empty-note', '点击预览中的对象或从对象列表选择。')); return null; }
        container.appendChild(node('h4', '', object.name));
        if (object.notice) container.appendChild(node('p', 'presentation-empty-note', object.notice));
        if (object.parentId) container.appendChild(node('p', 'presentation-empty-note', '此对象位于组合内，位置与尺寸使用组合内部坐标。'));
        const readers = [];
        const section = title => { const details = node('details', 'presentation-native-section'); details.open = true; details.appendChild(node('summary', '', title)); container.appendChild(details); return details; };
        if (object.frame) {
            const box = section('位置与尺寸'), inputs = {};
            const grid = node('div', 'presentation-native-fields'); box.appendChild(grid);
            for (const [key, label] of Object.entries({ x: '横向位置', y: '纵向位置', width: '宽度', height: '高度', rotation: '旋转角度' })) {
                const control = field(label, 'number', object.frame[key]); control.input.dataset.nativeFrame = key; control.input.step = '0.1'; inputs[key] = control.input; grid.appendChild(control.wrapper);
            }
            readers.push(patch => {
                const changed = {};
                for (const key of Object.keys(inputs)) { const value = Number(inputs[key].value); if (value !== object.frame[key]) changed[key] = value; }
                if (Object.keys(changed).length) patch.frame = changed;
            });
        }
        if (object.fill && ['sp', 'cxnSp'].includes(object.kind)) {
            const box = section('填充与渐变');
            const initialType = object.fill.type === 'gradient' && !object.fill.editable || object.fill.type === 'solid' && !object.fill.color ? 'inherited' : object.fill.type;
            const type = field('填充方式', 'select', initialType, { inherited: '保持原稿', none: '无填充', solid: '纯色', gradient: '线性渐变' }); box.appendChild(type.wrapper);
            const solid = field('颜色', 'color', object.fill.color || '#FFFFFF'); box.appendChild(solid.wrapper);
            const angle = field('渐变角度', 'number', object.fill.angle || 0); box.appendChild(angle.wrapper);
            const stops = (object.fill.stops?.length ? object.fill.stops : [{ position: 0, color: '#FFFFFF' }, { position: 1, color: '#1769AA' }]).map((stop, index) => {
                const row = node('div', 'presentation-native-fields'), position = field(`色标${index + 1}位置（0至1）`, 'number', stop.position), paint = field('色标颜色', 'color', stop.color || '#FFFFFF');
                position.input.step = '0.01'; row.append(position.wrapper, paint.wrapper); box.appendChild(row); return { original: stop, position: position.input, color: paint.input };
            });
            readers.push(patch => {
                const value = type.input.value;
                const changed = value !== object.fill.type || value === 'solid' && solid.input.value.toUpperCase() !== String(object.fill.color).toUpperCase()
                    || value === 'gradient' && (Number(angle.input.value) !== Number(object.fill.angle || 0) || stops.some(stop => Number(stop.position.value) !== stop.original.position || stop.color.value.toUpperCase() !== String(stop.original.color).toUpperCase()));
                if (!changed || value === 'inherited') return;
                patch.fill = value === 'none' ? { type: value } : value === 'solid' ? { type: value, color: solid.input.value, opacity: object.fill.opacity ?? 1 } : { type: value, angle: Number(angle.input.value), stops: stops.map(stop => ({ position: Number(stop.position.value), color: stop.color.value, opacity: stop.original.opacity ?? 1 })) };
            });
        }
        if (object.runs.length) {
            const box = section('富文本分段');
            if (object.runs.length > 200) box.appendChild(node('p', 'presentation-empty-note', '当前显示前200个文字分段，其余内容保持原稿。'));
            for (const [index, run] of object.runs.slice(0, 200).entries()) {
                const text = field(`文字分段${index + 1}`, 'textarea', run.text), size = field('字号（点）', 'number', run.fontSize ?? ''), font = field('字体', 'text', run.fontFamily || ''), bold = field('加粗', 'checkbox', run.bold), italic = field('斜体', 'checkbox', run.italic);
                box.append(text.wrapper); const grid = node('div', 'presentation-native-fields'); grid.append(size.wrapper, font.wrapper, bold.wrapper, italic.wrapper); box.appendChild(grid);
                readers.push(patch => {
                    const edit = { paragraph: run.paragraph, run: run.run };
                    if (text.input.value !== run.text) edit.text = text.input.value;
                    if (size.input.value !== '' && Number(size.input.value) !== run.fontSize) edit.fontSize = Number(size.input.value);
                    if (font.input.value.trim() && font.input.value !== run.fontFamily) edit.fontFamily = font.input.value.trim();
                    if (bold.input.checked !== run.bold) edit.bold = bold.input.checked;
                    if (italic.input.checked !== run.italic) edit.italic = italic.input.checked;
                    if (Object.keys(edit).length > 2) (patch.runs ||= []).push(edit);
                });
            }
        }
        if (object.formulas.length) {
            const box = section('原生公式');
            for (const formula of object.formulas.slice(0, 50)) {
                const control = field(`公式${formula.index + 1}（LaTeX）`, 'textarea', formula.latex); control.input.disabled = !formula.editable; box.appendChild(control.wrapper);
                readers.push(patch => { if (formula.editable && control.input.value !== formula.latex) (patch.formulas ||= []).push({ index: formula.index, latex: control.input.value }); });
            }
        }
        if (object.table) {
            const box = section('原生表格单元格'), scroll = node('div', 'table-container'), table = node('table', 'data-table compact-table'); scroll.appendChild(table); box.appendChild(scroll);
            object.table.rows.forEach((cells, row) => { const tr = node('tr'); table.appendChild(tr); cells.forEach((cell, column) => {
                const td = node('td'), control = field(`第${row + 1}行第${column + 1}列`, 'textarea', cell.text); control.input.disabled = cell.merged; td.appendChild(control.wrapper); tr.appendChild(td);
                readers.push(patch => { if (!cell.merged && control.input.value !== cell.text) (patch.cells ||= []).push({ row, column, text: control.input.value }); });
            }); });
        }
        if (object.chart?.editable) {
            const box = section('原生图表与嵌入工作簿');
            box.appendChild(node('p', 'presentation-empty-note', '修改分类、序列名称和数值，保留原有分类与序列数量。'));
            const scroll = node('div', 'table-container'), table = node('table', 'data-table compact-table'), head = node('tr'); scroll.appendChild(table); table.appendChild(head); box.appendChild(scroll);
            head.appendChild(node('th', '', '分类'));
            const names = object.chart.series.map(series => { const td = node('th'), control = field('序列名称', 'text', series.name); td.appendChild(control.wrapper); head.appendChild(td); return control.input; });
            const categories = [], values = object.chart.series.map(() => []);
            object.chart.categories.forEach((category, row) => {
                const tr = node('tr'), td = node('td'), control = field(`分类${row + 1}`, 'text', category); categories.push(control.input); td.appendChild(control.wrapper); tr.appendChild(td); table.appendChild(tr);
                object.chart.series.forEach((series, column) => { const cell = node('td'), number = field(`第${row + 1}行序列${column + 1}`, 'number', series.values[row]); number.input.step = 'any'; values[column].push(number.input); cell.appendChild(number.wrapper); tr.appendChild(cell); });
            });
            readers.push(patch => {
                const data = { categories: categories.map(input => input.value), series: names.map((input, index) => ({ name: input.value, values: values[index].map(value => Number(value.value)) })) };
                if (JSON.stringify(data) !== JSON.stringify({ categories: object.chart.categories, series: object.chart.series })) patch.chart = data;
            });
        } else if (object.chart) container.appendChild(node('p', 'presentation-empty-note', object.chart.reason));
        if (object.geometry) {
            const box = section(object.geometry.type === 'custom' ? '自由路径控制点' : '原生形状调整参数');
            const adjustments = (object.geometry.adjustments || []).filter(item => /^val -?\d+$/.test(item.formula));
            adjustments.forEach(item => {
                const control = field(item.name, 'number', Number(item.formula.slice(4))); box.appendChild(control.wrapper);
                readers.push(patch => { if ('val ' + Number(control.input.value) !== item.formula) ((patch.geometry ||= {}).adjustments ||= []).push({ name: item.name, formula: 'val ' + Number(control.input.value) }); });
            });
            if (object.geometry.paths) {
                const paths = JSON.parse(JSON.stringify(object.geometry.paths));
                let pointIndex = 0;
                const changes = [];
                paths.forEach((path, pathIndex) => path.commands.forEach(command => command.points.forEach(point => {
                    if (++pointIndex > 200 || ![point.x, point.y].every(value => /^-?\d+(?:\.\d+)?$/.test(String(value)))) return;
                    const row = node('div', 'presentation-native-fields'), x = field(`路径${pathIndex + 1} · 点${pointIndex}横坐标`, 'number', point.x), y = field('纵坐标', 'number', point.y);
                    row.append(x.wrapper, y.wrapper); box.appendChild(row); changes.push({ point, x: x.input, y: y.input });
                })));
                if (pointIndex > 200) box.appendChild(node('p', 'presentation-empty-note', '当前界面显示前200个数值控制点，其他路径内容保持原稿。'));
                readers.push(patch => { for (const change of changes) { change.point.x = String(Math.round(Number(change.x.value))); change.point.y = String(Math.round(Number(change.y.value))); } if (JSON.stringify(paths) !== JSON.stringify(object.geometry.paths)) (patch.geometry ||= {}).paths = paths; });
            }
        }
        return () => { const patch = { objectId: object.id }; readers.forEach(read => read(patch)); return Object.keys(patch).length > 1 ? patch : null; };
    }
    window.Pivot.exposeModule('apps.presentations.nativeProperties', { render });
})();
