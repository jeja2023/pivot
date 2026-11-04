const path = require('node:path');

// 仅开放已安装 PDF.js 的两个浏览器入口，不暴露整个 node_modules。
function registerDocumentPreviewAssets(app) {
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    for (const filename of ['pdf.mjs', 'pdf.worker.mjs']) {
        app.get(`/common/vendor/pdfjs/${filename}`, (_req, res) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(path.join(root, 'build', filename));
        });
    }
}

module.exports = { registerDocumentPreviewAssets };
