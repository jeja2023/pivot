/* 只读 SQL 可视化查询构建器 */

const VISUAL_SQL_OPERATOR_OPTIONS = [
    ['eq', '等于'],
    ['neq', '不等于'],
    ['contains', '包含'],
    ['startsWith', '开头是'],
    ['endsWith', '结尾是'],
    ['gt', '大于'],
    ['gte', '大于等于'],
    ['lt', '小于'],
    ['lte', '小于等于'],
    ['between', '介于'],
    ['in', '属于列表'],
    ['isNull', '为空'],
    ['notNull', '不为空'],
    ['today', '当天'],
    ['beforeToday', '早于当天'],
    ['afterToday', '晚于当天']
];

const VISUAL_SQL_TODAY_OPERATORS = new Set(['today', 'beforeToday', 'afterToday']);

const VISUAL_SQL_AGGREGATION_OPTIONS = [
    ['', '不做汇总'],
    ['count', '计数'],
    ['sum', '求和'],
    ['avg', '平均值'],
    ['min', '最小值'],
    ['max', '最大值']
];

const VISUAL_SQL_TEMPORAL_OPERATOR_LABELS = {
    eq: '等于',
    neq: '不等于',
    gt: '晚于',
    gte: '不早于',
    lt: '早于',
    lte: '不晚于',
    between: '时间范围',
    in: '属于列表',
    isNull: '为空',
    notNull: '不为空',
    today: '当天',
    beforeToday: '早于当天',
    afterToday: '晚于当天'
};

function isVisualSqlQueryTool(tool) {
    return toolShortName(tool) === 'db.run_readonly_query';
}

function queryBuilderString(value, fallback = '') {
    return String(value ?? fallback).trim();
}

function uniqueQueryBuilderStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => queryBuilderString(value))
        .filter(Boolean))];
}

function normalizeVisualSqlFilter(filter = {}) {
    const operator = VISUAL_SQL_OPERATOR_OPTIONS.some(([value]) => value === filter.operator)
        ? filter.operator
        : 'eq';
    return {
        field: queryBuilderString(filter.field),
        fieldType: queryBuilderString(filter.fieldType || filter.field_type),
        operator,
        value: queryBuilderString(filter.value),
        value2: queryBuilderString(filter.value2)
    };
}

function normalizeVisualSqlFilterRelation(value) {
    return queryBuilderString(value).toLowerCase() === 'or' ? 'or' : 'and';
}

function queryBuilderTemporalKind(fieldType = '') {
    const type = queryBuilderString(fieldType).toLowerCase();
    if (!type) return '';
    if (/(datetime|timestamp|timestamptz|smalldatetime|datetimeoffset)/.test(type)) return 'datetime';
    if (/\bdate\b/.test(type)) return 'date';
    if (/\btime\b/.test(type)) return 'time';
    return '';
}

function queryBuilderTemporalInputValue(value, kind = '') {
    const text = queryBuilderString(value);
    if (!text || !kind) return text;
    if (kind === 'date') return text.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
    if (kind === 'time') return text.match(/^\d{2}:\d{2}(?::\d{2})?/)?.[0] || '';
    const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    return match ? `${match[1]}T${match[2]}${match[3] ? `:${match[3]}` : ''}` : '';
}

function queryBuilderTemporalSqlValue(value, fieldType = '') {
    const kind = queryBuilderTemporalKind(fieldType);
    const normalized = queryBuilderTemporalInputValue(value, kind);
    if (kind !== 'datetime' || !normalized) return normalized;
    const [date, time] = normalized.split('T');
    return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}

function normalizeVisualSqlQueryBuilder(input = {}) {
    const source = input?.queryBuilder && typeof input.queryBuilder === 'object' && !Array.isArray(input.queryBuilder)
        ? input.queryBuilder
        : {};
    const hasSavedBuilder = Object.keys(source).length > 0;
    const rawMode = queryBuilderString(source.mode);
    const mode = rawMode === 'advanced' || (!hasSavedBuilder && queryBuilderString(input.sql)) ? 'advanced' : 'visual';
    const aggregation = VISUAL_SQL_AGGREGATION_OPTIONS.some(([value]) => value === source.aggregation)
        ? source.aggregation
        : '';
    return {
        mode,
        schema: queryBuilderString(source.schema),
        table: queryBuilderString(source.table),
        columns: uniqueQueryBuilderStrings(source.columns),
        filters: (Array.isArray(source.filters) ? source.filters : []).map(normalizeVisualSqlFilter).slice(0, 12),
        filterRelation: normalizeVisualSqlFilterRelation(source.filterRelation || source.filter_relation || source.filterLogic || source.filter_logic),
        aggregation,
        aggregationField: queryBuilderString(source.aggregationField || source.aggregation_field),
        groupBy: queryBuilderString(source.groupBy || source.group_by),
        sortBy: queryBuilderString(source.sortBy || source.sort_by),
        sortOrder: queryBuilderString(source.sortOrder || source.sort_order, 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        limit: Math.max(1, Math.min(Number.parseInt(source.limit ?? input.limit ?? 100, 10) || 100, 1000))
    };
}

function queryBuilderDialect(databaseType = '') {
    const type = queryBuilderString(databaseType).toLowerCase();
    if (type === 'mysql' || type === 'mariadb') return 'mysql';
    if (type === 'sqlserver' || type === 'mssql') return 'sqlserver';
    if (type === 'postgres' || type === 'postgresql') return 'postgres';
    return 'sqlite';
}

function queryBuilderSafeIdentifier(value) {
    const text = queryBuilderString(value);
    if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > 256) return '';
    return text;
}

