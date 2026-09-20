'use strict';

/**
 * Immutable MCP tool catalog releases.
 *
 * The legacy `mcp_tool_cache` remains a compatibility projection. This module
 * owns the durable source-of-truth snapshot and deliberately validates a whole
 * refresh before changing the active release, so a malformed remote tools/list
 * response can never erase a working catalog.
 */
const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeToolContract } = require('./agent-contracts');
const { normalizeJsonSchema, validateJsonSchemaDefinition } = require('./agent-dag-contracts');

const MAX_TOOL_COUNT = 2_000;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_DESCRIPTION_LENGTH = 8_000;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

class ToolCatalogValidationError extends Error {
    constructor(message, details = []) {
        super(message);
        this.name = 'ToolCatalogValidationError';
        this.code = 'TOOL_CATALOG_VALIDATION_FAILED';
        this.status = 400;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
    }, {});
}

function canonicalJson(value) {
    return JSON.stringify(stableValue(value === undefined ? null : value));
}

function digest(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function plainObject(value, fallback = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function cleanText(value, limit) {
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, limit);
}

function normalizeAnnotations(raw = {}) {
    const annotations = plainObject(raw.annotations || raw.toolAnnotations || raw.tool_annotations);
    const pick = (...keys) => keys.find(key => annotations[key] !== undefined || raw[key] !== undefined);
    const boolean = (...keys) => {
        const key = pick(...keys);
        return key ? Boolean(annotations[key] ?? raw[key]) : false;
    };
    return {
        title: cleanText(annotations.title || raw.title || '', 255),
        readOnlyHint: boolean('readOnlyHint', 'read_only_hint'),
        destructiveHint: boolean('destructiveHint', 'destructive_hint'),
        idempotentHint: boolean('idempotentHint', 'idempotent_hint'),
        openWorldHint: boolean('openWorldHint', 'open_world_hint')
    };
}

function normalizedSchema(raw, field, issues, toolName) {
    const source = raw[field] ?? raw[field === 'input_schema' ? 'inputSchema' : 'outputSchema'];
    if (source === undefined || source === null || source === '') return {};
    const schema = normalizeJsonSchema(source);
    const bytes = Buffer.byteLength(canonicalJson(schema), 'utf8');
    if (bytes > MAX_SCHEMA_BYTES) issues.push(`${toolName}.${field} 超过 ${MAX_SCHEMA_BYTES} 字节限制。`);
    validateJsonSchemaDefinition(schema, `${toolName}.${field}`, issues);
    return schema;
}

function riskName(value) {
    const number = Number(value);
    if (number >= 5) return 'critical';
    if (number >= 4) return 'high';
    if (number >= 2) return 'medium';
    return 'low';
}

function normalizeCatalogTool(raw = {}, { serverId, serverName = '' } = {}) {
    const toolName = String(raw.name || '').trim();
    const issues = [];
    if (!TOOL_NAME_RE.test(toolName)) issues.push(`${toolName || '未命名工具'} 的名称不符合 MCP 工具命名规范。`);
    const description = cleanText(raw.description, MAX_DESCRIPTION_LENGTH);
    if (!description) issues.push(`${toolName || '未命名工具'} 缺少描述。`);
    const inputSchema = normalizedSchema(raw, 'input_schema', issues, toolName || '未命名工具');
    const outputSchema = normalizedSchema(raw, 'output_schema', issues, toolName || '未命名工具');
    if (Object.keys(inputSchema).length && inputSchema.type && inputSchema.type !== 'object') {
        issues.push(`${toolName} 的 input_schema 根类型必须为 object。`);
    }
    if (issues.length) throw new ToolCatalogValidationError(`工具 ${toolName || '-'} 契约无效。`, issues);
    const annotations = normalizeAnnotations(raw);
    const contract = normalizeToolContract({
        ...raw,
        name: `mcp.${serverId}.${toolName}`,
        title: annotations.title || raw.title || toolName,
        description,
        input_schema: inputSchema,
        output_schema: outputSchema,
        source: 'mcp',
        side_effect: raw.side_effect ?? raw.sideEffect ?? annotations.destructiveHint,
        idempotent: raw.idempotent ?? annotations.idempotentHint,
        network: raw.network ?? annotations.openWorldHint
    });
    const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.map(item => String(item || '').trim()).filter(Boolean) : contract.capabilities;
    const examples = Array.isArray(raw.examples) ? raw.examples.slice(0, 20) : [];
    const tags = Array.isArray(raw.tags) ? raw.tags.map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, 30) : [];
    const authScopes = Array.isArray(raw.authScopes || raw.auth_scopes)
        ? (raw.authScopes || raw.auth_scopes).map(scope => cleanText(scope, 160)).filter(Boolean).slice(0, 100)
        : [];
    const normalized = {
        serverId: Number(serverId),
        toolName,
        fullName: `mcp.${serverId}.${toolName}`,
        title: cleanText(annotations.title || raw.title || toolName, 255),
        description,
        inputSchema,
        outputSchema,
        annotations,
        capabilities,
        riskLevel: riskName(contract.risk_level),
        sideEffect: Boolean(contract.side_effect),
        idempotent: Boolean(contract.idempotent),
        cacheable: Boolean(contract.cacheable),
        cancellable: Boolean(contract.cancellable),
        concurrency: contract.concurrency,
        timeout: contract.timeout,
        authScopes,
        dataClassification: cleanText(raw.dataClassification || raw.data_classification || 'internal', 64) || 'internal',
        examples,
        tags,
        serverName: cleanText(serverName, 255)
    };
    normalized.definitionDigest = digest({
        toolName: normalized.toolName,
        inputSchema: normalized.inputSchema,
        outputSchema: normalized.outputSchema,
        annotations: normalized.annotations,
        capabilities: normalized.capabilities,
        riskLevel: normalized.riskLevel,
        sideEffect: normalized.sideEffect,
        idempotent: normalized.idempotent,
        cacheable: normalized.cacheable,
        cancellable: normalized.cancellable,
        concurrency: normalized.concurrency,
        timeout: normalized.timeout,
        authScopes: normalized.authScopes,
        dataClassification: normalized.dataClassification,
        description: normalized.description
    });
    return normalized;
}

