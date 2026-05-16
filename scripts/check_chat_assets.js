/* Chat asset structure guard */
const fs = require('fs');
const path = require('path');
const { loadChatHtmlTemplate, resolveChatHtmlIncludes } = require('../server/chat-template');

const rootDir = path.resolve(__dirname, '..');
const chatDir = path.join(rootDir, 'client', 'chat');
const cssEntryPath = path.join(chatDir, 'chat.css');
const partialsDir = path.join(chatDir, 'partials');
const stylesDir = path.join(chatDir, 'styles');

function fail(message) {
    console.error(`Chat asset check failed: ${message}`);
    process.exit(1);
}

function relative(filePath) {
    return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

const html = loadChatHtmlTemplate();
if (html.includes('@include')) fail('unresolved include directive remains after template assembly');
[
    'id="app"',
    'id="auth-container"',
    'id="agent-workbench-modal"',
    'id="knowledge-workbench-modal"',
    'id="mcp-workbench-modal"',
    'id="admin-container"',
    'id="rag-debug-modal"',
    'src="/chat/app.js?v=__APP_VERSION__"'
].forEach(needle => {
    if (!html.includes(needle)) fail(`assembled chat template is missing ${needle}`);
});

function collectFiles(dir, extension, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(fullPath, extension, files);
        } else if (entry.isFile() && entry.name.endsWith(extension)) {
            files.push(fullPath);
        }
    }
    return files;
}

const partialFiles = collectFiles(partialsDir, '.html');
if (partialFiles.length < 10) fail('expected chat partial files are missing');
partialFiles.forEach(filePath => {
    const text = fs.readFileSync(filePath, 'utf8');
    resolveChatHtmlIncludes(text);
    if (text.includes('<html') || text.includes('</body>')) {
        fail(`${relative(filePath)} should be an HTML fragment, not a full document`);
    }
});

const cssFiles = [cssEntryPath, ...collectFiles(stylesDir, '.css')];
const imports = [];
cssFiles.forEach(cssFile => {
    const cssText = fs.readFileSync(cssFile, 'utf8');
    [...cssText.matchAll(/@import\s+url\("(.+?)"\);/g)].forEach(match => {
        imports.push({ cssFile, importPath: match[1] });
    });
});
if (imports.length < 10) fail('chat.css should import split style modules');
imports.forEach(({ cssFile, importPath }) => {
    if (!importPath.startsWith('./styles/') || !importPath.endsWith('.css')) {
        const importerDir = path.dirname(cssFile);
        const resolved = path.resolve(importerDir, importPath);
        if (!resolved.startsWith(`${stylesDir}${path.sep}`) || !fs.existsSync(resolved)) {
            fail(`invalid stylesheet import path from ${relative(cssFile)}: ${importPath}`);
        }
        return;
    }
    const resolved = path.resolve(chatDir, importPath);
    if (!resolved.startsWith(`${stylesDir}${path.sep}`)) {
        fail(`stylesheet import escapes styles directory: ${importPath}`);
    }
    if (!fs.existsSync(resolved)) fail(`missing stylesheet module: ${importPath}`);
});

console.log(`Chat asset check passed (${partialFiles.length} partials, ${imports.length} style imports).`);
