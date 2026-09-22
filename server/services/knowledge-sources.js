'use strict';

// 局域网知识来源服务。首个可运行连接器是受白名单约束的本地/SMB 映射目录：
// 扫描原目录、复制一份到 Pivot 受控存储、通过原有解析索引链路入库，并用
// source + canonical_uri + 文件 hash 做增量和删除同步。网络/数据库来源沿用同一
// source 契约，后续不会再出现另一套文档身份模型。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getKnowledgeLimits } = require('./resource-limits');
const { readTypedEnv } = require('../config/env-registry');
const { isAdmin, isSuperAdmin } = require('../permissions');
const { assertSafeMcpOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const { safeJsonGet } = require('./safe-http-client');
const { resolveCredentialSecret } = require('./workflow-credentials');
const {
    executeDatabaseConnectionTool,
    getDatabaseConnectionForServerAsync
} = require('./database-mcp');
const {
    attachLegacyDocumentToProduct,
    getOrCreateProductDocumentForLegacy
} = require('./knowledge-content');
const { getApprovedKnowledgeDatabaseQueryTemplate } = require('./knowledge-database-templates');

const SUPPORTED_EXTENSIONS = new Set([
    '.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.json', '.html', '.htm'
]);

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 1) return true;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeExtensions(value) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[;,\s]+/);
    const normalized = items
        .map(item => String(item || '').trim().toLowerCase())
        .map(item => item ? (item.startsWith('.') ? item : `.${item}`) : '')
        .filter(item => SUPPORTED_EXTENSIONS.has(item));
    return normalized.length ? [...new Set(normalized)] : [...SUPPORTED_EXTENSIONS];
}

function getKnowledgeSourceRoots(env = process.env) {
    const configured = readTypedEnv('KNOWLEDGE_LOCAL_SOURCE_ROOTS', env);
    return configured
        .map(item => path.resolve(String(item || '').trim()))
        .filter(Boolean)
        .filter((item, index, all) => all.indexOf(item) === index);
}

function isPathWithinRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertKnowledgeSourcePathAllowed(rootPath, { env = process.env } = {}) {
    const resolved = path.resolve(String(rootPath || '').trim());
    const roots = getKnowledgeSourceRoots(env);
    if (!resolved || roots.length === 0 || !roots.some(root => isPathWithinRoot(resolved, root))) {
        const error = new Error('本地知识来源目录未被管理员列入 KNOWLEDGE_LOCAL_SOURCE_ROOTS 白名单。');
        error.code = 'KNOWLEDGE_SOURCE_ROOT_DENIED';
        error.status = 403;
        throw error;
    }
    return resolved;
}

function normalizeLocalDirectoryConfig(config = {}, options = {}) {
    const rootPath = assertKnowledgeSourcePathAllowed(config.rootPath || config.root_path, options);
    const maxFiles = Math.max(1, Math.min(Number.parseInt(config.maxFiles, 10) || readTypedEnv('KNOWLEDGE_SOURCE_MAX_FILES', options.env || process.env), 100000));
    return {
        rootPath,
        recursive: normalizeBool(config.recursive, true),
        extensions: normalizeExtensions(config.extensions),
        maxFiles,
        syncDeletes: normalizeBool(config.syncDeletes ?? config.sync_deletes, false)
    };
}

