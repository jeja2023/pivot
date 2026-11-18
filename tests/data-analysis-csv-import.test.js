const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { query, queryOne } = require('../server/db/client');
const { importCsvToParquet } = require('../server/services/data-analysis/datasets');
const { datasetRoot, getDatasetPaths, parquetToRows } = require('../server/services/data-analysis/shared');

const csv = '账号,备注\r\n0007,"华东,入账"\r\n0008,复核\r\n';
const gbk = Buffer.from('d5cbbac52cb1b8d7a20d0a303030372c22bbaab6ab2cc8ebd5cb220d0a303030382cb8b4bacb0d0a', 'hex');

test('上传 CSV 保留中文、带引号的分隔符、前导零及原始字节，拒绝损坏编码', async () => {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const { app, flushAllWrites } = require('../server/app');
    const { generateAccessToken } = require('../server/auth');
    const user = await queryOne(
        "INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id, username, role",
        [`csv_import_${crypto.randomUUID()}`]
    );
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const token = generateAccessToken(user, { sessionIp: '127.0.0.1' });
    const upload = async (bytes, name, authenticated = true) => {
        const body = new globalThis.FormData();
        body.set('file', new globalThis.Blob([bytes], { type: 'text/csv' }), name);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/data-analysis/datasets`, {
            method: 'POST',
            headers: { authorization: `Bearer ${authenticated ? token : 'invalid-token'}` },
            body
        });
        return { status: response.status, body: await response.json() };
    };

    try {
        assert.equal((await upload(gbk, 'unauthorized.csv', false)).status, 401);
        const utf16 = Buffer.from(`\ufeff${csv}`, 'utf16le');
        const fixtures = [
            ['GBK', gbk],
            ['UTF-8', Buffer.from(csv)],
            ['UTF-8 BOM', Buffer.from(`\ufeff${csv}`)],
            ['UTF-16LE BOM', utf16],
            ['UTF-16BE BOM', Buffer.from(utf16).swap16()]
        ];
        for (const [encoding, bytes] of fixtures) {
            const result = await upload(bytes, `${encoding}.csv`);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            const { dataset } = result.body;
            assert.deepEqual(dataset.columns.map(column => column.name), ['账号', '备注'], encoding);
            assert.equal(dataset.rowCount, 2, encoding);
            assert.deepEqual(dataset.previewRows, [{ c_1: '0007', c_2: '华东,入账' }, { c_1: '0008', c_2: '复核' }], encoding);
            const row = await queryOne('SELECT parquet_path, source_path FROM analysis_datasets WHERE id=?', [dataset.id]);
            const { sourcePath } = getDatasetPaths(row);
            assert.deepEqual(await fs.readFile(sourcePath), bytes, encoding);
            assert.deepEqual((await fs.readdir(path.dirname(sourcePath))).sort(), [`${encoding}.csv`, 'data.parquet'].sort());
        }

        const broken = Buffer.concat([Buffer.from('id,memo\n01,ok\n02,'), Buffer.from([0x81])]);
        for (const bytes of [broken, Buffer.concat([Buffer.from('\ufeff'), gbk])]) {
            const result = await upload(bytes, 'broken.csv');
            assert.equal(result.status, 400, JSON.stringify(result.body));
            assert.equal(result.body.code, 'ANALYSIS_CSV_ENCODING');
            assert.match(result.body.error, /另存为 UTF-8 CSV/);
        }
        const empty = await upload(Buffer.alloc(0), 'empty.csv');
        assert.equal(empty.status, 400, JSON.stringify(empty.body));
        const rows = await query('SELECT id FROM analysis_datasets WHERE user_id=?', [user.id]);
        assert.deepEqual((await fs.readdir(path.join(datasetRoot, String(user.id)))).sort(), rows.map(row => row.id).sort());
        assert.equal(rows.length, fixtures.length);
    } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await flushAllWrites();
    }
});

test('GB18030 转码在读取边界保留四字节字符并按实际列名复制宽表', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-csv-import-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'input.csv');
    const output = path.join(root, 'data.parquet');
    const headers = Array.from({ length: 12 }, (_, index) => `field_${index + 1}`);
    const prefix = Buffer.from(`${headers.join(',')}\n0007,`);
    // 将 GB18030 字符的首字节放在默认读取块的末尾。
    const padding = Buffer.alloc(64 * 1024 - 1 - prefix.length, 0x61);
    const suffix = Buffer.from(',3,4,5,6,7,8,9,10,11,12\n');
    await fs.writeFile(input, Buffer.concat([prefix, padding, Buffer.from('90308130', 'hex'), suffix]));
    const imported = await importCsvToParquet(input, output);
    assert.deepEqual(imported.columns.map(column => column.name), headers);
    assert.equal(imported.sourceColumnCount, 12);
    assert.equal(imported.rowCount, 1);
    const [row] = await parquetToRows(output);
    assert.equal(row.c_1, '0007');
    assert.equal(row.c_2, padding.toString() + '𐀀');
    assert.equal(row.c_12, '12');
    assert.deepEqual((await fs.readdir(root)).sort(), ['data.parquet', 'input.csv']);
});
