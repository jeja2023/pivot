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
    PIVOT_ELECTRON_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '桌面安装包保留的 Electron 语言包。' },
    PIVOT_CHROMIUM_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '本地 Agent Chromium 运行时保留的语言包。' }
});

function normalizeInteger(value, definition) {
    const parsed = Number.parseInt(value, 10);
    const fallback = Number(definition.defaultValue);
    const candidate = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(definition.max, Math.max(definition.min, candidate));
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
            const validation = definition.type === 'integer'
                ? `${definition.min}–${definition.max}`
                : definition.type === 'enum' ? definition.values.join('、') : '逗号分隔的语言标记';
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