function normalizeSourceConfig(kind, config = {}, options = {}) {
    if (kind === 'local_dir') return normalizeLocalDirectoryConfig(config, options);
    if (kind === 'lan_http' || kind === 'internal_api') {
        const url = String(config.url || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            const error = new Error('局域网 HTTP/API 数据源必须配置 http 或 https URL。');
            error.status = 400;
            throw error;
        }
        return {
            url,
            manifestPath: String(config.manifestPath || config.manifest_path || '').trim().slice(0, 240),
            credentialRef: String(config.credentialRef || config.credential_ref || '').trim().slice(0, 64),
            credentialHeader: String(config.credentialHeader || config.credential_header || 'Authorization').trim().slice(0, 80),
            credentialPrefix: String(config.credentialPrefix || config.credential_prefix || 'Bearer').trim().slice(0, 80),
            syncDeletes: normalizeBool(config.syncDeletes ?? config.sync_deletes, false)
        };
    }
    if (kind === 'database') {
        const connectionId = String(config.connectionId || config.connection_id || '').trim().slice(0, 128);
        const queryTemplateId = normalizeId(config.queryTemplateId || config.query_template_id);
        if (!connectionId || !queryTemplateId) {
            const error = new Error('数据库知识来源必须选择只读连接和已批准的查询模板。');
            error.status = 400;
            throw error;
        }
        return { connectionId, queryTemplateId, syncDeletes: normalizeBool(config.syncDeletes ?? config.sync_deletes, false) };
    }
    return config && typeof config === 'object' ? config : {};
}

async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function walkDirectory(rootPath, config, { fsPromises = fs.promises } = {}) {
    const files = [];
    const visit = async directory => {
        if (files.length >= config.maxFiles) return;
        const entries = await fsPromises.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (files.length >= config.maxFiles) break;
            const fullPath = path.join(directory, entry.name);
            // 不跟随符号链接，防止后续扫描越出白名单根目录。
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (config.recursive) await visit(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!config.extensions.includes(ext)) continue;
            const stat = await fsPromises.stat(fullPath);
            if (stat.size > getKnowledgeLimits().uploadMaxBytes) continue;
            files.push({
                absolutePath: fullPath,
                canonicalUri: fullPath.replace(/\\/g, '/'),
                name: entry.name,
                size: stat.size,
                mtimeMs: stat.mtimeMs
            });
        }
    };
    await visit(rootPath);
    return files;
}

async function stageSourceFile(file, { fsPromises = fs.promises } = {}) {
    const stageRoot = path.join(os.tmpdir(), 'pivot-knowledge-source-stage');
    await fsPromises.mkdir(stageRoot, { recursive: true });
    const ext = path.extname(file.name).toLowerCase();
    const target = path.join(stageRoot, `${crypto.randomUUID()}${ext}`);
    await fsPromises.copyFile(file.absolutePath, target);
    return {
        path: target,
        originalname: file.name,
        mimetype: 'application/octet-stream',
        size: file.size
    };
}

