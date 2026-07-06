const {
    assert,
    db,
    fs,
    path,
    removeTestPath,
    test,
    uploadRoot
} = require('./security-helpers');

const {
    createJobExport,
    createJobFromUpload,
    createPdfToolJobFromUploads,
    getJobDetail,
    getOutputDownload,
    savePageReview
} = require('../server/services/document-processing');
const { documentRoot, resolveStoredDocumentPath } = require('../server/services/document-processing/paths');
const { PDFDocument } = require('pdf-lib');
const { normalizePaddleDiagnostic, parsePaddleOutput } = require('../server/services/document-processing/ocr/adapters/paddle');

async function waitForDocumentJob(userId, jobId, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const detail = getJobDetail({ userId, jobId });
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
        const download = getOutputDownload({ userId, outputId: output.id });
        assert.ok(download.filePath.startsWith(documentRoot));
        assert.equal(fs.existsSync(download.filePath), true);
        assert.match(fs.readFileSync(download.filePath, 'utf8'), /第二行用于导出验证/);

        const htmlOutput = await createJobExport({ userId, jobId: detail.job.id, format: 'html' });
        assert.equal(htmlOutput.outputType, 'html');
        assert.ok(getOutputDownload({ userId, outputId: htmlOutput.id }).filePath.startsWith(documentRoot));

        const reviewed = savePageReview({
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

test('PaddleOCR 输出解析会保留文本、坐标和置信度', () => {
    const output = "[[[1,2],[3,2],[3,4],[1,4]], ('测试文字', 0.93)]\n[[[5,6],[7,6],[7,8],[5,8]], ('第二行', 88.0)]";
    const blocks = parsePaddleOutput(output);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, '测试文字');
    assert.equal(blocks[0].confidence, 0.93);
    assert.equal(blocks[1].text, '第二行');
    assert.equal(blocks[1].confidence, 0.88);
});

test('PaddleOCR 3.x 输出解析会保留识别文本和置信度', () => {
    const output = "{'rec_texts': ['测试文字', '第二行'], 'rec_scores': [0.93, 88.0], 'rec_polys': [array([[1, 2], [3, 2]], dtype=int16), array([[5, 6], [7, 6]], dtype=int16)]}";
    const blocks = parsePaddleOutput(output);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, '测试文字');
    assert.equal(blocks[0].confidence, 0.93);
    assert.equal(blocks[1].text, '第二行');
    assert.equal(blocks[1].confidence, 0.88);
});
test('PaddleOCR diagnostics ignore ANSI font notices', () => {
    const warning = '\u001b[33mUsing the local font file(models/paddleocr/fonts/simfang.ttf) specified by LOCAL_FONT_FILE_PATH\u001b[0m';
    assert.equal(normalizePaddleDiagnostic(warning), '');
    const blocks = parsePaddleOutput(warning + "\n{'rec_texts': ['hello'], 'rec_scores': [0.91]}");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, 'hello');
    assert.equal(blocks[0].confidence, 0.91);
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
        const download = getOutputDownload({ userId, outputId: output.id });
        assert.ok(download.filePath.startsWith(documentRoot));
        const merged = await PDFDocument.load(fs.readFileSync(download.filePath));
        assert.equal(merged.getPageCount(), 2);
    } finally {
        cleanupDocumentProcessingRows(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});
