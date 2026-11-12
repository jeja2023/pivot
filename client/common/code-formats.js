/* 聊天源码格式由浏览器和服务端共用，未知语言只允许保存为纯文本。 */
(function (scope) {
    'use strict';
    const CODE_FORMAT_ALIASES = Object.freeze({
        python: 'py', python3: 'py', py: 'py', py3: 'py',
        javascript: 'js', js: 'js', node: 'js', nodejs: 'js',
        typescript: 'ts', ts: 'ts', jsx: 'jsx', javascriptreact: 'jsx', tsx: 'tsx', typescriptreact: 'tsx',
        java: 'java', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', hpp: 'hpp',
        csharp: 'cs', cs: 'cs', 'c#': 'cs', go: 'go', golang: 'go', rust: 'rs', rs: 'rs',
        php: 'php', ruby: 'rb', rb: 'rb', swift: 'swift', kotlin: 'kt', kt: 'kt', kts: 'kts',
        shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh', sql: 'sql',
        json: 'json', 'application/json': 'json', jsonl: 'jsonl', ndjson: 'jsonl',
        yaml: 'yaml', yml: 'yml', 'application/yaml': 'yaml',
        xml: 'xml', 'application/xml': 'xml', 'text/xml': 'xml',
        svg: 'svg', 'image/svg+xml': 'svg', html: 'html', htm: 'html', html5: 'html', 'text/html': 'html',
        css: 'css', scss: 'scss', csv: 'csv', 'text/csv': 'csv', tsv: 'tsv', 'text/tab-separated-values': 'tsv',
        ini: 'ini', toml: 'toml', markdown: 'md', md: 'md', mdown: 'md', gfm: 'md', commonmark: 'md',
        text: 'txt', txt: 'txt', plain: 'txt', plaintext: 'txt', 'text/plain': 'txt',
        code: 'txt', console: 'txt', output: 'txt', log: 'txt', mermaid: 'txt', mmd: 'txt'
    });
    const CODE_MIME_TYPES = Object.freeze({
        py: 'text/x-python; charset=utf-8', js: 'text/javascript; charset=utf-8',
        ts: 'text/typescript; charset=utf-8', jsx: 'text/javascript; charset=utf-8', tsx: 'text/typescript; charset=utf-8',
        java: 'text/x-java-source; charset=utf-8', c: 'text/x-c; charset=utf-8', h: 'text/x-c; charset=utf-8',
        cpp: 'text/x-c++; charset=utf-8', hpp: 'text/x-c++; charset=utf-8', cs: 'text/plain; charset=utf-8',
        go: 'text/x-go; charset=utf-8', rs: 'text/plain; charset=utf-8', php: 'text/x-php; charset=utf-8',
        rb: 'text/x-ruby; charset=utf-8', swift: 'text/x-swift; charset=utf-8', kt: 'text/plain; charset=utf-8', kts: 'text/plain; charset=utf-8',
        sh: 'text/x-shellscript; charset=utf-8', sql: 'application/sql; charset=utf-8', json: 'application/json; charset=utf-8',
        jsonl: 'application/x-ndjson; charset=utf-8', yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8',
        xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml; charset=utf-8', html: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8', scss: 'text/x-scss; charset=utf-8', csv: 'text/csv; charset=utf-8',
        tsv: 'text/tab-separated-values; charset=utf-8', ini: 'text/plain; charset=utf-8', toml: 'application/toml; charset=utf-8',
        md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8'
    });
    const FILE_EXTENSION_ALIASES = Object.freeze({ htm: 'html', markdown: 'md', ndjson: 'jsonl' });
    function extensionForLanguage(value) {
        const language = String(value || '').trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(CODE_FORMAT_ALIASES, language) ? CODE_FORMAT_ALIASES[language] : 'txt';
    }
    const api = { CODE_FORMAT_ALIASES, CODE_MIME_TYPES, FILE_EXTENSION_ALIASES, extensionForLanguage };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.Pivot.exposeModule('chat.codeFormats', api);
})(globalThis);
