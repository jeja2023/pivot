/* Chat asset structure guard */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const parse5 = require('parse5');
const acorn = require('acorn');
const { loadChatHtmlTemplate, resolveChatHtmlIncludes } = require('../server/chat-template');
const { renderManualHtml, stripVersionUpdateSections } = require('../server/manual-page');

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
    'id="official-writing-export-text-btn"',
    'id="official-writing-base-version"',
    'id="official-writing-target-version"',
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
    'src="/chat/app-workspaces.js?v=__APP_VERSION__"',
    'src="/chat/app.js?v=__APP_VERSION__"'
].forEach(needle => {
    if (!html.includes(needle)) fail(`assembled chat template is missing ${needle}`);
});

const echartsVendorPath = path.join(rootDir, 'client', 'common', 'vendor', 'echarts.min.js');
if (!fs.existsSync(echartsVendorPath)) fail('client/common/vendor/echarts.min.js is required for chart rendering');
const renderChartsJs = fs.readFileSync(path.join(chatDir, 'render-charts.js'), 'utf8');
if (!renderChartsJs.includes("loadScriptOnce('/common/vendor/echarts.min.js')")) {
    fail('render-charts.js must lazy-load echarts instead of requiring it on the initial chat page');
}

const manualPath = path.join(rootDir, '使用帮助.md');
if (!fs.existsSync(manualPath)) fail('使用帮助.md is required for the /manual page and Docker deployment');
const manualMarkdown = fs.readFileSync(manualPath, 'utf8');
if (/适用版本：|^##\s+(?:\[?v?\d+\.\d+\.\d+\]?\s*)?(?:更新提示|更新摘要|更新记录|更新日志|版本更新|版本更新记录)\s*$/im.test(manualMarkdown)) {
    fail('使用帮助.md must remain a version-free guide for ordinary users');
}
const manualTechnicalMarkers = /\b(?:API|HTTP|HTTPS|JWT|SQLite|SSE|MCP|RAG|DAG|JSON|SQL|Token|Embedding)\b|环境变量|服务日志|接口路径|技术实现/i;
if (manualTechnicalMarkers.test(manualMarkdown)) {
    fail('使用帮助.md must not contain implementation or integration details');
}
if (!manualMarkdown.includes('点击左侧“自动化”') || !manualMarkdown.includes('“工作流”标签') || !manualMarkdown.includes('“计划任务”标签')) {
    fail('使用帮助.md must describe workflow and schedule access through the automation workspace');
}
if (/点击左侧“任务”/.test(manualMarkdown)) {
    fail('使用帮助.md must not describe the removed task navigation item');
}
if (/任务运行/.test(manualMarkdown)) {
    fail('使用帮助.md must not describe the removed task-run workspace');
}
const manualNavSection = /### 1\.2 认识左侧导航([\s\S]*?)(?=\n### 1\.3)/.exec(manualMarkdown)?.[1] || '';
const expectedSidebarLabels = ['**搜索**', '**应用**', '**知识库**', '**工具库**', '**自动化**'];
let lastSidebarLabelIndex = -1;
expectedSidebarLabels.forEach(label => {
    const index = manualNavSection.indexOf(label);
    if (index <= lastSidebarLabelIndex) {
        fail('使用帮助.md sidebar navigation order does not match the current homepage');
    }
    lastSidebarLabelIndex = index;
});
const renderedManualHtml = renderManualHtml(manualMarkdown, { embedded: true });
if (/<h2>(?:\[?v?\d+\.\d+\.\d+\]?\s*(?:更新提示|更新摘要|更新记录|更新日志|版本更新|版本更新记录)|(?:版本更新记录|版本更新|更新记录|更新日志))<\/h2>/i.test(renderedManualHtml)) {
    fail('/manual page must not render version update records from 使用帮助.md');
}
const standaloneManualHtml = renderManualHtml(manualMarkdown);
if (/版本\s+v?\d+\.\d+\.\d+/i.test(standaloneManualHtml)) {
    fail('/manual page must not display an application version in the ordinary-user help header');
}
const syntheticManual = '# 标题\n\n适用版本：`v0.0.1`\n\n## 版本更新记录\n\n- 不应显示\n\n## v0.0.2 更新提示\n\n- 也不应显示\n\n## 1. 登录\n\n正文';
const strippedSyntheticManual = stripVersionUpdateSections(syntheticManual);
if (strippedSyntheticManual.includes('更新提示') || strippedSyntheticManual.includes('版本更新记录') || strippedSyntheticManual.includes('不应显示') || !strippedSyntheticManual.includes('适用版本') || !strippedSyntheticManual.includes('## 1. 登录')) {
    fail('manual version update stripping must keep help content and remove release notes');
}
const dockerignorePath = path.join(rootDir, '.dockerignore');
if (fs.existsSync(dockerignorePath)) {
    const ignoredEntries = fs.readFileSync(dockerignorePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    if (ignoredEntries.includes('使用帮助.md') || ignoredEntries.includes('*.md')) {
        fail('使用帮助.md must not be excluded by .dockerignore');
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

const HTML_VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_OPTIONAL_CLOSE = new Set(['li', 'dt', 'dd', 'p', 'rt', 'rp', 'optgroup', 'option', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

function findTagEnd(fragment, start) {
    let quote = '';
    for (let index = start + 1; index < fragment.length; index += 1) {
        const char = fragment[index];
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return index;
        }
    }
    return -1;
}

function validateHtmlFragment(fragment, sourceName) {
    const text = String(fragment || '');
    const parsed = parse5.parseFragment(text);
    if (parsed.childNodes.some(node => ['html', 'head', 'body'].includes(node.nodeName))) {
        fail(`${sourceName} must remain an HTML fragment, not a full document`);
    }
    const stack = [];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '<') continue;
        if (text.startsWith('<!--', index)) {
            const commentEnd = text.indexOf('-->', index + 4);
            if (commentEnd < 0) fail(`${sourceName} contains an unclosed HTML comment`);
            index = commentEnd + 2;
            continue;
        }
        const end = findTagEnd(text, index);
        if (end < 0) fail(`${sourceName} contains an unclosed HTML tag`);
        const token = text.slice(index + 1, end).trim();
        if (!token || token.startsWith('!') || token.startsWith('?')) {
            index = end;
            continue;
        }
        const closing = token.startsWith('/');
        const match = token.match(/^\/?\s*([A-Za-z][\w:-]*)/);
        if (!match) {
            index = end;
            continue;
        }
        const name = match[1].toLowerCase();
        if (closing) {
            const top = stack.at(-1);
            if (top !== name) {
                fail(`${sourceName} has an unmatched closing tag </${name}>${top ? `; expected </${top}>` : ''}`);
            }
            stack.pop();
        } else if (!token.endsWith('/') && !HTML_VOID_ELEMENTS.has(name)) {
            // HTML permits a small set of optional end tags. Close only those
            // elements; all other tags must be explicitly balanced so duplicate
            // closing tags cannot be silently swallowed by the browser parser.
            if (HTML_OPTIONAL_CLOSE.has(name) && stack.at(-1) === name) stack.pop();
            stack.push(name);
        }
        index = end;
    }
    if (stack.length) fail(`${sourceName} has unclosed tag(s): ${stack.join(', ')}`);
}

function validateHtmlTemplateLiterals(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'script' });
    } catch (error) {
        fail(`${relative(filePath)} cannot be parsed for HTML template validation: ${error.message}`);
    }
    let count = 0;
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'TemplateLiteral') {
            const fragment = node.quasis.map(quasi => quasi.value.raw).join('');
            if (/<\/?[A-Za-z][\s\S]*>/.test(fragment)) {
                count += 1;
                validateHtmlFragment(fragment, `${relative(filePath)} template #${count}`);
            }
        }
        Object.entries(node).forEach(([key, value]) => {
            if (key === 'loc' || key === 'start' || key === 'end') return;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        });
    };
    visit(ast);
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
validateHtmlFragment(html, 'assembled client/chat template');
validateHtmlTemplateLiterals(path.join(chatDir, 'agent-artifacts.js'));

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

