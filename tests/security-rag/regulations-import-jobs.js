const { assert, db, fs, path, test, uploadRoot } = require('../security-helpers');
const {
    claimNextRegulationImportJob,
    cancelRegulationImportJob,
    enqueueRegulationImportJob,
    failRegulationImportJob,
    listRegulationImportJobs,
    processRegulationImportJob
    , retryRegulationImportJob
} = require('../../server/services/regulations/import-jobs');
const { listRegulationArticleLocations } = require('../../server/services/regulations');
const { deriveArticleLocations } = require('../../server/services/regulations/locations');

async function createUploadFile(name, content) {
    const folder = path.join(uploadRoot, 'regulations-job-tests');
    await fs.promises.mkdir(folder, { recursive: true });
    const filePath = path.join(folder, name);
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { path: filePath, originalname: name, mimetype: 'text/plain' };
}

test('法规导入任务持久化排队、发布结果和可查询进度', async () => {
    const file = await createUploadFile('导入任务测试办法_20240101.txt', '第一条 为规范导入任务，制定本办法。\n第二条 本办法适用于测试。');
    const queued = await enqueueRegulationImportJob({
        userId: 1,
        file,
        metadata: { category: '行业规范', effectStatus: 'unverified' }
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.progress, 0);
    assert.equal(Object.hasOwn(queued, 'source_path'), false);
    const claimed = await claimNextRegulationImportJob({ workerId: 'regulation-test-worker' });
    assert.equal(claimed.id, queued.id);
    assert.equal(claimed.status, 'running');
    const result = await processRegulationImportJob(claimed);
    assert.ok(result.document?.id);
    assert.ok(result.version?.id);
    const jobs = await listRegulationImportJobs({ userId: 1 });
    const completed = jobs.data.find(job => job.id === queued.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.documentId, result.document.id);
    assert.equal(completed.versionId, result.version.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM regulation_articles WHERE version_id = ?').get(result.version.id).count, 2);
    const firstArticle = db.prepare('SELECT id FROM regulation_articles WHERE version_id = ? ORDER BY sort_order ASC LIMIT 1').get(result.version.id);
    const locations = await listRegulationArticleLocations({ articleId: firstArticle.id });
    assert.equal(locations.length, 1);
    assert.equal(Number(locations[0].page_number), 1);
    assert.ok(Number(locations[0].char_end) > Number(locations[0].char_start));
});

test('空文本法规导入任务终止为失败且不建立空法规文档', async () => {
    const file = await createUploadFile('空导入任务.txt', '');
    const queued = await enqueueRegulationImportJob({ userId: 1, file, metadata: {} });
    const claimed = await claimNextRegulationImportJob({ workerId: 'regulation-test-worker' });
    assert.equal(claimed.id, queued.id);
    await assert.rejects(processRegulationImportJob(claimed), { statusCode: 422 });
    const failure = await failRegulationImportJob(claimed, Object.assign(new Error('未能从文档中提取可用正文'), { statusCode: 422 }));
    assert.equal(failure.status, 'failed');
    const row = db.prepare('SELECT status, attempts, error_message FROM regulation_import_jobs WHERE id = ?').get(queued.id);
    assert.equal(row.status, 'failed');
    assert.equal(Number(row.attempts), 1);
    assert.match(row.error_message, /未能从文档中提取/);
});

test('法规导入任务拒绝上传根目录外的源文件路径', async () => {
    const outside = path.join(path.dirname(uploadRoot), 'regulation-job-outside.txt');
    await fs.promises.writeFile(outside, '第一条 不应读取此文件', 'utf8');
    try {
        await assert.rejects(
            enqueueRegulationImportJob({ userId: 1, file: { path: outside, originalname: '外部路径.txt' }, metadata: {} }),
            { statusCode: 400 }
        );
    } finally {
        await fs.promises.rm(outside, { force: true });
    }
});

test('法规导入任务仅在未领取时可取消，失败任务可由创建者重新提交', async () => {
    const file = await createUploadFile('可恢复导入任务.txt', '第一条 可恢复任务正文。');
    const queued = await enqueueRegulationImportJob({ userId: 1, file, metadata: {} });
    const cancelled = await cancelRegulationImportJob({ jobId: queued.id, userId: 1 });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await cancelRegulationImportJob({ jobId: queued.id, userId: 1 }), null);
    const retried = await retryRegulationImportJob({ jobId: queued.id, userId: 1 });
    assert.equal(retried.status, 'queued');
    assert.equal(retried.attempts, 0);
    assert.equal(await retryRegulationImportJob({ jobId: queued.id, userId: 2 }), null);
});

test('法规页码定位能识别 PDF 提取器在页末写入的页分隔标记', () => {
    const text = '第一条 第一页正文。\n-- 1 of 2 --\n\n第二条 第二页正文。\n-- 2 of 2 --';
    const locations = deriveArticleLocations([
        { sortOrder: 1, content: '第一条 第一页正文。' },
        { sortOrder: 2, content: '第二条 第二页正文。' }
    ], text);
    assert.equal(locations[0].pageNumber, 1);
    assert.equal(locations[1].pageNumber, 2);
});
