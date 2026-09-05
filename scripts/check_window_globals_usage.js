/* Enforce a single, explicit browser namespace for the classic-script client. */
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client', 'chat');
const PIVOT_BOOTSTRAP_FILE = 'client/chat/pivot-core.js';
const ALLOWED_WINDOW_PROPERTIES = new Set([
    'Pivot', 'DOMPurify', 'confirm', 'prompt', 'location', 'URL',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'addEventListener', 'removeEventListener', 'requestAnimationFrame',
    'cancelAnimationFrame', 'innerWidth', 'innerHeight', 'matchMedia',
    'getComputedStyle', 'ResizeObserver', 'EventSource', 'isSecureContext',
    'localStorage', 'sessionStorage', 'crypto', 'CSS', 'devicePixelRatio',
    'fetch', 'getSelection', 'navigator', 'electronAPI', 'pivotDesktop',
    'isDesktopApp', 'APP_VERSION_TAG', 'echarts', 'open', 'close', 'history',
    'performance', 'AbortController', 'MutationObserver'
]);

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, files);
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
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

function walkAst(node, visit, parent = null) {
    if (!node || typeof node !== 'object') return;
    visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(item => walkAst(item, visit, node));
        else if (value?.type) walkAst(value, visit, node);
    }
}

function directWindowProperty(node) {
    if (node?.type !== 'MemberExpression' || node.object?.type !== 'Identifier' || node.object.name !== 'window') return null;
    if (node.computed) return typeof node.property?.value === 'string' ? node.property.value : '[computed]';
    return node.property?.type === 'Identifier' ? node.property.name : null;
}

const violations = [];
for (const file of walk(clientRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replace(/\\/g, '/');
    const lines = source.split(/\r?\n/);
    const ast = parse(source, file);
    walkAst(ast, (node, parent) => {
        const property = directWindowProperty(node);
        if (!property) return;
        if (!ALLOWED_WINDOW_PROPERTIES.has(property)) {
            violations.push({ file: relative, line: node.loc.start.line, property, reason: 'free-property', code: lines[node.loc.start.line - 1]?.trim() || '' });
            return;
        }
        if (parent?.type === 'AssignmentExpression' && parent.left === node) {
            const allowedBootstrap = property === 'Pivot' && relative === PIVOT_BOOTSTRAP_FILE && parent.operator === '=';
            if (!allowedBootstrap) violations.push({ file: relative, line: node.loc.start.line, property, reason: 'assignment', code: lines[node.loc.start.line - 1]?.trim() || '' });
        }
    });
}

if (violations.length) {
    console.error(`全局变量规范扫描失败：发现 ${violations.length} 个未命名空间化的 window 访问。`);
    violations.slice(0, 50).forEach(item => console.error(` - ${item.file}:${item.line} [${item.reason}] window.${item.property}: ${item.code}`));
    console.error('业务 API 请通过 window.Pivot.modules 或 window.Pivot.legacy 访问；仅浏览器 API、桌面预加载桥和 Pivot 启动根允许直接挂在 window。');
    process.exit(1);
}

console.log('全局变量规范扫描通过：业务 API 已收敛至 window.Pivot 命名空间，未发现自由 window.* 读写。');
