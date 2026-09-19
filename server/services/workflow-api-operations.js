'use strict';

const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeJsonSchema } = require('./agent-dag-contracts');
const { normalizeSlug } = require('./workflow-credentials');

const MAX_OPENAPI_BYTES = 1024 * 1024;
const MAX_OPERATIONS_PER_IMPORT = 50;
const SUPPORTED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SUPPORTED_SCHEMA_KEYS = new Set([
    'type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties', 'description', 'title', 'pattern'
]);

function invalid(message, code = 'WORKFLOW_API_OPERATION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function parseDocument(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const text = String(value || '').trim();
    if (!text) throw invalid('请提供 OpenAPI 3 JSON 文档。', 'OPENAPI_DOCUMENT_REQUIRED');
    if (Buffer.byteLength(text, 'utf8') > MAX_OPENAPI_BYTES) throw invalid('OpenAPI 文档超过 1MB 上限。', 'OPENAPI_DOCUMENT_TOO_LARGE', 413);
    try { return JSON.parse(text); } catch (_) { throw invalid('OpenAPI 文档必须是合法 JSON。', 'OPENAPI_DOCUMENT_JSON_INVALID'); }
}

function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('{') || raw.includes('}')) throw invalid('请提供不含变量占位符的 HTTPS 或 HTTP 服务地址。', 'OPENAPI_BASE_URL_INVALID');
    let url;
    try { url = new URL(raw); } catch (_) { throw invalid('OpenAPI 服务地址无效。', 'OPENAPI_BASE_URL_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw invalid('OpenAPI 服务地址只能使用不含账号和片段的 HTTP 或 HTTPS 地址。', 'OPENAPI_BASE_URL_INVALID');
    }
    return url.toString().replace(/\/$/, '');
}

function normalizeName(value, fallback = 'API 操作') {
    const name = String(value || fallback).trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!name) throw invalid('API 操作名称不能为空。', 'OPENAPI_OPERATION_NAME_REQUIRED');
    return name;
}

function normalizeOperationId(value, fallback) {
    return String(value || fallback || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160);
}

