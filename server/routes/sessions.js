/* 会话管理路由 Session Management Routes */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute, transaction } = require('../db/client');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { buildFtsQuery } = require('../search');
const { buildContextMeta, compactSessionMemory } = require('../llm');
const { getAccessibleModelAsync } = require('../services/models');
const { TimeoutError } = require('../services/concurrency');
const { encodeAttachmentUrl } = require('../security');
const sessionsRepository = require('../repositories/sessions');

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
const SESSION_SORT_DATE_EXPR = `substr(${SESSION_SORT_EXPR}::text, 1, 10)`;

const SESSION_PINNED_EXPR = "COALESCE(s.is_pinned, 0)";

const SESSION_ARCHIVED_EXPR = "COALESCE(s.is_archived, 0)";

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

async function appendAttachmentTokens(messages, userId, sessionId) {
    const rows = await sessionsRepository.listAttachmentTokens(userId, sessionId, getBeijingTimestamp());
    if (!rows || rows.length === 0) return messages;

    const tokenEntries = rows.flatMap(row => {
            const plainUrl = '/' + String(row.file_path || '').replace(/\\/g, '/');
            const encodedUrl = encodeAttachmentUrl(row.file_path);
            const tokenizedUrl = encodeAttachmentUrl(row.file_path, row.access_token);
            if (!tokenizedUrl) return [];
            return encodedUrl && encodedUrl !== plainUrl
                ? [[plainUrl, tokenizedUrl], [encodedUrl, tokenizedUrl]]
                : [[plainUrl, tokenizedUrl]];
        });
    const tokenByUrl = new Map(tokenEntries);

    return (messages || []).map(message => {
        let content = String(message.content || '');
        for (const [url, tokenizedUrl] of tokenByUrl.entries()) {
            const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(`${escapedUrl}(?![\\w/?=&%.-])`, 'g'), tokenizedUrl);
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
        const includeTotal = req.query.includeTotal !== 'false' && req.query.total !== 'false';
        const offset = (page - 1) * limit;

        let queryStr = `
            SELECT s.*,
            ${SESSION_SORT_DATE_EXPR} AS sort_day,
            ${SESSION_SORT_EXPR} AS sort_time,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count
            FROM sessions s
            WHERE s.user_id = ? AND ${SESSION_ARCHIVED_EXPR} = ? AND s.deleted_at IS NULL
        `;
        let params = [req.user.id, archived];

        if (keyword) {
            queryStr += ` AND s.title LIKE ? `;
            params.push(`%${keyword}%`);
        }
        if (tagList.length > 0) {
            const tagClause = tagList.map(() => `(',' || COALESCE(s.tags, '') || ',') LIKE ?`).join(tagMode === 'all' ? ' AND ' : ' OR ');
            queryStr += ` AND (${tagClause}) `;
            params.push(...tagList.map(item => `%,${item},%`));
        }
        if (cursor) {
            queryStr += ` AND (
                ${SESSION_SORT_DATE_EXPR} < ?
                OR (${SESSION_SORT_DATE_EXPR} = ? AND ${SESSION_PINNED_EXPR} < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND ${SESSION_PINNED_EXPR} = ? AND ${SESSION_SORT_EXPR} < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND ${SESSION_PINNED_EXPR} = ? AND ${SESSION_SORT_EXPR} = ? AND s.id < ?)
            ) `;
            params.push(
                cursor.day,
                cursor.day, cursor.pinned,
                cursor.day, cursor.pinned, cursor.time,
                cursor.day, cursor.pinned, cursor.time, cursor.id
            );
        }

        queryStr += ` ORDER BY
            ${SESSION_SORT_DATE_EXPR} DESC,
            ${SESSION_PINNED_EXPR} DESC,
            ${SESSION_SORT_EXPR} DESC,
            s.id DESC
            LIMIT ? `;
        params.push(limit + 1);
        if (!cursor && page > 1) {
            queryStr += ` OFFSET ? `;
            params.push(offset);
        }

        const rows = await query(queryStr, params);
        const sessions = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const nextCursor = hasMore ? encodeSessionCursor(sessions[sessions.length - 1]) : null;

        let total = null;
        if (includeTotal) {
            let countQuery = `SELECT COUNT(*) as count FROM sessions s WHERE s.user_id = ? AND ${SESSION_ARCHIVED_EXPR} = ? AND s.deleted_at IS NULL`;
            const countParams = [req.user.id, archived];
            if (keyword) {
                countQuery += ` AND s.title LIKE ?`;
                countParams.push(`%${keyword}%`);
            }
            if (tagList.length > 0) {
                const tagClause = tagList.map(() => `(',' || COALESCE(s.tags, '') || ',') LIKE ?`).join(tagMode === 'all' ? ' AND ' : ' OR ');
                countQuery += ` AND (${tagClause})`;
                countParams.push(...tagList.map(item => `%,${item},%`));
            }
            const countRow = await queryOne(countQuery, countParams);
            total = Number(countRow?.count || 0);
        }

        const payload = {
            data: sessions,
            hasMore: includeTotal && !cursor && page > 1 ? (offset + sessions.length) < total : hasMore,
            nextCursor
        };
        if (includeTotal) payload.total = total;
        res.json(payload);
    }));

    router.post('/sessions', authMiddleware, asyncHandler(async (req, res) => {
        const id = uuidv4();
        const title = req.body.title || '新对话';
        await sessionsRepository.createSession({
            id,
            userId: req.user.id,
            title,
            createdAt: getBeijingTimestamp()
        });
        logAction(req, '创建对话', `创建对话: ${title}`);
        res.json({ id, title });
    }));

    router.get('/sessions/tags/list', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await sessionsRepository.listSessionTagValues(req.user.id);
        const tags = [...new Set(rows.flatMap(row => String(row.tags).split(',').map(tag => tag.trim()).filter(Boolean)))].sort();
        res.json(tags);
    }));

    router.get('/sessions/tags/summary', authMiddleware, asyncHandler(async (req, res) => {
        const includeArchived = req.query.includeArchived === 'true';
        const archivedFilter = "AND COALESCE(is_archived, 0) = 0";
        const rows = await query(`
            SELECT id, title, tags, is_archived, is_pinned, updated_at, created_at
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL ${includeArchived ? '' : archivedFilter}
            ORDER BY COALESCE(updated_at, created_at) DESC
        `, [req.user.id]);

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
                const isArchived = row.is_archived === true || Number(row.is_archived) === 1 || String(row.is_archived) === '1' || String(row.is_archived).toLowerCase() === 'true';
                const isPinned = row.is_pinned === true || Number(row.is_pinned) === 1 || String(row.is_pinned) === '1' || String(row.is_pinned).toLowerCase() === 'true';
                if (isArchived) current.archivedCount += 1;
                else current.activeCount += 1;
                if (isPinned) current.pinnedCount += 1;
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

        // FTS 内容搜索在 PostgreSQL 模式下暂不支持 SQLite 特有的 snippet/messages_fts 语法
        const sessions = await query(`
            SELECT DISTINCT s.*,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count,
            '' as snippet
            FROM sessions s
            JOIN messages m ON m.session_id = s.id
            WHERE s.user_id = ? AND s.deleted_at IS NULL AND m.deleted_at IS NULL
              AND m.content ILIKE ?
            ORDER BY s.updated_at DESC
            LIMIT 50
        `, [req.user.id, `%${keyword}%`]);

        res.json({ data: sessions });
    }));

    router.get('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const session = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const requestedLimit = Number.parseInt(req.query.messageLimit, 10);
        if (Number.isSafeInteger(requestedLimit) && requestedLimit > 0) {
            const pageResult = await sessionsRepository.listMessagePage(req.params.id, req.user.id, {
                beforeId: req.query.beforeMessageId,
                limit: requestedLimit
            });
            const messages = await appendAttachmentTokens(pageResult.messages, req.user.id, req.params.id);
            const contextMeta = req.query.beforeMessageId
                ? null
                : buildContextMeta(await sessionsRepository.listMessages(req.params.id, req.user.id));
            return res.json({ session, messages, page: pageResult.page, contextMeta });
        }
        const rawMessages = await sessionsRepository.listMessages(req.params.id, req.user.id);
        const messages = await appendAttachmentTokens(rawMessages, req.user.id, req.params.id);
        res.json({ session, messages, contextMeta: buildContextMeta(rawMessages) });
    }));

    router.get('/sessions/:id/context', authMiddleware, asyncHandler(async (req, res) => {
        const session = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const rawMessages = await sessionsRepository.listMessages(req.params.id, req.user.id);
        res.json({ contextMeta: buildContextMeta(rawMessages) });
    }));

    router.post('/sessions/:id/compact', authMiddleware, asyncHandler(async (req, res) => {
        const session = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });

        const modelId = req.body?.modelId ? parseInt(req.body.modelId, 10) : null;
        const modelCfg = (await getAccessibleModelAsync(modelId, req.user)) || (await getAccessibleModelAsync(null, req.user));
        if (!modelCfg) return res.status(400).json({ error: '没有可用于压缩的模型配置' });
        if (modelCfg.secret_error) return res.status(400).json({ error: `${modelCfg.secret_error}，请重新保存该模型的 API Key` });

        let result;
        try {
            result = await compactSessionMemory(req.params.id, req.user.id, modelCfg, { force: true });
        } catch (err) {
            if (err instanceof TimeoutError || err.code === 'OPERATION_TIMEOUT') {
                return res.status(504).json({
                    error: `${err.message}。可调高 MEMORY_COMPRESSION_TIMEOUT_MS 或换用响应更快的模型后重试。`,
                    code: 'MEMORY_COMPRESSION_TIMEOUT'
                });
            }
            throw err;
        }
        const message = result.compressed
            ? `已压缩 ${Number(result.summarizedCount || 0)} 条较早上下文`
            : result.reason === 'duplicate'
                ? '上下文压缩正在进行中，请稍后查看用量变化'
                : result.reason === 'too_many'
                    ? '当前压缩任务较多，请稍后重试'
                    : '当前会话暂时没有可压缩的早期上下文';
        logAction(req, '手动压缩上下文', `会话ID: ${req.params.id}，结果: ${result.compressed ? '已压缩' : '已跳过'}`);
        res.json({
            success: true,
            compressed: Boolean(result.compressed),
            skipped: Boolean(result.skipped),
            inProgress: result.reason === 'duplicate',
            reason: result.reason || '',
            message,
            contextMeta: result.after || result.before || buildContextMeta(await sessionsRepository.listMessages(req.params.id, req.user.id))
        });
    }));

    router.post('/sessions/:id/fork', authMiddleware, asyncHandler(async (req, res) => {
        const source = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: '会话不存在' });

        const requestedMessageId = Number.parseInt(req.body?.messageId, 10);
        const fallbackMessage = await queryOne(`
            SELECT id
            FROM messages
            WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL
            ORDER BY id DESC
            LIMIT 1
        `, [source.id, req.user.id]);
        const forkedFromMessageId = Number.isSafeInteger(requestedMessageId)
            ? requestedMessageId
            : Number(fallbackMessage?.id || 0);
        if (!forkedFromMessageId) return res.status(400).json({ error: '当前会话没有可分叉的消息' });

        const forkMessage = await queryOne(`
            SELECT id
            FROM messages
            WHERE id = ? AND session_id = ? AND user_id = ? AND deleted_at IS NULL
        `, [forkedFromMessageId, source.id, req.user.id]);
        if (!forkMessage) return res.status(404).json({ error: '分叉消息不存在' });

        const newSessionId = uuidv4();
        const now = getBeijingTimestamp();
        const baseTitle = String(req.body?.title || source.title || '新分支').trim();
        const title = (baseTitle.startsWith('分支：') ? baseTitle : `分支：${baseTitle}`).slice(0, 80);
        const forkNote = String(req.body?.note || '').trim().slice(0, 500);
        const rootSessionId = source.fork_root_session_id || source.parent_session_id || source.id;
        const copiedMessages = await query(`
            SELECT role, content, token_count, is_summary, context_archived, compressed_at, model_id, created_at
            FROM messages
            WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL AND id <= ?
            ORDER BY id ASC
        `, [source.id, req.user.id, forkedFromMessageId]);

        await transaction(async trx => {
            await trx.execute(`
                INSERT INTO sessions (
                    id, user_id, title, tags, system_prompt, parent_session_id, forked_from_message_id,
                    fork_root_session_id, fork_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
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
            ]);

            for (const message of copiedMessages) {
                await trx.execute(`
                    INSERT INTO messages (
                        session_id, user_id, role, content, token_count, is_summary, context_archived,
                        compressed_at, model_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
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
                ]);
            }
        });

        const forkedSession = await sessionsRepository.getSessionById(newSessionId, req.user.id);
        logAction(req, '分叉会话', `源会话ID: ${source.id}，新会话ID: ${newSessionId}，消息ID: ${forkedFromMessageId}`);
        res.status(201).json({ success: true, session: forkedSession, copiedMessages: copiedMessages.length });
    }));

    router.get('/sessions/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const session = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const messages = await sessionsRepository.listMessages(req.params.id, req.user.id);

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
        const session = await sessionsRepository.getSessionById(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const messages = await sessionsRepository.listMessages(req.params.id, req.user.id);

        const escapeHtml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const title = escapeHtml(session.title || '会话记录');
        const exportedAt = getBeijingTimestamp();
        // 消息正文走浏览器侧渲染（marked + DOMPurify），故这里只输出占位容器，
        // 原始内容通过 <script type="application/json"> 数据岛传给前端，避免在 HTML 模板内做 markdown 渲染
        const messagesForPrint = messages.map(msg => ({
            role: String(msg.role || ''),
            createdAt: String(msg.created_at || ''),
            content: String(msg.content || '')
        }));
        const messageHtml = messagesForPrint.map((msg, idx) => {
            const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role === 'system' ? '系统' : escapeHtml(msg.role || '消息');
            const roleClass = msg.role === 'user' ? 'role-user' : msg.role === 'assistant' ? 'role-assistant' : 'role-system';
            return `
                <article class="print-msg ${roleClass}">
                    <header class="print-msg-head"><span class="print-msg-role">${roleLabel}</span><time>${escapeHtml(msg.createdAt)}</time></header>
                    <div class="print-msg-body" data-print-msg-body data-print-msg-index="${idx}">渲染中…</div>
                </article>
            `;
        }).join('\n');
        // JSON 序列化后再把 '<' 转义为 <，避免内容里出现 </script> 提前关闭脚本块；浏览器 JSON.parse 时会还原
        const printDataJson = JSON.stringify(messagesForPrint).replace(/</g, '\\u003c');
        // 嵌入模式：作为 iframe 嵌入到主工作区时，去掉外层背景、缩小内边距、隐藏标题
        const embedded = req.query.embed === '1';

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
  .print-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  .print-meta { font-size: 13px; color: #64748b; }
  .print-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .print-actions button { padding: 6px 14px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: #1e293b; font-size: 13px; cursor: pointer; }
  .print-actions button.primary { background: #10a37f; border-color: #10a37f; color: #fff; }
  .print-msg { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; margin: 12px 0; page-break-inside: avoid; }
  .print-msg-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: #64748b; margin-bottom: 8px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px; }
  .print-msg-role { font-weight: 600; color: #1e293b; }
  .print-msg-body { font-size: 14px; word-break: break-word; line-height: 1.65; }
  .print-msg-body p { margin: 0 0 0.6em; }
  .print-msg-body p:last-child { margin-bottom: 0; }
  .print-msg-body ul, .print-msg-body ol { margin: 0.4em 0 0.6em; padding-left: 1.6em; }
  .print-msg-body li { margin: 0.15em 0; }
  .print-msg-body pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5; }
  .print-msg-body code { background: #f1f5f9; border-radius: 3px; padding: 1px 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  .print-msg-body pre code { background: transparent; padding: 0; }
  .print-msg-body blockquote { margin: 0.4em 0; padding: 4px 12px; border-left: 3px solid #cbd5e1; color: #475569; }
  .print-msg-body table { border-collapse: collapse; margin: 0.5em 0; }
  .print-msg-body th, .print-msg-body td { border: 1px solid #cbd5e1; padding: 4px 8px; font-size: 13px; text-align: left; }
  .print-msg-body th { background: #f1f5f9; }
  .print-msg-body img { max-width: 100%; height: auto; }
  .print-msg-body h1, .print-msg-body h2, .print-msg-body h3, .print-msg-body h4 { margin: 0.6em 0 0.3em; line-height: 1.3; }
  .print-msg-body h1 { font-size: 1.35em; }
  .print-msg-body h2 { font-size: 1.2em; }
  .print-msg-body h3 { font-size: 1.05em; }
  .print-msg-body h4 { font-size: 1em; }
  .role-user .print-msg-role { color: #2563eb; }
  .role-assistant .print-msg-role { color: #059669; }
  .role-system { background: #fef3c7; }
  .role-system .print-msg-role { color: #b45309; }
  /* 嵌入模式：作为 iframe 嵌到主工作区时，去掉外层背景与标题，缩小内边距 */
  body.is-embed { background: transparent; padding: 12px 18px; }
  body.is-embed > h1 { display: none; }
  body.is-embed > .print-topbar { margin-bottom: 12px; }
  body.is-embed .print-meta { font-size: 12px; color: #94a3b8; }
  body.is-embed .print-actions #close-btn { display: none; }
  @media print {
    body { background: #fff; padding: 0 12mm; }
    .print-actions { display: none; }
    .print-msg { box-shadow: none; }
  }
</style>
</head>
<body class="${embedded ? 'is-embed' : ''}">
  <h1>${title}</h1>
  <div class="print-topbar">
    <div class="print-meta">导出时间：${escapeHtml(exportedAt)} · 共 ${messages.length} 条消息</div>
    <div class="print-actions">
      <button id="print-btn" class="primary" type="button">打印 / 导出为 PDF</button>
      <button id="close-btn" type="button">关闭</button>
    </div>
  </div>
  ${messageHtml}
  <script id="pivot-print-data" type="application/json" nonce="${nonce}">${printDataJson}</script>
  <script src="/common/vendor/marked.min.js" nonce="${nonce}"></script>
  <script src="/common/vendor/purify.min.js" nonce="${nonce}"></script>
  <script nonce="${nonce}">
    (function () {
      // 移除 AI 思考过程标签（<thought>…</thought> / <thinking>…</thinking>），导出版默认不保留
      function stripThoughtBlocks(text) {
        return String(text || '')
          .replace(/<thought>[\\s\\S]*?<\\/thought>/gi, '')
          .replace(/<thinking>[\\s\\S]*?<\\/thinking>/gi, '')
          .replace(/^[ \\t]*\\n/gm, '');
      }
      function safeMarkdownToHtml(text) {
        var cleaned = stripThoughtBlocks(text);
        if (window.marked && typeof window.marked.parse === 'function') {
          try {
            var html = window.marked.parse(cleaned, { breaks: true, gfm: true });
            if (window.DOMPurify) {
              return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
            }
            return html;
          } catch (e) {
            // marked 解析失败时退回到纯文本
          }
        }
        // 兜底：转义后保留换行
        return cleaned
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\\n/g, '<br>');
      }
      var dataEl = document.getElementById('pivot-print-data');
      var data;
      try { data = JSON.parse(dataEl.textContent || '[]'); } catch (e) { data = []; }
      document.querySelectorAll('[data-print-msg-body]').forEach(function (el) {
        var idx = Number(el.getAttribute('data-print-msg-index'));
        var msg = data[idx];
        if (!msg) { el.textContent = ''; return; }
        el.innerHTML = safeMarkdownToHtml(msg.content || '');
      });
      document.getElementById('print-btn').addEventListener('click', function () { window.print(); });
      document.getElementById('close-btn').addEventListener('click', function () { window.close(); });
    })();
  </script>
</body>
</html>`);
    }));

    router.put('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { title } = req.body;
        const safeTitle = String(title || '').trim().slice(0, 80);
        const changed = await execute(
            'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?',
            [safeTitle, getBeijingTimestamp(), req.params.id, req.user.id]
        );
        if (changed > 0) logAction(req, '修改对话名称', `会话ID: ${req.params.id}，新名称: ${safeTitle}`);
        res.json({ success: changed > 0 });
    }));

    router.put('/sessions/:id/pin', authMiddleware, asyncHandler(async (req, res) => {
        const { isPinned } = req.body;
        const pinVal = isPinned ? 1 : 0;
        const pinChanged = await execute('UPDATE sessions SET is_pinned = ? WHERE id = ? AND user_id = ?', [pinVal, req.params.id, req.user.id]);
        if (pinChanged === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.put('/sessions/:id/archive', authMiddleware, asyncHandler(async (req, res) => {
        const isArchived = req.body.isArchived ? 1 : 0;
        const archiveChanged = await execute('UPDATE sessions SET is_archived = ? WHERE id = ? AND user_id = ?', [isArchived, req.params.id, req.user.id]);
        if (archiveChanged === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, isArchived ? '归档对话' : '恢复对话', `会话ID: ${req.params.id}`);
        res.json({ success: true });
    }));

    router.put('/sessions/:id/tags', authMiddleware, asyncHandler(async (req, res) => {
        const tags = normalizeTags(req.body.tags);
        const tagsChanged = await execute('UPDATE sessions SET tags = ? WHERE id = ? AND user_id = ?', [tags, req.params.id, req.user.id]);
        if (tagsChanged === 0) return res.status(404).json({ error: '会话不存在' });
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
        if (sessionIds.length === 0) return res.status(400).json({ error: '缺少必需的 sessionIds 参数' });

        const placeholders = sessionIds.map(() => '?').join(', ');
        const rows = await query(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
        `, [req.user.id, ...sessionIds]);
        if (rows.length === 0) return res.status(404).json({ error: '未找到匹配的会话记录' });

        const now = getBeijingTimestamp();
        await transaction(async trx => {
            for (const row of rows) {
                await trx.execute('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?',
                    [applyTagOperation(row.tags, nextTags, operation), now, row.id, req.user.id]);
            }
        });
        logAction(req, '批量更新对话标签', `数量: ${rows.length}，操作: ${operation}，标签: ${nextTags.join(',') || '-'}`);
        res.json({ success: true, affected: rows.length, operation, tags: nextTags.join(',') });
    }));

    router.post('/sessions/tags/rename', authMiddleware, asyncHandler(async (req, res) => {
        const fromTag = String(req.body?.fromTag || '').trim();
        const toTag = String(req.body?.toTag || '').trim();
        if (!fromTag || !toTag) return res.status(400).json({ error: '缺少必需的 fromTag 或 toTag 参数' });
        if (fromTag === toTag) return res.json({ success: true, affected: 0, fromTag, toTag });

        const rows = await query(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
              AND (',' || COALESCE(tags, '') || ',') LIKE ?
        `, [req.user.id, `%,${fromTag},%`]);

        const now = getBeijingTimestamp();
        await transaction(async trx => {
            for (const row of rows) {
                await trx.execute('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?',
                    [renameTagValue(row.tags, fromTag, toTag), now, row.id, req.user.id]);
            }
        });
        logAction(req, '重命名对话标签', `标签: ${fromTag} -> ${toTag}，影响: ${rows.length}`);
        res.json({ success: true, affected: rows.length, fromTag, toTag });
    }));

    router.post('/sessions/tags/remove', authMiddleware, asyncHandler(async (req, res) => {
        const tag = String(req.body?.tag || '').trim();
        if (!tag) return res.status(400).json({ error: '缺少必需的 tag 标签参数' });
        const rows = await query(`
            SELECT id, tags
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
              AND (',' || COALESCE(tags, '') || ',') LIKE ?
        `, [req.user.id, `%,${tag},%`]);

        const now = getBeijingTimestamp();
        await transaction(async trx => {
            for (const row of rows) {
                await trx.execute('UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?',
                    [applyTagOperation(row.tags, [tag], 'remove'), now, row.id, req.user.id]);
            }
        });
        logAction(req, '删除对话标签', `标签: ${tag}，影响: ${rows.length}`);
        res.json({ success: true, affected: rows.length, tag });
    }));

    router.put('/sessions/:id/system-prompt', authMiddleware, asyncHandler(async (req, res) => {
        const { systemPrompt } = req.body;
        const spChanged = await execute('UPDATE sessions SET system_prompt = ? WHERE id = ? AND user_id = ?', [systemPrompt, req.params.id, req.user.id]);
        if (spChanged === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.delete('/messages/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { id } = req.params;
        const msgDeleted = await execute(
            'UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
            [getBeijingTimestamp(), id, req.user.id]
        );
        if (msgDeleted > 0) logAction(req, '删除消息', `消息ID: ${id}`);
        res.json({ success: msgDeleted > 0 });
    }));

    router.delete('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const sessionId = req.params.id;
        const userId = req.user.id;
        const session = await queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [sessionId, userId]);
        if (!session) return res.status(403).json({ error: '无权删除或会话不存在' });

        const now = getBeijingTimestamp();
        let sessionDeleted = 0;
        await transaction(async trx => {
            await trx.execute('UPDATE attachments SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL', [now, sessionId, userId]);
            await trx.execute('UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL', [now, sessionId, userId]);
            sessionDeleted = await trx.execute('UPDATE sessions SET deleted_at = ?, deleted_by_user = 1, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [now, now, sessionId, userId]);
        });
        logAction(req, '删除对话', `删除会话ID: ${sessionId}`);
        res.json({ success: sessionDeleted > 0 });
    }));

    return router;
}

module.exports = { createSessionsRouter };
