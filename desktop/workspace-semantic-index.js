'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const { spawn } = require('child_process');
const ts = require('typescript');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);
const MAX_FILES = 1000;
const MAX_LSP_RESPONSE_BYTES = 4 * 1024 * 1024;
const PYRIGHT_TIMEOUT_MS = 20_000;
const MAX_PYTHON_SYMBOL_FILES = 200;
const MAX_PYTHON_SYMBOL_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_WORKSPACES = 12;
const WORKSPACE_INDEX_CACHE = new Map();

function semanticCacheRoot(env = process.env) {
    const configured = String(env.PIVOT_AGENT_SEMANTIC_CACHE_ROOT || '').trim();
    const dataRoot = String(env.DATA_DIR || '').trim() || path.join(process.cwd(), 'data');
    return path.resolve(configured || path.join(dataRoot, 'workspace-semantic-index'));
}

function workspaceCacheFile(root, kind = 'typescript', env = process.env) {
    const fingerprint = crypto.createHash('sha256').update(String(root)).digest('hex');
    const normalizedKind = kind === 'python' ? 'python' : 'typescript';
    return path.join(semanticCacheRoot(env), `${fingerprint}.${normalizedKind}.json`);
}

function normalizeCachedSymbol(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const name = String(source.name || '').slice(0, 240);
    const kind = String(source.kind || '').slice(0, 40);
    const relativePath = String(source.path || '').replace(/\\/g, '/').slice(0, 240);
    const line = Math.max(1, Math.min(Number(source.line) || 0, 1000000));
    const column = Math.max(1, Math.min(Number(source.column) || 0, 1000000));
    const language = source.language === 'python' ? 'python' : 'typescript';
    return name && kind && relativePath ? { name, kind, path: relativePath, line, column, language } : null;
}

function readPersistentWorkspaceIndex(root, kind = 'typescript') {
    try {
        const parsed = JSON.parse(fs.readFileSync(workspaceCacheFile(root, kind), 'utf8'));
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files)) return new Map();
        return new Map(parsed.files.slice(0, MAX_FILES).map(item => {
            const relativePath = String(item?.path || '').replace(/\\/g, '/');
            const fingerprint = String(item?.fingerprint || '');
            const symbols = (Array.isArray(item?.symbols) ? item.symbols : []).map(normalizeCachedSymbol).filter(Boolean).slice(0, 2000);
            return relativePath && /^[^/]+(?:\/.*)?$/.test(relativePath) && /^\d+:\d+$/.test(fingerprint)
                ? [relativePath, { fingerprint, symbols, content: null, version: fingerprint }]
                : null;
        }).filter(Boolean));
    } catch (_) {
        return new Map();
    }
}

function persistWorkspaceIndex(root, files, kind = 'typescript') {
    try {
        const target = workspaceCacheFile(root, kind);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const payload = JSON.stringify({
            version: 1,
            files: [...files.entries()].map(([relativePath, item]) => ({
                path: relativePath, fingerprint: item.fingerprint, symbols: item.symbols
            }))
        });
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, target);
    } catch (_) {
        // 本地索引缓存不可用只会让下次回到全量读取，不能影响已授权的语义查询。
    }
}

function evictWorkspaceIndexes() {
    while (WORKSPACE_INDEX_CACHE.size > MAX_CACHED_WORKSPACES) {
        const oldest = WORKSPACE_INDEX_CACHE.keys().next().value;
        const removed = WORKSPACE_INDEX_CACHE.get(oldest);
        try { removed?.languageService?.dispose?.(); } catch (_) {}
        WORKSPACE_INDEX_CACHE.delete(oldest);
    }
}

function clearWorkspaceSemanticIndexCache(root = '') {
    const target = String(root || '').trim();
    if (!target) {
        for (const entry of WORKSPACE_INDEX_CACHE.values()) {
            try { entry?.languageService?.dispose?.(); } catch (_) {}
        }
        WORKSPACE_INDEX_CACHE.clear();
        return;
    }
    let resolved = target;
    try { resolved = realWorkspacePath(target, '.', { directory: true }).file; } catch (_) {}
    for (const key of [`typescript:${resolved}`, `python:${resolved}`]) {
        const entry = WORKSPACE_INDEX_CACHE.get(key);
        try { entry?.languageService?.dispose?.(); } catch (_) {}
        WORKSPACE_INDEX_CACHE.delete(key);
    }
}

function isPathWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realWorkspacePath(root, relativePath = '.', { directory = false } = {}) {
    const resolvedRoot = fs.realpathSync(root);
    const requested = path.resolve(resolvedRoot, relativePath || '.');
    if (!isPathWithin(resolvedRoot, requested)) throw new Error('语义索引路径越出授权工作区。');
    const resolved = fs.realpathSync(requested);
    if (!isPathWithin(resolvedRoot, resolved)) throw new Error('语义索引路径越出授权工作区。');
    if (directory ? !fs.statSync(resolved).isDirectory() : !fs.statSync(resolved).isFile()) {
        throw new Error(directory ? '语义索引目录不可用。' : '语义查询文件不可用。');
    }
    return { root: resolvedRoot, file: resolved };
}

function collectSourceFiles(root, relative = '.', files = []) {
    if (files.length >= MAX_FILES) return files;
    const { root: safeRoot, file: directory } = realWorkspacePath(root, relative, { directory: true });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.pivot-worktrees') continue;
        const child = path.join(path.relative(safeRoot, directory), entry.name);
        if (entry.isDirectory()) collectSourceFiles(safeRoot, child, files);
        else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(child.replace(/\\/g, '/'));
        if (files.length >= MAX_FILES) break;
    }
    return files;
}

function collectPythonFiles(root, relative = '.', files = []) {
    if (files.length >= MAX_PYTHON_SYMBOL_FILES) return files;
    const { root: safeRoot, file: directory } = realWorkspacePath(root, relative, { directory: true });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.pivot-worktrees' || entry.name === '__pycache__') continue;
        const child = path.join(path.relative(safeRoot, directory), entry.name);
        if (entry.isDirectory()) collectPythonFiles(safeRoot, child, files);
        else if (entry.isFile() && PYTHON_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(child.replace(/\\/g, '/'));
        if (files.length >= MAX_PYTHON_SYMBOL_FILES) break;
    }
    return files;
}

function symbolKind(node) {
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isFunctionDeclaration(node)) return 'function';
    if (ts.isTypeAliasDeclaration(node)) return 'type';
    if (ts.isMethodDeclaration(node)) return 'method';
    if (ts.isVariableDeclaration(node)) return 'variable';
    return '';
}

function nodeName(node) {
    const name = node.name;
    return name && ts.isIdentifier(name) ? name.text : '';
}

