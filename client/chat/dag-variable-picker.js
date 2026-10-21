/* Agent DAG 智能变量选择气泡与插值辅助函数 */

function insertTextIntoInput(targetInput, textToInsert) {
    if (!targetInput) return;
    const value = targetInput.value || '';
    const start = targetInput.selectionStart ?? value.length;
    const end = targetInput.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);

    // 如果用户刚好输入了 {{，插入表达式时自动闭合消除冗余 {{
    let finalInsert = textToInsert;
    let actualStart = start;
    if (before.endsWith('{{') && textToInsert.startsWith('{{') && textToInsert.endsWith('}}')) {
        actualStart = start - 2;
    }

    targetInput.value = value.slice(0, actualStart) + finalInsert + after;
    const newPos = actualStart + finalInsert.length;
    targetInput.selectionStart = newPos;
    targetInput.selectionEnd = newPos;
    targetInput.focus();
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
}

function showVariablePickerPopover({ anchorEl, targetInput, nodeId, nodes = [], tools = [], onSelect, expectedType }) {
    let popover = document.getElementById('pivot-dag-variable-popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'pivot-dag-variable-popover';
        popover.className = 'pivot-dag-variable-popover hidden';
        document.body.appendChild(popover);
    }

    const dagCore = typeof window !== 'undefined' ? window.Pivot?.moduleApi?.('agent.dagCore') : null;
    const getOptions = dagCore?.getAvailableVariableOptions || window.Pivot?.legacy?.getAvailableVariableOptions;
    const groups = typeof getOptions === 'function'
        ? getOptions(nodes || [], nodeId, tools || [])
        : [];
    const normalizedType = type => type === 'text' ? 'string' : type;
    const compatible = item => !expectedType || !item.type || item.type === 'any' || normalizedType(item.type) === normalizedType(expectedType) || (expectedType === 'number' && item.type === 'integer');
    const typeNames = { string: '文字', text: '文字', object: '对象', array: '记录列表', number: '数字', integer: '整数', boolean: '是/否', null: '空值', any: '任意类型' };
    groups.forEach(group => group.items.sort((a, b) => Number(compatible(b)) - Number(compatible(a))));

    const groupCount = groups.reduce((acc, g) => acc + (g.items?.length || 0), 0);

    const fallbackEscape = (str) => {
        if (typeof document === 'undefined') return String(str ?? '');
        const div = document.createElement('div');
        div.textContent = String(str ?? '');
        return div.innerHTML;
    };
    const escapeHtml = (window.Pivot?.legacy?.PivotSafeHtml?.escapeHtml) || fallbackEscape;
    const escapeAttr = (window.Pivot?.legacy?.PivotSafeHtml?.escapeAttr) || (s => escapeHtml(s).replace(/"/g, '&quot;'));
    const safeHtml = window.Pivot?.safeHtml || window.Pivot?.legacy?.PivotSafeHtml || (typeof PivotSafeHtml !== 'undefined' ? PivotSafeHtml : null);

    const markup = `
        <div class="pivot-dag-var-popover-head">
            <div class="pivot-dag-var-popover-title">
                <strong>插入变量</strong>
                <span class="pivot-dag-var-badge">${groupCount} 项可用</span>
            </div>
            <button type="button" class="workspace-modal-close pivot-dag-var-popover-close" aria-label="关闭">&times;</button>
        </div>
        <div class="pivot-dag-var-popover-search">
            <input type="text" class="form-input" placeholder="搜索变量名或字段…" data-pivot-dag-var-search="1">
            <label><input type="checkbox" data-pivot-dag-show-expression> 显示原始表达式</label>
        </div>
        <div class="pivot-dag-var-popover-body">
            ${groups.map(grp => `
                <div class="pivot-dag-var-group" data-pivot-dag-var-group-name="${escapeAttr(grp.group)}">
                    <div class="pivot-dag-var-group-title">${escapeHtml(grp.group)}</div>
                    <div class="pivot-dag-var-items">
                        ${grp.items.map(item => `
                            <button type="button" class="btn-secondary pivot-dag-var-item" data-pivot-dag-var-expr="${escapeAttr(item.expression)}" ${compatible(item) ? '' : 'disabled'} title="${escapeAttr(compatible(item) ? item.description || item.expression : `此参数需要 ${expectedType}，当前为 ${item.type}，请重新选择来源。`)}">
                                <span class="pivot-dag-var-item-label">${escapeHtml(item.label)}</span>
                                <span>${escapeHtml(typeNames[item.type] || '数据')} · ${escapeHtml(({ sample: '实际测试样例', override: '测试覆盖', mock: '模拟样本', history: '历史复用', workflow_input: '运行参数默认样例' })[item.source] || '输出契约')}</span>
                                ${!compatible(item) ? `<span>需要${escapeHtml(typeNames[expectedType] || expectedType)}，此字段为${escapeHtml(typeNames[item.type] || item.type)}；请重新选择。</span>` : ''}
                                ${item.sample !== undefined ? `<span>${escapeHtml(JSON.stringify(item.sample).slice(0, 120))}</span>` : ''}
                                <code class="pivot-dag-var-item-expr hidden">${escapeHtml(item.expression)}</code>
                            </button>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    if (safeHtml && typeof safeHtml.setHtml === 'function') {
        safeHtml.setHtml(popover, markup);
    }

    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const popoverWidth = 340;
        const popoverHeight = 360;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + popoverWidth > window.innerWidth - 16) {
            left = Math.max(16, window.innerWidth - popoverWidth - 16);
        }
        if (top + popoverHeight > window.innerHeight - 16) {
            top = Math.max(16, rect.top - popoverHeight - 6);
        }
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
    } else {
        popover.style.left = '50%';
        popover.style.top = '50%';
        popover.style.transform = 'translate(-50%, -50%)';
    }

    popover.classList.remove('hidden');

    const searchInput = popover.querySelector('[data-pivot-dag-var-search]');
    popover.querySelector('[data-pivot-dag-show-expression]')?.addEventListener('change', event => popover.querySelectorAll('.pivot-dag-var-item-expr').forEach(code => code.classList.toggle('hidden', !event.target.checked)));
    requestAnimationFrame(() => searchInput?.focus());

    searchInput?.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        popover.querySelectorAll('.pivot-dag-var-group').forEach(grp => {
            let hasVisible = false;
            grp.querySelectorAll('.pivot-dag-var-item').forEach(item => {
                const text = item.textContent.toLowerCase();
                const expr = (item.dataset.pivotDagVarExpr || '').toLowerCase();
                const match = !q || text.includes(q) || expr.includes(q);
                item.style.display = match ? '' : 'none';
                if (match) hasVisible = true;
            });
            grp.style.display = hasVisible ? '' : 'none';
        });
    });

    const closePopover = () => {
        popover.classList.add('hidden');
        document.removeEventListener('pointerdown', onDocPointerDown);
        anchorEl?.focus();
    };

    const onDocPointerDown = (e) => {
        if (!popover.contains(e.target) && (!anchorEl || !anchorEl.contains(e.target))) {
            closePopover();
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', onDocPointerDown), 10);
    popover.querySelector('.pivot-dag-var-popover-close')?.addEventListener('click', closePopover);
    popover.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closePopover(); } };

    popover.querySelectorAll('[data-pivot-dag-var-expr]').forEach(itemBtn => {
        itemBtn.addEventListener('click', () => {
            const expr = itemBtn.dataset.pivotDagVarExpr;
            if (typeof onSelect === 'function') {
                onSelect(expr);
            } else if (targetInput) {
                insertTextIntoInput(targetInput, expr);
            } else {
                navigator.clipboard?.writeText(expr).then(() => {
                    window.Pivot?.legacy?.showToast?.(`已复制变量：${expr}`, 'success');
                }).catch(() => {});
            }
            closePopover();
        });
    });
}

if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
    window.Pivot.registerModule('agent.dagVariablePicker', {
        insertTextIntoInput,
        showVariablePickerPopover
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        insertTextIntoInput,
        showVariablePickerPopover
    };
}
