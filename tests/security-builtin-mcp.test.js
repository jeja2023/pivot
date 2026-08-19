// 内置工具库（Built-in MCP）执行路径测试
// 内置工具是工具库能力的实际执行体，直接读取服务器报表目录、处理数据并向内网发送通知，
// 此前仅有 system.health 与 models.list 被间接触及。本套件覆盖分发层、数据处理正确性
// 和报表目录的授权边界，重点保证越权路径与非白名单扩展名不可读取。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools,
    executeBuiltinMcpTool,
    normalizeBuiltinPayload
} = require('../server/services/builtin-mcp');
const { executeFormatConversionTool } = require('../server/services/builtin-mcp-format');
const { executeDataProcessingTool } = require('../server/services/builtin-mcp-data');
const { executeReportConfigTool } = require('../server/services/builtin-mcp-reports');

const SAMPLE_ROWS = [
    { 部门: '财务部', 金额: '120', 备注: ' 已核销 ' },
    { 部门: '财务部', 金额: '80', 备注: '待核销' },
    { 部门: '技术部', 金额: '200', 备注: '' }
];

// 建一个隔离的报表根目录，用于验证授权边界。
function createReportSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-builtin-mcp-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-builtin-mcp-outside-'));
    fs.writeFileSync(path.join(root, '月度报表.csv'), '部门,金额\n财务部,120\n技术部,200\n', 'utf8');
    fs.writeFileSync(path.join(root, '说明.md'), '# 报表说明\n\n本目录用于测试。\n', 'utf8');
    // 授权目录内的非白名单扩展名，用于验证扩展名限制
    fs.writeFileSync(path.join(root, '配置.ini'), 'key=value\n', 'utf8');
    // 授权目录之外的敏感文件，用于验证路径穿越防护
    fs.writeFileSync(path.join(outside, '机密.csv'), '账号,密码\nadmin,secret\n', 'utf8');
    return {
        config: { roots: [root], extensions: ['csv', 'md', 'json', 'txt'], maxFileMb: 20, maxRows: 500 },
        root,
        outside,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
            fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
        }
    };
}

test('内置工具分发层按 URL 前缀识别全部服务类型', () => {
    const expected = {
        'pivot-reports://local': 'reports',
        'pivot-visualization://local': 'visualization',
        'pivot-report://local': 'report',
        'pivot-documents://local': 'documents',
        'pivot-data://local': 'data',
        'pivot-format://local': 'format',
        'pivot-im://local': 'im'
    };
    Object.entries(expected).forEach(([url, type]) => {
        assert.equal(getBuiltinServiceTypeFromUrl(url), type, `${url} 应识别为 ${type}`);
        assert.equal(isInternalMcpUrl(url), true);
    });
    assert.equal(getBuiltinServiceTypeFromUrl('https://example.test/mcp'), '');
    assert.equal(isInternalMcpUrl('https://example.test/mcp'), false);
    assert.equal(isInternalMcpUrl('pivot-db://1'), true);
});

test('内置工具分发层拒绝未知服务类型', async () => {
    const server = { base_url: 'https://example.test/mcp' };
    assert.throws(() => listBuiltinMcpTools(server), /Unsupported built-in MCP server|不支持的内置 MCP 服务类型/);
    await assert.rejects(
        () => executeBuiltinMcpTool(server, 'format.to_json', { value: 1 }),
        /Unsupported built-in MCP server|不支持的内置 MCP 服务类型/
    );
});

