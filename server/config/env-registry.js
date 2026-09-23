'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_START = '# >>> PIVOT_TYPED_CONFIG_REGISTRY >>>';
const REGISTRY_END = '# <<< PIVOT_TYPED_CONFIG_REGISTRY <<<';
const ROOT = path.resolve(__dirname, '../..');

const ENV_CONFIG_REGISTRY = Object.freeze({
    NODE_ENV: { group: '基础运行', type: 'enum', defaultValue: 'production', values: ['development', 'production', 'test'], description: '服务运行环境。' },
    PORT: { group: '基础运行', type: 'integer', defaultValue: 3000, min: 1, max: 65535, description: 'HTTP 服务监听端口。' },
    LOG_LEVEL: { group: '日志', type: 'enum', defaultValue: 'info', values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], description: '结构化日志最低输出级别。' },
    LOG_FILE_MAX_BYTES: { group: '日志', type: 'integer', defaultValue: 52_428_800, min: 1_048_576, max: 1_073_741_824, description: '单个日志文件最大字节数。' },
    LOG_FILE_MAX_ARCHIVES: { group: '日志', type: 'integer', defaultValue: 5, min: 1, max: 100, description: '轮转日志保留份数。' },
    PG_POOL_MAX: { group: 'PostgreSQL', type: 'integer', defaultValue: 30, min: 1, max: 200, description: 'PostgreSQL 连接池上限。' },
    PG_STATEMENT_TIMEOUT_MS: { group: 'PostgreSQL', type: 'integer', defaultValue: 20_000, min: 1_000, max: 600_000, description: '普通 SQL 单条执行超时。' },
    PG_ANALYZE_TIMEOUT_MS: { group: 'PostgreSQL 维护', type: 'integer', defaultValue: 60_000, min: 1_000, max: 120_000, description: '单张表 ANALYZE 的执行超时。' },
    PG_ANALYZE_TOTAL_TIMEOUT_MS: { group: 'PostgreSQL 维护', type: 'integer', defaultValue: 600_000, min: 60_000, max: 3_600_000, description: '单轮 ANALYZE 的总时限；到期后从进度游标继续。' },
    PIVOT_EMBED_ALLOWED_ORIGINS: { group: '安全', type: 'csv', defaultValue: '', description: '工作流页面、媒体和 iframe 可使用的外部 Origin 白名单；留空时仅允许同源资源。' },
    PIVOT_PRESENTATION_MAX_BYTES: { group: 'PPT 制作', type: 'integer', defaultValue: 8_388_608, min: 262_144, max: 67_108_864, description: '单份演示文稿结构化 IR 的最大字节数，限制页面、文本和内嵌表格数据，避免编辑与渲染耗尽内存。' },
    PIVOT_PRESENTATION_ASSET_MAX_BYTES: { group: 'PPT 制作', type: 'integer', defaultValue: 20_971_520, min: 1_048_576, max: 67_108_864, description: '单个 PPT 图片素材允许上传的最大字节数；素材仍受安全上传 MIME、真实文件头与 CAS 归属校验。' },
    PIVOT_ELECTRON_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '桌面安装包保留的 Electron 语言包。' },
    PIVOT_CHROMIUM_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '本地 Agent Chromium 运行时保留的语言包。' },
    PIVOT_CHAT_AUTO_ROUTE_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否启用对话的统一自适应路由总开关。关闭后保留原有 RAG 与 MCP 流程。' },
    PIVOT_CHAT_AUTO_RAG_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否允许路由器自动缩小知识库 Collection 范围。' },
    PIVOT_CHAT_AUTO_TOOL_DISCOVERY_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否允许路由器自动缩小已授权 MCP 工具候选集合。' },
    PIVOT_CHAT_ROUTE_SHADOW_MODE: { group: '对话自适应路由', type: 'boolean', defaultValue: false, description: '是否仅记录路由建议而不改变 RAG 与 MCP 的实际候选范围。' },
    PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES: { group: '对话自适应路由', type: 'integer', defaultValue: 4, min: 1, max: 12, description: '自动工具发现传给 MCP Planner 的最大候选工具数。' },
    PIVOT_CHAT_ROUTE_MAX_COLLECTIONS: { group: '对话自适应路由', type: 'integer', defaultValue: 2, min: 1, max: 8, description: '自动知识库路由选取的最大 Collection 数。' },
    PIVOT_CHAT_ROUTE_RAG_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.58, min: 0, max: 1, description: '自动定向检索 Collection 所需的高置信度阈值。' },
    PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.38, min: 0, max: 1, description: '知识库路由的低置信度阈值；低于该值时跳过自动检索。' },
    PIVOT_CHAT_ROUTE_TOOL_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.34, min: 0, max: 1, description: '无强规则命中时，工具候选进入 MCP Planner 的最低综合分。' },
    PIVOT_CHAT_ROUTE_EMBEDDING_TIMEOUT_MS: { group: '对话自适应路由', type: 'integer', defaultValue: 2500, min: 100, max: 30000, description: '对话路由等待 Query Embedding 的最大时长；超时后安全降级。' },
    PIVOT_CHAT_PROMPT_CACHE_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否在 Responses API 的兼容模型上请求会话隔离的 Prompt Cache；不支持的端点会自动重试并降级。' },
    PIVOT_CHAT_PROMPT_CACHE_TTL: { group: '对话自适应路由', type: 'enum', defaultValue: '30m', values: ['30m'], description: 'Responses API Prompt Cache 的最短复用时间。' },
    PIVOT_TOOL_MAX_CONCURRENT_PER_TOOL: { group: '工具库执行治理', type: 'integer', defaultValue: 4, min: 1, max: 100, description: '单进程内同一工具/连接的最大并发执行数；超过后快速拒绝，避免下游雪崩。' },
    PIVOT_TOOL_MAX_CALLS_PER_MINUTE: { group: '工具库执行治理', type: 'integer', defaultValue: 120, min: 1, max: 100000, description: '单进程内同一工具/连接每分钟最大调用数；用于保护下游服务和账号配额。' },
    PIVOT_TOOL_CIRCUIT_FAILURE_THRESHOLD: { group: '工具库执行治理', type: 'integer', defaultValue: 5, min: 1, max: 100, description: '同一工具/连接连续临时失败达到该阈值后开启熔断保护。' },
    PIVOT_TOOL_CIRCUIT_COOLDOWN_MS: { group: '工具库执行治理', type: 'integer', defaultValue: 30000, min: 1000, max: 1800000, description: '工具熔断后的冷却时间；冷却结束只允许一次半开恢复探测。' },
    PIVOT_ALLOW_INSECURE_OAUTH_HTTP: { group: '工具库执行治理', type: 'boolean', defaultValue: false, description: '是否仅为本地开发允许 OAuth 授权端点和回调使用 HTTP；生产环境必须保持 false。' },
    KNOWLEDGE_LOCAL_SOURCE_ROOTS: { group: '知识库局域网来源', type: 'csv', defaultValue: '', description: '允许被本地目录知识源扫描的绝对路径白名单，多个路径用英文逗号分隔；留空时禁用目录同步。' },
    KNOWLEDGE_SOURCE_MAX_FILES: { group: '知识库局域网来源', type: 'integer', defaultValue: 5000, min: 1, max: 100000, description: '单次局域网目录同步最多扫描的文件数，超出后需拆分数据源。' },
    KNOWLEDGE_SOURCE_SCHEDULE_INTERVAL_MS: { group: '知识库局域网来源', type: 'integer', defaultValue: 300000, min: 10000, max: 86400000, description: '后台轮询 scheduled/watch 知识来源的最短间隔；目录 watch 也以安全轮询方式实现。' },
    KNOWLEDGE_EMBEDDING_RECOVERY_INTERVAL_MS: { group: '知识库局域网来源', type: 'integer', defaultValue: 300000, min: 60000, max: 86400000, description: 'Embedding 服务恢复后扫描 lexical_ready 文档并补齐向量索引的间隔。' },
    AGENT_WEB_SEARCH_ENDPOINT: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '受控网页检索 Provider 的 HTTPS JSON Endpoint；运行任务仍须在网络策略中显式允许该 Origin。' },
    AGENT_WEB_SEARCH_CREDENTIAL: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '可选的工作流凭据引用名；设置后优先用其作为网页检索 Provider 凭据。' },
    AGENT_WEB_SEARCH_API_KEY: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '可选网页检索 Provider 密钥；仅在未配置凭据引用时使用，生产环境建议改用凭据引用。' },
    AGENT_WEB_SEARCH_HEADER: { group: 'Agent 网页检索', type: 'string', defaultValue: 'Authorization', description: '网页检索 Provider 凭据请求头名称。' },
    AGENT_WEB_SEARCH_PREFIX: { group: 'Agent 网页检索', type: 'string', defaultValue: 'Bearer', description: '网页检索 Provider 凭据请求头前缀；运行时会自动补一个空格。' },
    AGENT_IMAGE_GENERATION_ENDPOINT: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '受控图片生成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。' },
    AGENT_IMAGE_GENERATION_CREDENTIAL: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选图片生成 Provider 凭据引用名；生产环境优先使用凭据引用。' },
    AGENT_IMAGE_GENERATION_API_KEY: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选图片生成 Provider 密钥；仅在未设置凭据引用时使用。' },
    AGENT_IMAGE_GENERATION_HEADER: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Authorization', description: '图片生成 Provider 凭据请求头名称。' },
    AGENT_IMAGE_GENERATION_PREFIX: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Bearer', description: '图片生成 Provider 凭据请求头前缀；运行时自动补一个空格。' },
    AGENT_TTS_ENDPOINT: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '受控语音合成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。' },
    AGENT_TTS_CREDENTIAL: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选语音合成 Provider 凭据引用名；生产环境优先使用凭据引用。' },
    AGENT_TTS_API_KEY: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选语音合成 Provider 密钥；仅在未设置凭据引用时使用。' },
    AGENT_TTS_HEADER: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Authorization', description: '语音合成 Provider 凭据请求头名称。' },
    AGENT_TTS_PREFIX: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Bearer', description: '语音合成 Provider 凭据请求头前缀；运行时自动补一个空格。' }
});

