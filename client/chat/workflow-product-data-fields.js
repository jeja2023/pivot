/* 结构化参数的表格编辑与原始文本共享一个值，保留数字、false、null和未展示行。 */
(function () {
    const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const labels = { region: '地区', amount: '金额', text: '内容', date: '日期', name: '名称', title: '标题', content: '正文' };
    function enhance(root, selector) {
        for (const raw of root.querySelectorAll(selector)) {
            if (raw.dataset.structuredEditor) continue;
            const expected = raw.dataset.valueType || raw.dataset.dagInputType;
            if (!['array', 'object'].includes(expected)) continue;
            raw.dataset.structuredEditor = '1';
            const container = document.createElement('div'); container.className = 'workflow-product-data-editor';
            const error = document.createElement('p'); error.setAttribute('role', 'alert');
            const view = document.createElement('div');
            const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '高级：编辑原始数据';
            raw.before(container); details.append(summary, raw); container.append(view, error, details);
            raw.required = false;
            let value;
            const commit = () => { raw.value = JSON.stringify(value); raw.dispatchEvent(new Event('input', { bubbles: true })); error.textContent = ''; };
            const button = (label, action) => { const control = document.createElement('button'); control.type = 'button'; control.className = 'btn-secondary btn-xs'; control.textContent = label; control.addEventListener('click', action); return control; };
            function cell(parent, current, assign, label) {
                const wrap = document.createElement('div'); wrap.className = 'workflow-product-data-cell';
                const type = typeOf(current); const input = document.createElement('input'); input.className = 'form-input';
                input.setAttribute('aria-label', label); input.type = type === 'boolean' ? 'checkbox' : type === 'number' ? 'number' : 'text';
                if (type === 'boolean') input.checked = current;
                else input.value = type === 'null' ? '' : type === 'object' || type === 'array' ? JSON.stringify(current) : String(current ?? '');
                if (type === 'null') input.placeholder = '空值';
                input.addEventListener('input', () => {
                    let next = input.type === 'checkbox' ? input.checked : input.value;
                    if (type === 'number') { if (next === '' || !Number.isFinite(Number(next))) { error.textContent = `${label}需要有效数字，当前编辑尚未写入。`; return; } next = Number(next); }
                    if (type === 'object' || type === 'array') { try { next = JSON.parse(next); } catch (_) { error.textContent = `${label}的嵌套数据尚未完成。`; return; } }
                    if (type === 'null' && next === '') next = null;
                    assign(next); commit();
                });
                wrap.append(input); parent.append(wrap);
            }
            function render() {
                view.replaceChildren();
                const tableWrap = document.createElement('div'); tableWrap.className = 'table-container';
                const table = document.createElement('table'); table.className = 'data-table compact-table';
                const head = document.createElement('thead'); const rowHead = document.createElement('tr'); const body = document.createElement('tbody');
                const records = expected === 'array' ? value : [value];
                const isRecords = expected === 'object' || records.every(item => item && typeOf(item) === 'object');
                const keys = isRecords ? [...new Set(records.flatMap(item => Object.keys(item)))].slice(0, 30) : ['内容'];
                for (const key of [...keys, ...(expected === 'array' ? ['操作'] : [])]) { const th = document.createElement('th'); th.textContent = labels[key] || key; rowHead.append(th); }
                head.append(rowHead); table.append(head, body); tableWrap.append(table); view.append(tableWrap);
                records.slice(0, 100).forEach((record, index) => {
                    const row = document.createElement('tr');
                    for (const key of keys) {
                        const td = document.createElement('td');
                        cell(td, isRecords ? record[key] : record, next => { if (isRecords) record[key] = next; else value[index] = next; }, `${labels[key] || key}，第 ${index + 1} 条`); row.append(td);
                    }
                    if (expected === 'array') { const td = document.createElement('td'); td.append(button(`移除第 ${index + 1} 条`, () => { value.splice(index, 1); commit(); render(); })); row.append(td); }
                    body.append(row);
                });
                const actions = document.createElement('div'); actions.className = 'workflow-product-row';
                if (expected === 'array') actions.append(button('添加记录', () => {
                    const sample = value[0];
                    value.push(isRecords ? keys.length ? Object.fromEntries(keys.map(key => [key, typeof sample?.[key] === 'number' ? 0 : typeof sample?.[key] === 'boolean' ? false : ''])) : { 内容: '' } : ''); commit(); render();
                }));
                if (isRecords) actions.append(button('添加字段', async () => {
                    const name = await window.Pivot.legacy.showInputPrompt({ title: '添加字段', message: '填写业务字段名称。', value: '' });
                    if (!name || ['__proto__', 'constructor', 'prototype'].includes(name) || keys.includes(name)) return;
                    if (!records.length) value.push({});
                    (expected === 'array' ? value : [value]).forEach(item => { item[name] = ''; }); commit(); render();
                }));
                view.append(actions);
                if (records.length > 100 || keys.length >= 30) { const hint = document.createElement('p'); hint.textContent = '当前显示前 100 条、30 个字段；其余数据保留，可在高级原始数据中编辑。'; view.append(hint); }
            }
            const sync = () => {
                try { value = JSON.parse(raw.value || (expected === 'array' ? '[]' : '{}')); if (expected === 'array' ? !Array.isArray(value) : typeOf(value) !== 'object') throw new Error(); error.textContent = ''; render(); }
                catch (_) { error.textContent = '原始数据尚未完成，请展开高级编辑修正；已填内容仍保留。'; }
            };
            raw.addEventListener('change', sync); sync();
        }
    }
    window.Pivot.registerModule('agent.workflowDataFields', { enhance });
})();
