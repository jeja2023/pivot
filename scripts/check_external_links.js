/* External dependency readiness check: config-only by default, live probes with --live. */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const {
    assertSafeMcpOutboundUrl,
    assertSafeOutboundUrl,
    createSafeHttpAgentsForUser,
    decryptSecret
} = require('../server/security');

const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const live = process.argv.includes('--live');
const timeoutMs = Math.max(1000, Math.min(Number(process.env.PIVOT_EXTERNAL_CHECK_TIMEOUT_MS || 15000) || 15000, 120000));
const adminGuardUser = { id: 1, username: 'admin', role: 'admin' };
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
const dbPath = process.env.PIVOT_DB_PATH ? path.resolve(process.env.PIVOT_DB_PATH) : path.join(dataDir, 'chat.db');

const builtinPrefixes = {
    reports: 'pivot-reports://',
    visualization: 'pivot-visualization://',
    report: 'pivot-report://',
    documents: 'pivot-documents://',
    data: 'pivot-data://',
    format: 'pivot-format://',
    im: 'pivot-im://'
};

const checks = [];

function add(scope, name, status, detail = '', meta = {}) {
    checks.push({ scope, name, status, detail, ...meta });
}

function parseJson(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_) {
        return fallback;
    }
}

function decryptQuiet(value) {
    try {
        return decryptSecret(value || '');
    } catch (_) {
        return '';
    }
}

function urlPreview(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return raw.slice(0, 120);
        return `${parsed.origin}${parsed.pathname}${parsed.search ? '?...' : ''}`;
    } catch (_) {
        return raw.slice(0, 120);
    }
}

function openReadOnlyDb() {
    if (!fs.existsSync(dbPath)) {
        add('配置库', 'SQLite', 'warn', `未找到 ${dbPath}，只能检查 .env 中的配置。`);
        return null;
    }
    try {
        return new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
        add('配置库', 'SQLite', 'warn', `无法只读打开 ${dbPath}: ${err.message}`);
        return null;
    }
}

function tableExists(db, name) {
    if (!db) return false;
    try {
        return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    } catch (_) {
        return false;
    }
}

function safeAll(db, sql, params = []) {
    if (!db) return [];
    try {
        return db.prepare(sql).all(...params);
    } catch (err) {
        add('配置库', 'SQL 查询', 'warn', err.message);
        return [];
    }
}

function getBuiltinType(baseUrl = '') {
    const url = String(baseUrl || '');
    if (url.startsWith('pivot-db://')) return 'database';
    return Object.entries(builtinPrefixes).find(([, prefix]) => url.startsWith(prefix))?.[0] || 'external';
}

function resolveEmbeddingUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (lower.endsWith('/embeddings') || lower.endsWith('/api/embeddings') || lower.endsWith('/api/embed')) return trimmed;
    if (lower.endsWith('/v1')) return `${trimmed}/embeddings`;
    return `${trimmed}/v1/embeddings`;
}

function buildEmbeddingPayload(input, model, targetUrl) {
    const endpoint = String(targetUrl || '').toLowerCase();
    if (endpoint.includes('/api/embeddings')) return { model, prompt: input };
    if (endpoint.includes('/api/embed')) return { model, input };
    return { input, model };
}

function extractEmbeddingVector(data) {
    if (Array.isArray(data) && data.every(Number.isFinite)) return data;
    if (Array.isArray(data?.embedding)) return data.embedding;
    if (Array.isArray(data?.data?.[0]?.embedding)) return data.data[0].embedding;
    if (Array.isArray(data?.embeddings?.[0])) return data.embeddings[0];
    if (Array.isArray(data?.result?.embedding)) return data.result.embedding;
    return [];
}

