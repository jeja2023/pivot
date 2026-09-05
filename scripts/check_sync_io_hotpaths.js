'use strict';

/**
 * HTTP 请求处理在单线程事件循环上运行。同步磁盘 I/O 会让同一进程的
 * 所有请求一起排队，因此只要它直接出现在路由、上传中间件或它们直接调用的
 * 文件处理服务边界就必须阻断。
 *
 * 后台作业、启动装配和原生 DuckDB closeSync 不在本检查范围内；它们有各自的
 * 并发/资源治理。若需要新增 HTTP 边界例外，必须先把工作移到异步 worker，
 * 而不是在此处维护“历史白名单”。
 */
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = [
    path.join(root, 'server', 'routes'),
    path.join(root, 'server', 'upload.js'),
    path.join(root, 'server', 'services', 'rag-documents.js'),
    path.join(root, 'server', 'services', 'regulations'),
    path.join(root, 'server', 'services', 'document-processing'),
    path.join(root, 'server', 'services', 'data-analysis'),
    path.join(root, 'server', 'services', 'agent-data-adapter.js'),
    path.join(root, 'server', 'services', 'system-health.js')
];
const syncMethods = new Set([
    'accessSync', 'appendFileSync', 'closeSync', 'copyFileSync', 'existsSync',
    'mkdirSync', 'openSync', 'readFileSync', 'readdirSync', 'readSync', 'renameSync',
    'rmSync', 'statSync', 'unlinkSync', 'writeFileSync'
]);

function collectFiles(target, files = []) {
    if (!fs.existsSync(target)) return files;
    const stat = fs.statSync(target);
    if (stat.isFile()) {
        if (target.endsWith('.js')) files.push(target);
        return files;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        collectFiles(path.join(target, entry.name), files);
    }
    return files;
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(item => walk(item, visit));
        else if (value?.type) walk(value, visit);
    }
}

function parse(source, file) {
    try {
        return acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'script' });
    } catch (_) {
        try {
            return acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
        } catch (error) {
            throw new Error(`无法解析 ${path.relative(root, file)}: ${error.message}`);
        }
    }
}

function isDirectFsSyncCall(node) {
    if (node?.callee?.type !== 'MemberExpression') return false;
    const property = node.callee.property;
    const name = node.callee.computed ? property?.value : property?.name;
    if (!syncMethods.has(name)) return false;
    // DuckDB exposes closeSync on connection/instance/appender. Only Node's fs
    // namespace is relevant here; checking the receiver avoids false positives.
    return node.callee.object?.type === 'Identifier' && node.callee.object.name === 'fs';
}

const findings = [];
for (const file of targets.flatMap(target => collectFiles(target))) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    const ast = parse(source, file);
    walk(ast, node => {
        if (node.type !== 'CallExpression' || !isDirectFsSyncCall(node)) return;
        const property = node.callee.property;
        const name = node.callee.computed ? property?.value : property?.name;
        findings.push({
            file: path.relative(root, file).replace(/\\/g, '/'),
            line: node.loc.start.line,
            method: name,
            code: lines[node.loc.start.line - 1]?.trim() || ''
        });
    });
}

if (findings.length) {
    console.error(`同步 I/O 热路径检查失败：发现 ${findings.length} 个 HTTP 边界同步调用。`);
    findings.forEach(item => console.error(` - ${item.file}:${item.line} ${item.method}: ${item.code}`));
    console.error('请使用 fs.promises、流式 API 或将工作转移到受控后台作业。');
    process.exit(1);
}

console.log('同步 I/O 热路径检查通过：路由、上传中间件及其文件处理服务未发现同步文件操作。');
