'use strict';

// 数据库来源不直接保存可执行 SQL。管理员先创建并显式批准只读模板，数据源
// 只引用模板 ID；这样来源配置、审计与连接权限策略能形成可追溯边界。
const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isAdmin } = require('../permissions');
const { assertReadonlySql } = require('./database-mcp/sql-governance');


function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeField(value, fallback) {
    const field = String(value || fallback || '').trim();
    return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(field) ? field : fallback;
}

function parseTemplate(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        connectionId: String(row.connection_id || ''),
        name: row.name,
        sql: row.sql_template,
        titleField: row.title_field,
        contentField: row.content_field,
        watermarkField: row.watermark_field,
        status: row.status,
        approvedBy: normalizeId(row.approved_by),
        approvedAt: row.approved_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function normalizeTemplateInput(body = {}) {
    const connectionId = String(body.connectionId || body.connection_id || '').trim().slice(0, 128);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    const sql = assertReadonlySql(String(body.sql || body.sqlTemplate || body.sql_template || '').trim().slice(0, 12000));
    if (!connectionId || !name) {
        const error = new Error('数据库模板必须包含连接、名称和只读 SQL。');
        error.status = 400;
        throw error;
    }
    return {
        connectionId,
        name,
        sql,
        titleField: normalizeField(body.titleField || body.title_field, 'title'),
        contentField: normalizeField(body.contentField || body.content_field, 'content'),
        watermarkField: normalizeField(body.watermarkField || body.watermark_field, 'updated_at')
    };
}

async function listKnowledgeDatabaseQueryTemplates(user, { connectionId = '', limit = 100 } = {}) {
    if (!user?.id) return [];
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    const connection = String(connectionId || '').trim().slice(0, 128);
    const rows = await query(`
        SELECT * FROM knowledge_database_query_templates
        WHERE ${isAdmin(user) ? '1 = 1' : 'user_id = ?'}
          ${connection ? 'AND connection_id = ?' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT ?
    `, [...(isAdmin(user) ? [] : [user.id]), ...(connection ? [connection] : []), safeLimit]);
    return rows.map(parseTemplate);
}

async function createKnowledgeDatabaseQueryTemplate(user, body = {}) {
    if (!isAdmin(user)) return null;
    const input = normalizeTemplateInput(body);
    const timestamp = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO knowledge_database_query_templates (
            user_id, connection_id, name, sql_template, title_field, content_field, watermark_field,
            status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING *
    `, [user.id, input.connectionId, input.name, input.sql, input.titleField, input.contentField, input.watermarkField, timestamp, timestamp]);
    return parseTemplate(row);
}

async function approveKnowledgeDatabaseQueryTemplate(user, templateId, { approved = true } = {}) {
    if (!isAdmin(user)) return null;
    const id = normalizeId(templateId);
    if (!id) return null;
    const timestamp = getBeijingTimestamp();
    const status = approved === true ? 'approved' : 'disabled';
    const row = await queryOne(`
        UPDATE knowledge_database_query_templates
        SET status = ?, approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? RETURNING *
    `, [status, user.id, status === 'approved' ? timestamp : null, timestamp, id]);
    return parseTemplate(row);
}

async function getApprovedKnowledgeDatabaseQueryTemplate(templateId, connectionId) {
    const id = normalizeId(templateId);
    const connection = String(connectionId || '').trim().slice(0, 128);
    if (!id || !connection) return null;
    const row = await queryOne(`
        SELECT * FROM knowledge_database_query_templates
        WHERE id = ? AND connection_id = ? AND status = 'approved'
    `, [id, connection]);
    return parseTemplate(row);
}

module.exports = {
    approveKnowledgeDatabaseQueryTemplate,
    createKnowledgeDatabaseQueryTemplate,
    getApprovedKnowledgeDatabaseQueryTemplate,
    listKnowledgeDatabaseQueryTemplates,
    normalizeTemplateInput
};
