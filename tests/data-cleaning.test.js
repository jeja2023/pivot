const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
    normalizeRules,
    buildCleaningPlan,
    buildPreviewMetricsSql
} = require('../server/services/data-analysis/cleaning');
const {
    createDuckConnection,
    createParquetFromRows,
    fromProjectRelative,
    sqlIdent,
    sqlLiteral
} = require('../server/services/data-analysis/shared');
const {
    createDatasetFromRows,
    getDatasetDetail,
    getCleaningQuality,
    previewCleaning,
    applyCleaning,
    listCleaningRuns,
    replayCleaningRun,
    listDatasets,
    listDatasetArtifacts
} = require('../server/services/data-analysis');
const { queryOne, execute } = require('../server/db/client');

const testRoot = path.resolve(__dirname, '..', 'artifacts', `data-cleaning-test-${process.pid}-${Date.now()}`);
const columns = [
    { key: 'c_1', name: '编号', index: 0 },
    { key: 'c_2', name: '名称', index: 1 },
    { key: 'c_3', name: '金额', index: 2 },
    { key: 'c_4', name: '日期', index: 3 }
];

test('数据清洗规则会验证字段、保持顺序并生成安全的 DuckDB 清洗计划', async () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const parquetPath = path.join(testRoot, 'source.parquet');
    await createParquetFromRows(columns, [
        { c_1: ' A-01 ', c_2: ' 甲 ', c_3: '￥1,200.50', c_4: '2024/01/02' },
        { c_1: 'A-01', c_2: '', c_3: '1,200.50', c_4: '2024-01-02' },
        { c_1: 'B-02', c_2: '乙', c_3: '50%', c_4: '2024年02月03日' }
    ], parquetPath);

    const rules = normalizeRules([
        { operation: 'trim', field: 'c_1' },
        { operation: 'trim', field: 'c_2' },
        { operation: 'normalize_empty', field: 'c_2' },
        { operation: 'fill_missing', field: 'c_2', strategy: 'constant', value: '未命名' },
        { operation: 'cast_number', field: 'c_3' },
        { operation: 'cast_date', field: 'c_4' },
        { operation: 'deduplicate', fields: ['c_1'], includeEmpty: false },
        { operation: 'rename_column', field: 'c_2', name: '客户名称' },
        { operation: 'drop_column', field: 'c_4' }
    ], columns);
    const plan = buildCleaningPlan(parquetPath, columns, rules);
    assert.deepEqual(plan.outputColumns.map(column => column.name), ['编号', '客户名称', '金额']);
    assert.match(plan.withSql, /read_parquet/);
    assert.doesNotMatch(plan.withSql, /A-01/);

    const { instance, connection } = await createDuckConnection();
    try {
        const rows = (await connection.runAndReadAll(`${plan.withSql} SELECT ${plan.outputColumns.map(column => sqlIdent(column.key)).join(', ')} FROM final ORDER BY "c_1"`)).getRowObjectsJson();
        assert.equal(rows.length, 2);
        assert.equal(rows[0].c_1, 'A-01');
        assert.equal(rows[0].c_2, '甲');
        assert.equal(Number(rows[0].c_3), 1200.5);
        assert.equal(Number(rows[1].c_3), 0.5);

        const metrics = (await connection.runAndReadAll(buildPreviewMetricsSql(plan))).getRowObjectsJson()[0];
        assert.equal(Number(metrics.input_rows), 3);
        assert.equal(Number(metrics.output_rows), 2);

        const outputPath = path.join(testRoot, 'cleaned.parquet');
        await connection.run(`COPY (${plan.withSql} SELECT ${plan.outputColumns.map(column => sqlIdent(column.key)).join(', ')} FROM final) TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
        assert.equal(fs.existsSync(outputPath), true);
    } finally {
        connection.closeSync();
        instance.closeSync();
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

test('数据清洗拒绝未知字段、空规则以及删除全部字段', () => {
    assert.throws(() => normalizeRules([], columns), /至少配置一条/);
    assert.throws(() => normalizeRules([{ operation: 'trim', field: 'missing' }], columns), /字段不存在/);
    assert.throws(() => normalizeRules([
        { operation: 'drop_column', field: 'c_1' },
        { operation: 'drop_column', field: 'c_2' },
        { operation: 'drop_column', field: 'c_3' },
        { operation: 'drop_column', field: 'c_4' }
    ], columns), /至少需要保留一个字段/);
});

test('数据清洗全部文本、统计填充、过滤与离群规则可按顺序执行', async () => {
    const operationRoot = path.join(testRoot, 'all-operations');
    fs.mkdirSync(operationRoot, { recursive: true });
    const parquetPath = path.join(operationRoot, 'source.parquet');
    const operationColumns = [
        { key: 'c_1', name: '代码', index: 0 },
        { key: 'c_2', name: '分类', index: 1 },
        { key: 'c_3', name: '数值', index: 2 },
        { key: 'c_4', name: '日期', index: 3 },
        { key: 'c_5', name: '均值字段', index: 4 }
    ];
    await createParquetFromRows(operationColumns, [
        { c_1: ' Alpha ', c_2: 'cold', c_3: '1', c_4: '2024/01/01', c_5: '1' },
        { c_1: ' alpha ', c_2: 'cold', c_3: '2', c_4: '2024/01/02', c_5: '2' },
        { c_1: ' beta ', c_2: '', c_3: '', c_4: '2024年01月03日', c_5: '' },
        { c_1: '   ', c_2: 'warm', c_3: '3', c_4: '2024/01/04', c_5: '3' },
        { c_1: 'gamma', c_2: 'warm', c_3: '100', c_4: '2024/01/05', c_5: '4' }
    ], parquetPath);
    const rules = normalizeRules([
        { operation: 'trim', field: 'c_1' },
        { operation: 'lowercase', field: 'c_1' },
        { operation: 'uppercase', field: 'c_1' },
        { operation: 'replace', field: 'c_1', search: 'ALPHA', replacement: 'OMEGA' },
        { operation: 'regex_replace', field: 'c_1', search: 'M', replacement: 'N' },
        { operation: 'normalize_empty', field: 'c_1' },
        { operation: 'remove_missing', field: 'c_1' },
        { operation: 'fill_missing', field: 'c_2', strategy: 'mode' },
        { operation: 'fill_missing', field: 'c_3', strategy: 'median' },
        { operation: 'fill_missing', field: 'c_5', strategy: 'mean' },
        { operation: 'remove_outliers', field: 'c_3', factor: 1.5 },
        { operation: 'deduplicate', fields: ['c_1'], includeEmpty: false },
        { operation: 'cast_date', field: 'c_4' }
    ], operationColumns);
    const plan = buildCleaningPlan(parquetPath, operationColumns, rules);
    const { instance, connection } = await createDuckConnection();
    try {
        const rows = (await connection.runAndReadAll(`${plan.withSql} SELECT * EXCLUDE ("__pivot_source_row") FROM final ORDER BY "c_1"`)).getRowObjectsJson();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map(row => row.c_1), ['BETA', 'ONEGA']);
        assert.equal(rows.find(row => row.c_1 === 'BETA').c_2, 'cold');
        assert.equal(Number(rows.find(row => row.c_1 === 'BETA').c_3), 2);
        assert.equal(Number(rows.find(row => row.c_1 === 'BETA').c_5), 7 / 3);
        assert.ok(rows.every(row => row.c_4 instanceof Date || typeof row.c_4 === 'string'));
    } finally {
        connection.closeSync();
        instance.closeSync();
        fs.rmSync(operationRoot, { recursive: true, force: true });
    }
});

test('数据清洗路由包含质量、预览、应用、记录和重放接口', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'apps', 'index.js'), 'utf8');
    assert.match(route, /datasets\/:id\/cleaning\/quality/);
    assert.match(route, /datasets\/:id\/cleaning\/preview/);
    assert.match(route, /datasets\/:id\/cleaning\/apply/);
    assert.match(route, /datasets\/:id\/cleaning\/runs/);
    assert.match(route, /cleaning\/runs\/:runId\/replay/);
    assert.equal(sqlLiteral("a'b"), "'a''b'");
    assert.throws(() => fromProjectRelative('@analysis/../../outside.parquet'), /不安全/);
});

test('数据清洗客户端提供页签、规则预览、派生数据集和规则回放操作', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'view.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'cleaning.js'), 'utf8');
    const loader = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'apps-workbench-data-analysis.js'), 'utf8');

    assert.match(view, /data-data-analysis-tab="cleaning"/);
    assert.match(view, /data-analysis-cleaning-panel/);
    assert.match(loader, /data-analysis\/cleaning\.js/);
    assert.match(client, /cleaning\/preview/);
    assert.match(client, /cleaning\/apply/);
    assert.match(client, /cleaning\/runs/);
    assert.match(client, /再次生成/);
});

test('数据清洗客户端可渲染质量报告、规则编辑器、预览和版本记录', () => {
    const elements = new Map(['data-cleaning-quality', 'data-cleaning-recommendations-list', 'data-cleaning-rules', 'data-cleaning-preview', 'data-cleaning-runs', 'data-cleaning-name']
        .map(id => [id, { id, innerHTML: '', value: '', classList: { add() {}, remove() {} } }]));
    const state = {
        activeId: 'source-1',
        cleaningDatasetId: 'source-1',
        cleaningQuality: {
            summary: { totalRows: 3, totalColumns: 2, missingCells: 1, duplicateRows: 0 },
            fields: [{ key: 'c_1', name: '客户', type: 'text', fillRate: 1, empty: 0, distinct: 2, samples: ['甲'] }],
            recommendations: [{ operation: 'trim', field: 'c_1', title: '去除空格', description: '检测到首尾空格。' }]
        },
        cleaningRules: [],
        cleaningPreview: {
            columns: [{ key: 'c_1', name: '客户' }],
            rows: [{ c_1: '甲' }],
            summary: { inputRows: 3, outputRows: 3, removedRows: 0, changedRows: 1, changedCells: 1, changedByField: { c_1: 1 } }
        },
        cleaningRuns: [{ id: 'run-1', name: '首次清洗', outputDatasetId: 'output-1', rules: [{ operation: 'trim' }], summary: { inputRows: 3, outputRows: 3, inputColumns: 2, outputColumns: 2 } }],
        cleaningRunName: '',
        cleaningLoadVersion: 0,
        datasets: [{ id: 'source-1', columns: [{ key: 'c_1', name: '客户' }, { key: 'c_2', name: '金额' }] }]
    };
    const app = {
        API: '/api/apps/data-analysis',
        state,
        esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        fmtNumber: value => String(value ?? ''),
        fetchJson: async () => ({})
    };
    const context = {
        window: { PivotDataAnalysis: app },
        document: { getElementById: id => elements.get(id) || null },
        PivotSafeHtml: { setHtml(element, html) { element.innerHTML = String(html); } },
        console,
        Date,
        Math,
        Number,
        String,
        Object,
        Array,
        Set,
        Promise
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'cleaning.js'), 'utf8'), context, {
        filename: 'client/chat/data-analysis/cleaning.js'
    });

    app.renderCleaning();
    assert.match(elements.get('data-cleaning-quality').innerHTML, /缺失单元格/);
    assert.match(elements.get('data-cleaning-recommendations-list').innerHTML, /去除空格/);
    assert.match(elements.get('data-cleaning-preview').innerHTML, /清洗预览/);
    assert.match(elements.get('data-cleaning-runs').innerHTML, /再次生成/);

    state.cleaningRules.push(app.createCleaningRule('replace', 'c_1'));
    app.renderCleaning();
    assert.match(elements.get('data-cleaning-rules').innerHTML, /查找/);
});

test('数据清洗会保留原数据集、生成派生数据集并保存可回放记录', { skip: process.env.PIVOT_TEST_DB_SYNC !== 'postgres' }, async () => {
    const suffix = Date.now().toString(36);
    const username = `cleaning_user_${suffix}`;
    const createdUser = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, (NOW() AT TIME ZONE 'Asia/Shanghai'))
        RETURNING id
    `, [username, 'hash', 'Cleaning Test', 'QA', 'user', 'active']);
    const userId = createdUser.id;
    const user = { id: userId, username };

    try {
        const source = await createDatasetFromRows({
            user,
            name: '清洗源数据',
            rows: [
                { code: ' A-01 ', customer: '甲', amount: '￥1,200.00', happened_at: '2024/01/02' },
                { code: 'A-01', customer: '甲', amount: '1,200.00', happened_at: '2024-01-02' },
                { code: 'B-02', customer: '', amount: '50%', happened_at: '2024年02月03日' }
            ]
        });
        const code = source.columns.find(column => column.name === 'code').key;
        const customer = source.columns.find(column => column.name === 'customer').key;
        const amount = source.columns.find(column => column.name === 'amount').key;
        const date = source.columns.find(column => column.name === 'happened_at').key;
        const rules = [
            { operation: 'trim', field: code },
            { operation: 'normalize_empty', field: customer },
            { operation: 'fill_missing', field: customer, strategy: 'constant', value: '未命名' },
            { operation: 'cast_number', field: amount },
            { operation: 'cast_date', field: date },
            { operation: 'deduplicate', fields: [code], includeEmpty: false },
            { operation: 'rename_column', field: customer, name: '客户名称' }
        ];

        const quality = await getCleaningQuality(userId, source.id);
        assert.equal(quality.summary.totalRows, 3);
        assert.equal(quality.summary.duplicateRows, 0);
        assert.ok(quality.recommendations.some(item => item.operation === 'normalize_empty' && item.field === customer));

        const preview = await previewCleaning(userId, source.id, rules);
        assert.equal(preview.summary.inputRows, 3);
        assert.equal(preview.summary.outputRows, 2);
        assert.equal(preview.columns.find(column => column.key === customer).name, '客户名称');

        const applied = await applyCleaning({ user, datasetId: source.id, rules, name: '清洗后的客户数据' });
        assert.notEqual(applied.dataset.id, source.id);
        assert.equal(applied.dataset.name, '清洗后的客户数据');
        assert.equal(applied.run.summary.outputRows, 2);

        const original = await getDatasetDetail(userId, source.id);
        const cleaned = await getDatasetDetail(userId, applied.dataset.id);
        assert.equal(original.rowCount, 3);
        assert.equal(cleaned.rowCount, 2);
        assert.equal(cleaned.derivedFromDatasetId, source.id);
        assert.equal(cleaned.columns.find(column => column.key === customer).name, '客户名称');
        assert.equal(Number(cleaned.previewRows.find(row => row[code] === 'B-02')[amount]), 0.5);

        const allDatasets = await listDatasets(userId);
        assert.equal(allDatasets.length, 2);
        assert.equal(allDatasets.find(dataset => dataset.id === applied.dataset.id).derivedFromDatasetId, source.id);

        const runs = await listCleaningRuns(userId, source.id);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].outputDatasetId, applied.dataset.id);
        assert.equal(runs[0].rules.length, rules.length);

        const replay = await replayCleaningRun({ user, runId: applied.run.id, name: '清洗后的客户数据（复跑）' });
        assert.equal(replay.dataset.rowCount, 2);
        assert.notEqual(replay.dataset.id, applied.dataset.id);

        const artifacts = await listDatasetArtifacts(userId, source.id);
        assert.equal(artifacts[0].type, 'cleaning');
        assert.equal(artifacts[0].cleaning.outputDatasetId, replay.dataset.id);
    } finally {
        await execute('DELETE FROM analysis_artifacts WHERE user_id = ?', [userId]);
        await execute('DELETE FROM analysis_cleaning_runs WHERE user_id = ?', [userId]);
        await execute('DELETE FROM analysis_datasets WHERE user_id = ?', [userId]);
        await execute('DELETE FROM users WHERE id = ?', [userId]);
    }
});
