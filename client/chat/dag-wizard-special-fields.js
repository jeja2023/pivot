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
    const tagListValuesFromControl = control => [...control.querySelectorAll('[data-pivot-dag-tag-list-value]')]
        .map(item => String(item.dataset.pivotDagTagListValue || '').trim())
        .filter(Boolean);
    const renderTagList = (control, value) => {
        const tags = (Array.isArray(value) ? value : [value])
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .filter((item, index, items) => items.indexOf(item) === index)
            .slice(0, 50);
        const list = control.querySelector('[data-pivot-dag-tag-list-list]');
        if (!list) return;
        PivotSafeHtml.setHtml(list, tags.length
            ? tags.map(tag => `<span class="pivot-dag-group-field-chip" data-pivot-dag-tag-list-value="${dagEscapeAttr(tag)}">${dagEscapeHtml(tag)}<button type="button" class="btn-secondary" data-pivot-dag-tag-list-remove="${dagEscapeAttr(tag)}" aria-label="移除 ${dagEscapeAttr(tag)}">×</button></span>`).join('')
            : '<span class="pivot-dag-group-fields-empty">尚未添加条目</span>');
    };
    const bindTagList = ({ control, setActiveField, showToast }) => {
        const input = control.querySelector('[data-pivot-dag-tag-list-input]');
        const addTag = () => {
            const next = String(input?.value || '').trim();
            if (!next) return;
            const tags = tagListValuesFromControl(control);
            if (tags.includes(next)) return showToast?.('该条目已存在。', 'warning');
            if (tags.length >= 50) return showToast?.('最多添加 50 个条目。', 'warning');
            renderTagList(control, [...tags, next]);
            input.value = '';
            input.focus?.({ preventScroll: true });
            setActiveField(control);
        };
        control.querySelector('[data-pivot-dag-tag-list-add]')?.addEventListener('click', addTag);
        input?.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addTag();
        });
        control.addEventListener('click', event => {
            const remove = event.target.closest('[data-pivot-dag-tag-list-remove]');
            if (!remove) return;
            const tag = String(remove.dataset.pivotDagTagListRemove || '').trim();
            renderTagList(control, tagListValuesFromControl(control).filter(item => item !== tag));
            setActiveField(control);
        });
    };
    const normalizedWorkflowInputType = value => ['text', 'number', 'boolean', 'object', 'array'].includes(String(value || ''))
        ? String(value)
        : 'text';
    const defaultEditorForType = (control, type) => control.querySelector(`[data-pivot-dag-input-default-editor="${['object', 'array'].includes(type) ? 'json' : type}"]`);
    const defaultEditorRawValue = (control, type) => {
        const editor = defaultEditorForType(control, type);
        if (!editor) return undefined;
        if (type === 'boolean') return editor.value === '' ? undefined : editor.value === 'true';
        return String(editor.value || '').trim() || undefined;
    };
    const workflowInputDefaultFromControl = (control, inputType = 'text') => {
        const type = normalizedWorkflowInputType(inputType);
        const raw = defaultEditorRawValue(control, type);
        if (raw === undefined) return undefined;
        if (type === 'number') {
            const value = Number(raw);
            return Number.isFinite(value) ? value : null;
        }
        if (type === 'object' || type === 'array') {
            try {
                const value = JSON.parse(raw);
                return type === 'array'
                    ? (Array.isArray(value) ? value : null)
                    : (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
            } catch (_) {
                return null;
            }
        }
        return raw;
    };
    const hydrateWorkflowInputDefault = (control, inputType = 'text', value) => {
        const type = normalizedWorkflowInputType(inputType);
        control.dataset.pivotDagWorkflowInputDefaultType = type;
        control.querySelectorAll('[data-pivot-dag-input-default-editor]').forEach(editor => {
            const active = editor.dataset.pivotDagInputDefaultEditor === (['object', 'array'].includes(type) ? 'json' : type);
            editor.classList.toggle('is-visible', active);
            editor.hidden = !active;
        });
        const editor = defaultEditorForType(control, type);
        if (editor) {
            if (type === 'boolean') editor.value = value === true ? 'true' : value === false ? 'false' : '';
            else if ((type === 'object' || type === 'array') && value !== undefined && value !== null && value !== '') {
                try { editor.value = JSON.stringify(value, null, 2); } catch (_) { editor.value = ''; }
            } else editor.value = value === undefined || value === null ? '' : String(value);
        }
        const hint = control.querySelector('[data-pivot-dag-workflow-input-default-hint]');
        if (hint) hint.textContent = type === 'text' ? '留空时由运行时输入决定。' : type === 'number'
            ? '会作为数字默认值传入运行时。' : type === 'boolean' ? '未设置、是、否三种状态会被准确保留。'
                : `请输入合法 JSON ${type === 'array' ? '数组' : '对象'}。`;
    };
    const bindWorkflowInputDefault = ({ control, typeControl, setActiveField, showToast }) => {
        const syncType = () => {
            const priorType = normalizedWorkflowInputType(control.dataset.pivotDagWorkflowInputDefaultType);
            const value = workflowInputDefaultFromControl(control, priorType);
            if (value === null) {
                if (typeControl) typeControl.value = priorType;
                showToast?.('请先修正默认值的 JSON 格式，再切换参数类型。', 'warning');
                return;
            }
            hydrateWorkflowInputDefault(control, typeControl?.value || 'text', value);
            setActiveField(control);
        };
        typeControl?.addEventListener('change', syncType);
        control.addEventListener('focusin', () => setActiveField(control));
        control.addEventListener('input', () => setActiveField(control));
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
    const bindChannelBindingPicker = ({ control, setActiveField, apiFetchFn, apiBase, showToast }) => {
        const select = control.querySelector('[data-pivot-dag-channel-binding-select]');
        const loadButton = control.querySelector('[data-pivot-dag-channel-binding-load]');
        const renderBindings = (bindings, currentValue = '') => {
            const labels = { wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };
            const active = (Array.isArray(bindings) ? bindings : []).filter(binding => {
                const platform = String(binding?.config?.platform || '').trim().toLowerCase();
                return binding?.status === 'active' && Object.hasOwn(labels, platform);
            });
            const current = String(currentValue || '').trim();
            const knownCurrent = active.some(binding => String(binding.id) === current);
            PivotSafeHtml.setHtml(select, [
                `<option value="">${active.length ? '请选择受控渠道绑定' : '暂无可用渠道绑定'}</option>`,
                current && !knownCurrent ? `<option value="${dagEscapeAttr(current)}">${dagEscapeHtml(`当前绑定（不可用）：${current}`)}</option>` : '',
                ...active.map(binding => {
                    const platform = String(binding?.config?.platform || '').trim().toLowerCase();
                    const label = `${labels[platform]} · ${binding.channelKey || binding.id}`;
                    return `<option value="${dagEscapeAttr(binding.id)}" data-pivot-dag-channel-platform="${dagEscapeAttr(platform)}">${dagEscapeHtml(label)}</option>`;
                })
            ].join(''));
            select.value = current;
            select.disabled = !active.length && !current;
            return active.length;
        };
        select?.addEventListener('change', () => setActiveField(control));
        loadButton?.addEventListener('click', async () => {
            const originalText = loadButton.textContent;
            loadButton.disabled = true;
            loadButton.textContent = '正在读取…';
            try {
                const response = await apiFetchFn(`${apiBase}/agents/channels?status=active`, { cache: 'no-store' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '读取可用渠道失败。');
                const count = renderBindings(Array.isArray(data.data) ? data.data : [], select?.value || '');
                showToast?.(count ? `已读取 ${count} 个可用通知渠道。` : '没有可用于工作流通知的活跃渠道。', count ? 'success' : 'warning');
            } catch (error) {
                showToast?.(error.message || '读取可用渠道失败。', 'error');
            } finally {
                loadButton.disabled = false;
                loadButton.textContent = originalText;
            }
        });
    };
    const bindConditionCompareField = ({ fieldsByName, setActiveField }) => {
        const operator = fieldsByName.get('operator');
        const compare = fieldsByName.get('compareTo') || fieldsByName.get('compare_to');
        const wrapper = compare?.closest?.('[data-pivot-dag-wizard-field-wrap]');
        if (!operator || !wrapper) return () => {};
        const comparisonOperators = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than']);
        const sync = () => {
            const visible = comparisonOperators.has(String(operator.value || '').trim());
            wrapper.hidden = !visible;
            wrapper.setAttribute('aria-hidden', visible ? 'false' : 'true');
        };
        operator.addEventListener('change', () => {
            setActiveField(operator);
            sync();
        });
        sync();
        return sync;
    };
    const bindOutputPresentationFields = ({ fieldsByName, setActiveField }) => {
        const presentation = fieldsByName.get('presentation');
        if (!presentation) return () => {};
        const wrappers = {
            table: ['tableTitle', 'tableColumns', 'table_title', 'table_columns'],
            file: ['fileRef', 'file_ref']
        };
        const all = [...new Set(Object.values(wrappers).flat())];
        const sync = () => {
            const mode = String(presentation.value || 'default').trim();
            all.forEach(field => {
                const wrapper = fieldsByName.get(field)?.closest?.('[data-pivot-dag-wizard-field-wrap]');
                if (!wrapper) return;
                const visible = mode === 'table' ? wrappers.table.includes(field) : mode === 'file' && wrappers.file.includes(field);
                wrapper.hidden = !visible;
                wrapper.setAttribute('aria-hidden', visible ? 'false' : 'true');
            });
        };
        presentation.addEventListener('change', () => {
            setActiveField(presentation);
            sync();
        });
        sync();
        return sync;
    };
    const bindBrowserTargetVisibility = ({ fieldsByName, setActiveField }) => {
        const action = fieldsByName.get('action');
        const target = fieldsByName.get('target');
        const wrapper = target?.closest?.('[data-pivot-dag-wizard-field-wrap]');
        if (!action || !wrapper) return () => {};
        const sync = () => {
            const visible = String(action.value || 'inspect') === 'click';
            wrapper.hidden = !visible;
            wrapper.setAttribute('aria-hidden', visible ? 'false' : 'true');
        };
        action.addEventListener('change', () => {
            setActiveField(action);
            sync();
        });
        sync();
        return sync;
    };
    const credentialValueFromControl = control => {
        const select = control.querySelector('[data-pivot-dag-credential-select]');
        if (select?.value === '__manual__') return String(control.querySelector('[data-pivot-dag-credential-manual]')?.value || '').trim() || undefined;
        return String(select?.value || '').trim() || undefined;
    };
    const syncCredentialPicker = (control, value = '') => {
        const select = control.querySelector('[data-pivot-dag-credential-select]');
        const manual = control.querySelector('[data-pivot-dag-credential-manual]');
        if (!select) return;
        const current = String(value || '').trim();
        const known = [...select.options].some(option => option.value === current);
        select.value = known ? current : (current ? '__manual__' : '');
        if (manual) {
            manual.value = known ? '' : current;
            manual.classList.toggle('is-visible', select.value === '__manual__');
        }
    };
    const bindCredentialPicker = ({ control, setActiveField, apiFetchFn, apiBase, showToast }) => {
        const select = control.querySelector('[data-pivot-dag-credential-select]');
        const manual = control.querySelector('[data-pivot-dag-credential-manual]');
        const loadButton = control.querySelector('[data-pivot-dag-credential-load]');
        const renderCredentials = (credentials, current = credentialValueFromControl(control)) => {
            const list = (Array.isArray(credentials) ? credentials : []).filter(item => String(item?.slug || '').trim());
            const known = list.some(item => String(item.slug).trim() === String(current || '').trim());
            PivotSafeHtml.setHtml(select, [
                '<option value="">不使用受控凭据</option>',
                ...list.map(item => {
                    const slug = String(item.slug || '').trim();
                    return `<option value="${dagEscapeAttr(slug)}">${dagEscapeHtml(`${item.name || slug} · ${slug}`)}</option>`;
                }),
                `<option value="__manual__">${current && !known ? '当前引用（未在凭据库中）' : '兼容：手动填写引用名'}</option>`
            ].join(''));
            syncCredentialPicker(control, current);
            return list.length;
        };
        select?.addEventListener('change', () => {
            setActiveField(control);
            const manualMode = select.value === '__manual__';
            manual?.classList.toggle('is-visible', manualMode);
            if (manualMode) manual?.focus?.({ preventScroll: true });
            else if (manual) manual.value = '';
        });
        manual?.addEventListener('input', () => setActiveField(control));
        loadButton?.addEventListener('click', async () => {
            const originalText = loadButton.textContent;
            loadButton.disabled = true;
            loadButton.textContent = '正在读取…';
            try {
                const response = await apiFetchFn(`${apiBase}/agents/credentials`, { cache: 'no-store' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '读取受控凭据失败。');
                const count = renderCredentials(Array.isArray(data.data) ? data.data : []);
                showToast?.(count ? `已读取 ${count} 个可用凭据。` : '没有可用的受控凭据。', count ? 'success' : 'warning');
            } catch (error) {
                showToast?.(error.message || '读取受控凭据失败。', 'error');
            } finally {
                loadButton.disabled = false;
                loadButton.textContent = originalText;
            }
        });
        syncCredentialPicker(control, credentialValueFromControl(control));
    };

    return {
        approvalLevelsFromControl,
        approvalTagsFromControl,
        bindConditionCompareField,
        bindChannelBindingPicker,
        bindCredentialPicker,
        bindBrowserTargetVisibility,
        bindOutputPresentationFields,
        bindTagList,
        bindWorkflowInputDefault,
        browserTargetFromControl,
        columnFieldsFromControl,
        credentialValueFromControl,
        groupFieldsFromControl,
        keyValueMapFromControl,
        renderApprovalLevels,
        renderApprovalTags,
        renderTagList,
        renderColumnFields,
        renderDataFieldPicker,
        renderGroupFields,
        renderKeyValueRows,
        renderResourceOptions,
        syncApprovalLevelSource,
        syncBrowserTargetMode,
        syncCredentialPicker,
        syncResourcePicker,
        tagListValuesFromControl,
        workflowInputDefaultFromControl,
        hydrateWorkflowInputDefault
    };
}
