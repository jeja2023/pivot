const { db, getBeijingTimestamp } = require('../security-helpers');
const express = require('express');
const http = require('node:http');
const { registerDocumentRoutes } = require('../../server/routes/apps/regulations/documents');

function createDocument(title) {
    const now = getBeijingTimestamp();
    return Number(db.prepare(`
        INSERT INTO regulation_documents (
            title, category, issuing_body, jurisdiction, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, created_at, updated_at
        ) VALUES (?, '', '', '', 'active', NULL, 0, 0, 1, 1, ?, ?)
    `).run(title, now, now).lastInsertRowid);
}

async function createRegulationBatchServer() {
    const app = express();
    const router = express.Router();
    const audit = [];
    app.use(express.json());
    registerDocumentRoutes(router, {
        authMiddleware: (req, res, next) => {
            const username = req.get('x-test-user');
            if (!username) return res.status(401).json({ error: '请登录' });
            req.user = { id: 1, username, role: username === 'ordinary' ? 'user' : 'admin' };
            next();
        },
        logAction: (_req, action, detail) => audit.push({ action, detail }),
        uploadLimiter: (_req, _res, next) => next(),
        upload: { single: () => (_req, _res, next) => next(), array: () => (_req, _res, next) => next() }
    });
    app.use('/api/apps/regulations', router);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { message: error.message } }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        audit,
        request: (username, ids, { patch, endpoint = 'batch-delete' } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/apps/regulations/documents/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(username ? { 'x-test-user': username } : {}) },
            body: JSON.stringify({ ids, patch })
        }),
        close: () => new Promise(resolve => server.close(resolve))
    };
}

module.exports = { createDocument, createRegulationBatchServer };
