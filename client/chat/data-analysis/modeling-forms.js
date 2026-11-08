(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const m = app.modeling, { state } = m, { esc } = app;
    const byId = id => document.getElementById(id);
    const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
    const input = (name, label, value = '', attributes = '') => `<label><span class="modeling-field-label">${esc(label)}</span><input class="form-input" name="modeling_${name}" value="${esc(value)}" ${attributes}></label>`;
    const select = (name, label, values, value) => `<label><span class="modeling-field-label">${esc(label)}</span><select class="form-input" name="modeling_${name}">${values.map(([key, itemLabel]) => option(key, itemLabel, key === value)).join('')}</select></label>`;
    const checkbox = (name, label, checked = false) => `<label class="modeling-checkbox"><input type="checkbox" name="modeling_${name}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    const datasets = () => app.state.datasets || [];
    const nodeOptions = () => (state.draft?.nodes || []).map(node => [node.id, node.name]);

    function columns(nodeId) {
        const node = state.draft?.nodes.find(item => item.id === nodeId);
        return state.selected?.sources?.find(source => source.nodeId === nodeId)?.columns || datasets().find(dataset => dataset.id === node?.datasetId)?.columns || [];
    }
    const fields = nodeId => columns(nodeId).map(column => [column.key, column.name]);
    const many = (name, label, choices, values = []) => `<div class="modeling-multi-group" data-modeling-multi-group><div class="modeling-multi-head"><span class="modeling-field-label">${esc(label)}</span><div class="modeling-multi-actions"><button class="btn-secondary" type="button" data-modeling-multi-action="all">全选</button><button class="btn-secondary" type="button" data-modeling-multi-action="clear">清空</button></div></div><select class="form-input modeling-multi-select" name="modeling_${name}" multiple aria-label="${esc(label)}">${choices.map(([key, itemLabel]) => option(key, itemLabel, values.includes(key))).join('')}</select><span class="modeling-field-hint">点击选项即可直接勾选或取消，无需按住 Ctrl 键。</span></div>`;

    let submitHandler = null, restoreFocus = null, dialogCurrent = () => false;
    function closeDialog() {
        state.requests.set('dialog', (state.requests.get('dialog') || 0) + 1);
        byId('data-analysis-modeling-dialog')?.classList.add('hidden');
        submitHandler = null;
        dialogCurrent = () => false;
        restoreFocus?.focus?.();
        restoreFocus = null;
    }
    function dialog(title, markup, handler) {
        m.mount();
        const modal = byId('data-analysis-modeling-dialog');
        const view = byId('data-analysis-view');
        if (modal && view && modal.parentElement !== view) view.appendChild(modal);
        restoreFocus = document.activeElement;
        byId('modeling-dialog-title').textContent = title;
        m.html(byId('modeling-dialog-body'), markup);
        byId('modeling-dialog-error').textContent = '';
        submitHandler = handler;
        dialogCurrent = m.capture('dialog');
        const submitBtn = byId('modeling-dialog-form').querySelector('[type="submit"]');
        submitBtn.disabled = false;
        submitBtn.classList.toggle('hidden', !handler);
        submitBtn.textContent = '确认';
        app.openModal('data-analysis-modeling-dialog');
    }
    function control(form, name) { return form.elements.namedItem(`modeling_${name}`); }
    function value(form, name) { return control(form, name)?.value || ''; }
    function number(form, name) { return Number(value(form, name)); }
    function checked(form, name) { return Boolean(control(form, name)?.checked); }
    function selected(form, name) { return Array.from(control(form, name)?.selectedOptions || [], item => item.value); }

    function expressionMarkup(expression = { constant: '0' }, currentId = '') {
        const kind = expression.metricId ? 'metric' : Object.hasOwn(expression, 'constant') ? 'constant' : expression.op;
        let content;
        if (kind === 'metric') content = `<select class="form-input" data-expression-metric aria-label="依赖指标">${state.draft.metrics.filter(metric => metric.id !== currentId).map(metric => option(metric.id, metric.name, metric.id === expression.metricId)).join('')}</select>`;
        else if (kind === 'constant') content = `<input class="form-input" data-expression-constant aria-label="十进制常量" value="${esc(expression.constant || '0')}" maxlength="128">`;
        else content = (expression.args || [{ constant: '0' }, { constant: '0' }]).map(arg => expressionMarkup(arg, currentId)).join('');
        return `<div class="modeling-expression-node"><select class="form-input" data-expression-kind aria-label="公式操作">${[['metric', '引用已有指标'], ['constant', '固定数值常量'], ['add', '相加 (+)'], ['subtract', '相减 (-)'], ['multiply', '相乘 (×)'], ['divide', '安全相除 (÷)']].map(([key, itemLabel]) => option(key, itemLabel, key === kind)).join('')}</select><div class="modeling-expression-body">${content}</div></div>`;
    }
    function expressionValue(node) {
        const kind = node.querySelector(':scope > [data-expression-kind]').value;
        const body = node.querySelector(':scope > .modeling-expression-body');
        if (kind === 'metric') return { metricId: body.querySelector('[data-expression-metric]')?.value || '' };
        if (kind === 'constant') return { constant: body.querySelector('[data-expression-constant]')?.value || '0' };
        return { op: kind, args: Array.from(body.children).filter(child => child.classList.contains('modeling-expression-node')).map(expressionValue) };
    }

    function filterFieldOptions(definition = state.draft, dimensionsOnly = false) {
        return [...(definition?.dimensions || []).map(dimension => [`d:${dimension.id}`, `维度 · ${dimension.name}`]), ...(dimensionsOnly ? [] : definition?.nodes || []).flatMap(node => fields(node.id).map(([key, label]) => [`f:${node.id}:${key}`, `${node.name} · ${label}`]))];
    }
    function filterRow(filter = {}, definition = state.draft, dimensionsOnly = false) {
        const selectedKey = filter.dimensionId ? `d:${filter.dimensionId}` : filter.field ? `f:${filter.field.nodeId}:${filter.field.fieldKey}` : '';
        return `<div class="modeling-filter-row">${select('filterField', '筛选字段', [['', '请选择字段或维度'], ...filterFieldOptions(definition, dimensionsOnly)], selectedKey)}${select('filterOperator', '条件', [['eq', '等于'], ['in', '属于多个值'], ['range', '区间（含起、不含止）'], ['is_null', '为空'], ['is_not_null', '不为空'], ['contains', '包含文本']], filter.operator || 'eq')}<label><span class="modeling-field-label">筛选值</span><textarea class="form-input" name="modeling_filterValue" rows="2" maxlength="20000" placeholder="多个值每行填写一个；区间分两行填写起点与终点">${esc(Array.isArray(filter.value) ? filter.value.join('\n') : filter.value ?? '')}</textarea></label><button type="button" class="btn-secondary" data-modeling-remove-filter>移除条件</button></div>`;
    }
    function readFilters(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll('.modeling-filter-row')).filter(row => row.querySelector('[name="modeling_filterField"]').value).map(row => {
            const reference = row.querySelector('[name="modeling_filterField"]').value.split(':');
            const result = reference[0] === 'd' ? { dimensionId: reference[1] } : { field: { nodeId: reference[1], fieldKey: reference[2] } };
            result.operator = row.querySelector('[name="modeling_filterOperator"]').value;
            const text = row.querySelector('[name="modeling_filterValue"]').value;
            if (!['is_null', 'is_not_null'].includes(result.operator)) result.value = ['in', 'range'].includes(result.operator) ? text.split('\n').filter(item => item.length) : text;
            return result;
        });
    }

    function editNode(nodeId = '', preset = {}) {
        const node = state.draft.nodes.find(item => item.id === nodeId);
        const datasetId = node?.datasetId || preset.datasetId || datasets().find(dataset => !state.draft.nodes.some(item => item.datasetId === dataset.id))?.id || '';
        if (!node) m.assertCanvasDataset(datasetId);
        const dataset = datasets().find(item => item.id === datasetId);
        const isFact = node?.role === 'fact';
        dialog(node ? (isFact ? '设置事实表与业务粒度' : '编辑维度表与主键') : '添加维度表', `${select('datasetId', '来源数据集', datasets().filter(item => item.id === datasetId || !state.draft.nodes.some(existing => existing.datasetId === item.id)).map(item => [item.id, item.name]), datasetId)}${input('name', '模型中的表名称', node?.name || dataset?.name || '', 'maxlength="120" required')}
            ${isFact ? `<label class="modeling-span-full"><span class="modeling-field-label">每一行代表什么业务记录（必填）</span><textarea name="modeling_grainDescription" class="form-input" maxlength="1000" rows="2" placeholder="例如：每一行代表一条订单商品明细，或一名学生的单次考试记录">${esc(state.draft.grainDescription || '')}</textarea></label>` : ''}
            ${many('grainKeys', isFact ? '唯一业务粒度键（勾选能唯一确定一行记录的字段组合）' : '维度表主键（用于被主表关联的唯一标识字段）', (dataset?.columns || []).map(column => [column.key, column.name]), node?.grainKeys || [])}
            <p class="modeling-dialog-note">提示：编号类字段会自动保留前导零；提交检查时将自动核验您勾选的主键是否存在空值或重复行。</p>`, form => {
            const next = { ...(node || { id: `node_${m.key().replaceAll('-', '')}`, role: 'dimension' }), datasetId: value(form, 'datasetId'), name: value(form, 'name'), grainKeys: selected(form, 'grainKeys'), grainNormalization: node?.grainNormalization || {} };
            if (node) state.draft.nodes[state.draft.nodes.indexOf(node)] = next;
            else { m.assertCanvasDataset(next.datasetId); if (preset.layout) state.canvasLayout[next.id] = { ...preset.layout }; state.draft.nodes.push(next); }
            if (next.role === 'fact') state.draft.grainDescription = value(form, 'grainDescription');
            state.selectedNodeId = next.id;
            m.changed();
            m.render();
        });
        if (node) control(byId('modeling-dialog-form'), 'datasetId').disabled = true;
    }

    function suggestJoinPair(leftNodeId, rightNodeId, preset = {}) {
        if (preset.leftFieldKey || preset.rightFieldKey) {
            return { leftFieldKey: preset.leftFieldKey || '', rightFieldKey: preset.rightFieldKey || '' };
        }
        const rightNode = state.draft?.nodes.find(item => item.id === rightNodeId);
        const leftCols = columns(leftNodeId), rightCols = columns(rightNodeId);
        const preferredRightKey = rightNode?.grainKeys?.[0] || '';
        const normalizeColName = text => String(text || '').trim().toLowerCase();
        const rightCol = rightCols.find(col => col.key === preferredRightKey)
            || rightCols.find(col => leftCols.some(leftCol => normalizeColName(leftCol.name) === normalizeColName(col.name)));
        if (!rightCol) return { leftFieldKey: '', rightFieldKey: '' };
        const rightName = normalizeColName(rightCol.name);
        const leftCol = leftCols.find(col => normalizeColName(col.name) === rightName)
            || (!/^c_\d+$/i.test(rightCol.key) ? leftCols.find(col => col.key === rightCol.key) : null);
        return leftCol ? { leftFieldKey: leftCol.key, rightFieldKey: rightCol.key } : { leftFieldKey: '', rightFieldKey: rightCol.key };
    }

    function editRelation(relationId = '', preset = {}) {
        const relation = state.draft.relations.find(item => item.id === relationId);
        if (state.draft.nodes.length < 2) throw new Error('请先从左侧添加至少一张维度表，再配置表关联。');
        const left = relation?.leftNodeId || preset.leftNodeId || state.draft.nodes.find(node => node.role === 'fact')?.id;
        const right = relation?.rightNodeId || preset.rightNodeId || state.draft.nodes.find(node => node.role === 'dimension')?.id;
        const firstDefault = relation ? (relation.keyPairs[0] || {}) : suggestJoinPair(left, right, preset);
        const pairs = Array.from({ length: 3 }, (_, index) => relation?.keyPairs[index] || (index === 0 ? firstDefault : {}));
        const hasAdvanced = Boolean(relation?.minMatchRate || relation?.keyPairs?.length > 1 || (relation?.keyPairs || []).some(p => p.normalization && (p.normalization.type !== 'text' || p.normalization.trim || p.normalization.emptyAsNull || p.normalization.caseSensitive === false)));
        const primaryPair = pairs[0];
        const extraPairMarkup = (pair, index) => `<fieldset data-modeling-key-pair="${index}"><legend>附加关联键 ${index + 1}（复合主键时使用）</legend>${select(`leftKey${index}`, '父表字段', [['', '不使用此键对'], ...fields(left)], pair.leftFieldKey || '')}${select(`rightKey${index}`, '维度表字段', [['', '不使用此键对'], ...fields(right)], pair.rightFieldKey || '')}${select(`keyType${index}`, '比较类型', [['text', '文本'], ['integer', '整数'], ['decimal', '精确小数'], ['date', '日期（年-月-日）']], pair.normalization?.type || 'text')}${checkbox(`trim${index}`, '去除首尾空格', pair.normalization?.trim)}${checkbox(`empty${index}`, '空字符串视为空值', pair.normalization?.emptyAsNull)}${checkbox(`ignoreCase${index}`, '忽略字母大小写', pair.normalization?.caseSensitive === false)}</fieldset>`;
        dialog(relation ? '编辑关联' : '添加关联', `${select('leftNodeId', '父表（提供外键的主表）', nodeOptions(), left)}${select('rightNodeId', '维度表（提供属性字典的表）', state.draft.nodes.filter(node => node.role === 'dimension').map(node => [node.id, node.name]), right)}${select('joinType', '关联方式', [['left', '左关联（推荐：保留父表全部记录）'], ['inner', '内关联（仅保留两表都匹配的记录）']], relation?.joinType || 'left')}${select('cardinality', '对应关系（父表 → 维度表）', [['many_to_one', '多对一（常见：多条业务明细对应一个维度项）'], ['one_to_one', '一对一（两表记录一一对应）']], relation?.cardinality || 'many_to_one')}
            <fieldset id="modeling-relation-primary" data-modeling-key-pair="0"><legend>关联字段配对</legend>${select('leftKey0', '父表关联字段', [['', '请选择父表字段'], ...fields(left)], primaryPair.leftFieldKey || '')}${select('rightKey0', '维度表主键字段', [['', '请选择维度表字段'], ...fields(right)], primaryPair.rightFieldKey || '')}</fieldset>
            <details class="modeling-advanced-panel"${hasAdvanced ? ' open' : ''}><summary>复合关联键、匹配率阈值与字符清洗规则（高级可选）</summary><div class="modeling-advanced-grid" id="modeling-relation-pairs">${select('keyType0', '主关联键比较类型', [['text', '文本（默认保留前导零）'], ['integer', '整数'], ['decimal', '精确小数'], ['date', '日期（年-月-日）']], primaryPair.normalization?.type || 'text')}${input('minMatchRate', '最低期望匹配率（0—1，可留空）', relation?.minMatchRate || '', 'inputmode="decimal" maxlength="10" placeholder="例如：0.95"')}<div class="modeling-checkbox-row">${checkbox('trim0', '主关联键去除首尾空格', primaryPair.normalization?.trim)}${checkbox('empty0', '空字符串视为空键', primaryPair.normalization?.emptyAsNull)}${checkbox('ignoreCase0', '忽略字母大小写', primaryPair.normalization?.caseSensitive === false)}</div>${extraPairMarkup(pairs[1], 1)}${extraPairMarkup(pairs[2], 2)}</div></details>`, form => {
            const keyPairs = [];
            for (let index = 0; index < 3; index++) {
                const leftFieldKey = value(form, `leftKey${index}`), rightFieldKey = value(form, `rightKey${index}`);
                if (!leftFieldKey && !rightFieldKey) continue;
                if (!leftFieldKey || !rightFieldKey) throw new Error('每一对关联键必须同时选择父表字段与维度表字段。');
                const normalization = { type: value(form, `keyType${index}`), trim: checked(form, `trim${index}`), emptyAsNull: checked(form, `empty${index}`), caseSensitive: !checked(form, `ignoreCase${index}`) };
                if (normalization.type === 'decimal') { normalization.precision = 18; normalization.scale = 2; }
                keyPairs.push({ leftFieldKey, rightFieldKey, normalization });
            }
            if (!keyPairs.length) throw new Error('请至少选择一对关联字段。');
            const next = { id: relation?.id || `relation_${m.key().replaceAll('-', '')}`, leftNodeId: value(form, 'leftNodeId'), rightNodeId: value(form, 'rightNodeId'), joinType: value(form, 'joinType'), cardinality: value(form, 'cardinality'), keyPairs };
            if (value(form, 'minMatchRate')) next.minMatchRate = value(form, 'minMatchRate');
            m.assertCanvasRelation(next.leftNodeId, next.rightNodeId, relation?.id || '');
            if (relation) state.draft.relations[state.draft.relations.indexOf(relation)] = next;
            else state.draft.relations.push(next);
            m.changed();
            m.render();
        });
    }

    function dimensionTypeChanged() {
        const form = byId('modeling-dialog-form');
        if (!form || !byId('modeling-dimension-date-group')) return;
        const type = value(form, 'logicalType');
        byId('modeling-dimension-date-group').classList.toggle('hidden', !['date', 'timestamp'].includes(type));
        byId('modeling-dimension-format-group')?.classList.toggle('hidden', type !== 'date');
    }

    function editDimension(dimensionId = '', preset = {}) {
        const dimension = state.draft.dimensions.find(item => item.id === dimensionId);
        const nodeId = dimension?.nodeId || preset.nodeId || state.draft.nodes[0]?.id;
        const initialFieldKey = dimension?.fieldKey || preset.fieldKey || fields(nodeId)[0]?.[0] || '';
        const initialName = dimension?.name || preset.name || '';
        const hasAdvanced = Boolean(dimension && ((dimension.memberKeyFields || []).length > 1 || dimension.hierarchyId || dimension.sort === 'desc' || (dimension.nullLabel && dimension.nullLabel !== '空值')));
        dialog(dimension ? '编辑维度' : '添加维度', `${input('name', '维度名称', initialName, 'maxlength="120" required placeholder="例如：所属地区、班级、下单月份"')}${select('nodeId', '来源表', nodeOptions(), nodeId)}${select('fieldKey', '来源展示字段', fields(nodeId), initialFieldKey)}${select('logicalType', '维度数据类型', [['text', '文本分类（如地区、部门、姓名）'], ['enum', '固定枚举分类'], ['date', '日期（可按年/季/月/日汇总）'], ['timestamp', '带时区的时间点']], dimension?.logicalType || preset.logicalType || 'text')}
            <div id="modeling-dimension-date-group" class="modeling-inline-pair">${select('granularity', '日期汇总粒度', [['day', '按日'], ['month', '按月'], ['quarter', '按季度'], ['year', '按年']], dimension?.granularity || 'day')}<div id="modeling-dimension-format-group">${select('dateFormat', '原始日期文本格式', [['%Y-%m-%d', '2026-11-07（年-月-日）'], ['%Y/%m/%d', '2026/11/07（年/月/日）'], ['%Y%m%d', '20261107（紧凑八位）']], dimension?.dateFormat || '%Y-%m-%d')}</div></div>
            <label class="modeling-span-full"><span class="modeling-field-label">业务说明（可选）</span><textarea class="form-input" name="modeling_description" rows="2" maxlength="1000" placeholder="可选：说明该维度的分类口径或适用场景">${esc(dimension?.description || '')}</textarea></label>
            <details class="modeling-advanced-panel"${hasAdvanced ? ' open' : ''}><summary>同名成员区分键、层级钻取与排序空值设置（高级可选）</summary><div class="modeling-advanced-grid">${many('memberKeyFields', '稳定成员键（存在重名成员时勾选编码字段加以区分，留空默认使用展示字段）', fields(nodeId), dimension?.memberKeyFields || [])}${select('sort', '默认排序方式', [['asc', '升序排列'], ['desc', '降序排列']], dimension?.sort || 'asc')}${input('nullLabel', '空值展示文案', dimension?.nullLabel || '空值', 'maxlength="120"')}${input('hierarchyId', '钻取层级组标识（可选）', dimension?.hierarchyId || '', 'maxlength="120" placeholder="例如：地理区域"')}${input('hierarchyLevel', '层级顺序（1 为最高层）', dimension?.hierarchyLevel || 1, 'type="number" min="1" max="120"')}</div></details>`, form => {
            const next = { id: dimension?.id || `dimension_${m.key().replaceAll('-', '')}`, name: value(form, 'name'), description: value(form, 'description'), nodeId: value(form, 'nodeId'), fieldKey: value(form, 'fieldKey'), logicalType: value(form, 'logicalType'), memberKeyFields: selected(form, 'memberKeyFields'), sort: value(form, 'sort'), nullLabel: value(form, 'nullLabel') };
            if (!next.memberKeyFields.length) next.memberKeyFields = [next.fieldKey];
            if (['date', 'timestamp'].includes(next.logicalType)) next.granularity = value(form, 'granularity');
            if (next.logicalType === 'date') next.dateFormat = value(form, 'dateFormat');
            if (value(form, 'hierarchyId')) { next.hierarchyId = value(form, 'hierarchyId'); next.hierarchyLevel = number(form, 'hierarchyLevel'); }
            if (dimension) state.draft.dimensions[state.draft.dimensions.indexOf(dimension)] = next;
            else {
                state.draft.dimensions.push(next);
                for (const metric of state.draft.metrics) metric.allowedDimensionIds.push(next.id);
            }
            m.changed();
            m.render();
        });
        dimensionTypeChanged();
    }

    function metricTypeChanged() {
        const form = byId('modeling-dialog-form');
        if (!form || !byId('modeling-metric-expression')) return;
        const type = value(form, 'type');
        const currencyMode = value(form, 'currencyMode');
        byId('modeling-metric-expression').classList.toggle('hidden', type !== 'derived');
        byId('modeling-metric-source').classList.toggle('hidden', type === 'derived' || type === 'count');
        byId('modeling-metric-currency').classList.toggle('hidden', type === 'derived' || type.startsWith('count'));
        byId('modeling-metric-currency-fixed')?.classList.toggle('hidden', currencyMode !== 'fixed');
        byId('modeling-metric-currency-field')?.classList.toggle('hidden', currencyMode !== 'field');
    }

    function editMetric(metricId = '', preset = {}) {
        const metric = state.draft.metrics.find(item => item.id === metricId), fact = state.draft.nodes.find(node => node.role === 'fact');
        if (!fact) throw new Error('请先选择事实表。');
        const numeric = metric?.numeric || {};
        const initialType = metric?.type || preset.type || 'sum';
        const initialFieldKey = metric?.field?.fieldKey || preset.fieldKey || fields(fact.id)[0]?.[0] || '';
        const initialCurrencyMode = metric?.currency ? 'fixed' : metric?.currencyField ? 'field' : 'none';
        const hasAdvanced = Boolean(metric && (metric.grainKey || metric.required || metric.invalidValuePolicy === 'ignore' || metric.validFrom || metric.validTo || (metric.filters || []).length));
        dialog(metric ? '编辑指标口径' : '添加指标口径', `<input type="hidden" name="modeling_metricId" value="${esc(metricId)}">${input('name', '指标名称', metric?.name || preset.name || '', 'maxlength="120" required placeholder="例如：实付金额、平均分、订单笔数"')}${select('type', '统计计算方式', [['sum', '求和（如金额、总分）'], ['avg', '平均值（如均价、平均分）'], ['count', '事实记录数（统计总行数）'], ['count_distinct', '精确去重计数（如去重客户数）'], ['count_nonnull', '非空值计数'], ['max', '最大值'], ['min', '最小值'], ['derived', '派生指标公式（基于已有指标运算）']], initialType)}
            <div id="modeling-metric-source" class="modeling-span-full">${select('fieldKey', `计算来源字段（来自事实表「${fact.name}」）`, fields(fact.id), initialFieldKey)}</div>
            <fieldset id="modeling-metric-expression"><legend>派生计算公式</legend>${expressionMarkup(metric?.expression, metricId)}</fieldset>
            <label class="modeling-span-full"><span class="modeling-field-label">业务定义与口径说明（必填）</span><textarea class="form-input" name="modeling_description" rows="2" maxlength="1000" required placeholder="请用通俗语言说明统计口径，例如：统计事实表实付金额合计">${esc(metric?.description || preset.description || '')}</textarea></label>
            ${input('unit', '展示单位（可选）', metric?.unit || '', 'maxlength="80" placeholder="如：元、分、人、单"')}${input('scale', '展示保留小数位', metric?.scale ?? 2, 'type="number" min="0" max="38"')}
            <fieldset id="modeling-metric-currency"><legend>金额与币种设置</legend>${select('currencyMode', '币种规则', [['none', '普通数值（不涉及币种）'], ['fixed', '固定单一币种（如人民币 CNY）'], ['field', '按事实表中的币种字段区分']], initialCurrencyMode)}<div id="modeling-metric-currency-fixed">${input('currency', '固定币种代码（三位大写）', metric?.currency || 'CNY', 'maxlength="3" placeholder="如 CNY"')}</div><div id="modeling-metric-currency-field">${select('currencyFieldKey', '币种所在字段', fields(fact.id), metric?.currencyField?.fieldKey)}</div></fieldset>
            <details class="modeling-advanced-panel"${hasAdvanced ? ' open' : ''}><summary>数值解析精度、允许分组维度、有效期与附加筛选条件（高级可选）</summary><div class="modeling-advanced-grid">${checkbox('grainKey', '去重计数时直接使用完整事实粒度键', metric?.grainKey)}${checkbox('required', '要求来源数值不能为空', metric?.required)}${input('precision', '来源十进制总精度', numeric.precision ?? 18, 'type="number" min="1" max="38"')}${input('numericScale', '来源数值小数位', numeric.scale ?? 2, 'type="number" min="0" max="38"')}<div class="modeling-checkbox-row">${checkbox('allowCurrency', '自动识别货币符号', numeric.allowCurrency)}${checkbox('allowThousands', '自动识别千分位逗号', numeric.allowThousands)}${checkbox('allowPercent', '识别百分号并折算比例', numeric.allowPercent)}</div>${select('invalidValuePolicy', '遇到异常非数值时处理策略', [['block', '严格阻断检查与计算（推荐）'], ['ignore', '忽略异常值并记录条数（非金额适用）']], metric?.invalidValuePolicy || 'block')}${many('allowedDimensionIds', '允许用于分组分析的维度（默认全部勾选）', state.draft.dimensions.map(dimension => [dimension.id, dimension.name]), metric?.allowedDimensionIds || state.draft.dimensions.map(dimension => dimension.id))}${input('validFrom', '口径生效时间（可留空）', metric?.validFrom || '', 'maxlength="40" placeholder="例如：2026-11-07T00:00:00+08:00"')}${input('validTo', '口径失效时间（可留空）', metric?.validTo || '', 'maxlength="40" placeholder="例如：2027-01-01T00:00:00+08:00"')}<fieldset><legend>指标专属附加筛选条件（在查询条件之上叠加）</legend><div id="modeling-metric-filters">${(metric?.filters || []).map(item => filterRow(item)).join('')}</div><button class="btn-secondary" type="button" data-modeling-add-metric-filter>+ 添加指标筛选条件</button></fieldset></div></details>`, form => {
            const type = value(form, 'type');
            const next = { id: metric?.id || `metric_${m.key().replaceAll('-', '')}`, name: value(form, 'name'), description: value(form, 'description'), type, scale: type.startsWith('count') ? 0 : number(form, 'scale'), unit: value(form, 'unit'), allowedDimensionIds: selected(form, 'allowedDimensionIds'), invalidValuePolicy: value(form, 'invalidValuePolicy'), required: checked(form, 'required'), filters: readFilters(byId('modeling-metric-filters')) };
            if (type === 'derived') next.expression = expressionValue(byId('modeling-metric-expression').querySelector('.modeling-expression-node'));
            else if (type === 'count_distinct' && checked(form, 'grainKey')) next.grainKey = true;
            else if (type !== 'count') next.field = { nodeId: fact.id, fieldKey: value(form, 'fieldKey') };
            if (['sum', 'avg', 'min', 'max'].includes(type)) next.numeric = { precision: number(form, 'precision'), scale: number(form, 'numericScale'), allowCurrency: checked(form, 'allowCurrency'), allowThousands: checked(form, 'allowThousands'), allowPercent: checked(form, 'allowPercent') };
            if (type !== 'derived' && value(form, 'currencyMode') === 'fixed') next.currency = value(form, 'currency');
            if (type !== 'derived' && value(form, 'currencyMode') === 'field') next.currencyField = { nodeId: fact.id, fieldKey: value(form, 'currencyFieldKey') };
            for (const key of ['validFrom', 'validTo']) if (value(form, key)) next[key] = value(form, key);
            if (metric) state.draft.metrics[state.draft.metrics.indexOf(metric)] = next;
            else state.draft.metrics.push(next);
            m.changed();
            m.render();
        });
        metricTypeChanged();
    }

    function formChanged(event) {
        const form = byId('modeling-dialog-form');
        if (!form?.contains(event.target)) return;
        const name = event.target.name?.replace(/^modeling_/, '');
        if (name === 'type' || name === 'currencyMode') metricTypeChanged();
        if (name === 'logicalType') dimensionTypeChanged();
        if (event.target.matches('[data-expression-kind]')) {
            const node = event.target.closest('.modeling-expression-node'), kind = event.target.value;
            const expression = kind === 'metric'
                ? { metricId: state.draft.metrics.find(metric => metric.id !== value(form, 'metricId'))?.id || '' }
                : kind === 'constant' ? { constant: '0' } : { op: kind, args: [{ constant: '0' }, { constant: '0' }] };
            const temporary = document.createElement('div');
            m.html(temporary, expressionMarkup(expression, value(form, 'metricId')));
            node.replaceWith(temporary.firstElementChild);
        }
        if (name === 'datasetId') {
            const dataset = datasets().find(item => item.id === event.target.value);
            const grain = control(form, 'grainKeys');
            if (grain) m.html(grain, (dataset?.columns || []).map(column => option(column.key, column.name)).join(''));
            if (control(form, 'name')) control(form, 'name').value = dataset?.name || '';
        }
        if (name === 'nodeId') {
            for (const fieldName of ['fieldKey', 'memberKeyFields']) {
                if (control(form, fieldName)) m.html(control(form, fieldName), fields(event.target.value).map(([key, label]) => option(key, label)).join(''));
            }
        }
        if (['leftNodeId', 'rightNodeId'].includes(name)) {
            const side = name === 'leftNodeId' ? 'left' : 'right';
            for (let index = 0; index < 3; index++) {
                const placeholder = index === 0 ? (side === 'left' ? '请选择父表字段' : '请选择维度表字段') : '不使用此键对';
                if (control(form, `${side}Key${index}`)) {
                    m.html(control(form, `${side}Key${index}`), option('', placeholder) + fields(event.target.value).map(([key, label]) => option(key, label)).join(''));
                }
            }
        }
    }

    async function submit(event) {
        if (event.target.id !== 'modeling-dialog-form') return;
        event.preventDefault();
        const current = dialogCurrent;
        if (!current()) { closeDialog(); return; }
        const submitBtn = event.target.querySelector('[type="submit"]');
        submitBtn.disabled = true;
        try {
            if (submitHandler) await submitHandler(event.target);
            if (current()) closeDialog();
        } catch (error) {
            if (current()) byId('modeling-dialog-error').textContent = error.message || '保存失败，请检查输入后重试。';
        } finally {
            if (current()) submitBtn.disabled = false;
        }
    }
    Object.assign(m, {
        dialog, closeDialog, editNode, editRelation, editDimension, editMetric,
        formChanged, submit, input, select, checkbox, many, fields, columns,
        value, number, checked, selected, filterRow, readFilters,
        filterRows: filters => filters.map(filter => filterRow(filter)).join(''),
        queryFilterRow: filter => filterRow(filter, state.queryMode === 'trial' ? state.draft : state.analysisDefinition, true)
    });
})();