function queryBuilderQuoteIdentifier(value, dialect = 'sqlite') {
    const text = queryBuilderSafeIdentifier(value);
    if (!text) return '';
    const parts = text.split('.');
    if (parts.some(part => !queryBuilderSafeIdentifier(part))) return '';
    const quote = dialect === 'mysql' ? '`' : dialect === 'sqlserver' ? '[' : '"';
    const close = dialect === 'sqlserver' ? ']' : quote;
    return parts.map(part => {
        const clean = queryBuilderSafeIdentifier(part);
        return `${quote}${clean.replace(new RegExp(quote === '[' ? '\\]' : quote, 'g'), quote === '[' ? ']]' : quote + quote)}${close}`;
    }).join('.');
}

function queryBuilderTableName(config, dialect) {
    const table = queryBuilderQuoteIdentifier(config.table, dialect);
    const schema = queryBuilderQuoteIdentifier(config.schema, dialect);
    if (!table) return '';
    return schema ? `${schema}.${table}` : table;
}

function queryBuilderLiteral(value) {
    return `'${queryBuilderString(value).replace(/'/g, "''")}'`;
}

function queryBuilderField(value, dialect) {
    return queryBuilderQuoteIdentifier(value, dialect);
}

function queryBuilderCurrentDateSql(dialect = 'sqlite') {
    if (dialect === 'mysql') return 'CURRENT_DATE';
    if (dialect === 'sqlserver') return 'CAST(GETDATE() AS date)';
    if (dialect === 'postgres') return 'CURRENT_DATE';
    return "date('now', '+8 hours')";
}

function queryBuilderDatePartSql(field, dialect, temporalKind) {
    if (temporalKind === 'date') return field;
    if (dialect === 'mysql') return `DATE(${field})`;
    if (dialect === 'sqlserver' || dialect === 'postgres') return `CAST(${field} AS date)`;
    return `date(${field})`;
}

function queryBuilderTodayFilterSql(filter, dialect, field) {
    const temporalKind = queryBuilderTemporalKind(filter.fieldType);
    if (!['date', 'datetime'].includes(temporalKind)) return '';
    const datePart = queryBuilderDatePartSql(field, dialect, temporalKind);
    const today = queryBuilderCurrentDateSql(dialect);
    if (filter.operator === 'beforeToday') return `${datePart} < ${today}`;
    if (filter.operator === 'afterToday') return `${datePart} > ${today}`;
    return `${datePart} = ${today}`;
}

function queryBuilderFilterSql(filter, dialect) {
    const field = queryBuilderField(filter.field, dialect);
    if (!field) return '';
    if (VISUAL_SQL_TODAY_OPERATORS.has(filter.operator)) return queryBuilderTodayFilterSql(filter, dialect, field);
    const filterValue = queryBuilderTemporalSqlValue(filter.value, filter.fieldType);
    const filterValue2 = queryBuilderTemporalSqlValue(filter.value2, filter.fieldType);
    const value = queryBuilderLiteral(filterValue);
    const value2 = queryBuilderLiteral(filterValue2);
    switch (filter.operator) {
        case 'neq': return `${field} <> ${value}`;
        case 'contains': return `${field} LIKE ${queryBuilderLiteral(`%${filter.value}%`)}`;
        case 'startsWith': return `${field} LIKE ${queryBuilderLiteral(`${filter.value}%`)}`;
        case 'endsWith': return `${field} LIKE ${queryBuilderLiteral(`%${filter.value}`)}`;
        case 'gt': return `${field} > ${value}`;
        case 'gte': return `${field} >= ${value}`;
        case 'lt': return `${field} < ${value}`;
        case 'lte': return `${field} <= ${value}`;
        case 'between': return `${field} BETWEEN ${value} AND ${value2}`;
        case 'in': {
            const values = filter.value.split(',').map(item => item.trim()).filter(Boolean);
            return values.length ? `${field} IN (${values.map(item => queryBuilderLiteral(queryBuilderTemporalSqlValue(item, filter.fieldType))).join(', ')})` : '';
        }
        case 'isNull': return `${field} IS NULL`;
        case 'notNull': return `${field} IS NOT NULL`;
        case 'eq':
        default:
            return `${field} = ${value}`;
    }
}

