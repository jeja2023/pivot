/* Chat asset structure guard */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
    'id="apps-workbench-modal"',
    'id="official-writing-source"',
    'id="official-writing-draft"',
    'id="official-writing-comments-list"',
    'id="official-writing-diff-result"',
    'id="agent-workbench-modal"',
    'id="knowledge-workbench-modal"',
    'id="mcp-workbench-modal"',
    'id="admin-container"',
    'id="manual-workbench-modal"',
    'id="print-workbench-modal"',
    'id="print-frame"',
    'id="rag-debug-modal"',
    'id="manual-link-btn"',
    'data-workspace-view="apps"',
    'data-workspace-view="manual"',
    'data-src="/manual?embed=1"',
    'src="/common/vendor/echarts.min.js"',
    'src="/chat/apps-workbench.js?v=__APP_VERSION__"',
    'src="/chat/app.js?v=__APP_VERSION__"'
].forEach(needle => {
    if (!html.includes(needle)) fail(`assembled chat template is missing ${needle}`);
});

const echartsVendorPath = path.join(rootDir, 'client', 'common', 'vendor', 'echarts.min.js');
if (!fs.existsSync(echartsVendorPath)) fail('client/common/vendor/echarts.min.js is required for chart rendering');

const manualPath = path.join(rootDir, '使用手册.md');
if (!fs.existsSync(manualPath)) fail('使用手册.md is required for the /manual page and Docker deployment');
const dockerignorePath = path.join(rootDir, '.dockerignore');
if (fs.existsSync(dockerignorePath)) {
    const ignoredEntries = fs.readFileSync(dockerignorePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    if (ignoredEntries.includes('使用手册.md') || ignoredEntries.includes('*.md')) {
        fail('使用手册.md must not be excluded by .dockerignore');
    }
}

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

const chatShellCss = fs.readFileSync(path.join(stylesDir, 'base', 'chat-shell.css'), 'utf8');
[
    '.chat-container[data-active-workspace="apps"]',
    '.chat-container[data-active-workspace="print"]',
    '.print-workspace-body',
    '.print-frame'
].forEach(needle => {
    if (!chatShellCss.includes(needle)) fail(`print workspace layout style is missing ${needle}`);
});

function createMarkdownRenderSandbox() {
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        requestAnimationFrame(callback) {
            if (typeof callback === 'function') callback();
        },
        navigator: { clipboard: null },
        document: {
            addEventListener() {},
            getElementById() { return null; },
            createElement() {
                return {
                    style: {},
                    focus() {},
                    select() {},
                    remove() {}
                };
            },
            body: {
                appendChild() {}
            },
            execCommand() {
                return false;
            }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.PivotSafeHtml = {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        escapeAttr(value) {
            return this.escapeHtml(value).replace(/"/g, '&quot;');
        },
        sanitizeHtml(html) {
            return html;
        }
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'common', 'vendor', 'marked.min.js'), 'utf8'), context, {
        filename: 'client/common/vendor/marked.min.js'
    });
    if (!sandbox.marked) fail('marked vendor did not expose a global renderer in the chat asset sandbox');

    vm.runInContext(fs.readFileSync(path.join(chatDir, 'render.js'), 'utf8'), context, {
        filename: 'client/chat/render.js'
    });
    if (typeof sandbox.renderMarkdown !== 'function') fail('client/chat/render.js did not expose renderMarkdown in the sandbox');
    return sandbox;
}

const markdownSandbox = createMarkdownRenderSandbox();
const closedMarkdownFence = markdownSandbox.renderMarkdown('```markdown\n### Heading\n\n- item\n```');
if (closedMarkdownFence.includes('code-block') || !closedMarkdownFence.includes('<h3>Heading</h3>')) {
    fail('single outer markdown fences should render as Markdown, not as a code block');
}
const openTextFence = markdownSandbox.renderMarkdown('```text/plain\n# Heading\n\nplain text');
if (openTextFence.includes('code-block') || !openTextFence.includes('<h1>Heading</h1>')) {
    fail('open prose fences should be unwrapped while streaming');
}
const realCodeFence = markdownSandbox.renderMarkdown('```js\nconst value = 1;\n```');
if (!realCodeFence.includes('code-block') || !realCodeFence.includes('language-js')) {
    fail('real code fences should remain code blocks');
}
const embeddedMarkdownFence = markdownSandbox.renderMarkdown('Example:\n\n```markdown\n# Kept as code\n```');
if (!embeddedMarkdownFence.includes('code-block-wrap')) {
    fail('embedded markdown examples should remain wrapped prose code blocks');
}
const fencedThenTail = markdownSandbox.renderMarkdown('```markdown\n# Kept as code\n```\n\nTail');
if (!fencedThenTail.includes('code-block-wrap') || !fencedThenTail.includes('Tail')) {
    fail('markdown fences followed by extra text should remain code examples');
}
const tableHtml = markdownSandbox.renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |');
if (!tableHtml.includes('table-wrapper')) fail('rendered Markdown tables should use the local scroll wrapper');

console.log(`Chat asset check passed (${partialFiles.length} partials, ${imports.length} style imports).`);
