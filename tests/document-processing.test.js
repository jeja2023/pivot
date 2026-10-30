const {
    assert,
    db,
    fs,
    path,
    readZipEntries,
    removeTestPath,
    runExpressHandlers,
    test,
    uploadRoot
} = require('./security-helpers');

const {
    createJobExport,
    createJobFromUpload,
    createOcrBatchFromUploads,
    assignReviewers,
    completeReview,
    submitOcrFeedback,
    reviewOcrFeedback,
    createPdfToolJobFromUploads,
    deleteJob,
    getDocumentProcessingSettings,
    getExportRequest,
    getJobPageSlice,
    getOcrChatContext,
    extractOcrFields,
    getOcrCapabilities,
    getJobDetail,
    getJobOutputsArchive,
    getJobOutputsArchiveStream,
    getOutputDownload,
    reprocessJob,
    preflightOcrUploads,
    retryJob,
    requestJobExport,
    savePageReview,
    updateDocumentProcessingSettings
} = require('../server/services/document-processing');
const {
    getPdfToolCapabilities,
    parsePageOrder,
    parsePageSelection
} = require('../server/services/document-processing/pdf');
const { getQpdfHealth } = require('../server/services/document-processing/pdf/engines/qpdf');
const { documentRoot, resolveStoredDocumentPath } = require('../server/services/document-processing/paths');
const { PDFDocument, PDFName } = require('pdf-lib');
const XLSX = require('@e965/xlsx');
const nodeHttp = require('http');
const httpOcr = require('../server/services/document-processing/ocr/adapters/http');
const { normalizeEngine } = require('../server/services/document-processing/ocr');
const { buildRecognitionResult } = require('../server/services/document-processing/ocr/adapters/shared');
const { createZip } = require('../server/services/document-processing/exporters');
const { extractOfdText } = require('../server/document-text');
const { extractPdfTextWithPageFallback } = require('../server/services/document-processing/text-extraction');
const { DOCUMENT_PROCESSING_SETTING_KEYS } = require('../server/services/document-processing/constants');
const { createOcrRouter } = require('../server/routes/apps/ocr');
const { deleteAppSettingAsync, refreshAppSettingsCache, setAppSettingAsync } = require('../server/services/app-settings');

async function waitForDocumentJob(userId, jobId, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const detail = await getJobDetail({ userId, jobId });
        if (detail && !['queued', 'processing'].includes(detail.job.status)) return detail;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('文档处理任务等待超时');
}


async function createSamplePdf(filePath, labels = ['Sample PDF']) {
    const pdf = await PDFDocument.create();
    labels.forEach(label => {
        const page = pdf.addPage([320, 240]);
        page.drawText(label, { x: 40, y: 180, size: 18 });
    });
    fs.writeFileSync(filePath, await pdf.save());
}

async function createFormPdf(filePath) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([320, 240]);
    const form = pdf.getForm();
    const name = form.createTextField('申请人');
    name.addToPage(page, { x: 40, y: 150, width: 180, height: 24 });
    const confirm = form.createCheckBox('确认');
    confirm.addToPage(page, { x: 40, y: 105, width: 18, height: 18 });
    fs.writeFileSync(filePath, await pdf.save());
}

function preserveAppSetting(key, callback) {
    const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').all(key);
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    const restore = () => {
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        rows.forEach(row => {
            db.prepare('INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)')
                .run(row.key, row.value, row.updated_at, row.updated_by);
        });
    };
    try {
        const result = callback();
        if (result && typeof result.then === 'function') {
            return result.finally(restore);
        }
        restore();
        return result;
    } catch (error) {
        restore();
        throw error;
    }
}


