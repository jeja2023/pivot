'use strict';

const path = require('node:path');

// 无同源权限的隔离页只读取这两个公开脚本，不改变其它资源的跨源策略。
function registerMermaidPreviewAssets(app) {
    const client = path.resolve(__dirname, '../../client');
    for (const [name, file] of [
        ['runtime.js', 'common/vendor/mermaid/11.17.2/mermaid.min.js'],
        ['frame.js', 'chat/mermaid-render-frame.js']
    ]) app.get(`/common/mermaid-assets/${name}`, (_req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-cache');
        res.type('js').sendFile(path.join(client, file));
    });
    app.get('/common/mermaid-render.html', (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(client, 'common/mermaid-render.html'));
    });
}

module.exports = { registerMermaidPreviewAssets };