async function stageSourceText({ name, content }, { fsPromises = fs.promises } = {}) {
    const stageRoot = path.join(os.tmpdir(), 'pivot-knowledge-source-stage');
    await fsPromises.mkdir(stageRoot, { recursive: true });
    const safeName = String(name || 'knowledge-source.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'knowledge-source.md';
    const target = path.join(stageRoot, `${crypto.randomUUID()}.md`);
    await fsPromises.writeFile(target, String(content || ''), 'utf8');
    const stat = await fsPromises.stat(target);
    return { path: target, originalname: safeName.endsWith('.md') ? safeName : `${safeName}.md`, mimetype: 'text/markdown', size: stat.size };
}

async function listSourceDocuments(sourceId) {
    return await query(`
        SELECT kd.*, kv.source_hash AS current_source_hash
        FROM knowledge_documents kd
        LEFT JOIN knowledge_document_versions kv ON kv.id = kd.current_version_id
        WHERE kd.source_id = ? AND kd.deleted_at IS NULL
    `, [sourceId]);
}

async function findSourceForUser(sourceId, user) {
    const source = await queryOne('SELECT * FROM knowledge_sources WHERE id = ? AND deleted_at IS NULL', [normalizeId(sourceId)]);
    if (!source) return null;
    return isSuperAdmin(user) || Number(source.user_id) === Number(user?.id) ? source : null;
}

async function listKnowledgeSourceSyncRuns(sourceId, user, { limit = 50 } = {}) {
    const source = await findSourceForUser(sourceId, user);
    if (!source) return null;
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
    const rows = await query(`
        SELECT * FROM knowledge_source_sync_runs
        WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `, [source.id, safeLimit]);
    return rows.map(row => ({
        id: Number(row.id), sourceId: Number(row.source_id), triggerType: row.trigger_type,
        status: row.status, summary: parseJson(row.summary_json, {}), errorMessage: row.error_message || '',
        startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at
    }));
}

async function attachImportedDocument({ created, source, canonicalUri }) {
    let product = await getOrCreateProductDocumentForLegacy({ legacyDocId: created.docId, userId: source.user_id });
    const existing = await queryOne(`
        SELECT * FROM knowledge_documents
        WHERE source_id = ? AND canonical_uri = ? AND deleted_at IS NULL
        ORDER BY id ASC LIMIT 1
    `, [source.id, canonicalUri]);
    if (existing && Number(existing.id) !== Number(product?.id)) {
        product = await attachLegacyDocumentToProduct({
            legacyDocId: created.docId,
            documentId: existing.id,
            sourceId: source.id,
            canonicalUri
        });
    } else if (product) {
        product = await attachLegacyDocumentToProduct({
            legacyDocId: created.docId,
            documentId: product.id,
            sourceId: source.id,
            canonicalUri
        });
    }
    return product;
}

async function importSourceItem({
    source,
    actor,
    canonicalUri,
    sourceHash,
    staged,
    existing = null,
    deps = {}
}) {
    const createDocument = deps.createKnowledgeDocumentFromUpload || require('./rag-documents').createKnowledgeDocumentFromUpload;
    const schedule = deps.scheduleKnowledgeDocumentIndexing || require('./rag-documents').scheduleKnowledgeDocumentIndexing;
    if (existing && String(existing.current_source_hash || '') === String(sourceHash || '')) return { action: 'skipped' };
    const imported = await createDocument({ userId: source.user_id, file: staged, collectionId: source.collection_id, tags: [] });
    const product = await attachImportedDocument({ created: imported, source, canonicalUri });
    const enqueueResult = await schedule({ docId: imported.docId, userId: source.user_id, user: actor, priority: 10 });
    return { action: existing ? 'changed' : 'created', queued: Boolean(enqueueResult.started), product, imported };
}

async function archiveMissingSourceDocuments(source, seenUris, { enabled = false } = {}) {
    if (!enabled) return 0;
    const existing = await listSourceDocuments(source.id);
    let archived = 0;
    const timestamp = getBeijingTimestamp();
    for (const document of existing) {
        if (seenUris.has(String(document.canonical_uri || ''))) continue;
        // 删除同步必须同时撤下 legacy 检索投影；仅标记 product 文档会让
        // knowledge_docs 继续参与 RAG，形成“已删除资料仍能回答”的泄露。
        const changedRows = await transaction(async trx => {
            const changed = await trx.execute(`
                UPDATE knowledge_documents SET lifecycle_status = 'archived', updated_at = ?
                WHERE id = ? AND source_id = ? AND deleted_at IS NULL AND lifecycle_status != 'archived'
            `, [timestamp, document.id, source.id]);
            if (Number(changed || 0) <= 0) return 0;
            await trx.execute(`
                UPDATE knowledge_document_versions
                SET status = 'archived', updated_at = ?
                WHERE document_id = ? AND status = 'published'
            `, [timestamp, document.id]);
            await trx.execute(`
                UPDATE knowledge_docs
                SET is_enabled = 0, lifecycle_status = 'archived', updated_at = ?
                WHERE product_document_id = ? AND deleted_at IS NULL
            `, [timestamp, document.id]);
            return Number(changed || 0);
        });
        if (Number(changedRows || 0) > 0) archived += 1;
    }
    return archived;
}

async function syncLocalDirectorySource(source, actor, deps = {}) {
    const config = normalizeLocalDirectoryConfig(parseJson(source.config_json), { env: deps.env || process.env });
    const fsPromises = deps.fsPromises || fs.promises;
    const files = await walkDirectory(config.rootPath, config, { fsPromises });
    const existing = await listSourceDocuments(source.id);
    const byUri = new Map(existing.map(document => [String(document.canonical_uri || ''), document]));
    const seen = new Set();
    let created = 0;
    let changed = 0;
    let skipped = 0;
    let queued = 0;
    const failures = [];

    for (const file of files) {
        seen.add(file.canonicalUri);
        const digest = await hashFile(file.absolutePath);
        const current = byUri.get(file.canonicalUri);
        if (current && String(current.current_source_hash || '') === digest) {
            skipped += 1;
            continue;
        }
        let staged = null;
        try {
            staged = await stageSourceFile(file, { fsPromises });
            const result = await importSourceItem({
                source,
                actor,
                canonicalUri: file.canonicalUri,
            sourceHash: digest,
                staged,
                existing: current,
                deps
            });
            if (result.queued) queued += 1;
            if (result.action === 'changed') changed += 1;
            if (result.action === 'created') created += 1;
        } catch (error) {
            failures.push({ path: file.canonicalUri, error: String(error.message || error).slice(0, 500) });
        } finally {
            if (staged?.path) await fsPromises.rm(staged.path, { force: true }).catch(() => {});
        }
    }

    const archived = await archiveMissingSourceDocuments(source, seen, { enabled: config.syncDeletes });
    return { kind: 'local_dir', scanned: files.length, created, changed, skipped, queued, archived, failures: failures.slice(0, 50), cursor: JSON.stringify({ scannedAt: getBeijingTimestamp(), files: files.length }) };
}

function resolveManifestUrl(config) {
    const base = new URL(config.url);
    if (!config.manifestPath) return base.toString();
    return new URL(config.manifestPath, base).toString();
}

function normalizeRemoteManifestItems(payload, sourceUrl) {
    const rawItems = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
    return rawItems.slice(0, readTypedEnv('KNOWLEDGE_SOURCE_MAX_FILES')).map((item, index) => {
        const content = String(item?.content ?? item?.text ?? '').trim();
        const title = String(item?.title ?? item?.name ?? `内网资料 ${index + 1}`).trim().slice(0, 255);
        const id = String(item?.id ?? item?.uri ?? index + 1).trim().slice(0, 300);
        const canonicalUri = String(item?.uri || `${sourceUrl}#${encodeURIComponent(id)}`).trim().slice(0, 2000);
        const downloadUrl = String(item?.url || item?.downloadUrl || item?.download_url || '').trim();
        return { title, content, downloadUrl, canonicalUri, hash: content ? crypto.createHash('sha256').update(content).digest('hex') : '' };
    }).filter(item => item.title && (item.content || item.downloadUrl) && item.canonicalUri);
}

async function stageRemoteFile(item, actor, deps = {}) {
    if (item.content) {
        const staged = await stageSourceText({ name: item.title, content: item.content });
        return { staged, hash: item.hash };
    }
    const get = deps.safeJsonGet || safeJsonGet;
    await assertSafeMcpOutboundUrl(item.downloadUrl, actor);
    const response = await get(item.downloadUrl, {
        user: actor,
        assertUrl: assertSafeMcpOutboundUrl,
        createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true }),
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: getKnowledgeLimits().uploadMaxBytes,
        maxBodyLength: getKnowledgeLimits().uploadMaxBytes,
        validateStatus: status => status >= 200 && status < 300
    });
    const bytes = Buffer.from(response.data || []);
    if (!bytes.length || bytes.length > getKnowledgeLimits().uploadMaxBytes) throw new Error('内网文件下载为空或超过知识库文件大小上限。');
    const ext = path.extname(new URL(item.downloadUrl).pathname).toLowerCase();
    const safeExt = SUPPORTED_EXTENSIONS.has(ext) ? ext : '.bin';
    if (!SUPPORTED_EXTENSIONS.has(safeExt)) throw new Error('内网下载文件格式不受支持。');
    const stageRoot = path.join(os.tmpdir(), 'pivot-knowledge-source-stage');
    await fs.promises.mkdir(stageRoot, { recursive: true });
    const target = path.join(stageRoot, `${crypto.randomUUID()}${safeExt}`);
    await fs.promises.writeFile(target, bytes);
    return {
        staged: {
            path: target,
            originalname: item.title.endsWith(safeExt) ? item.title : `${item.title}${safeExt}`,
            mimetype: 'application/octet-stream',
            size: bytes.length
        },
        hash: crypto.createHash('sha256').update(bytes).digest('hex')
    };
}