function buildVisualSqlQuery(config = {}, databaseType = '') {
    const builder = normalizeVisualSqlQueryBuilder({ queryBuilder: config });
    const dialect = queryBuilderDialect(databaseType);
    const issues = [];
    const tableName = queryBuilderTableName(builder, dialect);
    if (!tableName) issues.push('请先选择或填写数据表。');

    const columns = uniqueQueryBuilderStrings(builder.columns);
    const groupBy = queryBuilderField(builder.groupBy, dialect);
    const aggregateField = queryBuilderField(builder.aggregationField, dialect);
    if (builder.aggregation && builder.aggregation !== 'count' && !aggregateField) {
        issues.push('选择汇总方式后，请再选择统计字段。');
    }
    if (!builder.aggregation && !columns.length) issues.push('请至少选择一个返回字段。');
    if (builder.groupBy && !groupBy) issues.push('分组字段包含无效字符。');
    if (!builder.aggregation && ['__metric__', '__group__'].includes(builder.sortBy)) {
        issues.push('普通查询不能按统计值或分组值排序。');
    }
    if (builder.aggregation && builder.sortBy && !['__metric__', '__group__'].includes(builder.sortBy)) {
        issues.push('汇总查询只能按统计值或分组值排序。');
    }
    if (builder.sortBy === '__group__' && !groupBy) issues.push('按分组值排序前，请先选择分组字段。');
    const selectParts = [];
    if (builder.aggregation) {
        if (groupBy) selectParts.push(`${groupBy} AS ${queryBuilderQuoteIdentifier('group_value', dialect)}`);
        const aggregateExpression = builder.aggregation === 'count'
            ? 'COUNT(*)'
            : `${builder.aggregation.toUpperCase()}(${aggregateField})`;
        selectParts.push(`${aggregateExpression} AS ${queryBuilderQuoteIdentifier('metric_value', dialect)}`);
    } else {
        columns.forEach(column => {
            const field = queryBuilderField(column, dialect);
            if (!field) issues.push(`字段 ${column || '未命名'} 包含无效字符。`);
            else selectParts.push(field);
        });
    }
    if (!selectParts.length) issues.push('没有可生成的查询字段。');

    const filters = builder.filters
        .map(normalizeVisualSqlFilter)
        .filter(filter => filter.operator === 'isNull' || filter.operator === 'notNull' || filter.field || filter.value || filter.value2);
    const whereParts = filters.map(filter => {
        if (!filter.field) {
            issues.push('筛选条件缺少字段。');
            return '';
        }
        const temporalKind = queryBuilderTemporalKind(filter.fieldType);
        if (VISUAL_SQL_TODAY_OPERATORS.has(filter.operator) && !['date', 'datetime'].includes(temporalKind)) {
            issues.push(`筛选字段 ${filter.field} 只有日期或日期时间字段支持“当天”关系。`);
            return '';
        }
        if (!['isNull', 'notNull', ...VISUAL_SQL_TODAY_OPERATORS].includes(filter.operator) && !filter.value && filter.operator !== 'in') {
            issues.push(`筛选字段 ${filter.field} 缺少条件值。`);
            return '';
        }
        if (filter.operator === 'between' && !filter.value2) {
            issues.push(`筛选字段 ${filter.field} 需要填写两个边界值。`);
            return '';
        }
        const sql = queryBuilderFilterSql(filter, dialect);
        if (!sql) issues.push(`筛选字段 ${filter.field} 无法生成安全条件。`);
        return sql;
    }).filter(Boolean);

    const tableSql = tableName;
    const lines = [`SELECT ${selectParts.join(', ')}`, `FROM ${tableSql}`];
    if (whereParts.length) {
        const relation = builder.filterRelation === 'or' ? 'OR' : 'AND';
        lines.push(`WHERE ${whereParts.join(`\n  ${relation} `)}`);
    }
    if (groupBy && builder.aggregation) lines.push(`GROUP BY ${groupBy}`);
    const sortBy = builder.sortBy === '__metric__'
        ? queryBuilderQuoteIdentifier('metric_value', dialect)
        : builder.sortBy === '__group__'
            ? queryBuilderQuoteIdentifier('group_value', dialect)
            : queryBuilderField(builder.sortBy, dialect);
    if (sortBy) lines.push(`ORDER BY ${sortBy} ${builder.sortOrder.toUpperCase()}`);
    if (dialect === 'sqlserver') lines[0] = `SELECT TOP (${builder.limit}) ${selectParts.join(', ')}`;
    else lines.push(`LIMIT ${builder.limit}`);
    return { sql: issues.length ? '' : lines.join('\n'), issues, config: builder };
}

function visualSqlColumnRows(result) {
    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    return [...new Map(rows.map(row => {
        const name = queryBuilderString(row?.column_name || row?.name || row?.COLUMN_NAME || row?.field);
        return [name, { name, type: queryBuilderString(row?.data_type || row?.type || row?.DATA_TYPE) }];
    }).filter(([name]) => name)).values()];
}

function visualSqlTableNames(result) {
    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    return [...new Set(rows.map(row => queryBuilderString(row?.table_name || row?.name || row?.TABLE_NAME || row?.table)).filter(Boolean))];
}