async function checkHttpGet(scope, name, url, mode = 'model') {
    const startedAt = Date.now();
    try {
        if (mode === 'mcp') await assertSafeMcpOutboundUrl(url, adminGuardUser);
        else await assertSafeOutboundUrl(url, adminGuardUser);
        const agents = createSafeHttpAgentsForUser(adminGuardUser, {
            allowPrivateEnv: mode === 'mcp' ? 'ALLOW_PRIVATE_MCP_URLS' : 'ALLOW_PRIVATE_MODEL_URLS',
            allowExplicitLoopbackForAdmin: true
        });
        const response = await axios.get(url, {
            timeout: timeoutMs,
            proxy: false,
            ...agents,
            validateStatus: () => true
        });
        const status = response.status >= 200 && response.status < 400 ? 'ok' : 'fail';
        add(scope, name, status, `HTTP ${response.status}，${Date.now() - startedAt}ms`, { url: urlPreview(url) });
    } catch (err) {
        add(scope, name, 'fail', err.message, { url: urlPreview(url) });
    }
}

async function checkEmbeddingLive(config) {
    const targetUrl = resolveEmbeddingUrl(config.url);
    const startedAt = Date.now();
    try {
        await assertSafeOutboundUrl(targetUrl, adminGuardUser);
        const agents = createSafeHttpAgentsForUser(adminGuardUser, {
            allowPrivateEnv: 'ALLOW_PRIVATE_MODEL_URLS',
            allowExplicitLoopbackForAdmin: true
        });
        const response = await axios.post(
            targetUrl,
            buildEmbeddingPayload('Pivot external dependency check', config.model || 'nomic-embed-text', targetUrl),
            {
                headers: {
                    Authorization: config.apiKey ? `Bearer ${config.apiKey}` : undefined,
                    'Content-Type': 'application/json'
                },
                timeout: timeoutMs,
                proxy: false,
                ...agents,
                validateStatus: () => true
            }
        );
        if (response.status < 200 || response.status >= 300) {
            add('Embedding', '向量服务 live', 'fail', `HTTP ${response.status}，${Date.now() - startedAt}ms`, { url: urlPreview(targetUrl) });
            return;
        }
        const vector = extractEmbeddingVector(response.data);
        if (!Array.isArray(vector) || vector.length === 0) {
            add('Embedding', '向量服务 live', 'fail', `响应中未找到向量，${Date.now() - startedAt}ms`, { url: urlPreview(targetUrl) });
            return;
        }
        add('Embedding', '向量服务 live', 'ok', `维度 ${vector.length}，${Date.now() - startedAt}ms`, { url: urlPreview(targetUrl) });
    } catch (err) {
        add('Embedding', '向量服务 live', 'fail', err.message, { url: urlPreview(targetUrl) });
    }
}

async function checkDatabaseLive(rows) {
    if (rows.length === 0) return;
    let tester;
    try {
        tester = require('../server/services/database-mcp');
    } catch (err) {
        add('数据库 MCP', 'live 测试器', 'fail', `无法加载数据库测试模块: ${err.message}`);
        return;
    }
    for (const row of rows) {
        const options = parseJson(row.options, {});
        const payload = {
            database_type: row.database_type,
            host: row.host,
            port: row.port,
            database_name: row.database_name,
            username: row.username,
            password: decryptQuiet(row.password),
            schema: options.schema,
            maxRows: options.maxRows ?? options.max_rows,
            tableAllowlist: options.tableAllowlist ?? options.table_allowlist ?? options.allowedTables,
            fieldAllowlist: options.fieldAllowlist ?? options.field_allowlist ?? options.allowedFields,
            sensitiveFields: options.sensitiveFields ?? options.sensitive_fields,
            rowPolicyHint: options.rowPolicyHint ?? options.row_policy_hint,
            queryTimeoutMs: options.queryTimeoutMs ?? options.query_timeout_ms,
            sqlCostEstimate: options.sqlCostEstimate ?? options.sql_cost_estimate,
            ssl: options.ssl,
            allowSelfSigned: options.allowSelfSigned ?? options.allow_self_signed
        };
        try {
            const connection = tester.validateDatabaseConnectionPayload(payload, adminGuardUser);
            await tester.testDatabaseConnection(connection);
            add('数据库 MCP', row.server_name, 'ok', `${row.database_type} 只读连通测试成功`);
        } catch (err) {
            const failure = tester.normalizeDatabaseConnectionError
                ? tester.normalizeDatabaseConnectionError(err, payload)
                : { message: err.message };
            add('数据库 MCP', row.server_name, 'fail', failure.message || err.message);
        }
    }
}