function normalizeInteger(value, definition) {
    const parsed = Number.parseInt(value, 10);
    const fallback = Number(definition.defaultValue);
    const candidate = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(definition.max, Math.max(definition.min, candidate));
}

function normalizeNumber(value, definition) {
    const parsed = Number.parseFloat(value);
    const fallback = Number(definition.defaultValue);
    const candidate = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(definition.max, Math.max(definition.min, candidate));
}

function normalizeBoolean(value, definition) {
    if (value === undefined || value === null || String(value).trim() === '') return Boolean(definition.defaultValue);
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return Boolean(definition.defaultValue);
}

function normalizeCsv(value, definition) {
    const raw = String(value ?? definition.defaultValue ?? '');
    const values = raw.split(',').map(item => item.trim()).filter(Boolean);
    const valid = values.filter(item => !definition.itemPattern || definition.itemPattern.test(item));
    return [...new Set(valid.length ? valid : String(definition.defaultValue || '').split(',').map(item => item.trim()).filter(Boolean))];
}

function readTypedEnv(name, env = process.env) {
    const definition = ENV_CONFIG_REGISTRY[name];
    if (!definition) throw new Error(`未登记的类型化环境变量：${name}`);
    const raw = env[name];
    if (definition.type === 'integer') return normalizeInteger(raw, definition);
    if (definition.type === 'number') return normalizeNumber(raw, definition);
    if (definition.type === 'boolean') return normalizeBoolean(raw, definition);
    if (definition.type === 'csv') return normalizeCsv(raw, definition);
    if (definition.type === 'enum') {
        const value = String(raw || definition.defaultValue || '').trim();
        return definition.values.includes(value) ? value : definition.defaultValue;
    }
    return String(raw ?? definition.defaultValue ?? '');
}

