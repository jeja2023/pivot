/* 会话管理路由 Session Management Routes */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, stmts } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { buildFtsQuery } = require('../search');
const { buildContextMeta } = require('../llm');

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

const splitTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);

function normalizeTagList(value, limit = 8) {
    return [...new Set(
        (Array.isArray(value) ? value : splitTags(value))
            .map(tag => String(tag || '').trim())
            .filter(Boolean)
    )].slice(0, limit);
}

function applyTagOperation(existingTags, nextTags, operation = 'replace') {
    const current = normalizeTagList(existingTags);
    const incoming = normalizeTagList(nextTags);
    if (operation === 'add') return [...new Set([...current, ...incoming])].slice(0, 8).join(',');
    if (operation === 'remove') return current.filter(tag => !incoming.includes(tag)).join(',');
    return incoming.join(',');
}

function renameTagValue(existingTags, fromTag, toTag) {
    const current = normalizeTagList(existingTags);
    if (!current.includes(fromTag)) return current.join(',');
    return [...new Set(current.map(tag => (tag === fromTag ? toTag : tag)).filter(Boolean))].slice(0, 8).join(',');
}

const SESSION_SORT_EXPR = 'COALESCE(s.updated_at, s.created_at)';
const SESSION_SORT_DATE_EXPR = `date(${SESSION_SORT_EXPR})`;

