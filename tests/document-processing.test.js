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
    createPdfToolJobFromUploads,
    deleteJob,
    getDocumentProcessingSettings,
    getJobDetail,
    getJobOutputsArchive,
    getJobOutputsArchiveStream,
    getOutputDownload,
    reprocessJob,
    retryJob,
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
const nodeHttp = require('http');
const httpOcr = require('../server/services/document-processing/ocr/adapters/http');
const { normalizeEngine } = require('../server/services/document-processing/ocr');
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
    db.prepare('DELETE FROM document_ocr_blocks WHERE user_id = ?').run(userId);
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

test('OCR service URL setting is saved, normalized, cleared, and validated', () => {
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const previousUrl = process.env.OCR_SERVICE_URL;
    preserveAppSetting(key, () => {
        try {
            process.env.OCR_SERVICE_URL = 'http://env-ocr:9100';
            const settings = updateDocumentProcessingSettings({
                patch: { serviceUrl: 'http://ocr-service:9100/' },
                userId: 1
            });
            assert.equal(settings.serviceUrl, 'http://ocr-service:9100');
            assert.equal(getDocumentProcessingSettings().serviceUrl, 'http://ocr-service:9100');
            const cleared = updateDocumentProcessingSettings({ patch: { serviceUrl: '' }, userId: 1 });
            assert.equal(cleared.serviceUrl, 'http://env-ocr:9100');
            assert.throws(
                () => updateDocumentProcessingSettings({ patch: { serviceUrl: 'file:///tmp/ocr' }, userId: 1 }),
                /OCR 服务地址仅支持 HTTP 或 HTTPS/
            );
        } finally {
            if (previousUrl === undefined) delete process.env.OCR_SERVICE_URL;
            else process.env.OCR_SERVICE_URL = previousUrl;
        }
    });
});

test('OCR engine setting normalizes legacy values to external HTTP service', () => {
    const key = DOCUMENT_PROCESSING_SETTING_KEYS.engine;
    preserveAppSetting(key, () => {
        const settings = updateDocumentProcessingSettings({
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
            updateDocumentProcessingSettings({
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
        const before = await getJobDetail({ userId, jobId: job.job.id });
        const rejected = await retryJob({ userId, jobId: job.job.id, sourceModule: 'pdf_tools' });
        const after = await getJobDetail({ userId, jobId: job.job.id });
        assert.equal(rejected, null);
        assert.equal(after.job.status, before.job.status);
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
