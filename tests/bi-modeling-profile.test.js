'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DuckDBInstance } = require('@duckdb/node-api');
const { profileWithConnection } = require('../server/services/data-analysis/profile-sql');

test('宽字符串画像按原值分桶精确去重，哈希仅规划内存，预览截断不合并不同长值', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-profile-')), file = path.join(root, 'wide.parquet');
    const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '512MiB' }), connection = await instance.connect();
    try {
        const quoted = `'${file.replaceAll('\\', '/').replaceAll("'", "''")}'`;
        await connection.run(`COPY (SELECT repeat('界',1000)||CASE WHEN i<100 THEN '重复' ELSE CAST(i AS VARCHAR) END AS c_1,'0.25' AS c_2,NULL::VARCHAR AS c_3 FROM range(50000) t(i)) TO ${quoted} (FORMAT PARQUET)`);
        let partitions = 0;
        const profile = await profileWithConnection(connection, file, [{ key: 'c_1', name: '长文本' }, { key: 'c_2', name: '金额' }, { key: 'c_3', name: '空字段' }], 50000,
            { sampleChars: 256, run: async sql => { if (sql.includes('WHERE hash(v)%')) partitions++; return connection.runAndReadAll(sql); } });
        assert.ok(partitions > 1); assert.equal(profile[0].distinct, 49901); assert.equal(profile[0].filled, 50000);
        assert.equal(profile[0].topValues[0].count, 100); assert.equal(profile[0].topValues[0].value, '界'.repeat(256));
        assert.ok(profile[0].topValues.slice(1).every(item => item.count === 1));
        assert.equal(profile[1].distinct, 1); assert.equal(profile[1].numeric.sum, 12500); assert.equal(profile[2].empty, 50000);
    } finally { connection.closeSync(); instance.closeSync(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});