function createJsonResponse() {
    return {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function createOcrRouteForTest(pathName, method = 'get') {
    const router = createOcrRouter({
        authMiddleware: (_req, _res, next) => next(),
        uploadLimiter: (_req, _res, next) => next(),
        upload: { single: () => (_req, _res, next) => next() },
        logAction: () => {}
    });
    return router.stack.find(layer => layer.route?.path === pathName && layer.route?.methods?.[method]);
}

function cleanupDocumentProcessingRows(userId) {
    const paths = [];
    db.prepare('SELECT file_path FROM document_outputs WHERE user_id = ?').all(userId).forEach(row => paths.push(row.file_path));
    db.prepare('SELECT image_path FROM document_pages WHERE user_id = ?').all(userId).forEach(row => paths.push(row.image_path));
    db.prepare('SELECT file_path FROM document_files WHERE user_id = ?').all(userId).forEach(row => paths.push(row.file_path));
    paths.forEach(relativePath => {
        const target = resolveStoredDocumentPath(relativePath);
        if (target) removeTestPath(target);
    });
    db.prepare('DELETE FROM document_outputs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_exports WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_distributions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_ocr_blocks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_page_revisions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_reviews WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_pages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_jobs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM document_files WHERE user_id = ?').run(userId);
}

test('文档处理底座会登记文件、生成任务和受控输出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`doc_processing_${suffix}`, 'hash', 'Document Processing Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'document-processing-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${suffix}.txt`);
    fs.writeFileSync(tempPath, '第一行文档处理测试\n第二行用于导出验证', 'utf8');

    try {
        const initial = await createJobFromUpload({
            user: { id: userId, username: `doc_processing_${suffix}` },
            file: {
                path: tempPath,
                originalname: '文档处理测试.txt',
                mimetype: 'text/plain',
                size: fs.statSync(tempPath).size
            },
            jobType: 'extract_text',
            sourceModule: 'document_processing',
            config: {}
        });
        assert.equal(initial.job.status, 'queued');
        assert.equal(initial.file.originalName, '文档处理测试.txt');
        assert.equal(Object.prototype.hasOwnProperty.call(initial.file, 'filePath'), false);

        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded');
        assert.equal(detail.pages.length, 1);
        assert.match(detail.pages[0].text, /文档处理测试/);
        assert.ok(detail.outputs.some(output => output.outputType === 'txt'));
        assert.ok(detail.outputs.some(output => output.outputType === 'markdown'));
        assert.ok(detail.outputs.some(output => output.outputType === 'json'));

        const output = detail.outputs.find(item => item.outputType === 'txt');
        const download = await getOutputDownload({ userId, outputId: output.id });
        assert.ok(download.filePath.startsWith(documentRoot));
        assert.equal(fs.existsSync(download.filePath), true);
        assert.match(fs.readFileSync(download.filePath, 'utf8'), /第二行用于导出验证/);

        const htmlOutput = await createJobExport({ userId, jobId: detail.job.id, format: 'html' });
        assert.equal(htmlOutput.outputType, 'html');
        assert.ok((await getOutputDownload({ userId, outputId: htmlOutput.id })).filePath.startsWith(documentRoot));

        const reviewed = await savePageReview({
            userId,
            pageId: detail.pages[0].id,
            revisedText: '人工修订后的识别文本',
            reviewStatus: 'reviewed',
            lowConfidenceConfirmed: true
        });
        assert.equal(reviewed.pages[0].text, '人工修订后的识别文本');
        assert.equal(reviewed.reviews.length, 1);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('手动导出与任务清理共用任务锁，锁释放后可正常导出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare("INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Export Lock', 'QA', 'user', 'active', now())").run(`doc_export_lock_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'document-export-lock-test', String(userId));
    const source = path.join(tempDir, 'source.txt');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(source, '隔离导出测试');
    const owner = await require('../server/db/pg-connection').getPgPool().connect();
    let jobId;
    try {
        const initial = await createJobFromUpload({ user: { id: userId }, file: { path: source, originalname: 'source.txt', mimetype: 'text/plain', size: fs.statSync(source).size }, jobType: 'auto', sourceModule: 'document_processing' });
        jobId = initial.job.id;
        assert.equal((await waitForDocumentJob(userId, jobId)).job.status, 'succeeded');
        await owner.query("SELECT pg_advisory_lock(hashtext('pivot_document_job'), hashtext($1::text))", [String(jobId)]);
        assert.equal(await createJobExport({ userId: userId + 100000, jobId, format: 'txt' }), null);
        await assert.rejects(createJobExport({ userId, jobId, format: 'txt' }), error => error.code === 'DOCUMENT_JOB_BUSY');
        await owner.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(jobId)]);
        const output = await createJobExport({ userId, jobId, format: 'txt' });
        assert.ok(output?.id);
        const saved = await getOutputDownload({ userId, outputId: output.id });
        assert.match(fs.readFileSync(saved.filePath, 'utf8'), /隔离导出测试/);
    } finally {
        if (jobId) await owner.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(jobId)]).catch(() => {});
        owner.release();
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('文档处理任务删除会清理任务记录和受控文件', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`doc_delete_${suffix}`, 'hash', 'Document Delete Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'document-delete-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${suffix}.txt`);
    fs.writeFileSync(tempPath, '用于验证删除任务的文本内容', 'utf8');

    try {
        const initial = await createJobFromUpload({
            user: { id: userId, username: `doc_delete_${suffix}` },
            file: {
                path: tempPath,
                originalname: '待删除任务.txt',
                mimetype: 'text/plain',
                size: fs.statSync(tempPath).size
            },
            jobType: 'extract_text',
            sourceModule: 'document_processing',
            config: {}
        });
        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded');

        const fileRow = db.prepare('SELECT id, file_path FROM document_files WHERE id = ? AND user_id = ?').get(detail.file.id, userId);
        const outputRow = db.prepare('SELECT id, file_path FROM document_outputs WHERE job_id = ? AND user_id = ? LIMIT 1').get(detail.job.id, userId);
        const storedPath = resolveStoredDocumentPath(fileRow.file_path);
        const outputPath = resolveStoredDocumentPath(outputRow.file_path);
        assert.equal(fs.existsSync(storedPath), true);
        assert.equal(fs.existsSync(outputPath), true);

        const deleted = await deleteJob({ userId, jobId: detail.job.id, sourceModule: 'document_processing' });
        assert.equal(deleted.id, detail.job.id);
        assert.equal(await getJobDetail({ userId, jobId: detail.job.id }), null);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM document_jobs WHERE id = ?').get(detail.job.id).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM document_outputs WHERE job_id = ?').get(detail.job.id).count, 0);
        assert.ok(db.prepare('SELECT deleted_at FROM document_files WHERE id = ?').get(detail.file.id).deleted_at);
        assert.equal(fs.existsSync(storedPath), false);
        assert.equal(fs.existsSync(outputPath), false);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});


test('OCR engine status is visible only to built-in admin account', async () => {
    const route = createOcrRouteForTest('/engines', 'get');
    assert.ok(route);

    const managerRes = createJsonResponse();
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), {
        user: { id: 2, username: 'manager', role: 'admin', unit: 'QA' },
        headers: {}
    }, managerRes);
    assert.equal(managerRes.statusCode, 403);
    assert.match(managerRes.body.error, /admin/);

    const normalRes = createJsonResponse();
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), {
        user: { id: 3, username: 'user', role: 'user', unit: 'QA' },
        headers: {}
    }, normalRes);
    assert.equal(normalRes.statusCode, 403);

    const previousUrl = process.env.OCR_SERVICE_URL;
    const previousHealthTimeout = process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS;
    try {
        process.env.OCR_SERVICE_URL = 'http://127.0.0.1:1';
        process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS = '1000';
        const adminRes = createJsonResponse();
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), {
            user: { id: 1, username: 'admin', role: 'admin', unit: 'QA' },
            headers: {}
        }, adminRes);
        assert.equal(adminRes.statusCode, 200);
        assert.ok(adminRes.body.engines?.http);
    } finally {
        if (previousUrl === undefined) delete process.env.OCR_SERVICE_URL;
        else process.env.OCR_SERVICE_URL = previousUrl;
        if (previousHealthTimeout === undefined) delete process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS;
        else process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS = previousHealthTimeout;
    }
});

test('OCR engine normalization falls back to external HTTP service', () => {
    assert.equal(normalizeEngine('http'), 'http');
    assert.equal(normalizeEngine('paddle'), 'http');
    assert.equal(normalizeEngine('tesseract'), 'http');
    assert.equal(normalizeEngine(''), 'http');
});

test('OCR service URL setting is saved, normalized, cleared, and validated', async () => {
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const previousUrl = process.env.OCR_SERVICE_URL;
    await preserveAppSetting(key, async () => {
        try {
            process.env.OCR_SERVICE_URL = 'http://env-ocr:9100';
            const settings = await updateDocumentProcessingSettings({
                patch: { serviceUrl: 'http://ocr-service:9100/' },
                userId: 1
            });
            assert.equal(settings.serviceUrl, 'http://ocr-service:9100');
            assert.equal(getDocumentProcessingSettings().serviceUrl, 'http://ocr-service:9100');
            const cleared = await updateDocumentProcessingSettings({ patch: { serviceUrl: '' }, userId: 1 });
            assert.equal(cleared.serviceUrl, 'http://env-ocr:9100');
            const previousEngine = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DOCUMENT_PROCESSING_SETTING_KEYS.engine)?.value;
            await assert.rejects(
                () => updateDocumentProcessingSettings({ patch: { engine: 'http', serviceUrl: 'file:///tmp/ocr' }, userId: 1 }),
                /OCR 服务地址仅支持 HTTP 或 HTTPS/
            );
            assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DOCUMENT_PROCESSING_SETTING_KEYS.engine)?.value, previousEngine);
        } finally {
            if (previousUrl === undefined) delete process.env.OCR_SERVICE_URL;
            else process.env.OCR_SERVICE_URL = previousUrl;
        }
    });
});

test('OCR engine setting normalizes legacy values to external HTTP service', async () => {
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.engine;
    await preserveAppSetting(key, async () => {
        const settings = await updateDocumentProcessingSettings({
            patch: { engine: 'paddle' },
            userId: 1
        });
        assert.equal(settings.engine, 'http');
        assert.equal(getDocumentProcessingSettings().engine, 'http');
    });
});

test('HTTP OCR adapter calls external service and normalizes result blocks', async () => {
    const previousUrl = process.env.OCR_SERVICE_URL;
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').all(key);
    await deleteAppSettingAsync(key);
    await refreshAppSettingsCache();
    const previousHealthTimeout = process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS;
    const imagePath = path.join(uploadRoot, `http-ocr-${Date.now()}.png`);
    fs.writeFileSync(imagePath, Buffer.from('fake-image'));
    let receivedBody = null;
    const server = nodeHttp.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', engine: 'external' }));
            return;
        }
        if (req.method !== 'POST' || req.url !== '/ocr') {
            res.writeHead(404);
            res.end();
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                language: receivedBody.language,
                blocks: [{ text: 'external text', confidence: 0.92, bbox: [] }]
            }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        process.env.OCR_SERVICE_URL = `http://127.0.0.1:${address.port}`;
        await setAppSettingAsync(key, process.env.OCR_SERVICE_URL);
        await refreshAppSettingsCache();
        process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS = '1000';
        const status = await httpOcr.checkAvailability();
        assert.equal(status.available, true);
        const result = await httpOcr.recognizePage(imagePath, { language: 'ch', timeoutMs: 5000 });
        assert.equal(receivedBody.language, 'ch');
        assert.equal(Buffer.from(receivedBody.imageBase64, 'base64').toString('utf8'), 'fake-image');
        assert.equal(result.text, 'external text');
        assert.equal(result.engine, 'http');
        assert.equal(result.blocks[0].engine, 'http');
        assert.equal(result.confidence, 0.92);
    } finally {
        if (previousUrl === undefined) delete process.env.OCR_SERVICE_URL;
        else process.env.OCR_SERVICE_URL = previousUrl;
        if (previousHealthTimeout === undefined) delete process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS;
        else process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS = previousHealthTimeout;
        await deleteAppSettingAsync(key);
        for (const row of rows) {
            await setAppSettingAsync(row.key, row.value, {
                updatedAt: row.updated_at,
                updatedBy: row.updated_by
            });
        }
        await refreshAppSettingsCache();
        await new Promise(resolve => server.close(resolve));
        removeTestPath(imagePath);
    }
});

test('HTTP OCR adapter enforces configured image byte limit before request', async () => {
    const previousMax = process.env.OCR_SERVICE_MAX_IMAGE_BYTES;
    const imagePath = path.join(uploadRoot, `http-ocr-too-large-${Date.now()}.png`);
    fs.writeFileSync(imagePath, Buffer.from('too-large'));
    try {
        process.env.OCR_SERVICE_MAX_IMAGE_BYTES = '4';
        await assert.rejects(
            () => httpOcr.recognizePage(imagePath, { language: 'ch', timeoutMs: 5000 }),
            /OCR 页面图片超过外部服务请求上限/
        );
    } finally {
        if (previousMax === undefined) delete process.env.OCR_SERVICE_MAX_IMAGE_BYTES;
        else process.env.OCR_SERVICE_MAX_IMAGE_BYTES = previousMax;
        removeTestPath(imagePath);
    }
});

