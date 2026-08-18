// 从 security-rag.test.js 拆出；仍由父级入口统一加载。
const {
    assert,
    buildRagSearchContent,
    cleanupSoftDeletedStorage,
    createKnowledgeCollection,
    createKnowledgeTag,
    createKnowledgeDocumentFromUpload,
    db,
    debugRetrieveContext,
    deleteKnowledgeDocument,
    fs,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeSourcePath,
    getKnowledgeDocumentTags,
    getRagFeedbackSummary,
    listKnowledgeCollections,
    listKnowledgeTags,
    normalizeUploadedOriginalName,
    path,
    processKnowledgeDocument,
    readKnowledgeDocumentFromPath,
    recordRagFeedback,
    recoverStaleKnowledgeDocumentIndexes,
    removeTestPath,
    retrieveContext,
    runExpressHandlers,
    scheduleFailedKnowledgeDocumentsForUser,
    setKnowledgeDocumentCollection,
    setKnowledgeDocumentTags,
    test,
    toProjectRelativePath,
    uploadRoot
} = require('../security-helpers');

test('knowledge_docs 支持索引状态元数据', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_status_${suffix}`, 'hash', 'RAG Status Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_status_${suffix}.txt`, 'processing', 0, '');

    try {
        db.prepare(`
            UPDATE knowledge_docs
            SET status = ?, chunk_count = ?, error_message = ?, processed_at = ?, updated_at = ?
            WHERE id = ?
        `).run('ready', 3, '', '2099-01-01 00:00:00', '2099-01-01 00:00:00', docInfo.lastInsertRowid);
        const ready = db.prepare('SELECT status, chunk_count, error_message, processed_at, updated_at FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.deepEqual(ready, {
            status: 'ready',
            chunk_count: 3,
            error_message: '',
            processed_at: '2099-01-01 00:00:00',
            updated_at: '2099-01-01 00:00:00'
        });

        db.prepare('UPDATE knowledge_docs SET status = ?, error_message = ? WHERE id = ?')
            .run('error', 'embedding failed', docInfo.lastInsertRowid);
        const failed = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.deepEqual(failed, { status: 'error', error_message: 'embedding failed' });
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('knowledge_docs 支持启用进度和反馈元数据', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_meta_${suffix}`, 'hash', 'RAG Meta Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, progress, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_meta_${suffix}.txt`, 'ready', 0, 2, 2, 100);
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'RAG feedback chunk', 'RAG feedback chunk', JSON.stringify([1, 0]));

    try {
        const detail = await getKnowledgeDocumentDetail({
            docId: docInfo.lastInsertRowid,
            userId: userInfo.lastInsertRowid
        });
        assert.equal(detail.doc.is_enabled, 0);
        assert.equal(detail.doc.progress, 100);
        assert.equal(detail.totalChunks, 1);
        assert.equal(detail.chunks[0].id, chunkInfo.lastInsertRowid);

        const feedback = recordRagFeedback({
            userId: userInfo.lastInsertRowid,
            query: 'RAG feedback',
            chunkId: chunkInfo.lastInsertRowid,
            docName: `rag_meta_${suffix}.txt`,
            score: 0.88,
            helpful: false,
            note: 'not enough detail'
        });
        assert.ok(feedback.id > 0);
        const summary = getRagFeedbackSummary(userInfo.lastInsertRowid);
        assert.equal(summary.unhelpful, 1);
        assert.equal(summary.byDoc[0].unhelpful, 1);
    } finally {
        db.prepare('DELETE FROM rag_feedback WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG 文档源路径限制在 knowledge_docs 上传目录内', () => {
    const expected = path.resolve(uploadRoot, 'knowledge_docs', '1', '2.txt');
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/1/2.txt'), expected);
    assert.equal(getKnowledgeSourcePath('uploads/docs/legacy.txt'), null);
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/../secret.txt'), null);
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/%2e%2e/secret.txt'), null);
});

test('RAG 文档上传会保存修复后的中文文件名', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_name_${suffix}`, 'hash', 'RAG Name Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'rag-name-test');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${suffix}.txt`);
    fs.writeFileSync(tempPath, '中文文件名测试');
    const originalName = Buffer.from('测试文档.txt', 'utf8').toString('latin1');
    let docId = null;

    try {
        const result = await createKnowledgeDocumentFromUpload({
            userId,
            file: {
                path: tempPath,
                originalname: normalizeUploadedOriginalName(originalName)
            }
        });
        docId = result.docId;
        const row = db.prepare('SELECT name FROM knowledge_docs WHERE id = ?').get(docId);
        assert.equal(row.name, '测试文档.txt');
    } finally {
        if (docId) {
            const doc = db.prepare('SELECT source_path FROM knowledge_docs WHERE id = ?').get(docId);
            const sourcePath = doc?.source_path ? getKnowledgeSourcePath(doc.source_path) : null;
            removeTestPath(sourcePath);
            db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId);
            db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('RAG 文档读取器支持 Office、数据和网页文本格式', async () => {
    const XLSX = require('@e965/xlsx');
    const suffix = Date.now().toString(36);
    const tempDir = path.join(uploadRoot, 'rag-format-test');
    fs.mkdirSync(tempDir, { recursive: true });
    const csvPath = path.join(tempDir, `${suffix}.csv`);
    const jsonPath = path.join(tempDir, `${suffix}.json`);
    const htmlPath = path.join(tempDir, `${suffix}.html`);
    const xlsxPath = path.join(tempDir, `${suffix}.xlsx`);
    fs.writeFileSync(csvPath, 'name,score\nalice,98\nbob,88');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: '知识库 JSON 测试', items: ['alpha', 'beta'] }, null, 2));
    fs.writeFileSync(htmlPath, '<main><h1>知识库 HTML 测试</h1><p>正文内容</p></main>');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['部门', '人数'],
        ['研发', 12],
        ['运营', 5]
    ]), 'Sheet1');
    XLSX.writeFile(workbook, xlsxPath);

    try {
        assert.match(await readKnowledgeDocumentFromPath(csvPath, 'data.csv'), /alice/);
        assert.match(await readKnowledgeDocumentFromPath(jsonPath, 'data.json'), /知识库 JSON 测试/);
        assert.match(await readKnowledgeDocumentFromPath(htmlPath, 'page.html'), /知识库 HTML 测试/);
        assert.match(await readKnowledgeDocumentFromPath(xlsxPath, 'book.xlsx'), /研发/);
    } finally {
        removeTestPath(tempDir, { recursive: true });
    }
});

