const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { ensureSemanticBatches } = require('../server/services/data-analysis/semantic-analysis');

test('全量语义分析恢复会补齐部分批次并拒绝边界不一致', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const datasetId = `dataset-semantic-recovery-${suffix}`;
    const jobId = `job-semantic-recovery-${suffix}`;
    await execute(`
        INSERT INTO analysis_datasets (id, user_id, name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', ?, ?)
    `, [datasetId, user.id, '语义恢复测试数据集', '2000-01-01 00:00:00', '2000-01-01 00:00:00']);
    await execute(`
        INSERT INTO analysis_semantic_jobs (id, user_id, dataset_id, text_field, instruction, status, created_at, updated_at)
        VALUES (?, ?, ?, 'c_1', '检查恢复完整性', 'running', ?, ?)
    `, [jobId, user.id, datasetId, '2000-01-01 00:00:00', '2000-01-01 00:00:00']);
    await execute(`
        INSERT INTO analysis_semantic_batches (
            id, job_id, batch_index, segment_start, segment_end, row_start, row_end,
            segment_count, row_count, char_count, status, max_attempts
        ) VALUES (?, ?, 0, 0, 1, 1, 2, 2, 2, 20, 'succeeded', 3)
    `, [`batch-semantic-recovery-${suffix}`, jobId]);

    const batches = [
        { segmentStart: 0, segmentEnd: 1, rowStart: 1, rowEnd: 2, rowCount: 2, charCount: 20, segments: [{}, {}] },
        { segmentStart: 2, segmentEnd: 2, rowStart: 3, rowEnd: 3, rowCount: 1, charCount: 10, segments: [{}] }
    ];
    try {
        await ensureSemanticBatches({ id: jobId }, batches);
        const count = await queryOne('SELECT COUNT(*) AS count FROM analysis_semantic_batches WHERE job_id = ?', [jobId]);
        assert.equal(Number(count.count), 2);
        const succeeded = await queryOne('SELECT status FROM analysis_semantic_batches WHERE job_id = ? AND batch_index = 0', [jobId]);
        assert.equal(succeeded.status, 'succeeded');

        await assert.rejects(
            () => ensureSemanticBatches({ id: jobId }, [{ ...batches[0], segmentEnd: 99 }, batches[1]]),
            error => error.code === 'SEMANTIC_BATCH_DEFINITION_MISMATCH' && error.status === 409
        );
    } finally {
        await execute('DELETE FROM analysis_semantic_jobs WHERE id = ?', [jobId]);
        await execute('DELETE FROM analysis_datasets WHERE id = ?', [datasetId]);
    }
});