function normalizeCatalogTools(tools = [], options = {}) {
    if (!Array.isArray(tools)) throw new ToolCatalogValidationError('tools/list 返回的 tools 必须是数组。');
    if (tools.length > MAX_TOOL_COUNT) throw new ToolCatalogValidationError(`单个服务最多允许 ${MAX_TOOL_COUNT} 个工具。`);
    const seen = new Set();
    const normalized = tools.map(item => {
        const tool = normalizeCatalogTool(item, options);
        if (seen.has(tool.toolName)) throw new ToolCatalogValidationError(`tools/list 返回了重复工具：${tool.toolName}`);
        seen.add(tool.toolName);
        return tool;
    });
    return normalized.sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function schemaTypes(schema = {}) {
    const raw = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
    return new Set(raw.map(item => String(item || '')).filter(Boolean));
}

function schemaNarrowed(previous = {}, next = {}, path = '$', changes = []) {
    const oldTypes = schemaTypes(previous);
    const nextTypes = schemaTypes(next);
    if (oldTypes.size && nextTypes.size && [...oldTypes].some(type => !nextTypes.has(type))) {
        changes.push(`${path}.type`);
    }
    if (Array.isArray(previous.enum) && Array.isArray(next.enum)
        && previous.enum.some(value => !next.enum.some(candidate => canonicalJson(candidate) === canonicalJson(value)))) {
        changes.push(`${path}.enum`);
    }
    if (!Array.isArray(previous.enum) && Array.isArray(next.enum)) changes.push(`${path}.enum`);
    const boundaries = [['minLength', (oldValue, newValue) => newValue > oldValue], ['maxLength', (oldValue, newValue) => newValue < oldValue], ['minimum', (oldValue, newValue) => newValue > oldValue], ['maximum', (oldValue, newValue) => newValue < oldValue], ['minItems', (oldValue, newValue) => newValue > oldValue], ['maxItems', (oldValue, newValue) => newValue < oldValue]];
    boundaries.forEach(([key, narrowed]) => {
        if (Number.isFinite(Number(previous[key])) && Number.isFinite(Number(next[key])) && narrowed(Number(previous[key]), Number(next[key]))) changes.push(`${path}.${key}`);
        if (previous[key] === undefined && next[key] !== undefined && ['maxLength', 'maximum', 'maxItems'].includes(key)) changes.push(`${path}.${key}`);
    });
    const previousRequired = new Set(Array.isArray(previous.required) ? previous.required : []);
    const nextRequired = new Set(Array.isArray(next.required) ? next.required : []);
    [...nextRequired].filter(key => !previousRequired.has(key)).forEach(key => changes.push(`${path}.required.${key}`));
    const oldProperties = plainObject(previous.properties);
    const nextProperties = plainObject(next.properties);
    Object.keys(oldProperties).filter(key => Object.prototype.hasOwnProperty.call(nextProperties, key)).forEach(key => {
        schemaNarrowed(oldProperties[key], nextProperties[key], `${path}.properties.${key}`, changes);
    });
    if (previous.additionalProperties !== false && next.additionalProperties === false) changes.push(`${path}.additionalProperties`);
    if (previous.items && next.items) schemaNarrowed(previous.items, next.items, `${path}.items`, changes);
    return changes;
}

function compareCatalogReleases(previousItems = [], nextItems = []) {
    const previous = new Map((previousItems || []).map(item => [item.toolName || item.tool_name, item]));
    const next = new Map((nextItems || []).map(item => [item.toolName || item.tool_name, item]));
    const changes = [];
    for (const [name, oldTool] of previous) {
        const newTool = next.get(name);
        if (!newTool) {
            changes.push({ toolName: name, kind: 'removed', breaking: true, detail: '工具被移除。' });
            continue;
        }
        const inputChanges = schemaNarrowed(oldTool.inputSchema || parseJson(oldTool.input_schema, {}), newTool.inputSchema || parseJson(newTool.input_schema, {}));
        if (inputChanges.length) changes.push({ toolName: name, kind: 'input_breaking', breaking: true, detail: inputChanges });
        const oldOutput = oldTool.outputSchema || parseJson(oldTool.output_schema, {});
        const newOutput = newTool.outputSchema || parseJson(newTool.output_schema, {});
        if (canonicalJson(oldOutput) !== canonicalJson(newOutput)) changes.push({ toolName: name, kind: 'output_breaking', breaking: true, detail: '输出契约发生变化。' });
        if (!inputChanges.length && canonicalJson(oldOutput) === canonicalJson(newOutput)
            && String(oldTool.definitionDigest || oldTool.definition_digest || '') !== String(newTool.definitionDigest || newTool.definition_digest || '')) {
            changes.push({ toolName: name, kind: 'compatible', breaking: false, detail: '展示或非破坏性契约信息发生变化。' });
        }
    }
    for (const [name] of next) {
        if (!previous.has(name)) changes.push({ toolName: name, kind: 'new', breaking: false, detail: '新增工具。' });
    }
    return {
        breaking: changes.some(change => change.breaking),
        changes,
        added: changes.filter(change => change.kind === 'new').length,
        removed: changes.filter(change => change.kind === 'removed').length,
        inputBreaking: changes.filter(change => change.kind === 'input_breaking').length,
        outputBreaking: changes.filter(change => change.kind === 'output_breaking').length
    };
}

function mapCatalogRow(row = {}) {
    return {
        ...row,
        inputSchema: parseJson(row.input_schema, {}),
        outputSchema: parseJson(row.output_schema, {}),
        annotations: parseJson(row.annotations, {}),
        capabilities: parseJson(row.capabilities, []),
        authScopes: parseJson(row.auth_scopes, []),
        examples: parseJson(row.examples, []),
        tags: parseJson(row.tags, []),
        timeout: {
            default_seconds: Number(row.timeout_default_seconds || 30),
            max_seconds: Number(row.timeout_max_seconds || 120)
        },
        definitionDigest: String(row.definition_digest || '')
    };
}

function databaseApi(executor) {
    return {
        one: (...args) => executor.queryOne(...args),
        many: (...args) => executor.query(...args),
        mutate: (...args) => executor.execute(...args)
    };
}

function createToolCatalogReleaseStore(deps = {}) {
    const read = deps.query || query;
    const readOne = deps.queryOne || queryOne;
    const transact = deps.transaction || transaction;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;

    async function activeRelease(serverId, executor = { queryOne: readOne }) {
        return databaseApi(executor).one(`
            SELECT * FROM tool_catalog_releases
            WHERE server_id = ? AND status = 'active'
            ORDER BY published_at DESC NULLS LAST, id DESC LIMIT 1
        `, [serverId]);
    }

    async function releaseItems(releaseId, executor = { query: read }) {
        const rows = await databaseApi(executor).many('SELECT * FROM tool_catalog_items WHERE release_id = ? ORDER BY tool_name ASC', [releaseId]);
        return rows.map(mapCatalogRow);
    }

    async function projectReleaseToLegacyCache(releaseId, serverId, executor) {
        const db = databaseApi(executor);
        const items = await releaseItems(releaseId, executor);
        await db.mutate('DELETE FROM mcp_tool_cache WHERE server_id = ?', [serverId]);
        for (const item of items) {
            await db.mutate(`
                INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
                VALUES (?, ?, ?, ?, ?)
            `, [
                serverId,
                String(item.tool_name || item.toolName || ''),
                String(item.description || ''),
                JSON.stringify(item.inputSchema || item.input_schema || { type: 'object' }),
                now()
            ]);
        }
        return items.length;
    }

    async function syncItemAliases(item, executor) {
        const db = databaseApi(executor);
        const values = [
            ['legacy_name', item.toolName],
            ['display', item.title],
            ...((item.tags || []).map(tag => ['search', tag]))
        ].map(([type, alias]) => ({ type, alias: String(alias || '').trim().slice(0, 320) }))
            .filter(item => item.alias);
        for (const alias of values) {
            await db.mutate(`
                INSERT INTO tool_catalog_aliases (server_id, tool_item_id, alias, alias_type, migration_message, created_at)
                VALUES (?, ?, ?, ?, '', ?)
                ON CONFLICT(server_id, alias) DO UPDATE SET
                    tool_item_id = excluded.tool_item_id, alias_type = excluded.alias_type, migration_message = ''
            `, [item.serverId, item.id, alias.alias, alias.type, now()]);
        }
    }

    async function capture({ server, tools, protocolVersion = '', sourceEtag = '', sourceLastModified = '', fetchDurationMs = 0, conformanceStatus = 'not_run', user = null } = {}) {
        const serverId = Number(server?.id || server?.server_id || 0);
        if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new ToolCatalogValidationError('工具目录快照必须关联有效的 MCP 服务。');
        const normalizedTools = normalizeCatalogTools(tools, { serverId, serverName: server?.name || server?.server_name || '' });
        const sourceDigest = digest(normalizedTools.map(item => ({ toolName: item.toolName, definitionDigest: item.definitionDigest })));
        const releaseVersion = `sha256-${sourceDigest.slice(0, 24)}`;
        return transact(async trx => {
            const db = databaseApi(trx);
            const existing = await db.one('SELECT * FROM tool_catalog_releases WHERE server_id = ? AND source_digest = ? ORDER BY id DESC LIMIT 1', [serverId, sourceDigest]);
            if (existing) return { release: existing, items: await releaseItems(existing.id, trx), existing: true, activated: existing.status === 'active', comparison: parseJson(existing.compatibility_summary, {}) };
            const active = await activeRelease(serverId, trx);
            const previousItems = active ? await releaseItems(active.id, trx) : [];
            const comparison = compareCatalogReleases(previousItems, normalizedTools);
            const nextStatus = active && comparison.breaking ? 'pending_review' : 'active';
            if (nextStatus === 'active' && active) {
                await db.mutate("UPDATE tool_catalog_releases SET status = 'superseded' WHERE id = ?", [active.id]);
            }
            const release = await db.one(`
                INSERT INTO tool_catalog_releases (
                    server_id, release_version, protocol_version, source_etag, source_last_modified,
                    source_digest, fetched_at, published_at, status, fetch_duration_ms, tool_count,
                    conformance_status, compatibility_summary, created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
                RETURNING *
            `, [
                serverId, releaseVersion, String(protocolVersion || '').slice(0, 64), String(sourceEtag || '').slice(0, 512), String(sourceLastModified || '').slice(0, 256),
                sourceDigest, now(), nextStatus === 'active' ? now() : null, nextStatus, Math.max(Number(fetchDurationMs) || 0, 0), normalizedTools.length,
                String(conformanceStatus || 'not_run').slice(0, 32), JSON.stringify(comparison), user?.id || null, now()
            ]);
            for (const item of normalizedTools) {
                await db.mutate(`
                    INSERT INTO tool_catalog_items (
                        release_id, server_id, tool_name, full_name, title, description, input_schema, output_schema,
                        annotations, capabilities, risk_level, side_effect, idempotent, cacheable, cancellable,
                        concurrency, timeout_default_seconds, timeout_max_seconds, auth_scopes, data_classification,
                        examples, tags, definition_digest, compatibility_level, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?::jsonb, ?, ?, 'active', ?)
                `, [
                    release.id, serverId, item.toolName, item.fullName, item.title, item.description,
                    JSON.stringify(item.inputSchema), JSON.stringify(item.outputSchema), JSON.stringify(item.annotations), JSON.stringify(item.capabilities),
                    item.riskLevel, item.sideEffect, item.idempotent, item.cacheable, item.cancellable, item.concurrency,
                    item.timeout.default_seconds, item.timeout.max_seconds, JSON.stringify(item.authScopes), item.dataClassification,
                    JSON.stringify(item.examples), JSON.stringify(item.tags), item.definitionDigest,
                    comparison.changes.find(change => change.toolName === item.toolName)?.kind || 'new', now()
                ]);
                const persisted = await db.one('SELECT id FROM tool_catalog_items WHERE release_id = ? AND tool_name = ?', [release.id, item.toolName]);
                if (persisted?.id) await syncItemAliases({ ...item, id: persisted.id }, trx);
            }
            const items = await releaseItems(release.id, trx);
            let staleWorkflowReleaseIds = [];
            if (nextStatus === 'active') {
                try {
                    const { markWorkflowToolDependenciesStale } = require('./workflow-tool-releases');
                    staleWorkflowReleaseIds = await markWorkflowToolDependenciesStale(serverId, release.id, { query: trx.query, execute: trx.execute, getBeijingTimestamp: now });
                } catch (_) {
                    // Catalog activation remains valid even when a historical deployment has
                    // not yet received the workflow-release stale columns. Migration and
                    // operational retries will reconcile the marker afterwards.
                }
            }
            return { release, items, existing: false, activated: nextStatus === 'active', comparison, staleWorkflowReleaseIds };
        });
    }

    async function list(serverId, options = {}) {
        const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 200);
        return await read(`
            SELECT * FROM tool_catalog_releases WHERE server_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?
        `, [serverId, limit]);
    }

    async function get(releaseId, serverId = null) {
        const id = Number(releaseId);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        return serverId === null || serverId === undefined
            ? await readOne('SELECT * FROM tool_catalog_releases WHERE id = ?', [id])
            : await readOne('SELECT * FROM tool_catalog_releases WHERE id = ? AND server_id = ?', [id, serverId]);
    }

    async function activate(serverId, releaseId, user = null) {
        return transact(async trx => {
            const db = databaseApi(trx);
            const target = await db.one('SELECT * FROM tool_catalog_releases WHERE id = ? AND server_id = ?', [releaseId, serverId]);
            if (!target || ['blocked', 'rolled_back'].includes(target.status)) {
                const error = new Error('目标工具目录版本不存在或不可激活。');
                error.status = 404;
                throw error;
            }
            await db.mutate("UPDATE tool_catalog_releases SET status = CASE WHEN id = ? THEN 'active' ELSE 'superseded' END WHERE server_id = ? AND status = 'active'", [releaseId, serverId]);
            await db.mutate("UPDATE tool_catalog_releases SET status = 'active', published_at = COALESCE(published_at, ?), created_by = COALESCE(created_by, ?) WHERE id = ?", [now(), user?.id || null, releaseId]);
            await projectReleaseToLegacyCache(releaseId, serverId, trx);
            const release = await db.one('SELECT * FROM tool_catalog_releases WHERE id = ?', [releaseId]);
            try {
                const { markWorkflowToolDependenciesStale } = require('./workflow-tool-releases');
                release.staleWorkflowReleaseIds = await markWorkflowToolDependenciesStale(serverId, releaseId, { query: trx.query, execute: trx.execute, getBeijingTimestamp: now });
            } catch (_) {
                release.staleWorkflowReleaseIds = [];
            }
            return release;
        });
    }

    return { activeRelease, activate, capture, get, list, projectReleaseToLegacyCache, releaseItems, syncItemAliases };
}

const defaultStore = createToolCatalogReleaseStore();

module.exports = {
    ToolCatalogValidationError,
    compareCatalogReleases,
    digest,
    normalizeCatalogTools,
    ...defaultStore
};
