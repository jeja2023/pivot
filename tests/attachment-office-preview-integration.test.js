'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const XLSX = require('@e965/xlsx');
const { queryOne, execute } = require('../server/db/client');
const { createAttachmentsRouter } = require('../server/routes/attachments');
const { closePgPool } = require('../server/db/pg-connection');

test('附件支持 ONLYOFFICE 和内置 Excel 在线预览，并对回源票据与用户权限严格核验', async () => {
    let service = null;
    let xlsxAttachment = null;
    let docxAttachment = null;
    let docxBuffer = null;
    let xlsxPath = null;
    let docxPath = null;
    let targetDir = null;
    let sessionId = null;
    const priorEnv = {};
    try {
        const owner = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
        assert.ok(owner, '需要至少一个有效测试用户');

        const suffix = `${process.pid}_${Date.now()}`;
        sessionId = `test_sess_${suffix}`;
        await execute('INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)', [sessionId, owner.id, '测试会话']);

        const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
            ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
            : path.resolve(__dirname, '..', 'uploads');
        targetDir = path.join(uploadRoot, String(owner.id), sessionId);
        fs.mkdirSync(targetDir, { recursive: true });

        // 1. 创建测试 Excel 文件
        const xlsxFilename = `test_excel_${suffix}.xlsx`;
        xlsxPath = path.join(targetDir, xlsxFilename);
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([['项目', '预算'], ['服务器', 5000]]);
        XLSX.utils.book_append_sheet(wb, ws, '预算表');
        XLSX.writeFile(wb, xlsxPath);

        const relativeXlsxPath = `uploads/${owner.id}/${sessionId}/${xlsxFilename}`;
        xlsxAttachment = await queryOne(`
            INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [owner.id, sessionId, '测试预算.xlsx', relativeXlsxPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fs.statSync(xlsxPath).size, 'token_1']);

        // 2. 创建测试 Word 文件
        const docxFilename = `test_word_${suffix}.docx`;
        docxPath = path.join(targetDir, docxFilename);
        const docxZip = new JSZip();
        docxZip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello world from docx</w:t></w:r></w:p></w:body></w:document>');
        docxBuffer = await docxZip.generateAsync({ type: 'nodebuffer' });
        fs.writeFileSync(docxPath, docxBuffer);
        const relativeDocxPath = `uploads/${owner.id}/${sessionId}/${docxFilename}`;
        docxAttachment = await queryOne(`
            INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [owner.id, sessionId, '测试文档.docx', relativeDocxPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBuffer.length, 'token_2']);

        for (const key of ['PIVOT_ONLYOFFICE_PATH', 'PIVOT_ONLYOFFICE_PIVOT_URL', 'PIVOT_ONLYOFFICE_JWT_SECRET']) {
            priorEnv[key] = process.env[key];
        }
        process.env.PIVOT_ONLYOFFICE_PATH = '/onlyoffice';
        process.env.PIVOT_ONLYOFFICE_PIVOT_URL = 'http://pivot:3000';
        process.env.PIVOT_ONLYOFFICE_JWT_SECRET = 'onlyoffice-test-secret-0123456789abcdef';

        const app = express();
        app.use(express.json());
        app.use(createAttachmentsRouter({
            authMiddleware: (req, res, next) => {
                if (req.headers['x-test-user'] === 'owner') { req.user = owner; return next(); }
                if (req.headers['x-test-user'] === 'other') {
                    req.user = { id: Number(owner.id) + 888888, username: 'stranger_user', role: 'user' };
                    return next();
                }
                res.sendStatus(401);
            },
            uploadLimiter: (_req, _res, next) => next(),
            upload: { single: () => (_req, _res, next) => next() },
            normalizePage: v => Number(v) || 1,
            normalizeLimit: v => Number(v) || 20,
            logAction: () => {}
        }));
        app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

        service = http.createServer(app);
        await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${service.address().port}`;

        // A. 开启 ONLYOFFICE 时，Word 附件返回 ONLYOFFICE 配置并能成功回源
        const wordRes = await fetch(`${base}/api/attachments/preview-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner' },
            body: JSON.stringify({ attachmentId: docxAttachment.id })
        });
        assert.equal(wordRes.status, 200);
        const wordData = await wordRes.json();
        assert.equal(wordData.mode, 'onlyoffice');
        assert.equal(wordData.onlyoffice.editor.documentType, 'word');

        // 回源拉取文档内容
        const wordFileUrl = new URL(wordData.onlyoffice.editor.document.url);
        const wordFetched = await fetch(`${base}/api/attachments/onlyoffice/file${wordFileUrl.search}`);
        assert.equal(wordFetched.status, 200);
        assert.equal(Buffer.from(await wordFetched.arrayBuffer()).equals(docxBuffer), true);

        // B. 开启 ONLYOFFICE 时，Excel 附件返回 cell 类型配置
        const excelRes = await fetch(`${base}/api/attachments/preview-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner' },
            body: JSON.stringify({ url: `/${relativeXlsxPath}` })
        });
        assert.equal(excelRes.status, 200);
        const excelData = await excelRes.json();
        assert.equal(excelData.mode, 'onlyoffice');
        assert.equal(excelData.onlyoffice.editor.documentType, 'cell');

        // C. 未配置 ONLYOFFICE 时，Excel 附件回退到内置表格数据解析，Word 附件回退到纯净文本预览且不提示 ONLYOFFICE
        delete process.env.PIVOT_ONLYOFFICE_PATH;
        const excelDirectRes = await fetch(`${base}/api/attachments/preview-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner' },
            body: JSON.stringify({ attachmentId: xlsxAttachment.id })
        });
        assert.equal(excelDirectRes.status, 200);
        const excelDirectData = await excelDirectRes.json();
        assert.equal(excelDirectData.mode, 'excel');
        assert.deepEqual(excelDirectData.excel.sheetNames, ['预算表']);
        assert.deepEqual(excelDirectData.excel.sheets[0].rows[0], ['项目', '预算']);
        assert.deepEqual(excelDirectData.excel.sheets[0].rows[1], ['服务器', '5000']);

        const wordDirectRes = await fetch(`${base}/api/attachments/preview-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner' },
            body: JSON.stringify({ attachmentId: docxAttachment.id })
        });
        assert.equal(wordDirectRes.status, 200);
        const wordDirectData = await wordDirectRes.json();
        assert.equal(wordDirectData.mode, 'doc');
        assert.equal(wordDirectData.notice, undefined);
        assert.match(wordDirectData.html, /hello world from docx/);
        assert.match(wordDirectData.text, /hello world from docx/);

        // D. 权限阻断校验：无权用户请求附件预览返回 403
        const forbiddenRes = await fetch(`${base}/api/attachments/preview-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': 'other' },
            body: JSON.stringify({ attachmentId: xlsxAttachment.id })
        });
        assert.equal(forbiddenRes.status, 403);

        // E. 伪造或过期 ticket 回源返回 403
        const invalidTicketRes = await fetch(`${base}/api/attachments/onlyoffice/file?token=invalid`);
        assert.equal(invalidTicketRes.status, 403);
    } finally {
        for (const key of Object.keys(priorEnv)) {
            if (priorEnv[key] === undefined) delete process.env[key];
            else process.env[key] = priorEnv[key];
        }
        if (service) {
            if (typeof service.closeAllConnections === 'function') service.closeAllConnections();
            await new Promise(resolve => service.close(resolve));
        }
        try {
            await execute('DELETE FROM attachments WHERE session_id = ?', [sessionId]);
            await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        } catch (_) {}
        if (xlsxPath && fs.existsSync(xlsxPath)) fs.unlinkSync(xlsxPath);
        if (docxPath && fs.existsSync(docxPath)) fs.unlinkSync(docxPath);
        try { if (targetDir) fs.rmdirSync(targetDir); } catch (_) {}
        await closePgPool();
    }
});