function schemaWithoutReferences(schema, path = 'Schema', depth = 0) {
    if (schema === undefined || schema === null) return {};
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw invalid(`${path} 必须是对象。`, 'OPENAPI_SCHEMA_INVALID');
    if (depth > 12) throw invalid(`${path} 层级超过 12 层。`, 'OPENAPI_SCHEMA_TOO_DEEP');
    if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.not) {
        throw invalid(`${path} 暂不支持 $ref、allOf、anyOf、oneOf 或 not。请在导入前展开为内联 Schema。`, 'OPENAPI_SCHEMA_UNSUPPORTED');
    }
    const result = {};
    Object.entries(schema).forEach(([key, value]) => {
        if (!SUPPORTED_SCHEMA_KEYS.has(key)) return;
        if (key === 'properties') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${path}.properties 必须是对象。`, 'OPENAPI_SCHEMA_INVALID');
            result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaWithoutReferences(child, `${path}.properties.${name}`, depth + 1)]));
        } else if (key === 'items') {
            result.items = schemaWithoutReferences(value, `${path}.items`, depth + 1);
        } else if (key === 'type' && Array.isArray(value)) {
            result.type = value.filter(item => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(item))).slice(0, 4);
        } else {
            result[key] = value;
        }
    });
    return normalizeJsonSchema(result);
}

function normalizeParameter(parameter, pathTemplate) {
    if (!parameter || typeof parameter !== 'object' || parameter.$ref) throw invalid('参数必须是内联定义，暂不支持 $ref。', 'OPENAPI_PARAMETER_UNSUPPORTED');
    const name = String(parameter.name || '').trim();
    const location = String(parameter.in || '').trim().toLowerCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) || !['path', 'query'].includes(location)) {
        throw invalid('仅支持名称为字母、数字或下划线的 path/query 参数。', 'OPENAPI_PARAMETER_UNSUPPORTED');
    }
    if (location === 'path' && !pathTemplate.includes(`{${name}}`)) throw invalid(`路径参数 ${name} 未出现在 URL 模板中。`, 'OPENAPI_PARAMETER_INVALID');
    if (location === 'path' && parameter.required !== true) throw invalid(`路径参数 ${name} 必须标记为 required。`, 'OPENAPI_PARAMETER_INVALID');
    return { name, location, required: parameter.required === true, schema: schemaWithoutReferences(parameter.schema || { type: 'string' }, `参数 ${name}`), description: String(parameter.description || '').slice(0, 500) };
}

function jsonRequestBodySchema(operation = {}) {
    const content = operation.requestBody?.content;
    if (!content) return { schema: {}, required: false };
    const media = content['application/json'];
    if (!media) throw invalid('仅支持 application/json 请求体。', 'OPENAPI_REQUEST_BODY_UNSUPPORTED');
    const schema = schemaWithoutReferences(media.schema || { type: 'object' }, '请求体');
    return { schema, required: operation.requestBody.required === true };
}

function jsonResponseSchema(operation = {}) {
    const responses = operation.responses && typeof operation.responses === 'object' ? operation.responses : {};
    const response = responses['200'] || responses['201'] || responses['202'] || responses.default || {};
    const media = response?.content?.['application/json'];
    return media?.schema ? schemaWithoutReferences(media.schema, '响应体') : {};
}

function buildOperationInputSchema(parameters = [], bodyDefinition = {}) {
    const bodySchema = bodyDefinition?.schema && typeof bodyDefinition.schema === 'object' ? bodyDefinition.schema : {};
    const properties = {};
    const required = [];
    parameters.forEach(parameter => {
        properties[parameter.name] = { ...parameter.schema, description: parameter.description || parameter.schema?.description || '' };
        if (parameter.required) required.push(parameter.name);
    });
    if (Object.keys(bodySchema).length) {
        properties.body = bodySchema;
        if (bodyDefinition?.required === true) required.push('body');
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function buildOperationOutputSchema(responseSchema = {}) {
    return {
        type: 'object',
        required: ['statusCode', 'ok', 'headers', 'data', 'text'],
        properties: {
            statusCode: { type: 'integer' }, ok: { type: 'boolean' }, headers: { type: 'object' },
            data: Object.keys(responseSchema).length ? responseSchema : {}, text: { type: 'string' }
        }
    };
}

function extractOperations(document, options = {}) {
    if (!String(document?.openapi || '').startsWith('3.')) throw invalid('仅支持 OpenAPI 3.x 文档。', 'OPENAPI_VERSION_UNSUPPORTED');
    const baseUrl = normalizeBaseUrl(options.baseUrl || options.base_url || document?.servers?.[0]?.url);
    const paths = document.paths && typeof document.paths === 'object' && !Array.isArray(document.paths) ? document.paths : {};
    const operations = [];
    Object.entries(paths).forEach(([pathTemplate, pathItem]) => {
        if (!String(pathTemplate).startsWith('/') || pathTemplate.includes('://') || !pathItem || typeof pathItem !== 'object') return;
        const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
        Object.entries(pathItem).forEach(([method, operation]) => {
            const normalizedMethod = String(method).toLowerCase();
            if (!SUPPORTED_METHODS.has(normalizedMethod) || !operation || typeof operation !== 'object') return;
            const parameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
                .map(parameter => normalizeParameter(parameter, pathTemplate));
            const deduped = new Map();
            parameters.forEach(parameter => deduped.set(`${parameter.location}:${parameter.name}`, parameter));
            const bodySchema = jsonRequestBodySchema(operation);
            const responseSchema = jsonResponseSchema(operation);
            const fallbackName = `${normalizedMethod.toUpperCase()} ${pathTemplate}`;
            operations.push({
                name: normalizeName(operation.summary || operation.operationId || fallbackName),
                description: String(operation.description || operation.summary || '').trim().slice(0, 2000),
                operationId: normalizeOperationId(operation.operationId, `${normalizedMethod}_${pathTemplate}`),
                method: normalizedMethod.toUpperCase(),
                baseUrl,
                pathTemplate,
                parameters: [...deduped.values()],
                bodySchema,
                responseSchema
            });
        });
    });
    if (!operations.length) throw invalid('文档中没有可导入的 HTTP 操作。', 'OPENAPI_OPERATION_EMPTY');
    return operations.slice(0, MAX_OPERATIONS_PER_IMPORT);
}

function normalizeCredentialOptions(body = {}) {
    const credentialSlug = String(body.credentialSlug || body.credential_slug || '').trim();
    const credentialHeader = String(body.credentialHeader || body.credential_header || 'Authorization').trim();
    const credentialPrefix = String(body.credentialPrefix ?? body.credential_prefix ?? 'Bearer ');
    if (credentialSlug) normalizeSlug(credentialSlug);
    if (credentialHeader && /[\r\n:]/.test(credentialHeader)) throw invalid('凭据请求头名称无效。', 'OPENAPI_CREDENTIAL_HEADER_INVALID');
    if (credentialPrefix.length > 80) throw invalid('凭据前缀不能超过 80 个字符。', 'OPENAPI_CREDENTIAL_PREFIX_INVALID');
    return { credentialSlug: credentialSlug ? normalizeSlug(credentialSlug) : '', credentialHeader: credentialHeader || 'Authorization', credentialPrefix };
}

function parseStoredJson(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function operationToolName(id) { return `api.operation.${String(id || '').trim()}`; }

function toToolDefinition(row) {
    const parameters = parseStoredJson(row.parameter_schema);
    const bodySchema = parseStoredJson(row.body_schema);
    const responseSchema = parseStoredJson(row.response_schema);
    return {
        name: operationToolName(row.id),
        title: row.name,
        description: row.description || `${row.method} ${row.path_template}`,
        source: 'api_operation',
        version: row.source_digest || 'openapi-3',
        capabilities: ['network.http_request'],
        input_schema: buildOperationInputSchema(Array.isArray(parameters) ? parameters : [], bodySchema),
        output_schema: buildOperationOutputSchema(responseSchema),
        risk: row.side_effect ? 'high' : 'medium',
        side_effect: Boolean(row.side_effect),
        idempotent: Boolean(row.idempotent),
        approval_required: Boolean(row.side_effect),
        network: true,
        cacheable: false,
        apiOperationId: row.id,
        method: row.method,
        baseUrl: row.base_url,
        pathTemplate: row.path_template
    };
}

async function listWorkflowApiOperations(user, options = {}) {
    const rows = await query(`
        SELECT * FROM workflow_api_operations
        WHERE user_id = ? AND deleted_at IS NULL ${options.includeInactive ? '' : "AND status = 'active'"}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
    `, [user.id, Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 200, 200))]);
    return rows.map(toToolDefinition);
}

async function importOpenApiOperations(user, body = {}) {
    const document = parseDocument(body.document || body.spec || body.openapi);
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_OPENAPI_BYTES) throw invalid('OpenAPI 文档超过 1MB 上限。', 'OPENAPI_DOCUMENT_TOO_LARGE', 413);
    const selected = new Set(Array.isArray(body.operationIds || body.operation_ids)
        ? (body.operationIds || body.operation_ids).map(item => String(item || '').trim()).filter(Boolean)
        : []);
    const operations = extractOperations(document, body)
        .filter(operation => !selected.size || selected.has(operation.operationId));
    if (!operations.length) throw invalid('没有匹配到要导入的 API 操作。', 'OPENAPI_OPERATION_SELECTION_EMPTY');
    const credential = normalizeCredentialOptions(body);
    const now = getBeijingTimestamp();
    const sourceDigest = crypto.createHash('sha256').update(serialized).digest('hex');
    const imported = [];
    const importedNames = new Set();
    for (const operation of operations) {
        const baseName = operation.name;
        let name = baseName;
        let suffix = 2;
        while (importedNames.has(name)) name = `${baseName} (${suffix++})`.slice(0, 120);
        importedNames.add(name);
        const existing = await queryOne('SELECT id FROM workflow_api_operations WHERE user_id = ? AND name = ? AND deleted_at IS NULL', [user.id, name]);
        const id = existing?.id || crypto.randomUUID();
        const sideEffect = operation.method !== 'GET';
        await execute(`
            INSERT INTO workflow_api_operations (
                id, user_id, name, description, operation_id, method, base_url, path_template,
                parameter_schema, body_schema, response_schema, credential_slug, credential_header, credential_prefix,
                side_effect, idempotent, status, source_digest, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                description = excluded.description, operation_id = excluded.operation_id, method = excluded.method,
                base_url = excluded.base_url, path_template = excluded.path_template, parameter_schema = excluded.parameter_schema,
                body_schema = excluded.body_schema, response_schema = excluded.response_schema, credential_slug = excluded.credential_slug,
                credential_header = excluded.credential_header, credential_prefix = excluded.credential_prefix,
                side_effect = excluded.side_effect, idempotent = excluded.idempotent, status = 'active',
                source_digest = excluded.source_digest, updated_at = excluded.updated_at, deleted_at = NULL
        `, [
            id, user.id, name, operation.description, operation.operationId, operation.method, operation.baseUrl, operation.pathTemplate,
            JSON.stringify(operation.parameters), JSON.stringify(operation.bodySchema), JSON.stringify(operation.responseSchema),
            credential.credentialSlug, credential.credentialHeader, credential.credentialPrefix,
            sideEffect, operation.method === 'GET', sourceDigest, now, now
        ]);
        const row = await queryOne('SELECT * FROM workflow_api_operations WHERE id = ? AND user_id = ?', [id, user.id]);
        if (row) imported.push(toToolDefinition(row));
    }
    return { imported, sourceDigest, count: imported.length };
}

async function getWorkflowApiOperationForUser(id, user) {
    const row = await queryOne("SELECT * FROM workflow_api_operations WHERE id = ? AND user_id = ? AND status = 'active' AND deleted_at IS NULL", [id, user.id]);
    return row || null;
}

function resolveOperationUrl(row, input = {}) {
    const parameters = Array.isArray(parseStoredJson(row.parameter_schema)) ? parseStoredJson(row.parameter_schema) : [];
    let path = String(row.path_template || '');
    const queryValues = new URLSearchParams();
    for (const parameter of parameters) {
        const value = input[parameter.name];
        if ((value === undefined || value === null || value === '') && parameter.required) {
            throw invalid(`缺少 API 参数：${parameter.name}`, 'OPENAPI_OPERATION_PARAMETER_REQUIRED');
        }
        if (value === undefined || value === null || value === '') continue;
        if (parameter.location === 'path') {
            path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
        } else if (Array.isArray(value)) {
            value.forEach(item => queryValues.append(parameter.name, String(item)));
        } else if (typeof value === 'object') {
            throw invalid(`查询参数 ${parameter.name} 不支持对象值。`, 'OPENAPI_OPERATION_PARAMETER_INVALID');
        } else {
            queryValues.append(parameter.name, String(value));
        }
    }
    if (/\{[^}]+\}/.test(path)) throw invalid('API 路径缺少必要参数。', 'OPENAPI_OPERATION_PARAMETER_REQUIRED');
    const target = new URL(path.replace(/^\//, ''), `${String(row.base_url).replace(/\/$/, '')}/`);
    queryValues.forEach((value, key) => target.searchParams.append(key, value));
    return target.toString();
}

async function executeWorkflowApiOperation(id, input, user, context, executeHttp) {
    const row = await getWorkflowApiOperationForUser(id, user);
    if (!row) throw invalid('API 操作不存在、已停用或无权使用。', 'OPENAPI_OPERATION_NOT_FOUND', 404);
    const url = resolveOperationUrl(row, input || {});
    const body = input?.body;
    return await executeHttp({
        url,
        method: row.method,
        body,
        credentialSecret: row.credential_slug || '',
        credentialHeader: row.credential_header || 'Authorization',
        credentialPrefix: row.credential_prefix || 'Bearer '
    }, user, context);
}

async function deleteWorkflowApiOperation(id, user) {
    const row = await getWorkflowApiOperationForUser(id, user);
    if (!row) return null;
    await execute('UPDATE workflow_api_operations SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
        'disabled', getBeijingTimestamp(), getBeijingTimestamp(), row.id, user.id
    ]);
    return toToolDefinition(row);
}

module.exports = {
    buildOperationInputSchema,
    deleteWorkflowApiOperation,
    executeWorkflowApiOperation,
    extractOperations,
    importOpenApiOperations,
    listWorkflowApiOperations,
    resolveOperationUrl,
    schemaWithoutReferences,
    toToolDefinition
};
