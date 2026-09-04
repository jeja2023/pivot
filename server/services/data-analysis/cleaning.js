const fs = require('fs');
const { query, queryOne, execute } = require('../../db/client');
const { profileViaSql } = require('./profile');
const {
    MAX_PREVIEW_ROWS,
    analysisId,
    datasetRoot,
    resolveInside,
    toProjectRelative,
    jsonParse,
    sqlIdent,
    sqlLiteral,
    normalizeDatasetName,
    getBeijingTimestamp,
    getDatasetForUser,
    getDatasetPaths,
    serializeDataset,
    createDuckConnection,
    withDuckTimeout,
    withAnalysisSlot,
    parquetToRows,
    recordArtifact,
    bestEffortRemove
} = require('./shared');

const MAX_CLEANING_RULES = 80;
const MAX_RULE_TEXT_LENGTH = 500;
const CLEANING_OPERATIONS = new Set([
    'trim',
    'normalize_empty',
    'lowercase',
    'uppercase',
    'replace',
    'regex_replace',
    'fill_missing',
    'cast_number',
    'cast_date',
    'remove_missing',
    'remove_outliers',
    'deduplicate',
    'rename_column',
    'drop_column'
]);

const RULE_LABELS = {
    trim: '去除首尾空格',
    normalize_empty: '空白值标准化为空值',
    lowercase: '转换为小写',
    uppercase: '转换为大写',
    replace: '替换文本',
    regex_replace: '正则替换',
    fill_missing: '填充缺失值',
    cast_number: '转换为数值',
    cast_date: '转换为日期',
    remove_missing: '移除缺失值所在记录',
    remove_outliers: '移除离群值所在记录',
    deduplicate: '按字段去重',
    rename_column: '重命名字段',
    drop_column: '删除字段'
};

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function stringValue(value, maxLength = MAX_RULE_TEXT_LENGTH) {
    return String(value ?? '').replace(/[\0\r\n]/g, ' ').trim().slice(0, maxLength);
}

function cleanMissingExpr(expression) {
    return `NULLIF(trim(CAST(${expression} AS VARCHAR)), '')`;
}

function numericExpr(expression) {
    const text = `trim(CAST(${expression} AS VARCHAR))`;
    const cleaned = `regexp_replace(${text}, '[,￥¥$%[:space:]]', '', 'g')`;
    return `CASE WHEN regexp_matches(${text}, '%$') THEN TRY_CAST(${cleaned} AS DOUBLE) / 100 ELSE TRY_CAST(${cleaned} AS DOUBLE) END`;
}

function dateExpr(expression) {
    const text = cleanMissingExpr(expression);
    return `COALESCE(
        TRY_CAST(${text} AS TIMESTAMP),
        try_strptime(${text}, '%Y/%m/%d'),
        try_strptime(${text}, '%Y年%m月%d日'),
        try_strptime(${text}, '%d/%m/%Y'),
        try_strptime(${text}, '%m/%d/%Y')
    )`;
}

function assertKnownField(value, columns, label = '字段') {
    const field = stringValue(value, 120);
    const column = columns.find(item => item.key === field);
    if (!column) throw badRequest(`${label}不存在或已被删除。`);
    return field;
}