function formatDefault(definition) {
    return Array.isArray(definition.defaultValue) ? definition.defaultValue.join(',') : String(definition.defaultValue ?? '');
}

function renderEnvRegistryBlock() {
    const groups = new Map();
    Object.entries(ENV_CONFIG_REGISTRY).forEach(([name, definition]) => {
        const values = groups.get(definition.group) || [];
        values.push([name, definition]);
        groups.set(definition.group, values);
    });
    const lines = [REGISTRY_START, '# 以下核心参数由 server/config/env-registry.js 统一定义和校验。'];
    groups.forEach((entries, group) => {
        lines.push(`# --- ${group} ---`);
        entries.forEach(([name, definition]) => {
            lines.push(`# ${definition.description}`);
            lines.push(`${name}=${formatDefault(definition)}`);
        });
    });
    lines.push(REGISTRY_END);
    return `${lines.join('\n')}\n`;
}

function renderRegistryDocumentation() {
    const lines = [
        '# 类型化配置注册表',
        '',
        '> 此文档由 `server/config/env-registry.js` 生成；请修改注册表，而不是手工编辑本文档。',
        ''
    ];
    const groups = new Map();
    Object.entries(ENV_CONFIG_REGISTRY).forEach(([name, definition]) => {
        const values = groups.get(definition.group) || [];
        values.push([name, definition]);
        groups.set(definition.group, values);
    });
    groups.forEach((entries, group) => {
        lines.push(`## ${group}`, '', '| 环境变量 | 类型 | 默认值 | 校验 | 说明 |', '| --- | --- | --- | --- | --- |');
        entries.forEach(([name, definition]) => {
            const validation = ['integer', 'number'].includes(definition.type)
                ? `${definition.min}–${definition.max}`
                : definition.type === 'enum' ? definition.values.join('、') : definition.type === 'boolean' ? 'true / false' : '逗号分隔的语言标记';
            lines.push(`| \`${name}\` | ${definition.type} | \`${formatDefault(definition)}\` | ${validation} | ${definition.description} |`);
        });
        lines.push('');
    });
    return `${lines.join('\n')}\n`;
}

