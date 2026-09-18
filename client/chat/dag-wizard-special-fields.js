/* DAG 向导专用字段控件（分组、映射、审批、资源与浏览器目标）。 */

function createDagWizardSpecialFieldControls() {
    const normalizeGroupByFields = value => (Array.isArray(value) ? value : [value])
        .flatMap(item => typeof item === 'string' ? item.split(',') : [item])
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .filter((item, index, items) => items.indexOf(item) === index)
        .slice(0, 12);
    const groupFieldsFromControl = control => [...control.querySelectorAll('[data-pivot-dag-group-field-value]')]
        .map(item => String(item.dataset.pivotDagGroupFieldValue || '').trim())
        .filter(Boolean);
    const renderGroupFields = (control, value) => {
        const fields = normalizeGroupByFields(value);
        const list = control.querySelector('[data-pivot-dag-group-fields-list]');
        if (!list) return;
        PivotSafeHtml.setHtml(list, fields.length
            ? fields.map(field => `<span class="pivot-dag-group-field-chip" data-pivot-dag-group-field-value="${dagEscapeAttr(field)}">${dagEscapeHtml(field)}<button type="button" class="btn-secondary" data-pivot-dag-group-field-remove="${dagEscapeAttr(field)}" aria-label="移除字段 ${dagEscapeAttr(field)}">×</button></span>`).join('')
            : '<span class="pivot-dag-group-fields-empty">尚未添加分组字段</span>');
    };
    const columnFieldsFromControl = control => [...control.querySelectorAll('[data-pivot-dag-column-field-value]')]
        .map(item => String(item.dataset.pivotDagColumnFieldValue || '').trim())
        .filter(Boolean);
    const renderColumnFields = (control, value) => {
        const fields = (Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .filter((item, index, items) => items.indexOf(item) === index)
            .slice(0, 50);
        const list = control.querySelector('[data-pivot-dag-column-fields-list]');
        if (!list) return;
        PivotSafeHtml.setHtml(list, fields.length
            ? fields.map(field => `<span class="pivot-dag-group-field-chip" data-pivot-dag-column-field-value="${dagEscapeAttr(field)}">${dagEscapeHtml(field)}<button type="button" class="btn-secondary" data-pivot-dag-column-field-remove="${dagEscapeAttr(field)}" aria-label="移除字段 ${dagEscapeAttr(field)}">×</button></span>`).join('')
            : '<span class="pivot-dag-group-fields-empty">留空时将使用全部字段</span>');
    };
    const approvalTagsFromControl = control => [...control.querySelectorAll('[data-pivot-dag-approval-tag-value]')]
        .map(item => String(item.dataset.pivotDagApprovalTagValue || '').trim())
        .filter(Boolean);
    const renderApprovalTags = (control, value) => {
        const tags = (Array.isArray(value) ? value : [value])
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .filter((item, index, items) => items.indexOf(item) === index)
            .slice(0, 50);
        const list = control.querySelector('[data-pivot-dag-approval-tags-list]');
        if (!list) return;
        PivotSafeHtml.setHtml(list, tags.length
            ? tags.map(tag => `<span class="pivot-dag-group-field-chip" data-pivot-dag-approval-tag-value="${dagEscapeAttr(tag)}">${dagEscapeHtml(tag)}<button type="button" class="btn-secondary" data-pivot-dag-approval-tag-remove="${dagEscapeAttr(tag)}" aria-label="移除 ${dagEscapeAttr(tag)}">×</button></span>`).join('')
            : '<span class="pivot-dag-group-fields-empty">尚未添加审批对象</span>');
    };
    const splitWizardList = value => String(value || '')
        .split(/[,，;；\n]/)
        .map(item => item.trim())
        .filter(Boolean);
    const approvalLevelsFromControl = control => {
        const source = String(control.querySelector('[data-pivot-dag-approval-level-source]')?.value || '').trim();
        if (source) {
            if (source !== '__custom__') return source;
            return String(control.querySelector('[data-pivot-dag-approval-level-custom]')?.value || '').trim() || undefined;
        }
        const levels = [];
        let invalid = false;
        control.querySelectorAll('[data-pivot-dag-approval-level]').forEach(level => {
            const rawUserIds = splitWizardList(level.querySelector('[data-pivot-dag-approval-level-user-ids]')?.value || '');
            const invalidUserIds = rawUserIds.some(item => !/^[1-9]\d*$/.test(item));
            const userInput = level.querySelector('[data-pivot-dag-approval-level-user-ids]');
            userInput?.classList.toggle('is-invalid', invalidUserIds);
            if (invalidUserIds) {
                invalid = true;
                return;
            }
            const approverUserIds = rawUserIds.map(item => Number.parseInt(item, 10)).filter(Number.isSafeInteger);
            const approverUnits = [...new Set(splitWizardList(level.querySelector('[data-pivot-dag-approval-level-units]')?.value || ''))];
            if (!approverUserIds.length && !approverUnits.length) return;
            levels.push({
                title: String(level.querySelector('[data-pivot-dag-approval-level-title]')?.value || '').trim(),
                mode: level.querySelector('[data-pivot-dag-approval-level-mode]')?.value === 'all' ? 'all' : 'any',
                ...(approverUserIds.length ? { approverUserIds } : {}),
                ...(approverUnits.length ? { approverUnits } : {})
            });
        });
        return invalid ? null : (levels.length ? levels : undefined);
    };
    const renderApprovalLevels = (control, value) => {
        const list = control.querySelector('[data-pivot-dag-approval-level-list]');
        if (!list) return;
        const levels = Array.isArray(value)
            ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 10)
            : [];
        const renderLevel = (level = {}, index = 0) => {
            const userIds = Array.isArray(level.approverUserIds)
                ? level.approverUserIds
                : (Array.isArray(level.approver_user_ids) ? level.approver_user_ids : []);
            const units = Array.isArray(level.approverUnits)
                ? level.approverUnits
                : (Array.isArray(level.approver_units) ? level.approver_units : []);
            return `<article class="pivot-dag-approval-level" data-pivot-dag-approval-level><div class="pivot-dag-approval-level-head"><strong>第 ${index + 1} 级审批</strong><button type="button" class="btn-secondary" data-pivot-dag-approval-level-remove aria-label="删除第 ${index + 1} 级审批">删除</button></div><div class="pivot-dag-approval-level-grid"><label><span>本级说明</span><input class="form-input" data-pivot-dag-approval-level-title value="${dagEscapeAttr(level.title || '')}" placeholder="例如：直属负责人审批"></label><label><span>通过规则</span><select class="form-input" data-pivot-dag-approval-level-mode><option value="any" ${String(level.mode || '').toLowerCase() !== 'all' ? 'selected' : ''}>任一人通过即可</option><option value="all" ${String(level.mode || '').toLowerCase() === 'all' ? 'selected' : ''}>所有对象均需通过</option></select></label><label><span>审批用户 ID</span><input class="form-input" data-pivot-dag-approval-level-user-ids value="${dagEscapeAttr(userIds.join(', '))}" placeholder="多个 ID 用逗号分隔，例如 1001, 1002"></label><label><span>审批部门</span><input class="form-input" data-pivot-dag-approval-level-units value="${dagEscapeAttr(units.join(', '))}" placeholder="多个部门用逗号分隔，例如 财务部, 法务部"></label></div></article>`;
        };
        PivotSafeHtml.setHtml(list, (levels.length ? levels : [{}]).map(renderLevel).join(''));
    };
    const syncApprovalLevelSource = control => {
        const source = control.querySelector('[data-pivot-dag-approval-level-source]');
        const custom = control.querySelector('[data-pivot-dag-approval-level-custom]');
        const editor = control.querySelector('[data-pivot-dag-approval-level-list]')?.parentElement;
        const isReference = Boolean(source?.value);
        custom?.classList.toggle('is-visible', source?.value === '__custom__');
        editor?.classList.toggle('is-reference-active', isReference);
    };
    const browserTargetFromControl = control => {
        const source = String(control.querySelector('[data-pivot-dag-browser-target-source]')?.value || '').trim();
        if (source) {
            if (source !== '__custom__') return source;
            return String(control.querySelector('[data-pivot-dag-browser-target-custom]')?.value || '').trim() || undefined;
        }
        const mode = String(control.querySelector('[data-pivot-dag-browser-target-mode]')?.value || 'selector');
        const target = {};
        if (mode === 'role') {
            const role = String(control.querySelector('[data-pivot-dag-browser-target-role-input]')?.value || '').trim();
            const name = String(control.querySelector('[data-pivot-dag-browser-target-name-input]')?.value || '').trim();
            if (role) target.role = role;
            if (name) target.name = name;
        } else if (mode === 'text') {
            const text = String(control.querySelector('[data-pivot-dag-browser-target-text-input]')?.value || '').trim();
            if (text) target.text = text;
        } else {
            const selector = String(control.querySelector('[data-pivot-dag-browser-target-selector-input]')?.value || '').trim();
            if (selector) target.selector = selector;
        }
        if (control.querySelector('[data-pivot-dag-browser-target-exact]')?.checked) target.exact = true;
        return Object.keys(target).length ? target : undefined;
    };
    const syncBrowserTargetMode = control => {
        const source = control.querySelector('[data-pivot-dag-browser-target-source]');
        const custom = control.querySelector('[data-pivot-dag-browser-target-custom]');
        const editor = control.querySelector('[data-pivot-dag-browser-target-editor]');
        const mode = control.querySelector('[data-pivot-dag-browser-target-mode]')?.value || 'selector';
        const isReference = Boolean(source?.value);
        custom?.classList.toggle('is-visible', source?.value === '__custom__');
        editor?.classList.toggle('is-reference-active', isReference);
        control.querySelector('[data-pivot-dag-browser-target-selector]')?.classList.toggle('hidden', mode !== 'selector');
        control.querySelector('[data-pivot-dag-browser-target-role]')?.classList.toggle('hidden', mode !== 'role');
        control.querySelector('[data-pivot-dag-browser-target-text]')?.classList.toggle('hidden', mode !== 'text');
    };
    const renderDataFieldPicker = (control, value) => {
        const select = control.querySelector('[data-pivot-dag-data-field-select]');
        const manual = control.querySelector('[data-pivot-dag-data-field-manual]');
        if (!select) return;
        const options = [...select.options].map(option => option.value);
        const selected = value && options.includes(String(value)) ? String(value) : (value ? '__manual__' : '');
        select.value = selected;
        if (manual) {
            manual.value = selected === '__manual__' ? String(value || '') : '';
            manual.classList.toggle('is-visible', selected === '__manual__');
        }
    };
    const parseKeyValueEntry = value => {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        if (/^\{\{\s*[^{}]+?\s*\}\}$/.test(raw)) return raw;
        if (/^(?:\{|\[|true$|false$|null$|-?\d+(?:\.\d+)?$)/i.test(raw)) {
            try { return JSON.parse(raw); } catch (_) {}
        }
        return raw;
    };
    const keyValueMapFromControl = control => {
        const result = {};
        let invalid = false;
        control.querySelectorAll('.pivot-dag-keyvalue-map-row').forEach(row => {
            const key = String(row.querySelector('[data-pivot-dag-keyvalue-key]')?.value || '').trim();
            const value = String(row.querySelector('[data-pivot-dag-keyvalue-value]')?.value || '').trim();
            if (!key && !value) return;
            if (!key || Object.hasOwn(result, key)) {
                row.querySelector('[data-pivot-dag-keyvalue-key]')?.classList.add('is-invalid');
                invalid = true;
                return;
            }
            result[key] = parseKeyValueEntry(value);
        });
        return invalid ? null : result;
    };
    const renderKeyValueRows = (control, value) => {
        const entries = Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
        const list = control.querySelector('[data-pivot-dag-keyvalue-map-list]');
        if (!list) return;
        const rows = entries.length ? entries : [['', '']];
        const dataListId = `pivot-dag-data-field-options-${String(control.dataset.pivotDagKeyvalueMap || '')}`;
        PivotSafeHtml.setHtml(list, rows.map(([key, item]) => `<div class="pivot-dag-keyvalue-map-row"><input class="form-input" list="${dagEscapeAttr(dataListId)}" data-pivot-dag-keyvalue-key value="${dagEscapeAttr(key)}" placeholder="字段或键名"><textarea class="form-input" rows="2" data-pivot-dag-keyvalue-value placeholder="填写值或插入变量">${dagEscapeHtml(typeof item === 'string' ? item : JSON.stringify(item))}</textarea><button type="button" class="btn-secondary" data-pivot-dag-keyvalue-remove aria-label="删除此项">×</button></div>`).join(''));
    };
    const syncResourcePicker = (control, value, emptyLabel, currentLabel) => {
        const select = control.querySelector('select');
        const custom = control.querySelector('.pivot-dag-resource-picker-custom');
        if (!select) return;
        const currentValue = String(value ?? '').trim();
        const isReference = /^\{\{\s*[^{}]+?\s*\}\}$/.test(currentValue);
        const optionValues = [...select.options].map(option => option.value);
        if (currentValue && !isReference && !optionValues.includes(currentValue)) {
            const option = document.createElement('option');
            option.value = currentValue;
            option.textContent = currentLabel(currentValue);
            select.appendChild(option);
        }
        if (!currentValue && !optionValues.includes('')) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = emptyLabel;
            select.prepend(option);
        }
        select.value = isReference ? '__custom__' : currentValue;
        if (custom) {
            custom.value = isReference ? currentValue : '';
            custom.classList.toggle('is-visible', isReference);
        }
    };
    const renderResourceOptions = (select, entries, selectedValue, emptyLabel, currentLabel) => {
        if (!select) return;
        const normalized = [];
        const seen = new Set();
        entries.forEach(entry => {
            const value = String(entry?.value ?? '').trim();
            if (!value || seen.has(value)) return;
            seen.add(value);
            normalized.push({ value, label: String(entry.label || value).trim() || value });
        });
        const current = String(selectedValue ?? '').trim();
        const isCustom = current === '__custom__';
        if (current && !isCustom && !seen.has(current)) normalized.unshift({ value: current, label: currentLabel(current) });
        PivotSafeHtml.setHtml(select, [
            `<option value="">${dagEscapeHtml(emptyLabel)}</option>`,
            ...normalized.map(entry => `<option value="${dagEscapeAttr(entry.value)}">${dagEscapeHtml(entry.label)}</option>`),
            '<option value="__custom__">高级：自定义变量表达式</option>'
        ].join(''));
        select.value = current;
    };

    return {
        approvalLevelsFromControl,
        approvalTagsFromControl,
        browserTargetFromControl,
        columnFieldsFromControl,
        groupFieldsFromControl,
        keyValueMapFromControl,
        renderApprovalLevels,
        renderApprovalTags,
        renderColumnFields,
        renderDataFieldPicker,
        renderGroupFields,
        renderKeyValueRows,
        renderResourceOptions,
        syncApprovalLevelSource,
        syncBrowserTargetMode,
        syncResourcePicker
    };
}