function normalizeRules(rawRules, sourceColumns) {
    if (!Array.isArray(rawRules) || !rawRules.length) {
        throw badRequest('请至少配置一条数据清洗规则。');
    }
    if (rawRules.length > MAX_CLEANING_RULES) {
        throw badRequest(`单次最多应用 ${MAX_CLEANING_RULES} 条数据清洗规则。`);
    }

    const activeColumns = (Array.isArray(sourceColumns) ? sourceColumns : []).map(column => ({ ...column }));
    const seenRuleIds = new Set();
    return rawRules.map((sourceRule, index) => {
        const rule = sourceRule && typeof sourceRule === 'object' ? sourceRule : {};
        const operation = stringValue(rule.operation || rule.type, 64).toLowerCase();
        if (!CLEANING_OPERATIONS.has(operation)) {
            throw badRequest(`第 ${index + 1} 条规则的操作类型无效。`);
        }
        const idCandidate = stringValue(rule.id, 80) || `rule_${index + 1}`;
        const id = seenRuleIds.has(idCandidate) ? `${idCandidate}_${index + 1}` : idCandidate;
        seenRuleIds.add(id);
        const normalized = { id, operation };

        if (operation === 'deduplicate') {
            const fieldList = Array.isArray(rule.fields) ? rule.fields : [rule.field];
            const fields = [...new Set(fieldList.map(value => stringValue(value, 120)).filter(Boolean))];
            if (!fields.length) throw badRequest(`第 ${index + 1} 条去重规则至少需要一个字段。`);
            normalized.fields = fields.map(field => assertKnownField(field, activeColumns, `第 ${index + 1} 条去重字段`));
            normalized.includeEmpty = rule.includeEmpty === true;
            return normalized;
        }

        const field = assertKnownField(rule.field, activeColumns, `第 ${index + 1} 条规则的字段`);
        normalized.field = field;

        if (operation === 'replace' || operation === 'regex_replace') {
            normalized.search = stringValue(rule.search, MAX_RULE_TEXT_LENGTH);
            normalized.replacement = stringValue(rule.replacement, MAX_RULE_TEXT_LENGTH);
            if (!normalized.search) throw badRequest(`第 ${index + 1} 条替换规则缺少查找内容。`);
        }
        if (operation === 'fill_missing') {
            const strategy = stringValue(rule.strategy || 'constant', 32).toLowerCase();
            if (!['constant', 'mean', 'median', 'mode'].includes(strategy)) {
                throw badRequest(`第 ${index + 1} 条缺失值填充策略无效。`);
            }
            normalized.strategy = strategy;
            normalized.value = stringValue(rule.value, MAX_RULE_TEXT_LENGTH);
            if (strategy === 'constant' && !normalized.value) {
                throw badRequest(`第 ${index + 1} 条固定值填充规则缺少填充值。`);
            }
        }
        if (operation === 'remove_outliers') {
            const factor = Number(rule.factor ?? 1.5);
            if (!Number.isFinite(factor) || factor <= 0 || factor > 20) {
                throw badRequest(`第 ${index + 1} 条离群值规则的 IQR 系数应在 0 到 20 之间。`);
            }
            normalized.factor = Number(factor.toFixed(4));
        }
        if (operation === 'rename_column') {
            const nextName = stringValue(rule.name || rule.newName, 80);
            if (!nextName) throw badRequest(`第 ${index + 1} 条重命名规则缺少新字段名。`);
            if (activeColumns.some(column => column.key !== field && column.name === nextName)) {
                throw badRequest(`字段名“${nextName}”已存在。`);
            }
            normalized.name = nextName;
            activeColumns.find(column => column.key === field).name = nextName;
        }
        if (operation === 'drop_column') {
            if (activeColumns.length <= 1) throw badRequest('至少需要保留一个字段。');
            const columnIndex = activeColumns.findIndex(column => column.key === field);
            activeColumns.splice(columnIndex, 1);
        }
        return normalized;
    });
}

function buildSelectList(columns, replacement = null) {
    return columns.map(column => {
        const ident = sqlIdent(column.key);
        return replacement?.field === column.key ? `${replacement.expression} AS ${ident}` : ident;
    }).join(', ');
}

