const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const chatDir = path.join(root, 'client', 'chat');
const BUNDLES = Object.freeze({
    shell: { entry: 'chat.css', output: 'chat.shell.css' },
    apps: { entry: 'chat.workspace.apps.entry.css', output: 'chat.workspace.apps.css' },
    agent: { entry: 'chat.workspace.agent.entry.css', output: 'chat.workspace.agent.css' },
    knowledge: { entry: 'chat.workspace.knowledge.entry.css', output: 'chat.workspace.knowledge.css' },
    mcp: { entry: 'chat.workspace.mcp.entry.css', output: 'chat.workspace.mcp.css' },
    settings: { entry: 'chat.workspace.settings.entry.css', output: 'chat.workspace.settings.css' }
});
const entryPath = path.join(chatDir, BUNDLES.shell.entry);
const outputPath = path.join(chatDir, BUNDLES.shell.output);
const IMPORT_RE = /@import\s+url\("(.+?)"\);\s*/g;

function assertInsideChat(target) {
    const relative = path.relative(chatDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`样式导入越出 chat 目录：${target}`);
}

function collectCss(filePath, stack = []) {
    const absolute = path.resolve(filePath);
    assertInsideChat(absolute);
    if (stack.includes(absolute)) throw new Error(`样式导入出现循环：${[...stack, absolute].map(item => path.relative(chatDir, item)).join(' -> ')}`);
    const source = fs.readFileSync(absolute, 'utf8');
    const nextStack = [...stack, absolute];
    return source.replace(IMPORT_RE, (_match, importPath) => {
        const imported = path.resolve(path.dirname(absolute), importPath);
        if (!fs.existsSync(imported)) throw new Error(`样式导入不存在：${path.relative(chatDir, absolute)} -> ${importPath}`);
        return `\n/* === ${path.relative(chatDir, imported).replace(/\\/g, '/')} === */\n${collectCss(imported, nextStack)}\n`;
    });
}

function minifyCss(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};,])\s*/g, '$1')
        .replace(/;\}/g, '}')
        .replace(/:\s+/g, ':')
        .replace(/calc\([^)]+\)/g, match => match.replace(/\s*([+-])\s*/g, ' $1 '))
        .trim();
}

function resolveBundle(name = 'shell') {
    const bundle = BUNDLES[String(name || 'shell')];
    if (!bundle) throw new Error(`未知聊天样式包：${name}`);
    return {
        ...bundle,
        entryPath: path.join(chatDir, bundle.entry),
        outputPath: path.join(chatDir, bundle.output)
    };
}

function buildChatCss(name = 'shell') {
    const bundle = resolveBundle(name);
    const collected = collectCss(bundle.entryPath);
    const body = minifyCss(collected);
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    return `/* 此文件由 scripts/build_chat_css.js 生成；请勿手工编辑。source-sha256=${digest} */\n${body}\n`;
}

function buildAllChatCss() {
    return Object.fromEntries(Object.keys(BUNDLES).map(name => [name, buildChatCss(name)]));
}

function main() {
    Object.entries(buildAllChatCss()).forEach(([name, output]) => {
        const bundle = resolveBundle(name);
        fs.writeFileSync(bundle.outputPath, output, 'utf8');
        console.log(`聊天样式已合并并压缩：${path.relative(root, bundle.outputPath)}（${Buffer.byteLength(output)} bytes）`);
    });
}

if (require.main === module) main();

module.exports = { BUNDLES, buildAllChatCss, buildChatCss, collectCss, entryPath, minifyCss, outputPath, resolveBundle };