test('HTTP OCR adapter prefers saved service URL over environment default', async () => {
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const previousUrl = process.env.OCR_SERVICE_URL;
    const imagePath = path.join(uploadRoot, `http-ocr-setting-${Date.now()}.png`);
    fs.writeFileSync(imagePath, Buffer.from('setting-image'));
    let received = false;
    const server = nodeHttp.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/ocr') {
            res.writeHead(404);
            res.end();
            return;
        }
        req.resume();
        req.on('end', () => {
            received = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'setting url text', confidence: 0.88 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await preserveAppSetting(key, async () => {
        try {
            process.env.OCR_SERVICE_URL = 'http://127.0.0.1:1';
            await updateDocumentProcessingSettings({
                patch: { serviceUrl: `http://127.0.0.1:${address.port}` },
                userId: 1
            });
            const result = await httpOcr.recognizePage(imagePath, { language: 'ch', timeoutMs: 5000 });
            assert.equal(received, true);
            assert.equal(result.text, 'setting url text');
        } finally {
            if (previousUrl === undefined) delete process.env.OCR_SERVICE_URL;
            else process.env.OCR_SERVICE_URL = previousUrl;
            await new Promise(resolve => server.close(resolve));
            removeTestPath(imagePath);
        }
    });
});


test('PDF tools split outputs can be downloaded as one archive', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_archive_${suffix}`, 'hash', 'PDF Archive Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-archive-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Archive Page 1', 'Archive Page 2']);

    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_archive_${suffix}` },
            files: [
                { path: sourcePath, originalname: 'archive-source.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }
            ],
            operation: 'split',
            config: { operation: 'split', pages: '1-2' }
        });
        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded');
        assert.equal(
            detail.outputs.filter(output => output.outputType === 'split_pdf').length,
            2,
            JSON.stringify({ config: detail.job.config, result: detail.job.result, outputs: detail.outputs })
        );

        const archive = await getJobOutputsArchive({ userId, jobId: detail.job.id, sourceModule: 'pdf_tools' });
        assert.ok(Buffer.isBuffer(archive.buffer));
        assert.equal(archive.mimeType, 'application/zip');
        assert.match(archive.fileName, /全部输出\.zip$/);
        const entries = readZipEntries(archive.buffer);
        assert.equal(entries.size, 2);
        assert.ok(Array.from(entries.keys()).every(name => name.endsWith('.pdf')));
        const streamArchive = await getJobOutputsArchiveStream({ userId, jobId: detail.job.id, sourceModule: 'pdf_tools' });
        const chunks = [];
        await new Promise((resolve, reject) => {
            streamArchive.stream.on('data', chunk => chunks.push(chunk));
            streamArchive.stream.once('error', reject);
            streamArchive.stream.once('end', resolve);
            streamArchive.stream.resume();
        });
        assert.equal(readZipEntries(Buffer.concat(chunks)).size, 2);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF tools merge multiple PDFs into one output', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_tool_${suffix}`, 'hash', 'PDF Tool Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-tool-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const firstPath = path.join(tempDir, `a-${suffix}.pdf`);
    const secondPath = path.join(tempDir, `b-${suffix}.pdf`);
    await createSamplePdf(firstPath, ['First PDF']);
    await createSamplePdf(secondPath, ['Second PDF']);

    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_tool_${suffix}` },
            files: [
                { path: firstPath, originalname: 'first.pdf', mimetype: 'application/pdf', size: fs.statSync(firstPath).size },
                { path: secondPath, originalname: 'second.pdf', mimetype: 'application/pdf', size: fs.statSync(secondPath).size }
            ],
            operation: 'merge',
            config: { operation: 'merge' }
        });
        assert.equal(initial.job.status, 'queued');
        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded');
        assert.ok(detail.outputs.some(output => output.outputType === 'merged_pdf'));
        const output = detail.outputs.find(item => item.outputType === 'merged_pdf');
        const download = await getOutputDownload({ userId, outputId: output.id });
        assert.ok(download.filePath.startsWith(documentRoot));
        const merged = await PDFDocument.load(fs.readFileSync(download.filePath));
        assert.equal(merged.getPageCount(), 2);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 页面范围与重排必须严格匹配真实页数', () => {
    assert.deepEqual(parsePageSelection('1-3,5', 6, { limit: 6 }), [0, 1, 2, 4]);
    assert.throws(() => parsePageSelection('99', 6, { limit: 6 }), /超出文件/);
    assert.throws(() => parsePageSelection('3-1', 6, { limit: 6 }), /起始页不能大于结束页/);
    assert.deepEqual(parsePageOrder('3,1,2', 3, { limit: 3 }), [2, 0, 1]);
    assert.throws(() => parsePageOrder('3,1', 3, { limit: 3 }), /必须包含全部/);
    assert.throws(() => parsePageOrder('2junk,2,1', 3, { limit: 3 }), /不是有效页码/);
});

test('PDF 工具不在公开任务配置中保留密码，并公开能力契约', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_secret_${suffix}`, 'hash', 'PDF Secret Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-secret-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Secret test']);
    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_secret_${suffix}` },
            files: [{ path: sourcePath, originalname: 'secret-source.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'split',
            config: { operation: 'split', pages: '1', password: 'synthetic-password-only-for-test' }
        });
        assert.equal(Object.prototype.hasOwnProperty.call(initial.job.config, 'password'), false);
        assert.equal(initial.job.config.requiresPassword, true);
        const stored = db.prepare('SELECT config_json FROM document_jobs WHERE id = ?').get(initial.job.id);
        assert.equal(String(stored.config_json).includes('synthetic-password-only-for-test'), false);
        const capabilities = getPdfToolCapabilities();
        assert.ok(capabilities.operations.some(item => item.id === 'watermark'));
        assert.equal(capabilities.engines.structuralPdf.encryptedInput, getQpdfHealth().available);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM document_job_secrets WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 转图片会严格使用请求页码并保留原页号', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_pages_${suffix}`, 'hash', 'PDF Pages Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-pages-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5', 'Page 6']);
    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_pages_${suffix}` },
            files: [{ path: sourcePath, originalname: 'six-pages.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'pdf_to_images',
            config: { operation: 'pdf_to_images', pages: '5-6', maxToolPages: 6, dpi: 96 }
        });
        const detail = await waitForDocumentJob(userId, initial.job.id, 30000);
        assert.equal(detail.job.status, 'succeeded', detail.job.errorMessage);
        const names = detail.outputs.map(output => output.fileName).sort();
        assert.deepEqual(names, ['six-pages-第5页.png', 'six-pages-第6页.png']);
        assert.equal(detail.job.result.requestedPages, 2);
        assert.equal(detail.job.result.processedPages, 2);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('已完成 PDF 任务再次处理会创建新版本且保留原输出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_reprocess_${suffix}`, 'hash', 'PDF Reprocess Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-reprocess-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Reprocess page']);
    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_reprocess_${suffix}` },
            files: [{ path: sourcePath, originalname: 'reprocess.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'split',
            config: { operation: 'split', pages: '1' }
        });
        const original = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(original.job.status, 'succeeded');
        const originalOutput = original.outputs[0];
        const next = await reprocessJob({ userId, jobId: original.job.id, sourceModule: 'pdf_tools' });
        assert.ok(next.job.id !== original.job.id);
        assert.equal(next.job.parentJobId, original.job.id);
        const oldDownload = await getOutputDownload({ userId, outputId: originalOutput.id, sourceModule: 'pdf_tools' });
        assert.ok(oldDownload?.filePath);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 批量操作逐文件产出结果，水印与页码使用中文字体输出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_batch_${suffix}`, 'hash', 'PDF Batch Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-batch-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const firstPath = path.join(tempDir, `first-${suffix}.pdf`);
    const secondPath = path.join(tempDir, `second-${suffix}.pdf`);
    await createSamplePdf(firstPath, ['Batch 1']);
    await createSamplePdf(secondPath, ['Batch 2']);
    try {
        const batch = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_batch_${suffix}` },
            files: [
                { path: firstPath, originalname: 'first.pdf', mimetype: 'application/pdf', size: fs.statSync(firstPath).size },
                { path: secondPath, originalname: 'second.pdf', mimetype: 'application/pdf', size: fs.statSync(secondPath).size }
            ],
            operation: 'watermark',
            config: { operation: 'watermark', mode: 'batch', pages: '1', watermarkText: '内部资料', maxToolPages: 2 }
        });
        const detail = await waitForDocumentJob(userId, batch.job.id, 30000);
        assert.equal(detail.job.status, 'succeeded', detail.job.errorMessage);
        assert.equal(detail.job.result.processedFiles, 2);
        assert.equal(detail.outputs.filter(output => output.outputType === 'watermarked_pdf').length, 2);
        assert.equal(detail.job.result.items.filter(item => item.status === 'succeeded').length, 2);
        assert.equal(detail.items.length, 2);
        assert.equal(detail.items.every(item => item.status === 'succeeded'), true);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('错误模块范围不会重试或修改另一应用的任务', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_scope_${suffix}`, 'hash', 'PDF Scope Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-scope-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Scope']);
    try {
        const job = await createJobFromUpload({
            user: { id: userId, username: `pdf_scope_${suffix}` },
            file: { path: sourcePath, originalname: 'scope.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size },
            jobType: 'auto',
            sourceModule: 'ocr_app'
        });
        const rejected = await retryJob({ userId, jobId: job.job.id, sourceModule: 'pdf_tools' });
        const after = await getJobDetail({ userId, jobId: job.job.id });
        assert.equal(rejected, null);
        assert.equal(after.job.sourceModule, 'ocr_app');
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 页面工作区可编排、撤销后的计划以新版本输出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_plan_${suffix}`, 'hash', 'PDF Plan Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-plan-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['Page one', 'Page two']);
    try {
        const initial = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_plan_${suffix}` },
            files: [{ path: sourcePath, originalname: 'plan.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'page_plan',
            config: { operation: 'page_plan', pagePlan: [{ sourcePage: 2 }, { blank: true }, { sourcePage: 1, rotation: 90 }], maxToolPages: 5 }
        });
        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded', detail.job.errorMessage);
        const output = detail.outputs.find(item => item.outputType === 'page_plan_pdf');
        const downloaded = await getOutputDownload({ userId, outputId: output.id });
        const pdf = await PDFDocument.load(fs.readFileSync(downloaded.filePath));
        assert.equal(pdf.getPageCount(), 3);
        assert.equal(pdf.getPage(2).getRotation().angle, 90);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 轻批注与 AcroForm 填写保留可交互字段', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_form_${suffix}`, 'hash', 'PDF Form Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-form-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    const annotationPath = path.join(tempDir, `annotation-${suffix}.pdf`);
    await createFormPdf(sourcePath);
    fs.copyFileSync(sourcePath, annotationPath);
    try {
        const formJob = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_form_${suffix}` },
            files: [{ path: sourcePath, originalname: 'form.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'fill_form',
            config: { operation: 'fill_form', formValues: { 申请人: '张三', 确认: true } }
        });
        const formDetail = await waitForDocumentJob(userId, formJob.job.id);
        assert.equal(formDetail.job.status, 'succeeded', formDetail.job.errorMessage);
        const formOutput = formDetail.outputs.find(item => item.outputType === 'filled_form_pdf');
        const formDownload = await getOutputDownload({ userId, outputId: formOutput.id });
        const filled = await PDFDocument.load(fs.readFileSync(formDownload.filePath));
        assert.equal(filled.getForm().getTextField('申请人').getText(), '张三');
        assert.equal(filled.getForm().getCheckBox('确认').isChecked(), true);

        const annotationJob = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_form_${suffix}` },
            files: [{ path: annotationPath, originalname: 'form-annotate.pdf', mimetype: 'application/pdf', size: fs.statSync(annotationPath).size }],
            operation: 'annotate',
            config: { operation: 'annotate', annotations: [{ page: 1, type: 'highlight', x: 0.1, y: 0.1, width: 0.3, height: 0.1, content: '需要复核' }] }
        });
        const annotationDetail = await waitForDocumentJob(userId, annotationJob.job.id);
        assert.equal(annotationDetail.job.status, 'succeeded', annotationDetail.job.errorMessage);
        const annotationOutput = annotationDetail.outputs.find(item => item.outputType === 'annotated_pdf');
        const annotationDownload = await getOutputDownload({ userId, outputId: annotationOutput.id });
        const annotated = await PDFDocument.load(fs.readFileSync(annotationDownload.filePath));
        assert.ok(annotated.getPage(0).node.get(PDFName.of('Annots')));
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('PDF 比较、永久脱敏与 Word 导出生成可核对结果', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_compare_${suffix}`, 'hash', 'PDF Compare Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-compare-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const firstPath = path.join(tempDir, `first-${suffix}.pdf`);
    const secondPath = path.join(tempDir, `second-${suffix}.pdf`);
    const redactPath = path.join(tempDir, `redact-${suffix}.pdf`);
    const wordPath = path.join(tempDir, `word-${suffix}.pdf`);
    const xlsxPath = path.join(tempDir, `xlsx-${suffix}.pdf`);
    await createSamplePdf(firstPath, ['Original confidential value']);
    await createSamplePdf(secondPath, ['Changed confidential value']);
    fs.copyFileSync(firstPath, redactPath);
    fs.copyFileSync(secondPath, wordPath);
    fs.copyFileSync(secondPath, xlsxPath);
    try {
        const compare = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_compare_${suffix}` },
            files: [
                { path: firstPath, originalname: 'left.pdf', mimetype: 'application/pdf', size: fs.statSync(firstPath).size },
                { path: secondPath, originalname: 'right.pdf', mimetype: 'application/pdf', size: fs.statSync(secondPath).size }
            ],
            operation: 'compare',
            config: { operation: 'compare', compareDpi: 96 }
        });
        const compared = await waitForDocumentJob(userId, compare.job.id, 30000);
        assert.equal(compared.job.status, 'succeeded', compared.job.errorMessage);
        assert.ok(compared.outputs.some(item => item.outputType === 'pdf_compare_report'));

        const redact = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_compare_${suffix}` },
            files: [{ path: redactPath, originalname: 'redact.pdf', mimetype: 'application/pdf', size: fs.statSync(redactPath).size }],
            operation: 'redact',
            config: { operation: 'redact', redactRegions: [{ page: 1, x: 0.05, y: 0.1, width: 0.8, height: 0.35 }], maxToolPages: 1 }
        });
        const redacted = await waitForDocumentJob(userId, redact.job.id, 30000);
        assert.equal(redacted.job.status, 'succeeded', redacted.job.errorMessage);
        const redactOutput = redacted.outputs.find(item => item.outputType === 'redacted_flattened_pdf');
        const redactedDownload = await getOutputDownload({ userId, outputId: redactOutput.id });
        const redactedText = await require('../server/document-text').extractDocumentText(redactedDownload.filePath, '', 'redacted.pdf');
        assert.equal(String(redactedText).includes('confidential'), false);
        assert.equal(redactOutput.quality.originalObjectsRemoved, true);

        const word = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_compare_${suffix}` },
            files: [{ path: wordPath, originalname: 'word.pdf', mimetype: 'application/pdf', size: fs.statSync(wordPath).size }],
            operation: 'export_docx',
            config: { operation: 'export_docx' }
        });
        const wordDetail = await waitForDocumentJob(userId, word.job.id, 30000);
        assert.equal(wordDetail.job.status, 'succeeded', wordDetail.job.errorMessage);
        assert.ok(wordDetail.outputs.some(item => item.outputType === 'docx'));

        const workbook = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_compare_${suffix}` },
            files: [{ path: xlsxPath, originalname: 'excel.pdf', mimetype: 'application/pdf', size: fs.statSync(xlsxPath).size }],
            operation: 'export_xlsx',
            config: { operation: 'export_xlsx' }
        });
        const workbookDetail = await waitForDocumentJob(userId, workbook.job.id, 30000);
        assert.equal(workbookDetail.job.status, 'succeeded', workbookDetail.job.errorMessage);
        const xlsx = workbookDetail.outputs.find(item => item.outputType === 'xlsx');
        assert.ok(xlsx);
        const xlsxDownload = await getOutputDownload({ userId, outputId: xlsx.id });
        assert.equal(fs.readFileSync(xlsxDownload.filePath).subarray(0, 2).toString('utf8'), 'PK');
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('qpdf 适配器执行结构优化和 AES-256 保护，公开配置不含输出密码', async () => {
    const health = getQpdfHealth({ refresh: true });
    if (!health.available) return;
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_qpdf_${suffix}`, 'hash', 'PDF QPDF Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-qpdf-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    const protectPath = path.join(tempDir, `protect-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['qpdf test']);
    fs.copyFileSync(sourcePath, protectPath);
    try {
        const optimize = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_qpdf_${suffix}` },
            files: [{ path: sourcePath, originalname: 'optimize.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'compress',
            config: { operation: 'compress', compressionMode: 'structure' }
        });
        const optimized = await waitForDocumentJob(userId, optimize.job.id, 30000);
        assert.equal(optimized.job.status, 'succeeded', optimized.job.errorMessage);
        assert.match(optimized.outputs[0].quality.engine, /qpdf/i);

        const protectedJob = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_qpdf_${suffix}` },
            files: [{ path: protectPath, originalname: 'protect.pdf', mimetype: 'application/pdf', size: fs.statSync(protectPath).size }],
            operation: 'protect',
            config: { operation: 'protect', outputPassword: 'open-pass-test', ownerPassword: 'owner-pass-test', outputPermissions: { print: false, modify: false } }
        });
        assert.equal(Object.prototype.hasOwnProperty.call(protectedJob.job.config, 'outputPassword'), false);
        const protectedDetail = await waitForDocumentJob(userId, protectedJob.job.id, 30000);
        assert.equal(protectedDetail.job.status, 'succeeded', protectedDetail.job.errorMessage);
        const output = protectedDetail.outputs.find(item => item.outputType === 'protected_pdf');
        const download = await getOutputDownload({ userId, outputId: output.id });
        const encrypted = require('child_process').spawnSync(health.command, ['--is-encrypted', download.filePath], { shell: false });
        assert.equal(encrypted.status, 0);
        const encryptedInput = path.join(tempDir, `encrypted-${suffix}.pdf`);
        fs.copyFileSync(download.filePath, encryptedInput);
        const decryptedJob = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_qpdf_${suffix}` },
            files: [{ path: encryptedInput, originalname: 'encrypted-input.pdf', mimetype: 'application/pdf', size: fs.statSync(encryptedInput).size }],
            operation: 'rotate',
            config: { operation: 'rotate', pages: '1', rotateDegrees: 90, password: 'open-pass-test' }
        });
        const decryptedDetail = await waitForDocumentJob(userId, decryptedJob.job.id, 30000);
        assert.equal(decryptedDetail.job.status, 'succeeded', decryptedDetail.job.errorMessage);
        assert.ok(decryptedDetail.outputs.some(item => item.outputType === 'rotated_pdf'));
        const wrongPasswordInput = path.join(tempDir, `wrong-password-${suffix}.pdf`);
        fs.copyFileSync(download.filePath, wrongPasswordInput);
        const wrongPasswordJob = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_qpdf_${suffix}` },
            files: [{ path: wrongPasswordInput, originalname: 'wrong-password.pdf', mimetype: 'application/pdf', size: fs.statSync(wrongPasswordInput).size }],
            operation: 'rotate',
            config: { operation: 'rotate', pages: '1', rotateDegrees: 90, password: 'wrong-password' }
        });
        const wrongPasswordDetail = await waitForDocumentJob(userId, wrongPasswordJob.job.id, 30000);
        assert.equal(wrongPasswordDetail.job.status, 'failed');
        assert.match(wrongPasswordDetail.job.errorMessage, /密码/i);
        assert.equal(wrongPasswordDetail.outputs.length, 0);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM document_job_secrets WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('veraPDF 验证仅产出报告，未通过时绝不标记 PDF/A 合规', async () => {
    const capabilities = getPdfToolCapabilities();
    if (!capabilities.engines.veraPdf.available) return;
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`pdf_pdfa_${suffix}`, 'hash', 'PDF/A Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'pdf-pdfa-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    await createSamplePdf(sourcePath, ['ordinary PDF is not automatically PDF/A']);
    try {
        const job = await createPdfToolJobFromUploads({
            user: { id: userId, username: `pdf_pdfa_${suffix}` },
            files: [{ path: sourcePath, originalname: 'ordinary.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            operation: 'pdfa_validate',
            config: { operation: 'pdfa_validate', pdfaProfile: '1b' }
        });
        const detail = await waitForDocumentJob(userId, job.job.id, 30000);
        assert.equal(detail.job.status, 'succeeded', detail.job.errorMessage);
        const output = detail.outputs.find(item => item.outputType === 'pdfa_validation_report');
        assert.ok(output);
        assert.equal(output.quality.compliant, false);
        const download = await getOutputDownload({ userId, outputId: output.id });
        assert.match(fs.readFileSync(download.filePath, 'utf8'), /validationReport/i);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 按明确页范围建立完整处理计划，不会静默遗漏页面', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ocr_coverage_${suffix}`, 'hash', 'OCR Coverage Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-coverage-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, `source-${suffix}.pdf`);
    const settingKey = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    await createSamplePdf(sourcePath, ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
    let calls = 0;
    const server = nodeHttp.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', engine: 'test-ocr' }));
            return;
        }
        req.resume();
        req.on('end', () => {
            calls += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blocks: [{ text: `识别页 ${calls}`, confidence: 0.96, bbox: [[8, 8], [110, 8], [110, 26], [8, 26]] }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await preserveAppSetting(settingKey, async () => {
            await updateDocumentProcessingSettings({ patch: { serviceUrl: `http://127.0.0.1:${server.address().port}` }, userId: 1 });
            const created = await createJobFromUpload({
                user: { id: userId, username: `ocr_coverage_${suffix}` },
                file: { path: sourcePath, originalname: '五页扫描件.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size },
                jobType: 'ocr',
                sourceModule: 'ocr_app',
                config: { pages: '2,4-5', maxRenderPages: 5, maxOcrPages: 5, dpi: 72 }
            });
            const detail = await waitForDocumentJob(userId, created.job.id, 30000);
            assert.equal(detail.job.status, 'succeeded', detail.job.errorMessage);
            assert.equal(calls, 3);
            assert.equal(detail.file.pageCount, 5);
            assert.deepEqual(detail.pages.map(page => page.pageNumber), [2, 4, 5]);
            assert.equal(detail.job.sourcePageCount, 5);
            assert.equal(detail.job.plannedPageCount, 3);
            assert.equal(detail.job.processedPageCount, 3);
            assert.equal(detail.job.coverageComplete, true);
            assert.deepEqual(detail.job.omittedPages, [1, 3]);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 人工修订创建新内容版本，旧块不会冒充新版坐标结果', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ocr_revision_${suffix}`, 'hash', 'OCR Revision Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const fileId = db.prepare(`
        INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at)
        VALUES (?, ?, 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id
    `).get(userId, 'revision.png').id;
    const jobId = db.prepare(`
        INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, coverage_complete, source_page_count, planned_page_count, processed_page_count, created_at, updated_at)
        VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', 1, 1, 1, 1, now(), now()) RETURNING id
    `).get(userId, fileId).id;
    const pageId = db.prepare(`
        INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, confidence, created_at, updated_at)
        VALUES (?, ?, ?, 1, '原始识别文本', '原始识别文本', 6, 'succeeded', 'succeeded', 0.9, now(), now()) RETURNING id
    `).get(userId, fileId, jobId).id;
    db.prepare(`
        INSERT INTO document_ocr_blocks (user_id, file_id, job_id, page_id, page_number, sort_order, block_type, text, raw_text, effective_text, bbox_json, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, 'line', '原始识别文本', '原始识别文本', '原始识别文本', '[[1,1],[10,1],[10,5],[1,5]]', 0.9, now(), now())
    `).run(userId, fileId, jobId, pageId);
    try {
        const original = await createJobExport({ userId, jobId, format: 'txt', sourceModule: 'ocr_app' });
        const revised = await savePageReview({
            userId,
            pageId,
            revisedText: '人工修订文本',
            lowConfidenceConfirmed: true,
            expectedRevision: 1,
            sourceModule: 'ocr_app'
        });
        assert.equal(revised.job.contentRevision, 2);
        assert.equal(revised.pages[0].rawText, '原始识别文本');
        assert.equal(revised.pages[0].text, '人工修订文本');
        assert.equal(revised.pages[0].alignmentStatus, 'unaligned');
        assert.equal(revised.blocks[0].alignmentStatus, 'unaligned');
        assert.equal(revised.blocks[0].effectiveText, '原始识别文本');
        const next = await createJobExport({ userId, jobId, format: 'txt', sourceModule: 'ocr_app' });
        const oldText = fs.readFileSync((await getOutputDownload({ userId, outputId: original.id, sourceModule: 'ocr_app' })).filePath, 'utf8');
        const nextText = fs.readFileSync((await getOutputDownload({ userId, outputId: next.id, sourceModule: 'ocr_app' })).filePath, 'utf8');
        assert.match(oldText, /原始识别文本/);
        assert.match(nextText, /人工修订文本/);
        assert.equal(next.quality.contentRevision, 2);
        await assert.rejects(
            () => createJobExport({ userId, jobId, format: 'searchable_pdf', sourceModule: 'ocr_app' }),
            error => error?.code === 'EXPORT_ALIGNMENT_REQUIRED'
        );
        await assert.rejects(
            () => savePageReview({ userId, pageId, revisedText: '冲突写入', expectedRevision: 1, sourceModule: 'ocr_app' }),
            error => error?.code === 'REVIEW_REVISION_CONFLICT'
        );
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM document_page_revisions WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('OCR 异步导出固定请求时的内容版本并可轮询结果', async () => {
    const suffix = Date.now().toString(36);
    const user = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Async Export', 'QA', 'user', 'active', now())`).run(`ocr_async_export_${suffix}`);
    const userId = user.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '导出版本.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(userId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, coverage_complete, content_revision, created_at, updated_at) VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', 1, 1, now(), now()) RETURNING id`).get(userId, fileId).id;
    const pageId = db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, content_revision, created_at, updated_at) VALUES (?, ?, ?, 1, '第一版', '第一版', 3, 'succeeded', 'succeeded', 1, now(), now()) RETURNING id`).get(userId, fileId, jobId).id;
    try {
        const requested = await requestJobExport({ userId, jobId, format: 'txt', sourceModule: 'ocr_app' });
        assert.equal(requested.contentRevision, 1);
        await savePageReview({ userId, pageId, revisedText: '第二版', expectedRevision: 1, sourceModule: 'ocr_app' });
        let result = requested;
        for (let attempt = 0; attempt < 80 && ['queued', 'processing'].includes(result.status); attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 25));
            result = await getExportRequest({ userId, exportId: requested.id, sourceModule: 'ocr_app' });
        }
        assert.equal(result.status, 'ready', result.errorMessage);
        assert.ok(result.outputId);
        const download = await getOutputDownload({ userId, outputId: result.outputId, sourceModule: 'ocr_app' });
        assert.match(fs.readFileSync(download.filePath, 'utf8'), /第一版/);
        assert.doesNotMatch(fs.readFileSync(download.filePath, 'utf8'), /第二版/);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('OCR 服务适配器保留未知置信度并按阅读顺序生成文本', async () => {
    const result = buildRecognitionResult({
        engine: 'http',
        language: 'ch',
        blocks: [{ text: '后面', sortOrder: 2 }, { text: '前面', sortOrder: 1 }]
    });
    assert.equal(result.confidence, null);
    assert.equal(result.blocks[0].confidence, null);
    assert.equal(result.text, '前面\n后面');
    const capabilities = await getOcrCapabilities();
    assert.equal(Object.prototype.hasOwnProperty.call(capabilities.engine, 'serviceUrl'), false);
    assert.equal(capabilities.output.confidence, 'optional');
});

test('混合 PDF 逐页保留原生文本并仅对扫描页进行 OCR', async () => {
    const suffix = Date.now().toString(36);
    const settingKey = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const tempDir = path.join(uploadRoot, 'mixed-pdf-ocr-test', suffix);
    const sourcePath = path.join(tempDir, 'mixed.pdf');
    fs.mkdirSync(tempDir, { recursive: true });
    const sharp = require('sharp');
    const pdf = await PDFDocument.create();
    pdf.addPage([320, 240]).drawText('NATIVE FIRST PAGE', { x: 30, y: 170, size: 18 });
    const imageBytes = await sharp(Buffer.from('<svg width="320" height="240"><rect width="320" height="240" fill="white"/><text x="20" y="120" font-size="24">SCANNED SECOND PAGE</text></svg>')).png().toBuffer();
    const image = await pdf.embedPng(imageBytes);
    pdf.addPage([320, 240]).drawImage(image, { x: 0, y: 0, width: 320, height: 240 });
    fs.writeFileSync(sourcePath, await pdf.save());
    let calls = 0;
    const server = nodeHttp.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            calls += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'OCR SECOND PAGE', confidence: 0.95 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await preserveAppSetting(settingKey, async () => {
            await updateDocumentProcessingSettings({ patch: { serviceUrl: `http://127.0.0.1:${server.address().port}` }, userId: 1 });
            const result = await extractPdfTextWithPageFallback(sourcePath, { maxOcrPages: 2, desiredWidth: 640 });
            assert.equal(result.sourcePageCount, 2);
            assert.equal(result.plannedPageCount, 2);
            assert.equal(result.coverageComplete, true);
            assert.equal(result.pages[0].source, 'native');
            assert.match(result.pages[0].text, /NATIVE FIRST PAGE/);
            assert.equal(result.pages[1].source, 'ocr');
            assert.equal(result.pages[1].text, 'OCR SECOND PAGE');
            assert.equal(calls, 1);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 批量提交逐项入队，单项失败不会阻断已受理文件', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ocr_batch_${suffix}`, 'hash', 'OCR Batch Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-batch-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const firstPath = path.join(tempDir, 'first.txt');
    const secondPath = path.join(tempDir, 'second.txt');
    fs.writeFileSync(firstPath, '第一份批量文件');
    fs.writeFileSync(secondPath, '第二份批量文件');
    try {
        const result = await createOcrBatchFromUploads({
            user: { id: userId, username: `ocr_batch_${suffix}` },
            files: [
                { path: firstPath, originalname: 'first.png', mimetype: 'image/png', size: fs.statSync(firstPath).size },
                { path: secondPath, originalname: 'second.png', mimetype: 'image/png', size: fs.statSync(secondPath).size }
            ],
            config: { maxOcrPages: 1, maxRenderPages: 1 }
        });
        assert.equal(result.batch.totalFiles, 2);
        assert.equal(result.batch.acceptedFiles, 2);
        assert.equal(result.jobs.length, 2);
        const items = db.prepare('SELECT job_id, status FROM document_batch_items WHERE batch_id = ? ORDER BY item_order').all(result.batch.id);
        assert.equal(items.length, 2);
        assert.ok(items.every(item => item.job_id));
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM document_batch_items WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM document_batches WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 结构化表格会保存在页结果中并安全导出 Excel', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ocr_table_${suffix}`, 'hash', 'OCR Table Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '表格.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(userId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, coverage_complete, created_at, updated_at) VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', 1, now(), now()) RETURNING id`).get(userId, fileId).id;
    const result = { tables: [{ id: 't1', rowCount: 2, columnCount: 2, cells: [
        { rowIndex: 0, columnIndex: 0, text: '名称' }, { rowIndex: 0, columnIndex: 1, text: '金额' },
        { rowIndex: 1, columnIndex: 0, text: '示例' }, { rowIndex: 1, columnIndex: 1, text: '=1+1' }
    ] }] };
    db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, result_json, created_at, updated_at) VALUES (?, ?, ?, 1, '表格识别', '表格识别', 4, 'succeeded', 'succeeded', ?, now(), now())`).run(userId, fileId, jobId, JSON.stringify(result));
    try {
        const output = await createJobExport({ userId, jobId, format: 'xlsx', sourceModule: 'ocr_app' });
        assert.equal(output.outputType, 'xlsx');
        const download = await getOutputDownload({ userId, outputId: output.id, sourceModule: 'ocr_app' });
        const workbook = XLSX.read(fs.readFileSync(download.filePath), { type: 'buffer', raw: false });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false });
        assert.deepEqual(rows[0], ['名称', '金额']);
        assert.equal(rows[1][1], "'=1+1");
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('OCR 预检返回真实页数、明确处理范围并拒绝超额未选页文件', async () => {
    const suffix = Date.now().toString(36);
    const tempDir = path.join(uploadRoot, 'ocr-preflight-test', suffix);
    fs.mkdirSync(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, 'five-pages.pdf');
    await createSamplePdf(sourcePath, ['1', '2', '3', '4', '5']);
    try {
        const selected = await preflightOcrUploads({
            files: [{ path: sourcePath, originalname: 'five-pages.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            config: { pages: '2,4-5', maxRenderPages: 3, maxOcrPages: 3 }
        });
        assert.equal(selected.accepted, 1);
        assert.equal(selected.files[0].pageCount, 5);
        assert.deepEqual(selected.files[0].selectedPages, [2, 4, 5]);
        const rejected = await preflightOcrUploads({
            files: [{ path: sourcePath, originalname: 'five-pages.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size }],
            config: { maxRenderPages: 3, maxOcrPages: 3 }
        });
        assert.equal(rejected.rejected, 1);
        assert.match(rejected.files[0].warnings.join(' '), /超过|处理/);
    } finally {
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 公文字段提取返回页级候选来源且不声称已核验', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Field Test', 'QA', 'user', 'active', now())`).run(`ocr_fields_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '公文.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(userId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, created_at, updated_at) VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', now(), now()) RETURNING id`).get(userId, fileId).id;
    db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, created_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, 50, 'succeeded', 'succeeded', now(), now())`).run(userId, fileId, jobId, '文号：国办发〔2026〕1号\n发布日期：2026年10月13日\n金额：123.45元', '文号：国办发〔2026〕1号\n发布日期：2026年10月13日\n金额：123.45元');
    try {
        const fields = await extractOcrFields({ userId, jobId });
        assert.equal(fields.contentRevision, 1);
        assert.equal(fields.fields.documentNumber.pageNumber, 2);
        assert.equal(fields.fields.issueDate.value, '2026年10月13日');
        assert.equal(fields.fields.amount.confidence, 'candidate');
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('OCR 失败页重试只补处理失败页面并保留已完成页面', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Retry Test', 'QA', 'user', 'active', now())`).run(`ocr_retry_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-retry-test', String(userId));
    const sourcePath = path.join(tempDir, 'two-pages.pdf');
    const settingKey = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    fs.mkdirSync(tempDir, { recursive: true });
    await createSamplePdf(sourcePath, ['Page one', 'Page two']);
    let calls = 0;
    const server = nodeHttp.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            calls += 1;
            if (calls === 2) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '模拟第二页暂时失败' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: `识别第${calls}次`, confidence: 0.98 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await preserveAppSetting(settingKey, async () => {
            await updateDocumentProcessingSettings({ patch: { serviceUrl: `http://127.0.0.1:${server.address().port}` }, userId: 1 });
            const created = await createJobFromUpload({
                user: { id: userId, username: `ocr_retry_${suffix}` },
                file: { path: sourcePath, originalname: 'two-pages.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size },
                jobType: 'ocr', sourceModule: 'ocr_app', config: { maxRenderPages: 2, maxOcrPages: 2, dpi: 72 }
            });
            const partial = await waitForDocumentJob(userId, created.job.id, 30000);
            assert.equal(partial.job.status, 'partial_success');
            assert.equal(partial.job.failedPageCount, 1);
            assert.equal(partial.pages.find(page => page.pageNumber === 1).text, '识别第1次');
            const retried = await retryJob({ userId, jobId: created.job.id, sourceModule: 'ocr_app', retryFailedPages: true });
            const recovered = await waitForDocumentJob(userId, retried.job.id, 30000);
            assert.equal(recovered.job.status, 'succeeded', recovered.job.errorMessage);
            assert.equal(recovered.pages.length, 2);
            assert.equal(recovered.pages.find(page => page.pageNumber === 1).text, '识别第1次');
            assert.equal(recovered.pages.find(page => page.pageNumber === 2).text, '识别第3次');
            assert.equal(calls, 3);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 请求仍在运行时租约到期，不会启动重复识别', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare("INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Lease', 'QA', 'user', 'active', now())").run(`ocr_lease_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-lease-test', String(userId));
    const sourcePath = path.join(tempDir, 'page.pdf');
    const settingKey = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    fs.mkdirSync(tempDir, { recursive: true });
    await createSamplePdf(sourcePath, ['Page one']);
    let release;
    let received;
    let calls = 0;
    const started = new Promise(resolve => { received = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const server = nodeHttp.createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            calls += 1;
            received();
            await gate;
            if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '完成一次识别', confidence: 0.98 })); }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await preserveAppSetting(settingKey, async () => {
            await updateDocumentProcessingSettings({ patch: { serviceUrl: `http://127.0.0.1:${server.address().port}` }, userId: 1 });
            const created = await createJobFromUpload({ user: { id: userId, username: `ocr_lease_${suffix}` },
                file: { path: sourcePath, originalname: 'page.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size },
                jobType: 'ocr', sourceModule: 'ocr_app', config: { maxRenderPages: 1, maxOcrPages: 1, dpi: 72 } });
            let timer;
            try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR 请求未启动')), 15000); })]); }
            finally { clearTimeout(timer); }
            await require('../server/db/client').execute("UPDATE document_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ?", [created.job.id]);
            const recovery = await require('../server/services/document-processing/jobs').recoverDocumentProcessingJobs();
            assert.equal(recovery.requeued, 0);
            assert.equal((await getJobDetail({ userId, jobId: created.job.id })).job.status, 'processing');
            assert.equal(calls, 1);
            release();
            const completed = await waitForDocumentJob(userId, created.job.id, 30000);
            assert.equal(completed.job.status, 'succeeded');
            assert.equal(completed.pages[0].text, '完成一次识别');
            assert.equal(calls, 1);
        });
    } finally {
        release();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('锁连接中断后重领任务，旧 OCR 迟到结果不能覆盖新结果', { timeout: 60000 }, async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const userInfo = db.prepare("INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Fence', 'QA', 'user', 'active', now())").run(`ocr_fence_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-fence-test', String(userId));
    const sourcePath = path.join(tempDir, 'page.pdf');
    const settingKey = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    fs.mkdirSync(tempDir, { recursive: true });
    await createSamplePdf(sourcePath, ['Page one']);
    let release;
    let received;
    let calls = 0;
    const started = new Promise(resolve => { received = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const server = nodeHttp.createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            const current = ++calls;
            if (current === 1) { received(); await gate; }
            if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: current === 1 ? '过期执行结果' : '新执行结果', confidence: 0.98 })); }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await preserveAppSetting(settingKey, async () => {
            await updateDocumentProcessingSettings({ patch: { serviceUrl: `http://127.0.0.1:${server.address().port}` }, userId: 1 });
            const created = await createJobFromUpload({ user: { id: userId, username: `ocr_fence_${suffix}` },
                file: { path: sourcePath, originalname: 'page.pdf', mimetype: 'application/pdf', size: fs.statSync(sourcePath).size },
                jobType: 'ocr', sourceModule: 'ocr_app', config: { maxRenderPages: 1, maxOcrPages: 1, dpi: 72 } });
            let timer;
            try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR 请求未启动')), 15000); })]); }
            finally { clearTimeout(timer); }
            const { queryOne, execute } = require('../server/db/client');
            const backend = await queryOne('SELECT pid FROM pg_stat_activity WHERE application_name = ?', [`pivot-document-job-${created.job.id}`]);
            assert.ok(backend?.pid);
            await execute("UPDATE document_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ?", [created.job.id]);
            assert.equal((await queryOne('SELECT pg_terminate_backend(?) AS terminated', [backend.pid])).terminated, true);
            const { execFile } = require('node:child_process');
            const { promisify } = require('node:util');
            await promisify(execFile)(process.execPath, [path.join(__dirname, 'helpers', 'document-recovery-worker.js'), String(created.job.id)],
                { cwd: path.resolve(__dirname, '..'), env: process.env, windowsHide: true, timeout: 35000 });
            const recovered = await getJobDetail({ userId, jobId: created.job.id });
            assert.equal(recovered.pages[0].text, '新执行结果');
            release();
            await new Promise(resolve => setTimeout(resolve, 600));
            const afterLateResult = await getJobDetail({ userId, jobId: created.job.id });
            assert.equal(afterLateResult.job.status, 'succeeded');
            assert.equal(afterLateResult.pages[0].text, '新执行结果');
            assert.equal(calls, 2);
        });
    } finally {
        release();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 所有者可分派复核人，受指派用户仅能访问并保存该任务复核', async () => {
    const suffix = Date.now().toString(36);
    const owner = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Owner', 'QA', 'user', 'active', now())`).run(`ocr_owner_${suffix}`);
    const reviewer = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OCR Reviewer', 'QA', 'user', 'active', now())`).run(`ocr_reviewer_${suffix}`);
    const ownerId = owner.lastInsertRowid;
    const reviewerId = reviewer.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '分派复核.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(ownerId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, coverage_complete, created_at, updated_at) VALUES (?, ?, 'ocr', 'needs_review', 'ocr_app', 1, now(), now()) RETURNING id`).get(ownerId, fileId).id;
    const pageId = db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, created_at, updated_at) VALUES (?, ?, ?, 1, '待复核文本', '待复核文本', 5, 'needs_review', 'succeeded', now(), now()) RETURNING id`).get(ownerId, fileId, jobId).id;
    try {
        const assignments = await assignReviewers({ ownerUserId: ownerId, jobId, reviewerUserIds: [reviewerId], note: '请核对文号' });
        assert.equal(assignments.length, 1);
        const detail = await getJobDetail({ userId: reviewerId, jobId, sourceModule: 'ocr_app' });
        assert.equal(detail.job.id, jobId);
        const saved = await savePageReview({ userId: reviewerId, pageId, revisedText: '复核后的文本', expectedRevision: 1, sourceModule: 'ocr_app' });
        assert.equal(saved.pages[0].text, '复核后的文本');
        const assignment = db.prepare('SELECT status FROM document_review_assignments WHERE job_id = ? AND reviewer_user_id = ?').get(jobId, reviewerId);
        assert.equal(assignment.status, 'in_review');
        const another = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Other', 'QA', 'user', 'active', now())`).run(`ocr_other_${suffix}`);
        assert.equal(await getJobDetail({ userId: another.lastInsertRowid, jobId, sourceModule: 'ocr_app' }), null);
        db.prepare('DELETE FROM users WHERE id = ?').run(another.lastInsertRowid);
    } finally {
        cleanupDocumentProcessingRows(ownerId);
        db.prepare('DELETE FROM document_review_assignments WHERE job_id = ?').run(jobId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(ownerId, reviewerId);
    }
});

test('OCR 双人复核要求两位同单位已分派复核人各自保存后确认', async () => {
    const suffix = Date.now().toString(36);
    const owner = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Owner', 'QA', 'user', 'active', now())`).run(`ocr_double_owner_${suffix}`);
    const first = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Reviewer A', 'QA', 'user', 'active', now())`).run(`ocr_double_a_${suffix}`);
    const second = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Reviewer B', 'QA', 'user', 'active', now())`).run(`ocr_double_b_${suffix}`);
    const ownerId = owner.lastInsertRowid;
    const firstId = first.lastInsertRowid;
    const secondId = second.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '双人.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(ownerId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, coverage_complete, created_at, updated_at) VALUES (?, ?, 'ocr', 'needs_review', 'ocr_app', 1, now(), now()) RETURNING id`).get(ownerId, fileId).id;
    const pageId = db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, created_at, updated_at) VALUES (?, ?, ?, 1, '双人原文', '双人原文', 4, 'needs_review', 'succeeded', now(), now()) RETURNING id`).get(ownerId, fileId, jobId).id;
    try {
        await assignReviewers({ ownerUserId: ownerId, jobId, reviewerUserIds: [firstId, secondId] });
        await savePageReview({ userId: firstId, pageId, revisedText: '甲复核', expectedRevision: 1, sourceModule: 'ocr_app' });
        const firstComplete = await completeReview({ userId: firstId, jobId });
        assert.equal(firstComplete.doubleConfirmed, false);
        await savePageReview({ userId: secondId, pageId, revisedText: '乙复核', expectedRevision: 2, sourceModule: 'ocr_app' });
        const secondComplete = await completeReview({ userId: secondId, jobId });
        assert.equal(secondComplete.doubleConfirmed, true);
        assert.equal((await getJobDetail({ userId: ownerId, jobId })).job.reviewState, 'reviewed');
    } finally {
        cleanupDocumentProcessingRows(ownerId);
        db.prepare('DELETE FROM document_review_assignments WHERE job_id = ?').run(jobId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(ownerId, firstId, secondId);
    }
});

test('OCR 纠错反馈要求授权并在管理员审核后才进入已通过状态', async () => {
    const suffix = Date.now().toString(36);
    const owner = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Feedback Owner', 'QA', 'user', 'active', now())`).run(`ocr_feedback_${suffix}`);
    const admin = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Feedback Admin', 'QA', 'admin', 'active', now())`).run(`ocr_feedback_admin_${suffix}`);
    const userId = owner.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '反馈.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(userId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, created_at, updated_at) VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', now(), now()) RETURNING id`).get(userId, fileId).id;
    const pageId = db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, created_at, updated_at) VALUES (?, ?, ?, 1, '错误文本', '错误文本', 4, 'succeeded', 'succeeded', now(), now()) RETURNING id`).get(userId, fileId, jobId).id;
    try {
        await assert.rejects(() => submitOcrFeedback({ userId, pageId, correctedText: '正确文本', consented: false }), error => error?.code === 'OCR_FEEDBACK_CONSENT_REQUIRED');
        const feedback = await submitOcrFeedback({ userId, pageId, correctedText: '正确文本', consented: true });
        assert.equal(feedback.status, 'pending');
        const reviewed = await reviewOcrFeedback({ reviewerUserId: admin.lastInsertRowid, feedbackId: feedback.id, status: 'approved', reviewNote: '样本可用' });
        assert.equal(reviewed.status, 'approved');
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM document_ocr_feedback WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(userId, admin.lastInsertRowid);
    }
});

test('OFD 文本材料可安全提取并经 OCR 应用任务导出', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'OFD Test', 'QA', 'user', 'active', now())`).run(`ocr_ofd_${suffix}`);
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'ocr-ofd-test', String(userId));
    const sourcePath = path.join(tempDir, 'sample.ofd');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(sourcePath, createZip([
        { name: 'OFD.xml', data: '<ofd:OFD xmlns:ofd="urn:ofd"><ofd:DocBody/></ofd:OFD>' },
        { name: 'Doc_0/Pages/Page_0/Content.xml', data: '<ofd:Page xmlns:ofd="urn:ofd"><ofd:TextObject><ofd:TextCode>第一条 OFD 测试正文</ofd:TextCode></ofd:TextObject></ofd:Page>' }
    ]));
    try {
        assert.match(await extractOfdText(sourcePath), /OFD 测试正文/);
        const initial = await createJobFromUpload({
            user: { id: userId, username: `ocr_ofd_${suffix}` },
            file: { path: sourcePath, originalname: 'sample.ofd', mimetype: 'application/ofd', size: fs.statSync(sourcePath).size },
            jobType: 'ocr', sourceModule: 'ocr_app', config: {}
        });
        const detail = await waitForDocumentJob(userId, initial.job.id);
        assert.equal(detail.job.status, 'succeeded');
        assert.match(detail.pages[0].text, /OFD 测试正文/);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('OCR 分页详情与聊天上下文只返回可访问任务的页级来源', async () => {
    const suffix = Date.now().toString(36);
    const user = db.prepare(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', 'Context User', 'QA', 'user', 'active', now())`).run(`ocr_context_${suffix}`);
    const userId = user.lastInsertRowid;
    const fileId = db.prepare(`INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, '上下文.png', 'image', '.png', 1, 'ocr_app', now(), now()) RETURNING id`).get(userId).id;
    const jobId = db.prepare(`INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, content_revision, created_at, updated_at) VALUES (?, ?, 'ocr', 'succeeded', 'ocr_app', 3, now(), now()) RETURNING id`).get(userId, fileId).id;
    for (let page = 1; page <= 3; page += 1) db.prepare(`INSERT INTO document_pages (user_id, file_id, job_id, page_number, text, raw_text, text_length, ocr_status, processing_state, content_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 4, 'succeeded', 'succeeded', 3, now(), now())`).run(userId, fileId, jobId, page, `第${page}页正文`, `第${page}页正文`);
    try {
        const slice = await getJobPageSlice({ userId, jobId, sourceModule: 'ocr_app', page: 2, limit: 1 });
        assert.equal(slice.total, 3);
        assert.equal(slice.data.length, 1);
        assert.equal(slice.data[0].pageNumber, 2);
        const context = await getOcrChatContext({ userId, jobId });
        assert.match(context.text, /OCR 任务/);
        assert.match(context.text, /修订 3 第 2 页/);
        assert.equal(context.sources.length, 3);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});