async function main() {
    const configDb = openReadOnlyDb();
    const settings = tableExists(configDb, 'app_settings')
        ? new Map(safeAll(configDb, 'SELECT key, value FROM app_settings').map(row => [row.key, row.value]))
        : new Map();

    const models = tableExists(configDb, 'models')
        ? safeAll(configDb, `
            SELECT id, name, url, model_name, monitor_url, status
            FROM models
            WHERE COALESCE(status, 'active') = 'active'
            ORDER BY id ASC
        `)
        : [];
    add('模型', 'active 配置', models.length > 0 ? 'ok' : 'warn', models.length > 0 ? `${models.length} 个 active 模型` : '未配置 active 模型，真实模型调用无法验收。');
    models.forEach(model => {
        add('模型', model.name, model.url && model.model_name ? 'ok' : 'warn', `${model.model_name || '未填模型名'} @ ${urlPreview(model.url) || '未填 URL'}`);
    });

    const embeddingUrl = settings.get('rag_embedding_api_url') || process.env.EMBEDDING_API_URL || '';
    const embeddingModel = settings.get('rag_embedding_model') || process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    const embeddingApiKey = settings.has('rag_embedding_api_key')
        ? decryptQuiet(settings.get('rag_embedding_api_key'))
        : (process.env.EMBEDDING_API_KEY || '');
    add('Embedding', 'HTTP 配置', embeddingUrl ? 'ok' : 'warn', embeddingUrl ? `${embeddingModel} @ ${urlPreview(embeddingUrl)}` : '未配置 EMBEDDING_API_URL 或系统向量地址。');

    const mcpServers = tableExists(configDb, 'mcp_servers')
        ? safeAll(configDb, `
            SELECT id, name, base_url, api_key, config, status, last_error, last_checked_at
            FROM mcp_servers
            WHERE COALESCE(status, 'active') != 'deleted'
            ORDER BY id ASC
        `)
        : [];
    add('MCP', '服务配置', mcpServers.length > 0 ? 'ok' : 'warn', mcpServers.length > 0 ? `${mcpServers.length} 个未删除能力服务` : '未配置外部、数据库或内置能力服务。');
    mcpServers.forEach(server => {
        const type = getBuiltinType(server.base_url);
        const config = parseJson(server.config, {});
        const status = server.status === 'error' ? 'warn' : 'ok';
        const detail = type === 'external' && !config.healthCheckUrl
            ? `${type}，未配置健康检查 URL`
            : `${type}${server.last_error ? `，最近错误: ${server.last_error}` : ''}`;
        add('MCP', server.name, status, detail, { url: urlPreview(server.base_url) });
    });

    const databaseRows = tableExists(configDb, 'mcp_database_connections')
        ? safeAll(configDb, `
            SELECT c.*, s.name AS server_name, s.status AS server_status
            FROM mcp_database_connections c
            JOIN mcp_servers s ON s.id = c.mcp_server_id
            WHERE COALESCE(c.status, 'active') = 'active'
              AND COALESCE(s.status, 'active') = 'active'
            ORDER BY c.id ASC
        `)
        : [];
    add('数据库 MCP', '连接配置', databaseRows.length > 0 ? 'ok' : 'warn', databaseRows.length > 0 ? `${databaseRows.length} 个 active 数据库连接` : '未配置 active 数据库连接。');
    databaseRows.forEach(row => {
        add('数据库 MCP', row.server_name, row.database_name ? 'ok' : 'warn', `${row.database_type} @ ${row.host || 'sqlite'} / ${row.database_name || '未填数据库名'}`);
    });

    const builtinRows = tableExists(configDb, 'mcp_builtin_configs')
        ? safeAll(configDb, `
            SELECT c.*, s.name AS server_name, s.status AS server_status
            FROM mcp_builtin_configs c
            JOIN mcp_servers s ON s.id = c.mcp_server_id
            WHERE COALESCE(c.status, 'active') = 'active'
              AND COALESCE(s.status, 'active') = 'active'
            ORDER BY c.id ASC
        `)
        : [];
    const imRows = builtinRows.filter(row => row.service_type === 'im');
    imRows.forEach(row => {
        const config = parseJson(row.config, {});
        add('IM Webhook', row.server_name, config.endpointUrl ? 'ok' : 'warn', config.endpointUrl ? `endpoint ${urlPreview(config.endpointUrl)}` : '未配置 endpointUrl。');
    });

    const alertWebhook = settings.get('observability_webhook_url') || process.env.PIVOT_ALERT_WEBHOOK_URL || '';
    add('告警 Webhook', 'observability', alertWebhook ? 'ok' : 'warn', alertWebhook ? `已配置 ${urlPreview(alertWebhook)}` : '未配置慢查询/异常告警 Webhook。');

    if (configDb) configDb.close();

    if (live) {
        for (const model of models) {
            if (model.monitor_url) await checkHttpGet('模型', `${model.name} monitor`, model.monitor_url, 'model');
            else add('模型', `${model.name} live`, 'skipped', '未配置 monitor_url；本脚本不直接发起模型补全，避免消耗真实额度。');
        }
        if (embeddingUrl) await checkEmbeddingLive({ url: embeddingUrl, model: embeddingModel, apiKey: embeddingApiKey });
        for (const server of mcpServers.filter(item => getBuiltinType(item.base_url) === 'external')) {
            const config = parseJson(server.config, {});
            if (config.healthCheckUrl) await checkHttpGet('MCP', `${server.name} health`, config.healthCheckUrl, 'mcp');
            else add('MCP', `${server.name} live`, 'skipped', '未配置 healthCheckUrl；请在能力库刷新工具缓存或执行工具调用做 JSON-RPC 验收。');
        }
        await checkDatabaseLive(databaseRows);
        imRows.forEach(row => add('IM Webhook', `${row.server_name} live`, 'skipped', '未自动发送消息；请在能力诊断里指定测试目标后发送，避免误发生产群。'));
        if (alertWebhook) add('告警 Webhook', 'live', 'skipped', '未自动投递告警；请在监控设置或压测场景中触发真实告警验收。');
    }

    const counts = checks.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
    }, {});
    console.log(`Pivot 外部链路体检 ${live ? '(live)' : '(config-only)'}`);
    console.log(`配置库: ${dbPath}`);
    checks.forEach(item => {
        const prefix = item.status.toUpperCase().padEnd(7);
        const url = item.url ? ` [${item.url}]` : '';
        console.log(`${prefix} ${item.scope} / ${item.name}: ${item.detail}${url}`);
    });
    console.log(`汇总: ok=${counts.ok || 0}, warn=${counts.warn || 0}, fail=${counts.fail || 0}, skipped=${counts.skipped || 0}`);
    if (!live) {
        console.log('提示: 使用 npm run check:external -- --live 请求已配置的健康检查、Embedding 和数据库只读连通测试。');
    } else {
        console.log('提示: 模型补全、IM 发送和告警投递仍需按生产目标手动验收，避免误耗额度或误发消息。');
    }

    if (live && (counts.fail || 0) > 0) process.exitCode = 1;
}

main().catch(err => {
    console.error(`外部链路体检失败: ${err.message}`);
    process.exitCode = 1;
});