// apps-workbench 已按工作流拆分为多个全局脚本；逐个确认存在后合并校验关键守卫片段。
const appsWorkbenchSlices = [
    'apps-model-selector.js',
    'apps-workbench-core.js',
    'apps-workbench-editor.js',
    'apps-workbench-proofread.js',
    'apps-workbench-ai.js',
    'apps-workbench-rewrite.js',
    'apps-workbench-export.js',
    'apps-workbench-rag.js',
    'apps-workbench-data-analysis.js',
    'apps-workbench-regulations.js'
];
const appsWorkbenchJs = appsWorkbenchSlices.map(name => {
    const filePath = path.join(chatDir, name);
    if (!fs.existsSync(filePath)) fail(`apps workbench slice is missing ${name}`);
    return fs.readFileSync(filePath, 'utf8');
}).join('\n');
[
    'function createOfficialWritingState',
    'exportOfficialWritingText',
    'Array.from(base.options).some(option => option.value === currentBaseValue)',
    'setOfficialWritingMaterialSource(officialWritingState.materialSource'
].forEach(needle => {
    if (!appsWorkbenchJs.includes(needle)) fail(`apps workbench official writing guard is missing ${needle}`);
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
    sandbox.Pivot = { legacy: Object.create(null) };
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

console.log(`前端静态资源检查通过（${partialFiles.length} 个模板片段，${imports.length} 个样式导入）。`);