function buildCleaningPlan(sourcePath, sourceColumns, normalizedRules) {
    const originalColumns = (Array.isArray(sourceColumns) ? sourceColumns : []).map(column => ({ ...column }));
    let activeColumns = originalColumns.map(column => ({ ...column }));
    const ctes = [];
    const allSourceFields = originalColumns.map(column => sqlIdent(column.key)).join(', ');
    ctes.push(`source AS (
        SELECT ${allSourceFields}, ROW_NUMBER() OVER () AS "__pivot_source_row"
        FROM read_parquet(${sqlLiteral(sourcePath)})
    )`);
    let current = 'source';
    let step = 0;

    const createStep = sql => {
        step += 1;
        current = `step_${step}`;
        ctes.push(`${current} AS (${sql})`);
    };
    const currentFields = () => `${buildSelectList(activeColumns)}, "__pivot_source_row"`;

    normalizedRules.forEach((rule, index) => {
        const ident = rule.field ? sqlIdent(rule.field) : '';
        if (rule.operation === 'rename_column') {
            const column = activeColumns.find(item => item.key === rule.field);
            if (column) column.name = rule.name;
            return;
        }
        if (rule.operation === 'drop_column') {
            activeColumns = activeColumns.filter(column => column.key !== rule.field);
            return;
        }
        if (rule.operation === 'deduplicate') {
            const partition = rule.fields.map(sqlIdent).join(', ');
            const complete = rule.fields.map(field => `${cleanMissingExpr(sqlIdent(field))} IS NOT NULL`).join(' AND ');
            const rankedFields = currentFields();
            const rankExpr = rule.includeEmpty
                ? `ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY "__pivot_source_row")`
                : `CASE WHEN ${complete} THEN ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY "__pivot_source_row") ELSE 1 END`;
            createStep(`
                SELECT ${rankedFields}
                FROM (
                    SELECT ${rankedFields}, ${rankExpr} AS "__pivot_cleaning_rank"
                    FROM ${current}
                ) AS ranked
                WHERE "__pivot_cleaning_rank" = 1
            `);
            return;
        }
        if (rule.operation === 'remove_missing') {
            createStep(`SELECT ${currentFields()} FROM ${current} WHERE ${cleanMissingExpr(ident)} IS NOT NULL`);
            return;
        }
        if (rule.operation === 'remove_outliers') {
            const statsName = `stats_${index + 1}`;
            const numeric = numericExpr(ident);
            ctes.push(`${statsName} AS (
                SELECT QUANTILE_CONT(${numeric}, 0.25) AS q1, QUANTILE_CONT(${numeric}, 0.75) AS q3
                FROM ${current}
            )`);
            createStep(`
                SELECT ${currentFields()}
                FROM ${current} CROSS JOIN ${statsName}
                WHERE ${numeric} IS NULL
                    OR q1 IS NULL
                    OR ${numeric} BETWEEN q1 - ${rule.factor} * (q3 - q1) AND q3 + ${rule.factor} * (q3 - q1)
            `);
            return;
        }

        let expression = ident;
        if (rule.operation === 'trim') expression = `trim(CAST(${ident} AS VARCHAR))`;
        if (rule.operation === 'normalize_empty') expression = cleanMissingExpr(ident);
        if (rule.operation === 'lowercase') expression = `lower(CAST(${ident} AS VARCHAR))`;
        if (rule.operation === 'uppercase') expression = `upper(CAST(${ident} AS VARCHAR))`;
        if (rule.operation === 'replace') expression = `replace(CAST(${ident} AS VARCHAR), ${sqlLiteral(rule.search)}, ${sqlLiteral(rule.replacement)})`;
        if (rule.operation === 'regex_replace') expression = `regexp_replace(CAST(${ident} AS VARCHAR), ${sqlLiteral(rule.search)}, ${sqlLiteral(rule.replacement)}, 'g')`;
        if (rule.operation === 'cast_number') expression = numericExpr(ident);
        if (rule.operation === 'cast_date') expression = dateExpr(ident);
        if (rule.operation === 'fill_missing') {
            const missing = cleanMissingExpr(ident);
            if (rule.strategy === 'constant') expression = `COALESCE(${missing}, ${sqlLiteral(rule.value)})`;
            if (rule.strategy === 'mean' || rule.strategy === 'median') {
                const statsName = `stats_${index + 1}`;
                const numeric = numericExpr(ident);
                const aggregation = rule.strategy === 'mean' ? `AVG(${numeric})` : `MEDIAN(${numeric})`;
                ctes.push(`${statsName} AS (SELECT ${aggregation} AS value FROM ${current})`);
                expression = `COALESCE(${numeric}, (SELECT value FROM ${statsName}))`;
            }
            if (rule.strategy === 'mode') {
                const statsName = `stats_${index + 1}`;
                ctes.push(`${statsName} AS (
                    SELECT CAST(${ident} AS VARCHAR) AS value
                    FROM ${current}
                    WHERE ${missing} IS NOT NULL
                    GROUP BY CAST(${ident} AS VARCHAR)
                    ORDER BY COUNT(*) DESC, value
                    LIMIT 1
                )`);
                expression = `COALESCE(${missing}, (SELECT value FROM ${statsName}))`;
            }
        }
        createStep(`SELECT ${buildSelectList(activeColumns, { field: rule.field, expression })}, "__pivot_source_row" FROM ${current}`);
    });

    const finalFields = currentFields();
    ctes.push(`final AS (SELECT ${finalFields} FROM ${current})`);
    return {
        withSql: `WITH ${ctes.join(',\n')}`,
        outputColumns: activeColumns.map((column, index) => ({ ...column, index })),
        originalColumns
    };
}