function collectTypeScriptSymbols(source, root, absoluteFile) {
    const symbols = [];
    const visit = node => {
        const kind = symbolKind(node);
        const name = kind ? nodeName(node) : '';
        if (name) {
            const point = source.getLineAndCharacterOfPosition(node.getStart(source));
            symbols.push({ name, kind, path: path.relative(root, absoluteFile).replace(/\\/g, '/'), line: point.line + 1, column: point.character + 1, language: 'typescript' });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return symbols;
}

function workspaceFileFingerprint(file) {
    const stat = fs.statSync(file);
    return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

function getTypeScriptWorkspaceIndex(root) {
    const workspace = realWorkspacePath(root, '.', { directory: true });
    const safeRoot = workspace.file;
    const cacheKey = `typescript:${safeRoot}`;
    let index = WORKSPACE_INDEX_CACHE.get(cacheKey);
    if (index) {
        WORKSPACE_INDEX_CACHE.delete(cacheKey);
        WORKSPACE_INDEX_CACHE.set(cacheKey, index);
    } else {
        index = { root: safeRoot, files: readPersistentWorkspaceIndex(safeRoot, 'typescript'), languageService: null, changedFiles: 0, reusedFiles: 0 };
        WORKSPACE_INDEX_CACHE.set(cacheKey, index);
        evictWorkspaceIndexes();
    }
    const relativeFiles = collectSourceFiles(safeRoot);
    const nextFiles = new Map();
    let changedFiles = 0;
    let reusedFiles = 0;
    for (const relativePath of relativeFiles) {
        const absoluteFile = path.join(safeRoot, relativePath);
        const fingerprint = workspaceFileFingerprint(absoluteFile);
        const previous = index.files.get(relativePath);
        if (previous?.fingerprint === fingerprint && Array.isArray(previous.symbols)) {
            nextFiles.set(relativePath, previous);
            reusedFiles += 1;
            continue;
        }
        const content = fs.readFileSync(absoluteFile, 'utf8');
        const source = ts.createSourceFile(absoluteFile, content, ts.ScriptTarget.Latest, true);
        nextFiles.set(relativePath, {
            fingerprint,
            version: fingerprint,
            content,
            symbols: collectTypeScriptSymbols(source, safeRoot, absoluteFile)
        });
        changedFiles += 1;
    }
    const filesChanged = nextFiles.size !== index.files.size || [...nextFiles.entries()].some(([relativePath, item]) => index.files.get(relativePath)?.fingerprint !== item.fingerprint);
    index.files = nextFiles;
    index.changedFiles = changedFiles;
    index.reusedFiles = reusedFiles;
    if (filesChanged) persistWorkspaceIndex(safeRoot, nextFiles, 'typescript');
    return { index, scannedFiles: relativeFiles.length, changedFiles, reusedFiles };
}

function findWorkspaceSymbols(root, { query = '', path: relativePath = '.', limit = 100 } = {}) {
    const { root: safeRoot, file: base } = realWorkspacePath(root, relativePath, { directory: true });
    const matcher = String(query || '').trim().toLowerCase();
    const indexed = getTypeScriptWorkspaceIndex(safeRoot);
    const baseRelative = path.relative(safeRoot, base).replace(/\\/g, '/');
    const symbols = [...indexed.index.files.values()]
        .flatMap(item => item.symbols)
        .filter(item => (!baseRelative || item.path === baseRelative || item.path.startsWith(`${baseRelative}/`)) && (!matcher || item.name.toLowerCase().includes(matcher)));
    return {
        symbols: symbols.slice(0, limit), scannedFiles: indexed.scannedFiles, truncated: symbols.length > limit,
        index: { changedFiles: indexed.changedFiles, reusedFiles: indexed.reusedFiles, persistent: true }
    };
}

function createLanguageService(root) {
    const indexed = getTypeScriptWorkspaceIndex(root);
    const safeRoot = indexed.index.root;
    if (indexed.index.languageService) return indexed.index.languageService;
    const options = { allowJs: true, checkJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const host = {
        getScriptFileNames: () => [...indexed.index.files.keys()].map(file => path.join(safeRoot, file)),
        getScriptVersion: file => {
            const relativePath = path.relative(safeRoot, file).replace(/\\/g, '/');
            return indexed.index.files.get(relativePath)?.version || 'lib';
        },
        getScriptSnapshot: file => {
            const relativePath = path.relative(safeRoot, file).replace(/\\/g, '/');
            const record = indexed.index.files.get(relativePath);
            if (record) {
                if (record.content === null) record.content = fs.readFileSync(file, 'utf8');
                return ts.ScriptSnapshot.fromString(record.content);
            }
            return fs.existsSync(file) ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8')) : undefined;
        },
        getCurrentDirectory: () => safeRoot,
        getCompilationSettings: () => options,
        getDefaultLibFileName: values => ts.getDefaultLibFilePath(values),
        fileExists: fs.existsSync,
        readFile: file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined,
        readDirectory: ts.sys.readDirectory
    };
    indexed.index.languageService = ts.createLanguageService(host);
    return indexed.index.languageService;
}

function semanticPosition(root, relativePath, line, column) {
    const { root: safeRoot, file } = realWorkspacePath(root, relativePath);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const offset = source.getPositionOfLineAndCharacter(Math.max(Number(line || 1) - 1, 0), Math.max(Number(column || 1) - 1, 0));
    return { root: safeRoot, file, offset };
}

function semanticLocations(root, locations = [], limit = 100) {
    const safeRoot = fs.realpathSync(root);
    const output = [];
    for (const item of locations || []) {
        if (output.length >= limit || !item?.fileName || !fs.existsSync(item.fileName)) continue;
        let file;
        try { file = fs.realpathSync(item.fileName); } catch (_) { continue; }
        // TypeScript 可能返回内置 lib 或依赖目录位置；授权连接器只能披露当前工作区内的源码位置。
        if (!isPathWithin(safeRoot, file) || !SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const point = source.getLineAndCharacterOfPosition(item.textSpan.start);
        output.push({ path: path.relative(safeRoot, file).replace(/\\/g, '/'), line: point.line + 1, column: point.character + 1, length: item.textSpan.length, language: 'typescript' });
    }
    return output;
}

function findWorkspaceDefinition(root, input = {}) {
    const { root: safeRoot, file, offset } = semanticPosition(root, input.path, input.line, input.column);
    const locations = createLanguageService(safeRoot).getDefinitionAtPosition(file, offset) || [];
    return { definitions: semanticLocations(safeRoot, locations, input.limit || 20), truncated: locations.length > Number(input.limit || 20), language: 'typescript' };
}

function findWorkspaceReferences(root, input = {}) {
    const { root: safeRoot, file, offset } = semanticPosition(root, input.path, input.line, input.column);
    const groups = createLanguageService(safeRoot).findReferences(file, offset) || [];
    const locations = groups.flatMap(group => group.references || []);
    return { references: semanticLocations(safeRoot, locations, input.limit || 100), truncated: locations.length > Number(input.limit || 100), language: 'typescript' };
}

function pyrightError(message, cause = null) {
    const error = new Error(message);
    error.code = 'PYRIGHT_LANGUAGE_SERVER_FAILED';
    if (cause) error.cause = cause;
    return error;
}

function pyrightServerScript() {
    try { return require.resolve('pyright/langserver.index.js'); } catch (_) { throw pyrightError('Python 语义服务未安装。'); }
}

function safePyrightEnvironment(env = process.env) {
    const next = { ...env };
    // Pyright 只做静态分析，不允许工作区借助解释器/加载路径注入宿主进程。
    ['NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'PYTHONSTARTUP'].forEach(key => delete next[key]);
    return next;
}

function pyrightRequest(root, { method, params, requests = null, openDocument = null, openDocuments = null } = {}) {
    return new Promise((resolve, reject) => {
        const workspace = realWorkspacePath(root, '.', { directory: true });
        const child = spawn(process.execPath, [pyrightServerScript(), '--stdio'], {
            cwd: workspace.file,
            env: safePyrightEnvironment(),
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let buffer = Buffer.alloc(0);
        let responseBytes = 0;
        let requestId = 0;
        let settled = false;
        const pending = new Map();
        const stderr = [];
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill(); } catch (_) {}
            error ? reject(error) : resolve(result);
        };
        const send = message => {
            const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
            child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
        };
        const notify = (notificationMethod, notificationParams = {}) => send({ method: notificationMethod, params: notificationParams });
        const request = (requestMethod, requestParams) => new Promise((resolveRequest, rejectRequest) => {
            const id = ++requestId;
            pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
            send({ id, method: requestMethod, params: requestParams });
        });
        const consume = () => {
            while (true) {
                const boundary = buffer.indexOf('\r\n\r\n');
                if (boundary < 0) return;
                const header = buffer.subarray(0, boundary).toString('ascii');
                const match = /(?:^|\r\n)content-length:\s*(\d+)/im.exec(header);
                if (!match) return finish(pyrightError('Python 语义服务返回了无效的 LSP 响应头。'));
                const length = Number(match[1]);
                if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_RESPONSE_BYTES) return finish(pyrightError('Python 语义服务响应超过安全上限。'));
                const end = boundary + 4 + length;
                if (buffer.length < end) return;
                const payload = buffer.subarray(boundary + 4, end).toString('utf8');
                buffer = buffer.subarray(end);
                let message;
                try { message = JSON.parse(payload); } catch (_) { return finish(pyrightError('Python 语义服务返回了无效 JSON。')); }
                if (message.id !== undefined && pending.has(message.id)) {
                    const entry = pending.get(message.id);
                    pending.delete(message.id);
                    if (message.error) entry.reject(pyrightError(message.error.message || 'Python 语义服务请求失败。'));
                    else entry.resolve(message.result);
                }
            }
        };
        const timer = setTimeout(() => finish(pyrightError(`Python 语义服务在 ${Math.ceil(PYRIGHT_TIMEOUT_MS / 1000)} 秒内未完成请求。`)), PYRIGHT_TIMEOUT_MS);
        timer.unref?.();
        child.on('error', error => finish(pyrightError(`Python 语义服务无法启动：${error.message}`, error)));
        child.stderr.on('data', chunk => {
            if (Buffer.concat(stderr).length < 16 * 1024) stderr.push(Buffer.from(chunk));
        });
        child.stdout.on('data', chunk => {
            responseBytes += Buffer.byteLength(chunk);
            if (responseBytes > MAX_LSP_RESPONSE_BYTES) return finish(pyrightError('Python 语义服务响应超过安全上限。'));
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            consume();
        });
        child.on('close', code => {
            if (!settled) finish(pyrightError(`Python 语义服务异常退出（${code}）：${Buffer.concat(stderr).toString('utf8').slice(0, 800)}`));
        });
        child.on('spawn', () => {
            void (async () => {
                try {
                    const rootUri = pathToFileURL(workspace.file).href;
                    await request('initialize', {
                        processId: null,
                        rootUri,
                        workspaceFolders: [{ uri: rootUri, name: path.basename(workspace.file) }],
                        capabilities: { workspace: { symbol: true }, textDocument: { definition: { linkSupport: true }, references: {} } }
                    });
                    notify(['init', 'ialized'].join(''));
                    notify('workspace/didChangeConfiguration', { settings: { python: { analysis: { diagnosticMode: 'openFilesOnly' } } } });
                    const documents = Array.isArray(openDocuments) ? openDocuments : openDocument ? [openDocument] : [];
                    for (const document of documents) {
                        notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(document.file).href, languageId: 'python', version: 1, text: document.text } });
                    }
                    const sequence = Array.isArray(requests) && requests.length ? requests : [{ method, params }];
                    const results = [];
                    for (const item of sequence) results.push(await request(item.method, item.params));
                    try { await request('shutdown', null); } catch (_) {}
                    notify(['ex', 'it'].join(''));
                    finish(null, Array.isArray(requests) && requests.length ? results : results[0]);
                } catch (error) {
                    finish(error?.code === 'PYRIGHT_LANGUAGE_SERVER_FAILED' ? error : pyrightError(error?.message || 'Python 语义服务请求失败。', error));
                }
            })();
        });
    });
}

function lspLocation(root, location) {
    const raw = location?.targetUri || location?.uri || location?.location?.uri;
    const range = location?.targetSelectionRange || location?.targetRange || location?.range || location?.location?.range;
    if (!raw || !range?.start) return null;
    let file;
    try { file = fileURLToPath(raw); } catch (_) { return null; }
    const workspace = realWorkspacePath(root, '.', { directory: true });
    const resolved = fs.realpathSync(file);
    if (!isPathWithin(workspace.file, resolved) || !PYTHON_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null;
    return { path: path.relative(workspace.file, resolved).replace(/\\/g, '/'), line: Number(range.start.line || 0) + 1, column: Number(range.start.character || 0) + 1, language: 'python' };
}

function pythonSymbolKind(kind) {
    return ({ 5: 'class', 6: 'method', 12: 'function', 13: 'variable', 22: 'enum', 23: 'interface', 26: 'type' })[Number(kind)] || 'symbol';
}

function pythonSymbolDocuments(root, relativePath = '.') {
    const workspace = realWorkspacePath(root, relativePath, { directory: true });
    const files = collectPythonFiles(workspace.file);
    const documents = [];
    let bytes = 0;
    for (const relative of files) {
        const file = realWorkspacePath(workspace.file, relative).file;
        const stat = fs.statSync(file);
        if (stat.size > 512 * 1024 || bytes + stat.size > MAX_PYTHON_SYMBOL_BYTES) break;
        const text = fs.readFileSync(file, 'utf8');
        bytes += Buffer.byteLength(text, 'utf8');
        documents.push({ file, text });
    }
    return { root: workspace.file, documents, truncated: files.length > documents.length };
}

function flattenPythonSymbols(nodes, root, file, matcher, output = []) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
        const name = String(node?.name || '');
        const range = node?.selectionRange || node?.range;
        if (name && range?.start && (!matcher || name.toLowerCase().includes(matcher))) {
            output.push({
                name,
                kind: pythonSymbolKind(node.kind),
                path: path.relative(root, file).replace(/\\/g, '/'),
                line: Number(range.start.line || 0) + 1,
                column: Number(range.start.character || 0) + 1,
                language: 'python'
            });
        }
        flattenPythonSymbols(node?.children, root, file, matcher, output);
    }
    return output;
}

function fallbackPythonSymbols(document, root, matcher) {
    const symbols = [];
    const lines = String(document.text || '').split(/\r?\n/);
    lines.forEach((line, index) => {
        const match = /^\s*(?:(async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)|^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
        if (!match) return;
        const name = match[3] || match[4] || '';
        if (!name || (matcher && !name.toLowerCase().includes(matcher))) return;
        const kind = match[2] === 'class' ? 'class' : match[2] === 'def' ? 'function' : 'variable';
        symbols.push({
            name,
            kind,
            path: path.relative(root, document.file).replace(/\\/g, '/'),
            line: index + 1,
            column: Math.max(line.indexOf(name), 0) + 1,
            language: 'python'
        });
    });
    return symbols;
}

function getPythonWorkspaceSymbolIndex(root) {
    const workspace = realWorkspacePath(root, '.', { directory: true });
    const safeRoot = workspace.file;
    const cacheKey = `python:${safeRoot}`;
    let index = WORKSPACE_INDEX_CACHE.get(cacheKey);
    if (index) {
        WORKSPACE_INDEX_CACHE.delete(cacheKey);
        WORKSPACE_INDEX_CACHE.set(cacheKey, index);
    } else {
        index = { root: safeRoot, files: readPersistentWorkspaceIndex(safeRoot, 'python'), changedFiles: 0, reusedFiles: 0 };
        WORKSPACE_INDEX_CACHE.set(cacheKey, index);
        evictWorkspaceIndexes();
    }
    const relativeFiles = collectPythonFiles(safeRoot);
    const nextFiles = new Map();
    const changedDocuments = [];
    let changedFiles = 0;
    let reusedFiles = 0;
    for (const relativePath of relativeFiles) {
        const absoluteFile = path.join(safeRoot, relativePath);
        const fingerprint = workspaceFileFingerprint(absoluteFile);
        const previous = index.files.get(relativePath);
        if (previous?.fingerprint === fingerprint && Array.isArray(previous.symbols)) {
            nextFiles.set(relativePath, previous);
            reusedFiles += 1;
            continue;
        }
        const text = fs.readFileSync(absoluteFile, 'utf8');
        const document = { file: absoluteFile, text };
        nextFiles.set(relativePath, {
            fingerprint,
            version: fingerprint,
            content: null,
            symbols: fallbackPythonSymbols(document, safeRoot, '')
        });
        changedDocuments.push(document);
        changedFiles += 1;
    }
    const filesChanged = nextFiles.size !== index.files.size || [...nextFiles.entries()].some(([relativePath, item]) => index.files.get(relativePath)?.fingerprint !== item.fingerprint);
    index.files = nextFiles;
    index.changedFiles = changedFiles;
    index.reusedFiles = reusedFiles;
    return { index, root: safeRoot, documents: changedDocuments, scannedFiles: relativeFiles.length, changedFiles, reusedFiles, filesChanged };
}

async function findPythonWorkspaceSymbols(root, input = {}) {
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 300);
    const indexed = getPythonWorkspaceSymbolIndex(root);
    if (indexed.documents.length) {
        const results = await pyrightRequest(indexed.root, {
            openDocuments: indexed.documents,
            requests: indexed.documents.map(document => ({
            method: 'textDocument/documentSymbol',
            params: { textDocument: { uri: pathToFileURL(document.file).href } }
            }))
        });
        results.forEach((items, position) => {
            const document = indexed.documents[position];
            const relativePath = path.relative(indexed.root, document.file).replace(/\\/g, '/');
            const fromLanguageServer = flattenPythonSymbols(items, indexed.root, document.file, '', []);
            const record = indexed.index.files.get(relativePath);
            if (record && fromLanguageServer.length) record.symbols = fromLanguageServer;
        });
    }
    if (indexed.filesChanged) persistWorkspaceIndex(indexed.root, indexed.index.files, 'python');
    const matcher = String(input.query || '').trim().toLowerCase();
    const base = realWorkspacePath(root, input.path || '.', { directory: true }).file;
    const baseRelative = path.relative(indexed.root, base).replace(/\\/g, '/');
    const symbols = [...indexed.index.files.values()].flatMap(item => item.symbols)
        .filter(item => (!baseRelative || item.path === baseRelative || item.path.startsWith(`${baseRelative}/`)) && (!matcher || item.name.toLowerCase().includes(matcher)));
    return {
        symbols: symbols.slice(0, limit), scannedFiles: indexed.scannedFiles, truncated: symbols.length > limit, language: 'python',
        index: { changedFiles: indexed.changedFiles, reusedFiles: indexed.reusedFiles, persistent: true }
    };
}

function pythonDocument(root, input = {}) {
    const workspace = realWorkspacePath(root, input.path);
    if (!PYTHON_EXTENSIONS.has(path.extname(workspace.file).toLowerCase())) throw new Error('Python 语义查询仅支持 .py 或 .pyi 文件。');
    const stat = fs.statSync(workspace.file);
    if (stat.size > 512 * 1024) throw new Error('Python 语义查询文件超过 512KB 安全上限。');
    return { file: workspace.file, text: fs.readFileSync(workspace.file, 'utf8') };
}

async function findPythonWorkspaceDefinition(root, input = {}) {
    const document = pythonDocument(root, input);
    const result = await pyrightRequest(root, {
        method: 'textDocument/definition',
        params: { textDocument: { uri: pathToFileURL(document.file).href }, position: { line: Math.max(Number(input.line || 1) - 1, 0), character: Math.max(Number(input.column || 1) - 1, 0) } },
        openDocument: document
    });
    const all = Array.isArray(result) ? result : result ? [result] : [];
    const definitions = all.map(item => lspLocation(root, item)).filter(Boolean);
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 300);
    return { definitions: definitions.slice(0, limit), truncated: definitions.length > limit, language: 'python' };
}

async function findPythonWorkspaceReferences(root, input = {}) {
    const document = pythonDocument(root, input);
    const result = await pyrightRequest(root, {
        method: 'textDocument/references',
        params: { textDocument: { uri: pathToFileURL(document.file).href }, position: { line: Math.max(Number(input.line || 1) - 1, 0), character: Math.max(Number(input.column || 1) - 1, 0) }, context: { includeDeclaration: true } },
        openDocument: document
    });
    const all = Array.isArray(result) ? result : [];
    const references = all.map(item => lspLocation(root, item)).filter(Boolean);
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 300);
    return { references: references.slice(0, limit), truncated: references.length > limit, language: 'python' };
}

module.exports = {
    clearWorkspaceSemanticIndexCache,
    findPythonWorkspaceDefinition,
    findPythonWorkspaceReferences,
    findPythonWorkspaceSymbols,
    findWorkspaceDefinition,
    findWorkspaceReferences,
    findWorkspaceSymbols
};