async function syncHttpManifestSource(source, actor, deps = {}) {
    const config = normalizeSourceConfig(source.kind, parseJson(source.config_json));
    await assertSafeMcpOutboundUrl(config.url, actor);
    const cursor = parseJson(source.sync_cursor, {});
    const headers = cursor.etag ? { 'If-None-Match': String(cursor.etag).slice(0, 500) } : {};
    if (config.credentialRef) {
        const credential = await resolveCredentialSecret(config.credentialRef, actor);
        if (!credential) {
            const error = new Error('指定的数据源凭据引用不存在或无权使用。');
            error.status = 403;
            throw error;
        }
        headers[config.credentialHeader || 'Authorization'] = `${config.credentialPrefix ? `${config.credentialPrefix} ` : ''}${credential.value}`.trim();
    }
    const url = resolveManifestUrl(config);
    const get = deps.safeJsonGet || safeJsonGet;
    const response = await get(url, {
        user: actor,
        assertUrl: assertSafeMcpOutboundUrl,
        createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true }),
        headers,
        timeout: 30000,
        maxContentLength: 16 * 1024 * 1024,
        validateStatus: status => (status >= 200 && status < 300) || status === 304
    });
    if (response.status === 304) {
        return { kind: source.kind, scanned: 0, created: 0, changed: 0, skipped: 0, queued: 0, archived: 0, failures: [], cursor: JSON.stringify({ ...cursor, syncedAt: getBeijingTimestamp(), notModified: true }) };
    }
    const items = normalizeRemoteManifestItems(response.data, url);
    const existing = new Map((await listSourceDocuments(source.id)).map(document => [String(document.canonical_uri || ''), document]));
    const seen = new Set();
    const stats = { kind: source.kind, scanned: items.length, created: 0, changed: 0, skipped: 0, queued: 0, archived: 0, failures: [] };
    for (const item of items) {
        seen.add(item.canonicalUri);
        let staged = null;
        try {
            const remote = await stageRemoteFile(item, actor, deps);
            staged = remote.staged;
            const result = await importSourceItem({ source, actor, canonicalUri: item.canonicalUri, sourceHash: remote.hash, staged, existing: existing.get(item.canonicalUri), deps });
            if (result.action === 'created') stats.created += 1;
            if (result.action === 'changed') stats.changed += 1;
            if (result.action === 'skipped') stats.skipped += 1;
            if (result.queued) stats.queued += 1;
        } catch (error) {
            stats.failures.push({ path: item.canonicalUri, error: String(error.message || error).slice(0, 500) });
        } finally {
            if (staged?.path) await fs.promises.rm(staged.path, { force: true }).catch(() => {});
        }
    }
    stats.archived = await archiveMissingSourceDocuments(source, seen, { enabled: normalizeBool(config.syncDeletes, false) });
    stats.cursor = JSON.stringify({ syncedAt: getBeijingTimestamp(), items: items.length, etag: String(response.headers?.etag || '').slice(0, 500), target: new URL(url).origin });
    return stats;
}