function replaceRegistryBlock(source) {
    const block = renderEnvRegistryBlock().trimEnd();
    const pattern = new RegExp(`${REGISTRY_START}[\\s\\S]*?${REGISTRY_END}`);
    if (!pattern.test(source)) throw new Error('`.env.example` 缺少类型化配置注册表标记块。');
    const replaced = source.replace(pattern, block);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
}

function writeRegistryArtifacts(rootDir = ROOT) {
    const root = path.resolve(rootDir);
    const envPath = path.join(root, '.env.example');
    const docsPath = path.join(root, 'docs', 'configuration-registry.md');
    fs.writeFileSync(envPath, replaceRegistryBlock(fs.readFileSync(envPath, 'utf8')), 'utf8');
    fs.writeFileSync(docsPath, renderRegistryDocumentation(), 'utf8');
}

function assertRegistryArtifacts(rootDir = ROOT) {
    const root = path.resolve(rootDir);
    const envPath = path.join(root, '.env.example');
    const docsPath = path.join(root, 'docs', 'configuration-registry.md');
    const expectedEnv = replaceRegistryBlock(fs.readFileSync(envPath, 'utf8'));
    if (fs.readFileSync(envPath, 'utf8') !== expectedEnv) throw new Error('`.env.example` 的类型化配置块已过期；请运行 npm run generate:config-docs。');
    if (!fs.existsSync(docsPath) || fs.readFileSync(docsPath, 'utf8') !== renderRegistryDocumentation()) {
        throw new Error('`docs/configuration-registry.md` 已过期；请运行 npm run generate:config-docs。');
    }
}

module.exports = {
    assertRegistryArtifacts,
    readTypedEnv,
    writeRegistryArtifacts
};
