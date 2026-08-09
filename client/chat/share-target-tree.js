/* Shared unit and user target tree used by workflow, knowledge, and tool sharing. */
(function exposeShareTargetTree(root) {
    const UNASSIGNED_UNIT = '未设置单位';

    function normalizeUnit(value) {
        return String(value || '').trim() || UNASSIGNED_UNIT;
    }

    function uniqueUnits(values = []) {
        return [...new Set((Array.isArray(values) ? values : [])
            .map(value => String(value || '').trim())
            .filter(Boolean))];
    }

    function normalizeUserIds(values = []) {
        const source = Array.isArray(values) ? values : String(values || '').split(',');
        return new Set(source.map(Number).filter(Number.isSafeInteger));
    }

    function render(options = {}) {
        const escapeText = typeof options.escapeText === 'function' ? options.escapeText : value => String(value || '');
        const escapeAttr = typeof options.escapeAttr === 'function' ? options.escapeAttr : escapeText;
        const unitInputName = String(options.unitInputName || 'share-unit');
        const userInputName = String(options.userInputName || 'share-user');
        const availableUnits = uniqueUnits(options.units);
        const allowedUnits = uniqueUnits(options.allowedUnits);
        const users = Array.isArray(options.users) ? options.users.filter(item => Number(item?.id) > 0) : [];
        const allowedUserIds = normalizeUserIds(options.allowedUserIds);
        const selectableUnits = new Set([...availableUnits, ...allowedUnits]);
        const usersByUnit = new Map();
        users.forEach(target => {
            const unit = normalizeUnit(target.unit);
            if (!usersByUnit.has(unit)) usersByUnit.set(unit, []);
            usersByUnit.get(unit).push(target);
        });
        const units = [...new Set([...availableUnits, ...allowedUnits, ...usersByUnit.keys()])]
            .sort((left, right) => {
                if (left === UNASSIGNED_UNIT) return 1;
                if (right === UNASSIGNED_UNIT) return -1;
                return left.localeCompare(right, 'zh-CN');
            });
        const isShared = options.isShared === true;
        const isAll = options.isAll === true;
        const currentUnit = String(options.currentUnit || '').trim();

        if (!units.length) return '<div class="agent-workflow-share-empty">暂无可共享的单位或用户。</div>';
        return units.map(unit => {
            const unitUsers = usersByUnit.get(unit) || [];
            const selectable = unit !== UNASSIGNED_UNIT && selectableUnits.has(unit);
            const unitChecked = selectable && isShared && !isAll && allowedUnits.includes(unit);
            const meta = [
                unit === currentUnit ? '本单位' : '',
                unitUsers.length ? `${unitUsers.length} 名用户` : '暂无用户',
                selectable ? '' : '仅可选择个人'
            ].filter(Boolean).join(' · ');
            const unitInput = selectable
                ? `<label class="agent-workflow-share-tree-unit-label"><input type="checkbox" name="${escapeAttr(unitInputName)}" value="${escapeAttr(unit)}" data-share-tree-unit="${escapeAttr(unit)}" ${unitChecked ? 'checked' : ''}><span><strong>${escapeText(unit)}</strong><small>${escapeText(meta)}</small></span></label>`
                : `<span class="agent-workflow-share-tree-unit-label"><span><strong>${escapeText(unit)}</strong><small>${escapeText(meta)}</small></span></span>`;
            const userMarkup = unitUsers.length
                ? unitUsers.map(target => {
                    const id = Number(target.id);
                    const displayName = target.nickname || target.username || `用户 ${id}`;
                    const detail = target.nickname && target.username ? target.username : `用户 ${id}`;
                    const userChecked = isShared && !isAll && (unitChecked || allowedUserIds.has(id));
                    return `<label class="agent-workflow-share-tree-user"><input type="checkbox" name="${escapeAttr(userInputName)}" value="${id}" data-share-tree-user="${id}" data-share-tree-user-unit="${escapeAttr(unit === UNASSIGNED_UNIT ? '' : unit)}" ${userChecked ? 'checked' : ''}><span><strong>${escapeText(displayName)}</strong><small>${escapeText(detail)}</small></span></label>`;
                }).join('')
                : '<span class="agent-workflow-share-tree-empty">该单位暂无其他可共享用户</span>';
            return `<section class="agent-workflow-share-tree-unit" role="treeitem" aria-expanded="true"><div class="agent-workflow-share-tree-unit-head">${unitInput}</div><div class="agent-workflow-share-tree-users" role="group">${userMarkup}</div></section>`;
        }).join('');
    }

    function bind(container, { unitSelector = '[data-share-tree-unit]', userSelector = '[data-share-tree-user]', onChange } = {}) {
        if (!container) return;
        container.querySelectorAll(unitSelector).forEach(unitInput => {
            unitInput.addEventListener('change', () => {
                const unit = unitInput.dataset.shareTreeUnit || '';
                container.querySelectorAll(userSelector).forEach(userInput => {
                    if (userInput.dataset.shareTreeUserUnit === unit && !userInput.disabled) userInput.checked = unitInput.checked;
                });
                if (typeof onChange === 'function') onChange();
            });
        });
    }

    function setChecked(container, checked, { unitSelector = '[data-share-tree-unit]', userSelector = '[data-share-tree-user]' } = {}) {
        if (!container) return;
        container.querySelectorAll(`${unitSelector}, ${userSelector}`).forEach(input => {
            if (!input.disabled) input.checked = checked;
        });
    }

    root.PivotShareTargetTree = Object.freeze({
        UNASSIGNED_UNIT,
        render,
        bind,
        setChecked
    });
}(window));