async function syncDatabaseSource(source, actor, deps = {}) {
    if (!isAdmin(actor)) {
        const error = new Error('数据库知识来源仅管理员可执行同步。');
        error.status = 403;
        throw error;
    }
    const config = normalizeSourceConfig('database', parseJson(source.config_json));
    const connectionId = config.connectionId;
    const queryTemplate = await getApprovedKnowledgeDatabaseQueryTemplate(config.queryTemplateId, connectionId);
    if (!queryTemplate) {
        const error = new Error('数据库知识来源引用的查询模板不存在、未批准或已停用。');
        error.status = 409;
        error.code = 'KNOWLEDGE_DATABASE_TEMPLATE_UNAVAILABLE';
        throw error;
    }
    const server = await queryOne("SELECT id, user_id FROM mcp_servers WHERE id = ? AND status != 'deleted'", [connectionId]);
    if (!server || (!isSuperAdmin(actor) && Number(server.user_id) !== Number(actor.id))) {
        const error = new Error('数据库连接不存在或无权作为知识来源。');
        error.status = 404;
        throw error;
    }
    const connection = await getDatabaseConnectionForServerAsync(connectionId, { includeSecret: true });
    if (!connection) throw new Error('数据库连接配置不存在。');
    const executeTool = deps.executeDatabaseConnectionTool || executeDatabaseConnectionTool;
    const result = await executeTool(connection, 'db.run_readonly_query', { sql: queryTemplate.sql, limit: 1000 });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const items = rows.map((row, index) => {
        const title = String(row?.[queryTemplate.titleField] || `数据库资料 ${index + 1}`).trim().slice(0, 255);
        const content = String(row?.[queryTemplate.contentField] ?? '').trim();
        const watermark = String(row?.[queryTemplate.watermarkField] ?? '');
        const canonicalUri = `db://${encodeURIComponent(connectionId)}/${encodeURIComponent(String(row?.id ?? index + 1))}`;
        return { title, content, canonicalUri, hash: crypto.createHash('sha256').update(`${watermark}\n${content}`).digest('hex') };
    }).filter(item => item.title && item.content);
    const existing = new Map((await listSourceDocuments(source.id)).map(document => [String(document.canonical_uri || ''), document]));
    const seen = new Set();
    const stats = { kind: 'database', scanned: items.length, created: 0, changed: 0, skipped: 0, queued: 0, archived: 0, failures: [] };
    for (const item of items) {
        seen.add(item.canonicalUri);
        let staged = null;
        try {
            staged = await stageSourceText({ name: item.title, content: item.content });
            const imported = await importSourceItem({ source, actor, canonicalUri: item.canonicalUri, sourceHash: item.hash, staged, existing: existing.get(item.canonicalUri), deps });
            if (imported.action === 'created') stats.created += 1;
            if (imported.action === 'changed') stats.changed += 1;
            if (imported.action === 'skipped') stats.skipped += 1;
            if (imported.queued) stats.queued += 1;
        } catch (error) {
            stats.failures.push({ path: item.canonicalUri, error: String(error.message || error).slice(0, 500) });
        } finally {
            if (staged?.path) await fs.promises.rm(staged.path, { force: true }).catch(() => {});
        }
    }
    stats.archived = await archiveMissingSourceDocuments(source, seen, { enabled: normalizeBool(config.syncDeletes, false) });
    stats.cursor = JSON.stringify({ syncedAt: getBeijingTimestamp(), rows: items.length, queryTemplateId: queryTemplate.id });
    return stats;
}