test('内置工具清单对每种服务类型都返回带 schema 的工具', () => {
    ['reports', 'visualization', 'report', 'documents', 'data', 'format', 'im'].forEach(type => {
        const tools = listBuiltinMcpTools({ base_url: `pivot-${type}://local` });
        assert.ok(Array.isArray(tools) && tools.length > 0, `${type} 应返回工具列表`);
        tools.forEach(tool => {
            assert.match(tool.name, /^[a-z_]+\.[a-z_]+$/, `工具名格式异常: ${tool.name}`);
            assert.ok(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} 缺少入参 schema`);
        });
    });
});

test('格式转换工具覆盖表格、JSON 序列化与文本规范化', () => {
    const table = executeFormatConversionTool(null, 'format.to_markdown_table', { rows: SAMPLE_ROWS, columns: ['部门', '金额'] });
    assert.equal(table.type, 'format_markdown_table');
    assert.equal(table.rowCount, 3);
    assert.deepEqual(table.columns, ['部门', '金额']);
    assert.match(table.markdown, /财务部/);

    const pretty = executeFormatConversionTool(null, 'format.to_json', { value: { a: 1 } });
    assert.match(pretty.json, /\n/, '默认应输出带缩进的 JSON');
    const compact = executeFormatConversionTool(null, 'format.to_json', { value: { a: 1 }, pretty: false });
    assert.equal(compact.json, '{"a":1}');

    const normalized = executeFormatConversionTool(null, 'format.normalize_text', { text: '  多余   空格\r\n\n\n\n结尾  ', mode: 'upper' });
    assert.equal(normalized.text.includes('\r'), false);
    assert.equal(/\n{3,}/.test(normalized.text), false);
    assert.equal(normalized.charCount, normalized.text.length);
});

test('JSON 提取工具能从混杂文本中取出首个 JSON 并在缺失时报 400', () => {
    const extracted = executeFormatConversionTool(null, 'format.extract_json', {
        text: '模型回答如下：{"name": "测试", "items": [1, 2]} 以上。'
    });
    assert.equal(extracted.value.name, '测试');
    assert.deepEqual(extracted.value.items, [1, 2]);

    // 含大括号但不是合法 JSON 时也应按未找到处理，避免把脏数据当结果返回
    assert.throws(
        () => executeFormatConversionTool(null, 'format.extract_json', { text: '没有 JSON 的说明文本' }),
        error => error.status === 400
    );
});

test('格式转换工具拒绝未知工具名', () => {
    assert.throws(
        () => executeFormatConversionTool(null, 'format.unknown_tool', {}),
        /Unsupported format MCP tool|不支持的格式.*工具/
    );
});

test('数据处理工具的画像、过滤与字段规范化结果正确', () => {
    const profile = executeDataProcessingTool(null, 'data.profile_rows', { rows: SAMPLE_ROWS });
    assert.equal(profile.rowCount, 3);
    const amountField = profile.fields.find(item => item.field === '金额');
    assert.equal(amountField.filled, 3);
    assert.equal(amountField.fillRate, 1);
    // 空字符串不计入填充数
    const remarkField = profile.fields.find(item => item.field === '备注');
    assert.equal(remarkField.filled, 2);

    const contains = executeDataProcessingTool(null, 'data.filter_rows', { rows: SAMPLE_ROWS, filters: { 部门: '财务' } });
    assert.equal(contains.rowCount, 2, '默认按包含匹配');
    const exact = executeDataProcessingTool(null, 'data.filter_rows', { rows: SAMPLE_ROWS, filters: { 部门: '财务' }, matchMode: 'exact' });
    assert.equal(exact.rowCount, 0, '精确匹配不应命中部分文本');

    const normalized = executeDataProcessingTool(null, 'data.normalize_fields', {
        rows: SAMPLE_ROWS,
        renameMap: { 备注: 'remark' }
    });
    assert.equal(normalized.rows[0].remark, '已核销', '字符串应被去除首尾空格并按映射改名');
    assert.equal('备注' in normalized.rows[0], false);
});

test('数据分组汇总支持多种聚合方式且缺少 groupBy 时报 400', () => {
    const sum = executeDataProcessingTool(null, 'data.group_summary', { rows: SAMPLE_ROWS, groupBy: '部门', valueField: '金额' });
    const finance = sum.rows.find(row => row.部门 === '财务部');
    assert.equal(sum.aggregation, 'sum');
    assert.equal(finance.value, 200);
    assert.equal(finance.count, 2);

    const avg = executeDataProcessingTool(null, 'data.group_summary', { rows: SAMPLE_ROWS, groupBy: '部门', valueField: '金额', aggregation: 'avg' });
    assert.equal(avg.rows.find(row => row.部门 === '财务部').value, 100);

    const counted = executeDataProcessingTool(null, 'data.group_summary', { rows: SAMPLE_ROWS, groupBy: '部门' });
    assert.equal(counted.aggregation, 'count');
    assert.equal(counted.rows.find(row => row.部门 === '技术部').value, 1);

    assert.throws(
        () => executeDataProcessingTool(null, 'data.group_summary', { rows: SAMPLE_ROWS }),
        error => error.status === 400
    );
});

test('报表目录工具只列出授权根目录内的白名单文件', async () => {
    const sandbox = createReportSandbox();
    try {
        const listed = await executeReportConfigTool(sandbox.config, 'reports.list_files', {});
        const names = listed.files.map(file => path.basename(file.relativePath || file.path || ''));
        assert.ok(names.includes('月度报表.csv'));
        assert.ok(names.includes('说明.md'));
        assert.equal(names.includes('配置.ini'), false, '非白名单扩展名不应出现在清单中');
    } finally {
        sandbox.cleanup();
    }
});

test('报表目录工具可读取授权范围内的文件摘要', async () => {
    const sandbox = createReportSandbox();
    try {
        const summary = await executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: '月度报表.csv' });
        assert.equal(summary.file.extension, 'csv');
        assert.deepEqual(summary.columns, ['部门', '金额']);
        assert.ok(summary.sampleRows.length >= 1);
    } finally {
        sandbox.cleanup();
    }
});

test('报表目录工具拒绝路径穿越与授权目录外的绝对路径', async () => {
    const sandbox = createReportSandbox();
    const outsideFile = path.join(sandbox.outside, '机密.csv');
    try {
        // 相对路径穿越：解析后落在授权根目录之外，应按“未找到”处理而不是读取成功
        await assert.rejects(
            () => executeReportConfigTool(sandbox.config, 'reports.read_file_summary', {
                path: path.join('..', path.basename(sandbox.outside), '机密.csv')
            }),
            error => error.status === 404
        );

        // 绝对路径同样不得越过授权根目录
        await assert.rejects(
            () => executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: outsideFile }),
            error => error.status === 404
        );

        // 确认该文件本身是可读的，排除“测试文件不存在”导致的假阳性
        assert.equal(fs.existsSync(outsideFile), true);
    } finally {
        sandbox.cleanup();
    }
});

test('报表目录工具拒绝非白名单扩展名并要求提供路径', async () => {
    const sandbox = createReportSandbox();
    try {
        await assert.rejects(
            () => executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: '配置.ini' }),
            error => error.status === 400 && /不允许读取/.test(error.message)
        );
        await assert.rejects(
            () => executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: '' }),
            error => error.status === 400
        );
    } finally {
        sandbox.cleanup();
    }
});

test('内置载荷归一化会保留报表根目录并约束读取上限', () => {
    const payload = normalizeBuiltinPayload('reports', {
        roots: ['/srv/reports', '/srv/exports'],
        extensions: ['csv', 'exe', 'md'],
        maxFileMb: 9999,
        maxRows: 99999
    });
    assert.equal(payload.serviceType, 'reports');
    const config = payload.config;
    assert.equal(config.roots.length, 2);
    assert.equal(config.extensions.includes('exe'), false, '不支持的扩展名应被过滤');
    assert.ok(config.extensions.includes('csv') && config.extensions.includes('md'));
    assert.equal(config.maxFileMb, 200, '单文件上限应被夹到 200MB');
    assert.equal(config.maxRows, 5000, '读取行数应被夹到 5000');

    // 未配置任何根目录时必须拒绝，避免生成一个可读取范围不明确的报表工具
    assert.throws(
        () => normalizeBuiltinPayload('reports', { roots: [] }),
        error => error.status === 400
    );
});

test('内网消息通知配置会校验端点并保留目标白名单', () => {
    const payload = normalizeBuiltinPayload('im', {
        endpointUrl: 'https://im.example.test/webhook',
        allowedTargets: ['team-a', 'team-b', 'team-a'],
        maxMessageLength: 999999
    });
    assert.equal(payload.serviceType, 'im');
    const config = payload.config;
    assert.equal(config.method, 'POST');
    assert.deepEqual(config.allowedTargets, ['team-a', 'team-b'], '重复目标应去重');
    assert.equal(config.maxMessageLength, 10000, '消息长度应被夹到上限');

    // 非法端点必须在配置阶段就被拒绝，避免落库后再出站
    assert.throws(() => normalizeBuiltinPayload('im', { endpointUrl: 'file:///etc/passwd' }));
    // 缺少端点时不应生成可用配置
    assert.throws(
        () => normalizeBuiltinPayload('im', { allowedTargets: ['team-a'] }),
        error => error.status === 400
    );
});

test('报表目录工具读取不带 BOM 的 UTF-8 CSV 不会出现中文乱码', async () => {
    const sandbox = createReportSandbox();
    const noBomPath = path.join(sandbox.root, '无BOM.csv');
    const withBomPath = path.join(sandbox.root, '带BOM.csv');
    // 程序或 Linux 导出的 CSV 通常不带 BOM，若按单字节编码解析会让中文表头和内容整体乱码，
    // 并把乱码带进模型上下文，因此两种写法都必须解析正确。
    fs.writeFileSync(noBomPath, '部门,金额\n财务部,120\n技术部,200\n', 'utf8');
    fs.writeFileSync(withBomPath, '﻿部门,金额\n财务部,120\n', 'utf8');
    try {
        const noBom = await executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: '无BOM.csv' });
        assert.deepEqual(noBom.columns, ['部门', '金额']);
        assert.deepEqual(noBom.sampleRows[0], { 部门: '财务部', 金额: '120' });

        const withBom = await executeReportConfigTool(sandbox.config, 'reports.read_file_summary', { path: '带BOM.csv' });
        assert.deepEqual(withBom.columns, ['部门', '金额'], 'BOM 应被剥离且不污染首列列名');

        // 表格查询与摘要共用同一读取实现，需一并确认列名正确
        const queried = await executeReportConfigTool(sandbox.config, 'reports.query_table', { path: '无BOM.csv' });
        assert.deepEqual(queried.columns, ['部门', '金额']);
    } finally {
        sandbox.cleanup();
    }
});
