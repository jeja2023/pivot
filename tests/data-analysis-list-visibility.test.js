'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { listDatasets, getDatasetSummary } = require('../server/services/data-analysis/datasets');

test('数据集列表与统计按共享范围隔离，并隐藏共享敏感字段', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const owner = await queryOne('INSERT INTO users (username, password_hash, unit) VALUES (?, ?, ?) RETURNING id', [`owner_${suffix}`, 'hash', 'A']);
    const reader = await queryOne('INSERT INTO users (username, password_hash, unit) VALUES (?, ?, ?) RETURNING id', [`reader_${suffix}`, 'hash', 'B']);
    const rows = [
        ['own', reader.id, 'personal', '', '', 1],
        ['private', owner.id, 'personal', '', '', 2],
        ['unit', owner.id, 'shared', 'B', '', 3],
        ['person', owner.id, 'shared', '', String(reader.id), 4],
        ['other', owner.id, 'shared', 'C', '', 5],
        ['legacy', owner.id, '\tshared\n', 'B', '', 7],
        ['invalid', owner.id, 'unexpected', '', '', 8],
        ['all', owner.id, 'shared', '', '', 6]
    ];
    const columns = JSON.stringify([{ key: 'public', name: '公开' }, { key: 'secret', name: '秘密' }]);
    const profile = JSON.stringify([{ key: 'public' }, { key: 'secret' }]);
    const preview = JSON.stringify([{ public: 'ok', secret: 'hidden' }]);
    try {
        for (const [id, userId, scope, units, users, count] of rows) {
            await execute(`INSERT INTO analysis_datasets
                (id, user_id, name, scope, allowed_units, allowed_user_ids, row_count, columns_json, profile_json, preview_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [`${id}_${suffix}`, userId, id, scope, units, users, count, columns, profile, preview]);
        }
        await execute(`INSERT INTO analysis_field_governance (dataset_id, user_id, field_key, sensitivity)
            VALUES (?, ?, ?, ?)`, [`unit_${suffix}`, owner.id, 'secret', 'restricted']);
        const list = await listDatasets({ id: reader.id, unit: 'B' });
        const relevant = list.filter(row => row.id.endsWith(`_${suffix}`));
        assert.deepEqual(relevant.map(row => row.name).sort(), ['all', 'legacy', 'own', 'person', 'unit']);
        const unit = relevant.find(row => row.name === 'unit');
        assert.deepEqual(unit.columns.map(c => c.key), ['public']);
        assert.deepEqual(unit.profile.map(c => c.key), ['public']);
        assert.deepEqual(unit.previewRows, [{ public: 'ok' }]);
        assert.deepEqual(await getDatasetSummary({ id: reader.id, unit: 'B' }), { count: 5, rowCount: 21 });
    } finally {
        await execute('DELETE FROM analysis_datasets WHERE id LIKE ?', [`%_${suffix}`]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, reader.id]);
    }
});