function buildPreviewMetricsSql(plan) {
    const comparable = plan.outputColumns.filter(column => plan.originalColumns.some(item => item.key === column.key));
    const changedExpressions = comparable.map(column => {
        const key = sqlIdent(column.key);
        return `COUNT(*) FILTER (WHERE CAST(f.${key} AS VARCHAR) IS DISTINCT FROM CAST(s.${key} AS VARCHAR)) AS ${sqlIdent(`changed_${column.key}`)}`;
    });
    const rowChanged = comparable.length
        ? comparable.map(column => {
            const key = sqlIdent(column.key);
            return `CAST(f.${key} AS VARCHAR) IS DISTINCT FROM CAST(s.${key} AS VARCHAR)`;
        }).join(' OR ')
        : 'FALSE';
    return `
        ${plan.withSql}
        SELECT
            (SELECT COUNT(*) FROM source) AS input_rows,
            (SELECT COUNT(*) FROM final) AS output_rows,
            COUNT(*) FILTER (WHERE ${rowChanged}) AS changed_rows,
            ${changedExpressions.length ? changedExpressions.join(',\n') : '0 AS changed_cells'}
        FROM final f
        JOIN source s ON s."__pivot_source_row" = f."__pivot_source_row"
    `;
}

function serializeCleaningRun(row) {
    if (!row) return null;
    return {
        id: row.id,
        sourceDatasetId: row.source_dataset_id,
        outputDatasetId: row.output_dataset_id || '',
        outputDatasetName: row.output_dataset_name || '',
        name: row.name,
        status: row.status,
        rules: jsonParse(row.rules_json, []),
        summary: jsonParse(row.summary_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function getCleaningQuality(userId, datasetId) {
    const dataset = await getDatasetForUser(userId, datasetId);
    const columns = jsonParse(dataset.columns_json, []);
    const profile = jsonParse(dataset.profile_json, []);
    const { parquetPath } = getDatasetPaths(dataset);
    const columnList = columns.map(column => sqlIdent(column.key)).join(', ');
    const duplicate = columnList ? await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const result = await withDuckTimeout(connection, () => connection.runAndReadAll(`
                SELECT COALESCE(SUM(group_count - 1), 0) AS duplicate_rows,
                       COUNT(*) FILTER (WHERE group_count > 1) AS duplicate_groups
                FROM (
                    SELECT COUNT(*) AS group_count
                    FROM read_parquet(${sqlLiteral(parquetPath)})
                    GROUP BY ${columnList}
                ) AS grouped
            `));
            return result.getRowObjectsJson()[0] || {};
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    }) : {};
    const missingCells = profile.reduce((sum, field) => sum + (Number(field.empty) || 0), 0);
    const sourceRows = Number(dataset.row_count) || 0;
    const recommendations = [];
    profile.forEach(field => {
        if ((Number(field.empty) || 0) > 0) {
            recommendations.push({
                id: `normalize_${field.key}`,
                operation: 'normalize_empty',
                field: field.key,
                title: `统一“${field.name}”中的空白值`,
                description: `${field.empty} 条记录为空或仅含空白字符。`
            });
        }
        if (field.type === 'number' && (field.samples || []).some(value => /[,%￥¥$]/.test(String(value)))) {
            recommendations.push({
                id: `number_${field.key}`,
                operation: 'cast_number',
                field: field.key,
                title: `规范“${field.name}”的数值格式`,
                description: '检测到货币、千分位或百分比格式，可统一转换为可计算数值。'
            });
        }
        if (field.type === 'text' && (field.samples || []).some(value => /^\s|\s$/.test(String(value)))) {
            recommendations.push({
                id: `trim_${field.key}`,
                operation: 'trim',
                field: field.key,
                title: `去除“${field.name}”的首尾空格`,
                description: '检测到可能影响分组、比对和去重的首尾空白字符。'
            });
        }
    });
    if ((Number(duplicate.duplicate_rows) || 0) > 0) {
        recommendations.push({
            id: 'deduplicate_manual',
            operation: 'deduplicate',
            title: '按业务主键去重',
            description: `检测到 ${duplicate.duplicate_rows} 条完全重复记录；请选择业务主键后再应用去重。`
        });
    }
    return {
        dataset: serializeDataset(dataset),
        summary: {
            totalRows: sourceRows,
            totalColumns: columns.length,
            missingCells,
            duplicateRows: Number(duplicate.duplicate_rows) || 0,
            duplicateGroups: Number(duplicate.duplicate_groups) || 0
        },
        fields: profile,
        recommendations
    };
}

async function previewCleaning(userId, datasetId, rawRules) {
    const dataset = await getDatasetForUser(userId, datasetId);
    const sourceColumns = jsonParse(dataset.columns_json, []);
    const rules = normalizeRules(rawRules, sourceColumns);
    const { parquetPath } = getDatasetPaths(dataset);
    const plan = buildCleaningPlan(parquetPath, sourceColumns, rules);
    return withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const metrics = (await withDuckTimeout(connection, () => connection.runAndReadAll(buildPreviewMetricsSql(plan)))).getRowObjectsJson()[0] || {};
            const fields = plan.outputColumns.map(column => sqlIdent(column.key)).join(', ');
            const rows = (await withDuckTimeout(connection, () => connection.runAndReadAll(`
                ${plan.withSql}
                SELECT ${fields} FROM final
                LIMIT ${MAX_PREVIEW_ROWS}
            `))).getRowObjectsJson();
            const changedByField = Object.fromEntries(plan.outputColumns.map(column => [
                column.key,
                Number(metrics[`changed_${column.key}`]) || 0
            ]));
            const outputRows = Number(metrics.output_rows) || 0;
            return {
                rules,
                columns: plan.outputColumns,
                rows,
                summary: {
                    inputRows: Number(metrics.input_rows) || 0,
                    outputRows,
                    removedRows: Math.max(0, (Number(metrics.input_rows) || 0) - outputRows),
                    changedRows: Number(metrics.changed_rows) || 0,
                    changedCells: Object.values(changedByField).reduce((sum, value) => sum + value, 0),
                    changedByField,
                    droppedColumns: sourceColumns.length - plan.outputColumns.length
                }
            };
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
}

async function applyCleaning({ user, datasetId, rules: rawRules, name }) {
    const dataset = await getDatasetForUser(user.id, datasetId);
    const sourceColumns = jsonParse(dataset.columns_json, []);
    const rules = normalizeRules(rawRules, sourceColumns);
    const { parquetPath } = getDatasetPaths(dataset);
    const plan = buildCleaningPlan(parquetPath, sourceColumns, rules);
    const outputDatasetId = analysisId('ds');
    const runId = analysisId('clean');
    const outputDir = resolveInside(datasetRoot, String(user.id), outputDatasetId);
    const outputParquetPath = resolveInside(outputDir, 'data.parquet');
    const outputName = normalizeDatasetName('', stringValue(name, 120) || `${dataset.name}（清洗后）`);
    fs.mkdirSync(outputDir, { recursive: true });
    let datasetInserted = false;
    try {
        const result = await withAnalysisSlot(async () => {
            const { instance, connection } = await createDuckConnection();
            try {
                await withDuckTimeout(connection, () => connection.run(`COPY (${plan.withSql} SELECT ${plan.outputColumns.map(column => sqlIdent(column.key)).join(', ')} FROM final) TO ${sqlLiteral(outputParquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`));
                const count = Number((await withDuckTimeout(connection, () => connection.runAndReadAll(`SELECT COUNT(*) AS count FROM read_parquet(${sqlLiteral(outputParquetPath)})`))).getRowObjectsJson()[0]?.count || 0);
                if (!count) throw badRequest('当前清洗规则会移除全部记录，请调整规则后重试。');
                const profile = await profileViaSql(outputParquetPath, plan.outputColumns, count);
                const previewRows = await parquetToRows(outputParquetPath, { limit: MAX_PREVIEW_ROWS });
                return { count, profile, previewRows };
            } finally {
                connection.closeSync();
                instance.closeSync();
            }
        });
        const now = getBeijingTimestamp();
        const sourceTruncated = Number(dataset.truncated) || 0;
        const summary = {
            inputRows: Number(dataset.row_count) || 0,
            outputRows: result.count,
            removedRows: Math.max(0, (Number(dataset.row_count) || 0) - result.count),
            inputColumns: sourceColumns.length,
            outputColumns: plan.outputColumns.length,
            droppedColumns: sourceColumns.length - plan.outputColumns.length
        };
        await execute(`
            INSERT INTO analysis_datasets (
                id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                row_count, column_count, source_row_count, source_column_count, truncated, truncation_reason,
                columns_json, profile_json, preview_json, sheet_name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'cleaned', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'ready', ?, ?)
        `, [
            outputDatasetId,
            user.id,
            outputName,
            `${dataset.name}（清洗后）`,
            fs.statSync(outputParquetPath).size,
            toProjectRelative(outputParquetPath),
            result.count,
            plan.outputColumns.length,
            Number(dataset.row_count) || 0,
            sourceColumns.length,
            sourceTruncated,
            sourceTruncated ? `基于范围受限的数据集“${dataset.name}”清洗生成；${dataset.truncation_reason || '来源数据可能已截断'}` : '',
            JSON.stringify(plan.outputColumns),
            JSON.stringify(result.profile),
            JSON.stringify(result.previewRows),
            now,
            now
        ]);
        datasetInserted = true;
        await execute(`
            INSERT INTO analysis_cleaning_runs (
                id, user_id, source_dataset_id, output_dataset_id, name, rules_json, summary_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)
        `, [runId, user.id, datasetId, outputDatasetId, outputName, JSON.stringify(rules), JSON.stringify(summary), now, now]);
        await recordArtifact({
            userId: user.id,
            datasetId,
            type: 'cleaning',
            title: `数据清洗：${outputName}`,
            content: JSON.stringify({ runId, outputDatasetId, rules, summary }),
            metadata: { outputDatasetId, ruleCount: rules.length, ...summary }
        });
        const output = serializeDataset(await getDatasetForUser(user.id, outputDatasetId));
        return { dataset: output, run: serializeCleaningRun({
            id: runId,
            source_dataset_id: datasetId,
            output_dataset_id: outputDatasetId,
            output_dataset_name: outputName,
            name: outputName,
            status: 'applied',
            rules_json: JSON.stringify(rules),
            summary_json: JSON.stringify(summary),
            created_at: now,
            updated_at: now
        }) };
    } catch (error) {
        if (datasetInserted) {
            await execute('DELETE FROM analysis_datasets WHERE id = ? AND user_id = ?', [outputDatasetId, user.id]).catch(() => {});
        }
        bestEffortRemove(outputDir, { recursive: true });
        throw error;
    }
}

async function listCleaningRuns(userId, datasetId, { limit = 50 } = {}) {
    await getDatasetForUser(userId, datasetId);
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const rows = await query(`
        SELECT runs.*, output.name AS output_dataset_name
        FROM analysis_cleaning_runs runs
        LEFT JOIN analysis_datasets output ON output.id = runs.output_dataset_id AND output.deleted_at IS NULL
        WHERE runs.user_id = ? AND runs.source_dataset_id = ?
        ORDER BY runs.created_at DESC
        LIMIT ?
    `, [userId, datasetId, safeLimit]);
    return rows.map(serializeCleaningRun);
}

async function getCleaningRun(userId, runId) {
    const row = await queryOne(`
        SELECT runs.*, output.name AS output_dataset_name
        FROM analysis_cleaning_runs runs
        LEFT JOIN analysis_datasets output ON output.id = runs.output_dataset_id AND output.deleted_at IS NULL
        WHERE runs.id = ? AND runs.user_id = ?
    `, [runId, userId]);
    if (!row) {
        const err = new Error('数据清洗记录不存在或无权访问。');
        err.status = 404;
        throw err;
    }
    return serializeCleaningRun(row);
}

async function replayCleaningRun({ user, runId, name }) {
    const run = await getCleaningRun(user.id, runId);
    return applyCleaning({
        user,
        datasetId: run.sourceDatasetId,
        rules: run.rules,
        name: stringValue(name, 120) || `${run.name}（再次执行）`
    });
}

module.exports = {
    CLEANING_OPERATIONS,
    RULE_LABELS,
    normalizeRules,
    buildCleaningPlan,
    buildPreviewMetricsSql,
    getCleaningQuality,
    previewCleaning,
    applyCleaning,
    listCleaningRuns,
    getCleaningRun,
    replayCleaningRun
};