async function syncKnowledgeSource({ sourceId, user, triggerType = 'manual', deps = {} }) {
    const source = await findSourceForUser(sourceId, user);
    if (!source) return null;
    if (source.status !== 'active') {
        const error = new Error('数据源当前未启用。');
        error.status = 409;
        throw error;
    }
    const timestamp = getBeijingTimestamp();
    const running = await queryOne(`
        SELECT id FROM knowledge_source_sync_runs
        WHERE source_id = ? AND status = 'running'
        ORDER BY id DESC LIMIT 1
    `, [source.id]);
    if (running) {
        const error = new Error('该数据源已有同步任务正在运行。');
        error.status = 409;
        error.code = 'KNOWLEDGE_SOURCE_SYNC_RUNNING';
        throw error;
    }
    const run = await queryOne(`
        INSERT INTO knowledge_source_sync_runs (
            source_id, initiated_by_user, trigger_type, status, summary_json, started_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'running', '{}', ?, ?, ?) RETURNING *
    `, [source.id, user?.id || null, String(triggerType || 'manual').slice(0, 32), timestamp, timestamp, timestamp]);
    try {
        let result;
        if (source.kind === 'local_dir') result = await syncLocalDirectorySource(source, user, deps);
        else if (source.kind === 'lan_http' || source.kind === 'internal_api') result = await syncHttpManifestSource(source, user, deps);
        else if (source.kind === 'database') result = await syncDatabaseSource(source, user, deps);
        else {
            const error = new Error(`数据源类型 ${source.kind} 不支持主动同步。`);
            error.code = 'KNOWLEDGE_SOURCE_EXECUTOR_UNAVAILABLE';
            error.status = 409;
            throw error;
        }
        await execute(`
            UPDATE knowledge_sources
            SET sync_cursor = ?, last_sync_at = ?, last_error = '', updated_at = ? WHERE id = ?
        `, [result.cursor || '', timestamp, timestamp, source.id]);
        await execute(`
            UPDATE knowledge_source_sync_runs
            SET status = 'completed', summary_json = ?, completed_at = ?, updated_at = ? WHERE id = ?
        `, [JSON.stringify(result), getBeijingTimestamp(), getBeijingTimestamp(), run.id]);
        return { sourceId: Number(source.id), runId: Number(run.id), ...result };
    } catch (error) {
        await execute(`
            UPDATE knowledge_sources SET last_error = ?, updated_at = ? WHERE id = ?
        `, [String(error.message || error).slice(0, 1500), timestamp, source.id]);
        await execute(`
            UPDATE knowledge_source_sync_runs
            SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?
        `, [String(error.message || error).slice(0, 1500), getBeijingTimestamp(), getBeijingTimestamp(), run.id]).catch(() => {});
        throw error;
    }
}