function renderVisualSqlBuilder(initialInput = {}) {
    const config = normalizeVisualSqlQueryBuilder(initialInput);
    const optionMarkup = (items, selected) => items.map(([value, label]) => `<option value="${dagEscapeAttr(value)}" ${value === selected ? 'selected' : ''}>${dagEscapeHtml(label)}</option>`).join('');
    const fieldList = config.columns.length
        ? config.columns.map(name => `<label class="pivot-dag-query-column"><input type="checkbox" data-pivot-dag-query-column value="${dagEscapeAttr(name)}" checked><span>${dagEscapeHtml(name)}</span></label>`).join('')
        : '<span class="pivot-dag-query-empty">读取数据表字段后，在这里选择返回字段。</span>';
    const filters = config.filters.length ? config.filters : [];
    return `
        <section class="pivot-dag-query-builder" data-pivot-dag-query-builder data-database-type="">
            <header class="pivot-dag-query-builder-head">
                <div>
                    <strong>查询方式</strong>
                    <span>常规查询直接选择数据表、字段和条件；复杂查询可切换到高级模式。</span>
                </div>
                <div class="pivot-dag-query-mode" role="group" aria-label="查询方式">
                    <button type="button" class="is-active" data-pivot-dag-query-mode="visual">可视化查询</button>
                    <button type="button" data-pivot-dag-query-mode="advanced">高级查询</button>
                </div>
            </header>
            <div class="pivot-dag-query-visual" data-pivot-dag-query-visual>
                <div class="pivot-dag-query-source">
                    <label><span>数据库模式 / 命名空间</span><input class="form-input" data-pivot-dag-query-schema value="${dagEscapeAttr(config.schema)}" placeholder="可选，例如 public / dbo"></label>
                    <label><span>数据表</span><input class="form-input" data-pivot-dag-query-table list="pivot-dag-query-tables" value="${dagEscapeAttr(config.table)}" placeholder="读取后选择或手动输入"></label>
                    <div class="pivot-dag-query-source-actions"><button type="button" class="btn-secondary" data-pivot-dag-query-load-tables>读取数据表</button><button type="button" class="btn-secondary" data-pivot-dag-query-load-columns>读取字段</button><span class="pivot-dag-query-source-status" data-pivot-dag-query-source-status role="status" aria-live="polite">读取请求由 Pivot 服务端发起；“本机地址”指服务端或容器，而不是当前浏览器所在电脑。</span></div>
                    <datalist id="pivot-dag-query-tables"></datalist>
                </div>
                <div class="pivot-dag-query-section">
                    <div class="pivot-dag-query-section-head"><strong>返回字段</strong><span data-pivot-dag-query-columns-help>至少选择一个字段；选择后会自动生成查询语句。</span></div>
                    <div class="pivot-dag-query-columns" data-pivot-dag-query-columns>${fieldList}</div>
                </div>
                <div class="pivot-dag-query-section">
                    <div class="pivot-dag-query-section-head"><strong>筛选条件</strong><div class="pivot-dag-query-filter-actions"><div class="pivot-dag-query-filter-relation" role="group" aria-label="筛选条件关系"><button type="button" class="${config.filterRelation === 'and' ? 'is-active' : ''}" data-pivot-dag-query-filter-relation="and" aria-pressed="${config.filterRelation === 'and'}">全部满足</button><button type="button" class="${config.filterRelation === 'or' ? 'is-active' : ''}" data-pivot-dag-query-filter-relation="or" aria-pressed="${config.filterRelation === 'or'}">任一满足</button></div><button type="button" class="btn-secondary" data-pivot-dag-query-add-filter>添加条件</button></div></div>
                    <div class="pivot-dag-query-filters" data-pivot-dag-query-filters>${filters.map((filter, index) => renderVisualSqlFilterRow(filter, index)).join('')}</div>
                    <span class="pivot-dag-query-help" data-pivot-dag-query-filter-help>多个条件会按${config.filterRelation === 'or' ? '“任一满足”' : '“全部满足”'}组合；文本值会自动处理。</span>
                </div>
                <div class="pivot-dag-query-section pivot-dag-query-aggregate-section">
                    <div class="pivot-dag-query-section-head"><strong>汇总与排序</strong><span>需要统计时选择汇总方式，否则保持“不做汇总”。</span></div>
                    <div class="pivot-dag-query-options">
                        <label><span>汇总方式</span><select class="form-input" data-pivot-dag-query-aggregation>${optionMarkup(VISUAL_SQL_AGGREGATION_OPTIONS, config.aggregation)}</select></label>
                        <label><span>统计字段</span><select class="form-input" data-pivot-dag-query-aggregation-field><option value="">计数无需字段</option></select></label>
                        <label><span>分组字段</span><select class="form-input" data-pivot-dag-query-group-by><option value="">不分组</option></select></label>
                        <label><span>排序字段</span><select class="form-input" data-pivot-dag-query-sort-by><option value="">不排序</option><option value="__metric__">统计值</option><option value="__group__">分组值</option></select></label>
                        <label><span>排序方向</span><select class="form-input" data-pivot-dag-query-sort-order><option value="desc" ${config.sortOrder === 'desc' ? 'selected' : ''}>降序</option><option value="asc" ${config.sortOrder === 'asc' ? 'selected' : ''}>升序</option></select></label>
                        <label><span>最多返回</span><input class="form-input" type="number" min="1" max="1000" step="1" data-pivot-dag-query-limit value="${dagEscapeAttr(config.limit)}"></label>
                    </div>
                </div>
                <div class="pivot-dag-query-preview"><div class="pivot-dag-query-preview-head"><strong>查询预览</strong><span data-pivot-dag-query-status>填写条件后自动更新</span></div><pre data-pivot-dag-query-preview></pre></div>
            </div>
            <div class="pivot-dag-query-advanced hidden" data-pivot-dag-query-advanced>
                <label class="pivot-dag-query-sql-field"><span>只读查询语句</span><textarea class="form-input" data-pivot-dag-query-sql spellcheck="false" placeholder="例如：SELECT id, name FROM customers WHERE status = 'active' LIMIT 100">${dagEscapeHtml(initialInput.sql || '')}</textarea><small>仅允许读取和分析数据；执行时仍会进行权限和返回行数校验。</small></label>
            </div>
        </section>
    `;
}

function renderVisualSqlFilterRow(filter = {}, index = 0) {
    const operatorMarkup = VISUAL_SQL_OPERATOR_OPTIONS.map(([value, label]) => `<option value="${dagEscapeAttr(value)}" ${value === filter.operator ? 'selected' : ''}>${dagEscapeHtml(label)}</option>`).join('');
    const fieldType = queryBuilderString(filter.fieldType || filter.field_type);
    const temporalKind = queryBuilderTemporalKind(fieldType);
    const inputKind = temporalKind && filter.operator !== 'in' ? temporalKind : '';
    const inputType = inputKind === 'datetime' ? 'datetime-local' : (inputKind || 'text');
    const inputStep = inputKind === 'datetime' || inputKind === 'time' ? ' step="1"' : '';
    const value = queryBuilderTemporalInputValue(filter.value, inputKind);
    const value2 = queryBuilderTemporalInputValue(filter.value2, inputKind);
    return `<div class="pivot-dag-query-filter-row" data-pivot-dag-query-filter-row data-filter-index="${index}" data-filter-field-name="${dagEscapeAttr(filter.field || '')}" data-filter-field-type="${dagEscapeAttr(fieldType)}">
        <input class="form-input" data-pivot-dag-query-filter-field list="pivot-dag-query-columns-list" value="${dagEscapeAttr(filter.field || '')}" placeholder="字段">
        <select class="form-input" data-pivot-dag-query-filter-operator>${operatorMarkup}</select>
        <input class="form-input" type="${inputType}"${inputStep} data-pivot-dag-query-filter-value value="${dagEscapeAttr(value)}" placeholder="条件值">
        <input class="form-input hidden" type="${inputType}"${inputStep} data-pivot-dag-query-filter-value2 value="${dagEscapeAttr(value2)}" placeholder="第二个值">
        <button type="button" class="btn-danger-outline" data-pivot-dag-query-remove-filter aria-label="删除筛选条件" title="删除筛选条件">删除</button>
        <span class="pivot-dag-query-filter-type ${temporalKind ? '' : 'hidden'}" data-pivot-dag-query-filter-type-hint></span>
    </div>`;
}