function encodeSessionCursor(row) {
    if (!row) return null;
    const payload = {
        day: row.sort_day || '',
        pinned: Number(row.is_pinned || 0),
        time: row.sort_time || row.updated_at || row.created_at || '',
        id: row.id || ''
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSessionCursor(value) {
    if (!value) return null;
    try {
        const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (!cursor || !cursor.day || !cursor.time || !cursor.id) return null;
        return {
            day: String(cursor.day),
            pinned: Number(cursor.pinned || 0),
            time: String(cursor.time),
            id: String(cursor.id)
        };
    } catch (e) {
        return null;
    }
}

function appendAttachmentTokens(messages, userId, sessionId) {
    const rows = db.prepare(`
        SELECT file_path, access_token
        FROM attachments
        WHERE user_id = ? AND session_id = ? AND access_token IS NOT NULL AND access_token != ''
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
    `).all(userId, sessionId, getBeijingTimestamp());
    if (rows.length === 0) return messages;

    const tokenByUrl = new Map(rows.map(row => [
        '/' + String(row.file_path || '').replace(/\\/g, '/'),
        row.access_token
    ]));

    return messages.map(message => {
        let content = String(message.content || '');
        for (const [url, token] of tokenByUrl.entries()) {
            const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(`${escapedUrl}(?![\\w/?=&%.-])`, 'g'), `${url}?token=${token}`);
        }
        return { ...message, content };
    });
}

function createSessionsRouter({
    authMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();

    router.get('/sessions', authMiddleware, asyncHandler(async (req, res) => {
        const page = normalizePage(req.query.page || 1);
        const limit = normalizeLimit(req.query.limit || 20);
        const keyword = String(req.query.keyword || '').trim();
        const tagList = normalizeTagList(req.query.tag);
        const tagMode = String(req.query.tagMode || 'any').toLowerCase() === 'all' ? 'all' : 'any';
        const archived = req.query.archived === 'true' ? 1 : 0;
        const cursor = decodeSessionCursor(req.query.cursor);
        const offset = (page - 1) * limit;

        let query = `
            SELECT s.*,
            ${SESSION_SORT_DATE_EXPR} AS sort_day,
            ${SESSION_SORT_EXPR} AS sort_time,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count
            FROM sessions s
            WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ? AND s.deleted_at IS NULL
        `;
        let params = [req.user.id, archived];

        if (keyword) {
            query += ` AND s.title LIKE ? `;
            params.push(`%${keyword}%`);
        }
        if (tagList.length > 0) {
            const tagClause = tagList.map(() => `(',' || COALESCE(s.tags, '') || ',') LIKE ?`).join(tagMode === 'all' ? ' AND ' : ' OR ');
            query += ` AND (${tagClause}) `;
            params.push(...tagList.map(item => `%,${item},%`));
        }
        if (cursor) {
            query += ` AND (
                ${SESSION_SORT_DATE_EXPR} < ?
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) = ? AND ${SESSION_SORT_EXPR} < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) = ? AND ${SESSION_SORT_EXPR} = ? AND s.id < ?)
            ) `;
            params.push(
                cursor.day,
                cursor.day, cursor.pinned,
                cursor.day, cursor.pinned, cursor.time,
                cursor.day, cursor.pinned, cursor.time, cursor.id
            );
        }

        query += ` ORDER BY
            ${SESSION_SORT_DATE_EXPR} DESC,
            COALESCE(s.is_pinned, 0) DESC,
            ${SESSION_SORT_EXPR} DESC,
            s.id DESC
            LIMIT ? `;
        params.push(limit + 1);
        if (!cursor && page > 1) {
            query += ` OFFSET ? `;
            params.push(offset);
        }

        const rows = db.prepare(query).all(...params);
        const sessions = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const nextCursor = hasMore ? encodeSessionCursor(sessions[sessions.length - 1]) : null;

        let countQuery = 'SELECT COUNT(*) as count FROM sessions s WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ? AND s.deleted_at IS NULL';
        let countParams = [req.user.id, archived];
        if (keyword) {
            countQuery += ` AND s.title LIKE ?`;
            countParams.push(`%${keyword}%`);
        }
        if (tagList.length > 0) {
            const tagClause = tagList.map(() => `(',' || COALESCE(s.tags, '') || ',') LIKE ?`).join(tagMode === 'all' ? ' AND ' : ' OR ');
            countQuery += ` AND (${tagClause})`;
            countParams.push(...tagList.map(item => `%,${item},%`));
        }
        const total = db.prepare(countQuery).get(...countParams).count;

        res.json({
            data: sessions,
            total,
            hasMore: cursor || page === 1 ? hasMore : (offset + sessions.length) < total,
            nextCursor
        });
    }));

    router.post('/sessions', authMiddleware, asyncHandler(async (req, res) => {
        const id = uuidv4();
        const title = req.body.title || '新对话';
        db.prepare('INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)')
          .run(id, req.user.id, title, getBeijingTimestamp());
        logAction(req, '创建对话', `创建对话: ${title}`);
        res.json({ id, title });
    }));

    router.get('/sessions/tags/list', authMiddleware, asyncHandler(async (req, res) => {
        const rows = db.prepare("SELECT tags FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''").all(req.user.id);
        const tags = [...new Set(rows.flatMap(row => String(row.tags).split(',').map(tag => tag.trim()).filter(Boolean)))].sort();
        res.json(tags);
    }));

    router.get('/sessions/tags/summary', authMiddleware, asyncHandler(async (req, res) => {
        const includeArchived = req.query.includeArchived === 'true';
        const rows = db.prepare(`
            SELECT id, title, tags, is_archived, is_pinned, updated_at, created_at
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL ${includeArchived ? '' : 'AND COALESCE(is_archived, 0) = 0'}
            ORDER BY COALESCE(updated_at, created_at) DESC
        `).all(req.user.id);

        const byTag = new Map();
        rows.forEach(row => {
            splitTags(row.tags).forEach(tag => {
                const current = byTag.get(tag) || {
                    tag,
                    count: 0,
                    activeCount: 0,
                    archivedCount: 0,
                    pinnedCount: 0,
                    lastUsedAt: '',
                    recentSessionId: '',
                    recentSessionTitle: ''
                };
                current.count += 1;
                if (Number(row.is_archived || 0) === 1) current.archivedCount += 1;
                else current.activeCount += 1;
                if (Number(row.is_pinned || 0) === 1) current.pinnedCount += 1;
                const rowTime = String(row.updated_at || row.created_at || '');
                if (!current.lastUsedAt || rowTime > current.lastUsedAt) {
                    current.lastUsedAt = rowTime;
                    current.recentSessionId = row.id;
                    current.recentSessionTitle = row.title || '';
                }
                byTag.set(tag, current);
            });
        });

        const data = [...byTag.values()].sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.tag.localeCompare(b.tag, 'zh-CN');
        });
        res.json({ data, total: data.length });
    }));

    router.get('/sessions/search/content', authMiddleware, asyncHandler(async (req, res) => {
        const keyword = String(req.query.keyword || '').trim();
        if (!keyword) return res.json({ data: [] });
        const ftsQuery = buildFtsQuery(keyword);
        if (!ftsQuery) return res.json({ data: [] });

        const sessions = db.prepare(`
            SELECT DISTINCT s.*, 
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count,
            snippet(messages_fts, 0, '<b>', '</b>', '...', 20) as snippet
            FROM sessions s
            JOIN messages m ON m.session_id = s.id
            JOIN messages_fts f ON f.rowid = m.id
            WHERE s.user_id = ? AND s.deleted_at IS NULL AND m.deleted_at IS NULL AND messages_fts MATCH ?
            ORDER BY s.updated_at DESC
            LIMIT 50
        `).all(req.user.id, ftsQuery);

        res.json({ data: sessions });
    }));

    router.get('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const session = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const rawMessages = stmts.getMessages.all(req.params.id, req.user.id);
        const messages = appendAttachmentTokens(rawMessages, req.user.id, req.params.id);
        res.json({ session, messages, contextMeta: buildContextMeta(rawMessages) });
    }));

    router.post('/sessions/:id/fork', authMiddleware, asyncHandler(async (req, res) => {
        const source = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: '会话不存在' });

        const requestedMessageId = Number.parseInt(req.body?.messageId, 10);
        const fallbackMessage = db.prepare(`
            SELECT id
            FROM messages
            WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL
            ORDER BY id DESC
            LIMIT 1
        `).get(source.id, req.user.id);
        const forkedFromMessageId = Number.isSafeInteger(requestedMessageId)
            ? requestedMessageId
            : Number(fallbackMessage?.id || 0);
        if (!forkedFromMessageId) return res.status(400).json({ error: '当前会话没有可分叉的消息' });

        const forkMessage = db.prepare(`
            SELECT id
            FROM messages
            WHERE id = ? AND session_id = ? AND user_id = ? AND deleted_at IS NULL
        `).get(forkedFromMessageId, source.id, req.user.id);
        if (!forkMessage) return res.status(404).json({ error: '分叉消息不存在' });

        const newSessionId = uuidv4();
        const now = getBeijingTimestamp();
        const baseTitle = String(req.body?.title || source.title || '新分支').trim();
        const title = (baseTitle.startsWith('分支：') ? baseTitle : `分支：${baseTitle}`).slice(0, 80);
        const forkNote = String(req.body?.note || '').trim().slice(0, 500);
        const rootSessionId = source.fork_root_session_id || source.parent_session_id || source.id;
        const copiedMessages = db.prepare(`
            SELECT role, content, token_count, is_summary, context_archived, compressed_at, model_id, created_at
            FROM messages
            WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL AND id <= ?
            ORDER BY id ASC
        `).all(source.id, req.user.id, forkedFromMessageId);

        db.transaction(() => {
            db.prepare(`
                INSERT INTO sessions (
                    id, user_id, title, tags, system_prompt, parent_session_id, forked_from_message_id,
                    fork_root_session_id, fork_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                newSessionId,
                req.user.id,
                title,
                source.tags || '',
                source.system_prompt || '',
                source.id,
                forkedFromMessageId,
                rootSessionId,
                forkNote,
                now,
                now
            );

            const insertMessage = db.prepare(`
                INSERT INTO messages (
                    session_id, user_id, role, content, token_count, is_summary, context_archived,
                    compressed_at, model_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            copiedMessages.forEach(message => {
                insertMessage.run(
                    newSessionId,
                    req.user.id,
                    message.role,
                    message.content,
                    message.token_count || 0,
                    message.is_summary || 0,
                    message.context_archived || 0,
                    message.compressed_at || null,
                    message.model_id || null,
                    message.created_at || now
                );
            });
        })();

        const forkedSession = stmts.getSessionById.get(newSessionId, req.user.id);
        logAction(req, '分叉会话', `源会话ID: ${source.id}，新会话ID: ${newSessionId}，消息ID: ${forkedFromMessageId}`);
        res.status(201).json({ success: true, session: forkedSession, copiedMessages: copiedMessages.length });
    }));

    router.get('/sessions/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const session = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const messages = stmts.getMessages.all(req.params.id, req.user.id);

        let content = `# ${session.title}\n\n`;
        content += `> 导出时间: ${getBeijingTimestamp()}\n\n`;

        for (const msg of messages) {
            const role = msg.role === 'user' ? '👤 用户' : '🤖 助手';
            content += `### ${role}\n\n${msg.content}\n\n---\n\n`;
        }

        res.setHeader('Content-disposition', `attachment; filename="chat_${req.params.id.slice(0, 8)}.md"`);
        res.setHeader('Content-type', 'text/markdown; charset=utf-8');
        res.send(content);
    }));

    // 打印友好 HTML 视图：用户在浏览器中按 Ctrl/Cmd+P 即可"打印为 PDF"，无需服务端 puppeteer
    router.get('/sessions/:id/print', authMiddleware, asyncHandler(async (req, res) => {
        const session = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const messages = stmts.getMessages.all(req.params.id, req.user.id);

        const escapeHtml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const title = escapeHtml(session.title || '会话记录');
        const exportedAt = getBeijingTimestamp();
        const messageHtml = messages.map(msg => {
            const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role === 'system' ? '系统' : escapeHtml(msg.role || '消息');
            const roleClass = msg.role === 'user' ? 'role-user' : msg.role === 'assistant' ? 'role-assistant' : 'role-system';
            const time = escapeHtml(msg.created_at || '');
            const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
            return `
                <article class="print-msg ${roleClass}">
                    <header class="print-msg-head"><span class="print-msg-role">${roleLabel}</span><time>${time}</time></header>
                    <div class="print-msg-body">${content}</div>
                </article>
            `;
        }).join('\n');

        const nonce = res.locals.cspNonce || '';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${title} · Pivot 会话导出</title>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 40px; font-family: "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; color: #1e293b; background: #f8fafc; line-height: 1.6; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .print-meta { font-size: 13px; color: #64748b; margin-bottom: 20px; }
  .print-actions { display: flex; gap: 10px; margin-bottom: 24px; }
  .print-actions button { padding: 6px 14px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: #1e293b; font-size: 13px; cursor: pointer; }
  .print-actions button.primary { background: #10a37f; border-color: #10a37f; color: #fff; }
  .print-msg { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; margin: 12px 0; page-break-inside: avoid; }
  .print-msg-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: #64748b; margin-bottom: 8px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px; }
  .print-msg-role { font-weight: 600; color: #1e293b; }
  .print-msg-body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .role-user .print-msg-role { color: #2563eb; }
  .role-assistant .print-msg-role { color: #059669; }
  .role-system { background: #fef3c7; }
  .role-system .print-msg-role { color: #b45309; }
  @media print {
    body { background: #fff; padding: 0 12mm; }
    .print-actions { display: none; }
    .print-msg { box-shadow: none; }
  }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="print-meta">导出时间：${escapeHtml(exportedAt)} · 共 ${messages.length} 条消息</div>
  <div class="print-actions">
    <button id="print-btn" class="primary" type="button">打印 / 导出为 PDF</button>
    <button id="close-btn" type="button">关闭</button>
  </div>
  ${messageHtml}
  <script nonce="${nonce}">
    document.getElementById('print-btn').addEventListener('click', function () { window.print(); });
    document.getElementById('close-btn').addEventListener('click', function () { window.close(); });
  </script>
</body>
</html>`);
    }));

    router.put('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { title } = req.body;
        const safeTitle = String(title || '').trim().slice(0, 80);
        const info = stmts.updateSessionTitle.run(safeTitle, getBeijingTimestamp(), req.params.id, req.user.id);
        if (info.changes > 0) logAction(req, '修改对话名称', `会话ID: ${req.params.id}，新名称: ${safeTitle}`);
        res.json({ success: info.changes > 0 });
    }));

    router.put('/sessions/:id/pin', authMiddleware, asyncHandler(async (req, res) => {
        const { isPinned } = req.body;
        const stmt = db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(isPinned ? 1 : 0, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.put('/sessions/:id/archive', authMiddleware, asyncHandler(async (req, res) => {
        const isArchived = req.body.isArchived ? 1 : 0;
        const info = db.prepare('UPDATE sessions SET is_archived = ? WHERE id = ? AND user_id = ?')
          .run(isArchived, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, isArchived ? '归档对话' : '恢复对话', `会话ID: ${req.params.id}`);
        res.json({ success: true });
    }));

    router.put('/sessions/:id/tags', authMiddleware, asyncHandler(async (req, res) => {
        const tags = normalizeTags(req.body.tags);
        const info = db.prepare('UPDATE sessions SET tags = ? WHERE id = ? AND user_id = ?')
          .run(tags, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, '更新对话标签', `会话ID: ${req.params.id}，标签: ${tags || '-'}`);
        res.json({ success: true, tags });
    }));

    router.post('/sessions/tags/batch', authMiddleware, asyncHandler(async (req, res) => {
        const sessionIds = [...new Set((Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean))]
            .slice(0, 200);
        const operation = ['add', 'remove', 'replace'].includes(req.body?.operation) ? req.body.operation : 'replace';
        const nextTags = normalizeTagList(req.body?.tags);
        if (sessionIds.length === 0) return res.status(400).json({ error: 'sessionIds required' });

        const placeholders = sessionIds.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
        `).all(req.user.id, ...sessionIds);
        if (rows.length === 0) return res.status(404).json({ error: 'No matching sessions found' });

        const update = db.prepare('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?');
        const now = getBeijingTimestamp();
        db.transaction(() => {
            rows.forEach(row => update.run(applyTagOperation(row.tags, nextTags, operation), now, row.id, req.user.id));
        })();
        logAction(req, '批量更新对话标签', `数量: ${rows.length}，操作: ${operation}，标签: ${nextTags.join(',') || '-'}`);
        res.json({ success: true, affected: rows.length, operation, tags: nextTags.join(',') });
    }));

    router.post('/sessions/tags/rename', authMiddleware, asyncHandler(async (req, res) => {
        const fromTag = String(req.body?.fromTag || '').trim();
        const toTag = String(req.body?.toTag || '').trim();
        if (!fromTag || !toTag) return res.status(400).json({ error: 'fromTag and toTag required' });
        if (fromTag === toTag) return res.json({ success: true, affected: 0, fromTag, toTag });

        const rows = db.prepare(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
              AND (',' || COALESCE(tags, '') || ',') LIKE ?
        `).all(req.user.id, `%,${fromTag},%`);

        const update = db.prepare('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?');
        const now = getBeijingTimestamp();
        db.transaction(() => {
            rows.forEach(row => update.run(renameTagValue(row.tags, fromTag, toTag), now, row.id, req.user.id));
        })();
        logAction(req, '重命名对话标签', `标签: ${fromTag} -> ${toTag}，影响: ${rows.length}`);
        res.json({ success: true, affected: rows.length, fromTag, toTag });
    }));

    router.post('/sessions/tags/remove', authMiddleware, asyncHandler(async (req, res) => {
        const tag = String(req.body?.tag || '').trim();
        if (!tag) return res.status(400).json({ error: 'tag required' });
        const rows = db.prepare(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
              AND (',' || COALESCE(tags, '') || ',') LIKE ?
        `).all(req.user.id, `%,${tag},%`);

        const update = db.prepare('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?');
        const now = getBeijingTimestamp();
        db.transaction(() => {
            rows.forEach(row => update.run(applyTagOperation(row.tags, [tag], 'remove'), now, row.id, req.user.id));
        })();
        logAction(req, '删除对话标签', `标签: ${tag}，影响: ${rows.length}`);
        res.json({ success: true, affected: rows.length, tag });
    }));

    router.put('/sessions/:id/system-prompt', authMiddleware, asyncHandler(async (req, res) => {
        const { systemPrompt } = req.body;
        const stmt = db.prepare('UPDATE sessions SET system_prompt = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(systemPrompt, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.delete('/messages/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { id } = req.params;
        const info = db.prepare('UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
            .run(getBeijingTimestamp(), id, req.user.id);
        if (info.changes > 0) logAction(req, '删除消息', `消息ID: ${id}`);
        res.json({ success: info.changes > 0 });
    }));

    router.delete('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const sessionId = req.params.id;
        const userId = req.user.id;
        const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(sessionId, userId);
        if (!session) return res.status(403).json({ error: '无权删除或会话不存在' });

        const deleteTx = db.transaction(() => {
            const now = getBeijingTimestamp();
            db.prepare('UPDATE attachments SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL').run(now, sessionId, userId);
            db.prepare('UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL').run(now, sessionId, userId);
            const info = db.prepare('UPDATE sessions SET deleted_at = ?, deleted_by_user = 1, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, sessionId, userId);
            return info;
        });

        const info = deleteTx();
        logAction(req, '删除对话', `删除会话ID: ${sessionId}`);
        res.json({ success: info.changes > 0 });
    }));

    return router;
}

module.exports = { createSessionsRouter };