async function syncScheduledKnowledgeSources({ limit = 20, deps = {} } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 100));
    const rows = await query(`
        SELECT source.id, owner.id AS user_id, owner.username, owner.role, owner.unit
        FROM knowledge_sources source
        JOIN users owner ON owner.id = source.user_id AND owner.deleted_at IS NULL
        WHERE source.deleted_at IS NULL AND source.status = 'active'
          AND source.sync_mode IN ('scheduled', 'watch')
          AND source.kind IN ('local_dir', 'lan_http', 'internal_api', 'database')
        ORDER BY COALESCE(source.last_sync_at, source.created_at) ASC, source.id ASC
        LIMIT ?
    `, [safeLimit]);
    let started = 0;
    let skipped = 0;
    const failures = [];
    for (const row of rows) {
        try {
            await syncKnowledgeSource({
                sourceId: row.id,
                user: { id: row.user_id, username: row.username, role: row.role, unit: row.unit },
                triggerType: 'scheduled',
                deps
            });
            started += 1;
        } catch (error) {
            if (error?.code === 'KNOWLEDGE_SOURCE_SYNC_RUNNING') skipped += 1;
            else failures.push({ sourceId: Number(row.id), error: String(error.message || error).slice(0, 500) });
        }
    }
    return { scanned: rows.length, started, skipped, failures };
}

function createKnowledgeSourceSyncScheduler({
    intervalMs = readTypedEnv('KNOWLEDGE_SOURCE_SCHEDULE_INTERVAL_MS'),
    sync = syncScheduledKnowledgeSources,
    logger = require('../logger').logger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
} = {}) {
    let timer = null;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const result = await sync();
            if (Number(result.started || 0) > 0 || Number(result.failures?.length || 0) > 0) {
                logger.info({ ...result, failures: result.failures?.length || 0 }, '知识库局域网来源同步轮询完成');
            }
        } catch (error) {
            logger.warn({ err: error.message }, '知识库局域网来源同步轮询失败');
        } finally {
            running = false;
        }
    };
    return {
        async start() {
            if (timer) return;
            await tick();
            timer = setIntervalFn(() => { void tick(); }, Math.max(10000, Number(intervalMs) || 300000));
            timer?.unref?.();
        },
        stop() {
            if (timer) clearIntervalFn(timer);
            timer = null;
        },
        tick
    };
}

module.exports = {
    assertKnowledgeSourcePathAllowed,
    listKnowledgeSourceSyncRuns,
    normalizeLocalDirectoryConfig,
    normalizeSourceConfig,
    syncKnowledgeSource,
    createKnowledgeSourceSyncScheduler,
    archiveMissingSourceDocuments,
    walkDirectory
};