function mountVisualSqlBuilder({ modal, initialInput, wizardTools, getConnectionId, callTool }) {
    const root = modal?.querySelector('[data-pivot-dag-query-builder]');
    if (!root) return null;
    let config = normalizeVisualSqlQueryBuilder(initialInput);
    let columns = config.columns.map(name => ({ name, type: '' }));
    let tables = [];
    let loadedTable = config.table;
    root.dataset.databaseType = databaseWizardConnections(wizardTools).find(item => String(item.serverId) === String(getConnectionId?.()))?.databaseType || '';

    const databaseEntry = () => databaseWizardConnections(wizardTools).find(item => String(item.serverId) === String(getConnectionId?.())) || null;
    const selectedFieldNames = () => [...root.querySelectorAll('[data-pivot-dag-query-column]:checked')].map(input => queryBuilderString(input.value));
    const readConfig = () => {
        const filters = [...root.querySelectorAll('[data-pivot-dag-query-filter-row]')].map(row => normalizeVisualSqlFilter({
            field: row.querySelector('[data-pivot-dag-query-filter-field]')?.value,
            fieldType: row.dataset.filterFieldType,
            operator: row.querySelector('[data-pivot-dag-query-filter-operator]')?.value,
            value: row.querySelector('[data-pivot-dag-query-filter-value]')?.value,
            value2: row.querySelector('[data-pivot-dag-query-filter-value2]')?.value
        }));
        return normalizeVisualSqlQueryBuilder({ queryBuilder: {
            ...config,
            mode: root.querySelector('[data-pivot-dag-query-mode].is-active')?.dataset.pivotDagQueryMode || config.mode,
            schema: root.querySelector('[data-pivot-dag-query-schema]')?.value,
            table: root.querySelector('[data-pivot-dag-query-table]')?.value,
            columns: selectedFieldNames(),
            filters,
            filterRelation: root.querySelector('[data-pivot-dag-query-filter-relation].is-active')?.dataset.pivotDagQueryFilterRelation || config.filterRelation,
            aggregation: root.querySelector('[data-pivot-dag-query-aggregation]')?.value,
            aggregationField: root.querySelector('[data-pivot-dag-query-aggregation-field]')?.value,
            groupBy: root.querySelector('[data-pivot-dag-query-group-by]')?.value,
            sortBy: root.querySelector('[data-pivot-dag-query-sort-by]')?.value,
            sortOrder: root.querySelector('[data-pivot-dag-query-sort-order]')?.value,
            limit: root.querySelector('[data-pivot-dag-query-limit]')?.value
        } });
    };

    const setStatus = (message, tone = '') => {
        const status = root.querySelector('[data-pivot-dag-query-status]');
        if (!status) return;
        status.textContent = message || '';
        status.className = `pivot-dag-query-status ${tone}`;
    };

    const setSourceStatus = (message, tone = '') => {
        const status = root.querySelector('[data-pivot-dag-query-source-status]');
        if (!status) return;
        status.textContent = message || '';
        status.className = `pivot-dag-query-source-status ${tone}`;
    };

    const formatDatabaseReadError = (error, action) => {
        const code = String(error?.code || '').toUpperCase();
        const detail = String(error?.message || '').trim();
        const hint = String(error?.hint || '').trim();
        if (code === 'MCP_PRIVATE_HOST_RESTRICTED' || /内网|本机|localhost|loopback|云元数据/i.test(`${detail} ${hint}`)) {
            return `${action}按钮已触发，但数据库访问被服务端安全策略拦截。请确认连接目标是 Pivot 服务端可访问的地址；浏览器不会直接访问用户电脑的 localhost。`;
        }
        if (code === 'DB_CONNECTION_REFUSED' || /ECONNREFUSED|拒绝连接/i.test(detail)) {
            return `${action}按钮已触发，但数据库拒绝连接。请检查数据库监听地址、端口和防火墙规则。`;
        }
        if (code === 'DB_CONNECTION_TIMEOUT' || code === 'DB_CONNECTION_TEST_TIMEOUT' || /timeout|超时/i.test(detail)) {
            return `${action}按钮已触发，但连接数据库超时。请检查 Pivot 服务端到数据库的网络连通性。`;
        }
        if (code === 'DB_AUTH_FAILED' || /access denied|authentication failed|认证失败|登录失败/i.test(detail)) {
            return `${action}按钮已触发，但数据库账号认证失败。请检查账号、密码及来源地址授权。`;
        }
        return `${action}按钮已触发，但数据库读取失败：${detail || '服务端未返回具体原因。'}${hint ? ` ${hint}` : ''}`;
    };

    const refreshFieldOptions = () => {
        const options = columns.map(item => `<option value="${dagEscapeAttr(item.name)}">${dagEscapeHtml(item.name)}${item.type ? ` · ${dagEscapeHtml(item.type)}` : ''}</option>`).join('');
        const datalist = root.querySelector('#pivot-dag-query-columns-list');
        if (!datalist) {
            const node = document.createElement('datalist');
            node.id = 'pivot-dag-query-columns-list';
            root.appendChild(node);
        }
        PivotSafeHtml.setHtml(root.querySelector('#pivot-dag-query-columns-list'), options);
        ['[data-pivot-dag-query-aggregation-field]', '[data-pivot-dag-query-group-by]'].forEach(selector => {
            const select = root.querySelector(selector);
            if (!select) return;
            const previous = select.value || (selector.includes('aggregation') ? config.aggregationField : config.groupBy);
            const placeholder = selector.includes('aggregation') ? '计数无需字段' : '不分组';
            PivotSafeHtml.setHtml(select, `<option value="">${placeholder}</option>${options}`);
            select.value = previous;
        });
        const sort = root.querySelector('[data-pivot-dag-query-sort-by]');
        if (sort) {
            const previous = sort.value || config.sortBy;
            PivotSafeHtml.setHtml(sort, `<option value="">不排序</option><option value="__metric__">统计值</option><option value="__group__">分组值</option>${options}`);
            sort.value = previous;
        }
        root.querySelectorAll('[data-pivot-dag-query-filter-field]').forEach(input => {
            input.setAttribute('list', 'pivot-dag-query-columns-list');
        });
        syncFilterValueFields();
    };

    const renderColumns = () => {
        const host = root.querySelector('[data-pivot-dag-query-columns]');
        if (!host) return;
        const selected = new Set(config.columns);
        if (!columns.length) {
            PivotSafeHtml.setHtml(host, '<span class="pivot-dag-query-empty">读取数据表字段后，在这里选择返回字段。</span>');
            return;
        }
        PivotSafeHtml.setHtml(host, columns.map(item => `<label class="pivot-dag-query-column"><input type="checkbox" data-pivot-dag-query-column value="${dagEscapeAttr(item.name)}" ${selected.has(item.name) ? 'checked' : ''}><span>${dagEscapeHtml(item.name)}${item.type ? `<small>${dagEscapeHtml(item.type)}</small>` : ''}</span></label>`).join(''));
    };

    const renderFilters = () => {
        const host = root.querySelector('[data-pivot-dag-query-filters]');
        if (!host) return;
        PivotSafeHtml.setHtml(host, config.filters.map((filter, index) => renderVisualSqlFilterRow(filter, index)).join('') || '<span class="pivot-dag-query-empty">暂未添加筛选条件。</span>');
        syncFilterValueFields();
    };

    const syncFilterRelation = (relation = config.filterRelation) => {
        const normalized = normalizeVisualSqlFilterRelation(relation);
        root.querySelectorAll('[data-pivot-dag-query-filter-relation]').forEach(button => {
            const active = button.dataset.pivotDagQueryFilterRelation === normalized;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const help = root.querySelector('[data-pivot-dag-query-filter-help]');
        if (help) help.textContent = `多个条件会按${normalized === 'or' ? '“任一满足”' : '“全部满足”'}组合；文本值会自动处理。`;
    };

    const syncFilterValueFields = () => {
        root.querySelectorAll('[data-pivot-dag-query-filter-row]').forEach(row => {
            const field = queryBuilderString(row.querySelector('[data-pivot-dag-query-filter-field]')?.value);
            const fieldMeta = columns.find(item => item.name === field);
            const retainedType = row.dataset.filterFieldName === field ? row.dataset.filterFieldType : '';
            const fieldType = queryBuilderString(fieldMeta?.type || retainedType);
            const temporalKind = queryBuilderTemporalKind(fieldType);
            row.dataset.filterFieldName = field;
            row.dataset.filterFieldType = fieldType;
            const operatorControl = row.querySelector('[data-pivot-dag-query-filter-operator]');
            const textOnlyOperators = new Set(['contains', 'startsWith', 'endsWith']);
            operatorControl?.querySelectorAll('option').forEach(option => {
                const defaultLabel = VISUAL_SQL_OPERATOR_OPTIONS.find(([value]) => value === option.value)?.[1] || option.textContent;
                option.textContent = temporalKind ? (VISUAL_SQL_TEMPORAL_OPERATOR_LABELS[option.value] || defaultLabel) : defaultLabel;
                const unavailable = Boolean(
                    (temporalKind && textOnlyOperators.has(option.value))
                    || (VISUAL_SQL_TODAY_OPERATORS.has(option.value) && !['date', 'datetime'].includes(temporalKind))
                );
                option.disabled = unavailable;
                option.hidden = unavailable;
            });
            if (temporalKind && textOnlyOperators.has(operatorControl?.value)) operatorControl.value = 'eq';
            if (VISUAL_SQL_TODAY_OPERATORS.has(operatorControl?.value) && !['date', 'datetime'].includes(temporalKind)) operatorControl.value = 'eq';
            const operator = operatorControl?.value || 'eq';
            const value = row.querySelector('[data-pivot-dag-query-filter-value]');
            const value2 = row.querySelector('[data-pivot-dag-query-filter-value2]');
            const noValue = operator === 'isNull' || operator === 'notNull' || VISUAL_SQL_TODAY_OPERATORS.has(operator);
            const inputKind = temporalKind && operator !== 'in' && !VISUAL_SQL_TODAY_OPERATORS.has(operator) ? temporalKind : '';
            const inputType = inputKind === 'datetime' ? 'datetime-local' : (inputKind || 'text');
            [value, value2].forEach(input => {
                if (!input) return;
                const previous = input.value;
                input.type = inputType;
                if (inputKind === 'datetime' || inputKind === 'time') input.step = '1';
                else input.removeAttribute('step');
                input.placeholder = operator === 'in' && temporalKind ? '多个时间值，用英文逗号分隔' : (input === value2 ? '结束值' : '条件值');
                if (inputKind) input.value = queryBuilderTemporalInputValue(previous, inputKind);
                else if (input.value !== previous) input.value = previous;
            });
            value?.classList.toggle('hidden', noValue);
            value2?.classList.toggle('hidden', operator !== 'between');
            const hint = row.querySelector('[data-pivot-dag-query-filter-type-hint]');
            if (hint) {
                const label = temporalKind === 'date' ? '日期' : temporalKind === 'time' ? '时间' : '日期时间';
                hint.textContent = temporalKind
                    ? `${label}字段${fieldType ? ` · ${fieldType}` : ''}${VISUAL_SQL_TODAY_OPERATORS.has(operator) ? ' · 使用数据库当天日期' : operator === 'in' ? ' · 多个值使用英文逗号分隔' : ' · 不自动转换时区'}`
                    : '';
                hint.classList.toggle('hidden', !temporalKind);
            }
        });
    };

    const syncAggregationControls = (nextConfig) => {
        const aggregationEnabled = Boolean(nextConfig.aggregation);
        const aggregationField = root.querySelector('[data-pivot-dag-query-aggregation-field]');
        const groupBy = root.querySelector('[data-pivot-dag-query-group-by]');
        const sortBy = root.querySelector('[data-pivot-dag-query-sort-by]');
        if (aggregationField) aggregationField.disabled = !aggregationEnabled || nextConfig.aggregation === 'count';
        if (groupBy) groupBy.disabled = !aggregationEnabled;
        root.querySelectorAll('[data-pivot-dag-query-column]').forEach(input => {
            input.disabled = aggregationEnabled;
        });
        root.classList.toggle('is-aggregation', aggregationEnabled);
        const columnsHelp = root.querySelector('[data-pivot-dag-query-columns-help]');
        if (columnsHelp) {
            columnsHelp.textContent = aggregationEnabled
                ? '汇总模式由统计字段和分组字段决定返回结果。'
                : '至少选择一个字段；选择后会自动生成 SELECT。';
        }
        if (!sortBy) return;
        [...sortBy.options].forEach(option => {
            const rawField = option.value && !['__metric__', '__group__'].includes(option.value);
            const unavailable = aggregationEnabled
                ? (rawField || (option.value === '__group__' && !nextConfig.groupBy))
                : ['__metric__', '__group__'].includes(option.value);
            option.disabled = unavailable;
            option.hidden = unavailable;
        });
        const selected = sortBy.options[sortBy.selectedIndex];
        if (selected?.disabled) {
            sortBy.value = '';
            nextConfig.sortBy = '';
        }
    };

    const updatePreview = (modeOverride = '') => {
        config = readConfig();
        if (modeOverride) {
            config.mode = modeOverride;
        }
        syncFilterRelation(config.filterRelation);
        syncAggregationControls(config);
        const mode = config.mode;
        const visual = root.querySelector('[data-pivot-dag-query-visual]');
        const advanced = root.querySelector('[data-pivot-dag-query-advanced]');
        visual?.classList.toggle('hidden', mode !== 'visual');
        advanced?.classList.toggle('hidden', mode !== 'advanced');
        root.querySelectorAll('[data-pivot-dag-query-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.pivotDagQueryMode === mode));
        if (mode === 'advanced') {
            setStatus('高级查询将在保存和运行时进行只读校验。');
            return;
        }
        const result = buildVisualSqlQuery(config, root.dataset.databaseType || 'sqlite');
        const preview = root.querySelector('[data-pivot-dag-query-preview]');
        if (preview) preview.textContent = result.sql || '完成数据表、字段和筛选条件后，将在这里生成查询语句。';
        setStatus(result.issues[0] || '查询语句已生成，可在下方预览。', result.issues.length ? 'warn' : 'success');
    };

    const loadTables = async () => {
        config = readConfig();
        const entry = databaseEntry();
        const tableTool = entry?.tools?.['db.list_tables'];
        if (!tableTool) {
            const message = '读取数据表按钮已触发，但当前数据库连接没有可用的表列表工具。';
            setSourceStatus(message, 'error');
            return setStatus(message, 'error');
        }
        setSourceStatus('读取数据表按钮已触发，正在连接数据库...', '');
        setStatus('正在读取数据表...');
        try {
            const result = await callTool(tableTool, config.schema ? { schema: config.schema } : {});
            tables = visualSqlTableNames(result);
            const list = root.querySelector('#pivot-dag-query-tables');
            if (list) PivotSafeHtml.setHtml(list, tables.map(name => `<option value="${dagEscapeAttr(name)}"></option>`).join(''));
            const message = tables.length ? `已读取 ${tables.length} 个数据表，请选择后读取字段。` : '没有读取到数据表，可手动输入。';
            setSourceStatus(message, tables.length ? 'success' : 'warn');
            setStatus(message, tables.length ? '' : 'warn');
        } catch (error) {
            const message = formatDatabaseReadError(error, '读取数据表');
            setSourceStatus(message, 'error');
            setStatus(message, 'error');
        }
    };

    const loadColumns = async () => {
        config = readConfig();
        const entry = databaseEntry();
        const tableTool = entry?.tools?.['db.describe_table'];
        const table = queryBuilderString(root.querySelector('[data-pivot-dag-query-table]')?.value);
        if (!table) {
            const message = '读取字段按钮已触发，但尚未选择或填写数据表。';
            setSourceStatus(message, 'error');
            return setStatus(message, 'error');
        }
        if (!tableTool) {
            const message = '读取字段按钮已触发，但当前数据库连接没有可用的表结构工具。';
            setSourceStatus(message, 'error');
            return setStatus(message, 'error');
        }
        setSourceStatus('读取字段按钮已触发，正在连接数据库...', '');
        setStatus('正在读取字段...');
        try {
            const result = await callTool(tableTool, { table, ...(config.schema ? { schema: config.schema } : {}) });
            columns = visualSqlColumnRows(result);
            config = readConfig();
            const tableChanged = Boolean(loadedTable && loadedTable !== table);
            loadedTable = table;
            if (tableChanged) {
                config.filters = [];
                config.aggregationField = '';
                config.groupBy = '';
                config.sortBy = '';
                renderFilters();
            }
            const available = new Set(columns.map(item => item.name));
            config.columns = config.columns.filter(name => available.has(name));
            if (!config.columns.length) config.columns = columns.slice(0, 8).map(item => item.name);
            renderColumns();
            refreshFieldOptions();
            updatePreview();
            const message = columns.length ? `已读取 ${columns.length} 个字段，已默认选择前 ${Math.min(columns.length, 8)} 个。` : '没有读取到字段，请检查表名。';
            setSourceStatus(message, columns.length ? 'success' : 'warn');
            setStatus(message, columns.length ? 'success' : 'warn');
        } catch (error) {
            const message = formatDatabaseReadError(error, '读取字段');
            setSourceStatus(message, 'error');
            setStatus(message, 'error');
        }
    };

    const collect = () => {
        config = readConfig();
        if (config.mode === 'advanced') {
            const sql = queryBuilderString(root.querySelector('[data-pivot-dag-query-sql]')?.value);
            if (!sql) return { error: '请填写只读查询语句，或切换到可视化查询。' };
            return { sql, queryBuilder: { ...config, mode: 'advanced' } };
        }
        const result = buildVisualSqlQuery(config, root.dataset.databaseType || 'sqlite');
        if (result.issues.length) return { error: result.issues[0] };
        return { sql: result.sql, queryBuilder: { ...result.config, mode: 'visual' } };
    };

    const hydrate = (input = {}) => {
        config = normalizeVisualSqlQueryBuilder(input);
        columns = config.columns.map(name => ({ name, type: '' }));
        tables = [];
        loadedTable = config.table;
        const fields = {
            schema: config.schema,
            table: config.table,
            aggregation: config.aggregation,
            aggregationField: config.aggregationField,
            groupBy: config.groupBy,
            sortBy: config.sortBy,
            sortOrder: config.sortOrder,
            limit: config.limit
        };
        Object.entries(fields).forEach(([name, value]) => {
            const control = root.querySelector(`[data-pivot-dag-query-${name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}]`);
            if (control) control.value = value;
        });
        const sql = root.querySelector('[data-pivot-dag-query-sql]');
        if (sql) sql.value = input.sql || '';
        renderColumns();
        renderFilters();
        syncFilterRelation(config.filterRelation);
        refreshFieldOptions();
        updatePreview(config.mode);
    };

    root.querySelector('[data-pivot-dag-query-load-tables]')?.addEventListener('click', loadTables);
    root.querySelector('[data-pivot-dag-query-load-columns]')?.addEventListener('click', loadColumns);

    root.addEventListener('click', event => {
        const modeButton = event.target.closest('[data-pivot-dag-query-mode]');
        if (modeButton) {
            config = readConfig();
            config.mode = modeButton.dataset.pivotDagQueryMode === 'advanced' ? 'advanced' : 'visual';
            if (config.mode === 'advanced') {
                const sqlControl = root.querySelector('[data-pivot-dag-query-sql]');
                if (sqlControl && !queryBuilderString(sqlControl.value)) {
                    const result = buildVisualSqlQuery(config, root.dataset.databaseType || 'sqlite');
                    if (result.sql) sqlControl.value = result.sql;
                }
            }
            updatePreview(config.mode);
            return;
        }
        const relationButton = event.target.closest('[data-pivot-dag-query-filter-relation]');
        if (relationButton) {
            config = readConfig();
            config.filterRelation = normalizeVisualSqlFilterRelation(relationButton.dataset.pivotDagQueryFilterRelation);
            syncFilterRelation(config.filterRelation);
            updatePreview();
            return;
        }
        if (event.target.closest('[data-pivot-dag-query-add-filter]')) {
            config = readConfig();
            config.filters.push(normalizeVisualSqlFilter({ field: columns[0]?.name || '' }));
            renderFilters();
            updatePreview();
            return;
        }
        const remove = event.target.closest('[data-pivot-dag-query-remove-filter]');
        if (remove) {
            config = readConfig();
            const row = remove.closest('[data-pivot-dag-query-filter-row]');
            config.filters.splice(Number.parseInt(row?.dataset.filterIndex || '0', 10), 1);
            renderFilters();
            updatePreview();
        }
    });
    root.addEventListener('input', event => {
        if (event.target.matches('[data-pivot-dag-query-filter-field], [data-pivot-dag-query-filter-operator]')) syncFilterValueFields();
        updatePreview();
    });
    root.addEventListener('change', event => {
        if (event.target.matches('[data-pivot-dag-query-filter-field], [data-pivot-dag-query-filter-operator]')) syncFilterValueFields();
        updatePreview();
    });

    const onConnectionChange = () => {
        const entry = databaseEntry();
        root.dataset.databaseType = entry?.databaseType || '';
        columns = [];
        tables = [];
        loadedTable = '';
        renderColumns();
        refreshFieldOptions();
        const message = '数据库连接已切换，请重新读取表和字段。';
        setSourceStatus(message, 'warn');
        setStatus(message, 'warn');
    };

    hydrate(initialInput);
    return { collect, hydrate, onConnectionChange };
}