test('RAG 文档删除为软删除并保持可审计', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_delete_${suffix}`, 'hash', 'RAG Delete Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, source_path, source_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(
        userInfo.lastInsertRowid,
        `rag_delete_${suffix}.txt`,
        'ready',
        1,
        1,
        1,
        `uploads/knowledge_docs/${userInfo.lastInsertRowid}/${suffix}.txt`,
        128
    );
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'soft delete audit chunk', 'soft delete audit chunk', JSON.stringify([1, 0]));

    try {
        assert.equal(deleteKnowledgeDocument({ docId: docInfo.lastInsertRowid, userId: userInfo.lastInsertRowid }), true);
        const doc = db.prepare('SELECT deleted_at, deleted_by_user, is_enabled FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.ok(doc.deleted_at);
        assert.equal(doc.deleted_by_user, userInfo.lastInsertRowid);
        assert.equal(doc.is_enabled, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?').get(docInfo.lastInsertRowid).count, 1);
        assert.equal(getKnowledgeDocumentSummaryForUser(userInfo.lastInsertRowid).total, 0);

        const audit = getKnowledgeDocumentAuditList({ limit: 20 });
        const row = audit.data.find(item => item.id === docInfo.lastInsertRowid);
        assert.ok(row);
        assert.equal(row.username, `rag_delete_${suffix}`);
        assert.equal(row.name, `rag_delete_${suffix}.txt`);
        assert.ok(row.source_path.includes('/knowledge_docs/'));
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('软删除存储清理会清除过期文件和 RAG 分块', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`storage_gc_${suffix}`, 'hash', 'Storage GC Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const gcDir = path.join(uploadRoot, 'gc-test', String(userId));
    fs.mkdirSync(gcDir, { recursive: true });

    const attachmentPath = path.join(gcDir, 'old-attachment.txt');
    const knowledgePath = path.join(uploadRoot, 'knowledge_docs', String(userId), `old-doc-${suffix}.txt`);
    fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
    fs.writeFileSync(attachmentPath, 'old attachment');
    fs.writeFileSync(knowledgePath, 'old knowledge');

    const attachmentRel = toProjectRelativePath(attachmentPath);
    const knowledgeRel = toProjectRelativePath(knowledgePath);
    const attachmentInfo = db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'))
    `).run(userId, null, 'old-attachment.txt', attachmentRel, 'text/plain', 14, 'old-token');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, source_path, source_size, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'), datetime('now', '+8 hours', '-40 days'))
    `).run(userId, `old-doc-${suffix}.txt`, 'ready', 0, 1, 1, knowledgeRel, 13);
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'expired storage gc chunk', 'expired storage gc chunk', JSON.stringify([1, 0]));

    try {
        assert.equal(fs.existsSync(attachmentPath), true);
        assert.equal(fs.existsSync(knowledgePath), true);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE rowid = ?').get(chunkInfo.lastInsertRowid).count, 1);

        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.attachmentRows, 1);
        assert.equal(result.knowledgeDocRows, 1);
        assert.equal(fs.existsSync(attachmentPath), false);
        assert.equal(fs.existsSync(knowledgePath), false);

        const attachment = db.prepare('SELECT file_path, file_size, access_token, expires_at FROM attachments WHERE id = ?')
            .get(attachmentInfo.lastInsertRowid);
        assert.equal(attachment.file_path, '');
        assert.equal(attachment.file_size, 0);
        assert.equal(attachment.access_token, null);
        assert.equal(attachment.expires_at, null);

        const doc = db.prepare('SELECT status, source_path, source_size, chunk_count, indexed_chunks FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(doc.status, 'purged');
        assert.equal(doc.source_path, '');
        assert.equal(doc.source_size, 0);
        assert.equal(doc.chunk_count, 0);
        assert.equal(doc.indexed_chunks, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?').get(docInfo.lastInsertRowid).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE rowid = ?').get(chunkInfo.lastInsertRowid).count, 0);
    } finally {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true });
        removeTestPath(path.join(uploadRoot, 'knowledge_docs', String(userId)), { recursive: true });
    }
});

test('软删除存储清理会清除过期消息和消息 FTS 行', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`message_gc_${suffix}`, 'hash', 'Message GC Test', 'QA', 'user', 'active');
    const sessionId = `message-gc-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'), datetime('now', '+8 hours', '-40 days'))
    `).run(sessionId, userInfo.lastInsertRowid, 'Message GC');
    const messageInfo = db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, deleted_at, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'))
    `).run(sessionId, userInfo.lastInsertRowid, 'user', `expired message gc ${suffix}`);

    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE rowid = ?').get(messageInfo.lastInsertRowid).count, 1);
        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.messageRows, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(messageInfo.lastInsertRowid).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE rowid = ?').get(messageInfo.lastInsertRowid).count, 0);
    } finally {
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageInfo.lastInsertRowid);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('软删除存储清理会保留仍在保留期内的文件', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`storage_gc_keep_${suffix}`, 'hash', 'Storage GC Keep Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const gcDir = path.join(uploadRoot, 'gc-test', String(userId));
    fs.mkdirSync(gcDir, { recursive: true });
    const attachmentPath = path.join(gcDir, 'recent-attachment.txt');
    fs.writeFileSync(attachmentPath, 'recent attachment');
    const attachmentInfo = db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-2 days'), datetime('now', '+8 hours', '-3 days'))
    `).run(userId, null, 'recent-attachment.txt', toProjectRelativePath(attachmentPath), 'text/plain', 17);

    try {
        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.attachmentRows, 0);
        assert.equal(fs.existsSync(attachmentPath), true);
        const attachment = db.prepare('SELECT file_path FROM attachments WHERE id = ?').get(attachmentInfo.lastInsertRowid);
        assert.ok(attachment.file_path);
    } finally {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true });
    }
});

test('RAG 重建索引会把缺少源文件的旧文档标记为错误', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_reindex_${suffix}`, 'hash', 'RAG Reindex Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_reindex_${suffix}.txt`, 'ready', 1, '');

    try {
        await assert.rejects(
            processKnowledgeDocument({ docId: docInfo.lastInsertRowid, userId: userInfo.lastInsertRowid }),
            /原始文件不存在|source/i
        );
        const row = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(row.status, 'error');
        assert.match(row.error_message, /原始文件不存在|source/i);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG 恢复会把缺少源文件的中断处理文档标记为错误', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_recover_${suffix}`, 'hash', 'RAG Recovery Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_recover_${suffix}.txt`, 'processing', 0, '');

    try {
        const result = recoverStaleKnowledgeDocumentIndexes({ limit: 10 });
        assert.ok(result.total >= 1);
        assert.ok(result.failed >= 1);
        const row = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(row.status, 'error');
        assert.match(row.error_message, /原始文件缺失|重新上传/);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG 汇总会统计文档并调度可重试失败文档', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_summary_${suffix}`, 'hash', 'RAG Summary Test', 'QA', 'user', 'active');
    const readyDoc = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, source_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_summary_ready_${suffix}.txt`, 'ready', 4, 1234);
    const failedDoc = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, source_path, source_size, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(
        userInfo.lastInsertRowid,
        `rag_summary_failed_${suffix}.txt`,
        'error',
        0,
        `uploads/knowledge_docs/${userInfo.lastInsertRowid}/missing-${suffix}.txt`,
        42,
        'embedding failed'
    );

    try {
        const summary = getKnowledgeDocumentSummaryForUser(userInfo.lastInsertRowid);
        assert.equal(summary.total, 2);
        assert.equal(summary.ready, 1);
        assert.equal(summary.error, 1);
        assert.equal(summary.chunks, 4);
        assert.equal(summary.sourceSize, 1276);
        assert.equal(summary.retryableErrors, 1);
        assert.equal(summary.lastError.id, failedDoc.lastInsertRowid);

        const retry = scheduleFailedKnowledgeDocumentsForUser({ userId: userInfo.lastInsertRowid, limit: 10 });
        assert.deepEqual(retry, { total: 1, scheduled: 1, alreadyProcessing: 0 });
        const queuedAgain = scheduleFailedKnowledgeDocumentsForUser({ userId: userInfo.lastInsertRowid, limit: 10 });
        assert.deepEqual(queuedAgain, { total: 1, scheduled: 0, alreadyProcessing: 1 });
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id IN (?, ?)').run(readyDoc.lastInsertRowid, failedDoc.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG 调试检索无需外部嵌入也会返回带分数的分块', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_debug_${suffix}`, 'hash', 'RAG Debug Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_debug_${suffix}.txt`, 'ready', 2);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const matchedContent = '权限配置流程需要管理员审批，并记录审计日志';
    const otherContent = '季度销售报表包含收入、成本和利润分析';
    const matched = insertChunk.run(
        docInfo.lastInsertRowid,
        matchedContent,
        buildRagSearchContent(matchedContent),
        JSON.stringify([1, 0])
    );
    const other = insertChunk.run(
        docInfo.lastInsertRowid,
        otherContent,
        buildRagSearchContent(otherContent),
        JSON.stringify([0, 1])
    );

    try {
        const result = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置审批',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 0.95 }
        );
        assert.equal(result.query, '权限配置审批');
        assert.ok(result.keywords.length > 0);
        assert.equal(result.matches[0].chunkId, matched.lastInsertRowid);
        assert.equal(result.matches[0].score, 1);
        assert.equal(result.matches[0].matched, true);
        assert.match(result.injectedContext, /权限配置流程/);

        const strictResult = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置审批',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 1 }
        );
        assert.equal(strictResult.matches[0].matched, false);
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(matched.lastInsertRowid, other.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG collection scope limits debug retrieval candidates', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_collection_${suffix}`, 'hash', 'RAG Collection Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const collectionA = await createKnowledgeCollection({ userId, name: `制度专题 ${suffix}` });
    const collectionB = await createKnowledgeCollection({ userId, name: `项目专题 ${suffix}` });
    const docA = db.prepare(`
        INSERT INTO knowledge_docs (user_id, collection_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, collectionA.id, `policy-${suffix}.txt`);
    const docB = db.prepare(`
        INSERT INTO knowledge_docs (user_id, collection_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, collectionB.id, `project-${suffix}.txt`);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const contentA = `alpha-${suffix} 审批范围按照制度专题执行`;
    const contentB = `alpha-${suffix} 审批范围按照项目专题执行`;
    const chunkA = insertChunk.run(docA.lastInsertRowid, contentA, buildRagSearchContent(contentA), JSON.stringify([1, 0]));
    const chunkB = insertChunk.run(docB.lastInsertRowid, contentB, buildRagSearchContent(contentB), JSON.stringify([0.5, 0.5]));

    try {
        const scoped = await debugRetrieveContext(userId, `alpha-${suffix} 审批范围`, {
            queryVector: [1, 0],
            topK: 5,
            candidateLimit: 10,
            scoreThreshold: 0,
            scope: { collectionId: collectionA.id }
        });
        assert.equal(scoped.scope.cacheKey, `collections:${collectionA.id}`);
        assert.deepEqual(scoped.matches.map(item => item.chunkId), [chunkA.lastInsertRowid]);

        const all = await debugRetrieveContext(userId, `alpha-${suffix} 审批范围`, {
            queryVector: [1, 0],
            topK: 5,
            candidateLimit: 10,
            scoreThreshold: 0
        });
        const allIds = all.matches.map(item => item.chunkId);
        assert.equal(allIds.includes(chunkA.lastInsertRowid), true);
        assert.equal(allIds.includes(chunkB.lastInsertRowid), true);

        const moved = await setKnowledgeDocumentCollection({ docId: docB.lastInsertRowid, userId, collectionId: collectionA.id });
        assert.equal(moved.collection_id, collectionA.id);
        const collections = await listKnowledgeCollections(userId);
        const updatedA = collections.find(item => item.id === collectionA.id);
        assert.equal(updatedA.doc_count, 2);
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(chunkA.lastInsertRowid, chunkB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id IN (?, ?)').run(docA.lastInsertRowid, docB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_collections WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('RAG collection scope limits chat retrieval context', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_chat_scope_${suffix}`, 'hash', 'RAG Chat Scope Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const collectionA = await createKnowledgeCollection({ userId, name: `Chat Scope A ${suffix}` });
    const collectionB = await createKnowledgeCollection({ userId, name: `Chat Scope B ${suffix}` });
    const docAName = `chat-scope-a-${suffix}.txt`;
    const docBName = `chat-scope-b-${suffix}.txt`;
    const docA = db.prepare(`
        INSERT INTO knowledge_docs (user_id, collection_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, collectionA.id, docAName);
    const docB = db.prepare(`
        INSERT INTO knowledge_docs (user_id, collection_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, collectionB.id, docBName);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const contentA = `chat-scope-${suffix} approval answer from collection A only`;
    const contentB = `chat-scope-${suffix} approval answer from collection B should not leak`;
    const chunkA = insertChunk.run(docA.lastInsertRowid, contentA, buildRagSearchContent(contentA), null);
    const chunkB = insertChunk.run(docB.lastInsertRowid, contentB, buildRagSearchContent(contentB), null);

    try {
        const query = `chat-scope-${suffix} approval`;
        const scoped = await retrieveContext(userId, query, null, { scope: { collectionId: collectionA.id } });
        assert.equal(scoped.includes(docAName), true);
        assert.equal(scoped.includes(docBName), false);

        const all = await retrieveContext(userId, query);
        assert.equal(all.includes(docAName), true);
        assert.equal(all.includes(docBName), true);
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(chunkA.lastInsertRowid, chunkB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id IN (?, ?)').run(docA.lastInsertRowid, docB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_collections WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('RAG tag scope limits debug retrieval candidates', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_tag_${suffix}`, 'hash', 'RAG Tag Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const financeCollection = await createKnowledgeCollection({ userId, name: `财务专题-${suffix}` });
    const opsCollection = await createKnowledgeCollection({ userId, name: `运维专题-${suffix}` });
    const docA = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, `finance-${suffix}.txt`);
    const docB = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, 'ready', 1, 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, `ops-${suffix}.txt`);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const contentA = `beta-${suffix} 合同付款审批按照财务标签执行`;
    const contentB = `beta-${suffix} 合同付款审批按照运维标签执行`;
    const chunkA = insertChunk.run(docA.lastInsertRowid, contentA, buildRagSearchContent(contentA), JSON.stringify([1, 0]));
    const chunkB = insertChunk.run(docB.lastInsertRowid, contentB, buildRagSearchContent(contentB), JSON.stringify([0.5, 0.5]));

    try {
        assert.ok(await setKnowledgeDocumentCollection({ docId: docA.lastInsertRowid, userId, collectionId: financeCollection.id }));
        assert.ok(await setKnowledgeDocumentCollection({ docId: docB.lastInsertRowid, userId, collectionId: opsCollection.id }));
        for (const tag of ['财务', '合同', '2026', '运维']) {
            await createKnowledgeTag({ userId, tag });
        }
        assert.deepEqual(setKnowledgeDocumentTags({ docId: docA.lastInsertRowid, userId, tags: ['财务', '合同', '2026'] }), ['财务', '合同', '2026']);
        assert.deepEqual(setKnowledgeDocumentTags({ docId: docB.lastInsertRowid, userId, tags: ['运维', '合同'] }), ['运维', '合同']);
        assert.deepEqual(await getKnowledgeDocumentTags({ docId: docA.lastInsertRowid, userId }), ['2026', '合同', '财务']);
        const standaloneTag = await createKnowledgeTag({ userId, tag: `待分配-${suffix}` });
        assert.equal(standaloneTag.tag, `待分配-${suffix}`);
        assert.equal(standaloneTag.doc_count, 0);
        const tagSummary = listKnowledgeTags(userId);
        assert.equal(tagSummary.find(item => item.tag === '合同')?.doc_count, 2);
        assert.equal(tagSummary.find(item => item.tag === '财务')?.doc_count, 1);
        assert.equal(tagSummary.find(item => item.tag === `待分配-${suffix}`)?.doc_count, 0);
        const financeTags = listKnowledgeTags(userId, { collectionId: financeCollection.id });
        assert.equal(financeTags.find(item => item.tag === '合同')?.doc_count, 1);
        assert.equal(financeTags.find(item => item.tag === '财务')?.doc_count, 1);
        assert.equal(financeTags.some(item => item.tag === '运维'), false);
        assert.equal(financeTags.some(item => item.tag === `待分配-${suffix}`), false);

        const scoped = await debugRetrieveContext(userId, `beta-${suffix} 合同付款`, {
            queryVector: [1, 0],
            topK: 5,
            candidateLimit: 10,
            scoreThreshold: 0,
            scope: { tagNames: ['财务'] }
        });
        assert.equal(scoped.scope.cacheKey, 'tags:财务');
        assert.deepEqual(scoped.matches.map(item => item.chunkId), [chunkA.lastInsertRowid]);

        const all = await debugRetrieveContext(userId, `beta-${suffix} 合同付款`, {
            queryVector: [1, 0],
            topK: 5,
            candidateLimit: 10,
            scoreThreshold: 0
        });
        const allIds = all.matches.map(item => item.chunkId);
        assert.equal(allIds.includes(chunkA.lastInsertRowid), true);
        assert.equal(allIds.includes(chunkB.lastInsertRowid), true);
    } finally {
        db.prepare('DELETE FROM knowledge_doc_tags WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_tags WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(chunkA.lastInsertRowid, chunkB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id IN (?, ?)').run(docA.lastInsertRowid, docB.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_collections WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('RAG 检索会合并独立向量候选，并在没有语料时跳过嵌入调用', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_merge_${suffix}`, 'hash', 'RAG Merge Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_merge_${suffix}.txt`, 'ready', 1, 2);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const ftsOnly = insertChunk.run(
        docInfo.lastInsertRowid,
        'alpha 权限配置流程',
        buildRagSearchContent('alpha 权限配置流程'),
        JSON.stringify([1, 0])
    );
    const recentFallback = insertChunk.run(
        docInfo.lastInsertRowid,
        '完全无关键词但语义相关',
        buildRagSearchContent('完全无关键词但语义相关'),
        JSON.stringify([0.2, 1])
    );

    try {
        const result = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 0 }
        );
        const ids = result.matches.map(item => item.chunkId);
        assert.equal(ids.includes(ftsOnly.lastInsertRowid), true);
        assert.equal(ids.includes(recentFallback.lastInsertRowid), true);

        const empty = await retrieveContext(userInfo.lastInsertRowid + 1000000, '没有任何候选时不要请求向量');
        assert.equal(empty, '');
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(ftsOnly.lastInsertRowid, recentFallback.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('GET /docs 接口能正确连表查询总数并返回文档列表', async () => {
    const { ragRouter } = require('../../server/rag');
    const route = ragRouter.stack.find(layer => layer.route && layer.route.path === '/docs' && layer.route.methods.get);
    assert.ok(route);

    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_get_docs_${suffix}`, 'hash', 'RAG Get Docs Test', '研发部', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const { sql } = require('../../server/db/statements');
    const user = sql('SELECT * FROM users WHERE id = ?').get(userId);

    const collection = await createKnowledgeCollection({ userId, name: `Docs Collection ${suffix}` });
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, collection_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', 1, 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, collection.id, `doc_${suffix}.txt`);

    let responseData = null;
    let statusCode = 200;
    const req = {
        headers: {},
        query: { page: '1', limit: '15' },
        user
    };
    const res = {
        status(code) { statusCode = code; return this; },
        json(data) { responseData = data; return this; }
    };

    try {
        const handlers = route.route.stack.filter(l => l.name !== 'authMiddleware').map(l => l.handle);
        await runExpressHandlers(handlers, req, res);
        assert.equal(statusCode, 200);
        assert.ok(responseData);
        assert.equal(responseData.total, 1);
        assert.equal(responseData.data.length, 1);
        assert.equal(responseData.data[0].id, docInfo.lastInsertRowid);
        assert.equal(responseData.data[0].collection_name, `Docs Collection ${suffix}`);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_collections WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});
