const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const chatDir = path.join(root, 'client', 'chat');
const entryPath = path.join(chatDir, 'chat.css');
const outputPath = path.join(chatDir, 'chat.bundle.css');
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

function buildChatCss() {
    const body = collectCss(entryPath).trimEnd();
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    return `/* 此文件由 scripts/build_chat_css.js 生成；请勿手工编辑。source-sha256=${digest} */\n${body}\n`;
}

function main() {
    const output = buildChatCss();
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`聊天样式已合并：${path.relative(root, outputPath)}（${Buffer.byteLength(output)} bytes）`);
}

if (require.main === module) main();

module.exports = { buildChatCss, collectCss, entryPath, outputPath };
