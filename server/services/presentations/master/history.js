'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const compress = promisify(gzip), decompress = promisify(gunzip);
const { compactMessages } = require('./context');
const { HISTORY_PAGE_CHARS, confirmedWrite } = require('./observations');
const runtime = require('./runtime');

const THRESHOLD = 500000, MAX_ARCHIVES = 64, MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function observationBatch(message) {
    if (message.role !== 'user' || typeof message.content !== 'string') return null;
    let items;
    try { items = JSON.parse(message.content); } catch (_) { return null; }
    return Array.isArray(items) ? items : null;
}

function activePages(batches, before, phaseFrom) {
    // 只保护有界的源材料和当前阶段指引，同一页优先保留最近的读取结果。
    let materialChars = 48000, workflowChars = 96000;
    const retained = new Set(), pages = new Set();
    for (let index = batches.length - 1; index >= 0; index--) {
        for (const item of batches[index] || []) {
            const { path, text, offset } = item?.result || {};
            if (item.error || typeof text !== 'string' || typeof path !== 'string') continue;
            const material = item.action === 'read' && /^inputs\/material-[1-9]\d*\.md$/.test(path);
            const workflow = item.action === 'read_runtime' && Number.isSafeInteger(phaseFrom) && index >= phaseFrom;
            if (!material && !workflow) continue;
            const key = JSON.stringify([item.action, path, offset ?? 0, text]);
            if (pages.has(key) || index < before && text.length > (material ? materialChars : workflowChars)) continue;
            pages.add(key);
            retained.add(item);
            if (material) materialChars -= text.length;
            else workflowChars -= text.length;
        }
    }
    return retained;
}

function reduceObservation(item, archive, index) {
    const result = item?.result;
    if (!result || result.archived || !['read', 'read_runtime', 'read_history', 'list', 'run'].includes(item.action)) return item;
    const { text, files, stdout, stderr, ...metadata } = result;
    if (JSON.stringify({ text, files, stdout, stderr }).length < 1000) return item;
    return { ...item, result: { ...metadata, archived: { archive, index },
        ...(Array.isArray(files) ? { fileCount: files.length } : {}),
        note: '完整工具结果已归档。可按 archive、index 分页调用 read_history；核对当前文件时使用 read 或 list。' } };
}

function archiveFailedWrites(message, observations, archive, index) {
    if (!observations) return message;
    let turn;
    try { turn = JSON.parse(message.content); } catch (_) { return message; }
    if (!Array.isArray(turn.actions)) return message;
    let changed = false;
    const actions = turn.actions.map((action, position) => {
        if (action?.action !== 'write' || typeof action.text !== 'string' || action.text.length < 1000
            || confirmedWrite(action, observations[position])) return action;
        const { text: _text, ...fields } = action;
        changed = true;
        return { ...fields, rejectedWrite: { archive, index } };
    });
    return changed ? { ...message, content: JSON.stringify({ ...turn, actions }) } : message;
}

async function archiveOlderObservations(state, { force = false, recentTurns = 4, preserveActive = false } = {}) {
    if (!Array.isArray(state.messages) || (!force && JSON.stringify(state.messages).length <= THRESHOLD)) return false;
    const existing = Array.isArray(state.historyArchives) ? state.historyArchives : [];
    const before = state.messages, view = compactMessages(before).messages;
    const lastAssistants = [];
    for (let index = before.length - 1; index >= 0 && lastAssistants.length < recentTurns; index--) if (before[index].role === 'assistant') lastAssistants.push(index);
    const protectedFrom = lastAssistants.at(-1) ?? 0, archived = {}, archiveIndex = existing.length;
    const batches = before.map(observationBatch);
    const retained = preserveActive ? activePages(batches, protectedFrom, state.workflowPhaseFrom) : null;
    for (let index = protectedFrom; index < before.length; index++) view[index] = before[index];
    for (let index = 0; index < protectedFrom; index++) {
        const original = before[index];
        if (original.role === 'assistant') view[index] = archiveFailedWrites(view[index], batches[index + 1], archiveIndex, index);
        if (original.role === 'assistant' && view[index].content !== original.content) {
            archived[index] = original;
            view[index] = { ...view[index], content: view[index].content.replace('需要正文时使用 read 读取当前文件。', `历史原文可调用 read_history，archive=${archiveIndex}、index=${index}；当前文件可使用 read 读取。`) };
        }
        if (original.role !== 'user' || typeof original.content !== 'string') continue;
        view[index] = original;
        const entries = batches[index];
        if (!entries) continue;
        const reduced = entries.map(item => retained?.has(item) ? item : reduceObservation(item, archiveIndex, index));
        if (reduced.some((item, position) => item !== entries[position])) {
            archived[index] = original;
            view[index] = { ...original, content: JSON.stringify(reduced) };
        }
    }
    if (!Object.keys(archived).length || JSON.stringify(view).length >= JSON.stringify(before).length) return false;
    const raw = Buffer.from(JSON.stringify(archived)), zipped = await compress(raw);
    const archivesSize = existing.reduce((sum, item) => sum + String(item.data || '').length, 0) + Math.ceil(zipped.length / 3) * 4;
    if (existing.length >= MAX_ARCHIVES || raw.length > MAX_ARCHIVE_BYTES || archivesSize > MAX_ARCHIVE_BYTES) {
        throw runtime.error('历史检查点已达到保存上限，请分批制作；原任务仍可查看。', 'PPT_MASTER_HISTORY_LIMIT', 422);
    }
    state.historyArchives = [...existing, { data: zipped.toString('base64'), sha256: digest(raw), bytes: raw.length }];
    state.messages = view;
    return true;
}

async function readHistory(state, action) {
    const archive = Number(action.archive), index = Number(action.index), offset = Number(action.offset ?? 0), length = Number(action.length ?? HISTORY_PAGE_CHARS);
    if (![archive, index, offset, length].every(Number.isSafeInteger) || archive < 0 || index < 0 || offset < 0 || length < 1 || length > HISTORY_PAGE_CHARS) throw runtime.error('历史读取参数无效。');
    const entry = state.historyArchives?.[archive];
    if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_ARCHIVE_BYTES || typeof entry.data !== 'string' || entry.data.length > MAX_ARCHIVE_BYTES) throw runtime.error('历史检查点不存在或已损坏。');
    let decoded;
    try { decoded = await decompress(Buffer.from(entry.data, 'base64'), { maxOutputLength: MAX_ARCHIVE_BYTES }); } catch (_) { throw runtime.error('历史检查点无法解压。'); }
    if (decoded.length !== entry.bytes || digest(decoded) !== entry.sha256) throw runtime.error('历史检查点摘要不匹配，不能继续读取。');
    let message;
    try { message = JSON.parse(decoded.toString('utf8'))[index]; } catch (_) { throw runtime.error('历史检查点格式无效。'); }
    if (!message || typeof message.content !== 'string') throw runtime.error('历史消息不存在。');
    const chars = Array.from(message.content), start = Math.min(offset, chars.length), end = Math.min(start + length, chars.length);
    return { archive, index, role: message.role, text: chars.slice(start, end).join(''), offset: start, nextOffset: end < chars.length ? end : null, totalChars: chars.length };
}

module.exports = { archiveOlderObservations, readHistory };
