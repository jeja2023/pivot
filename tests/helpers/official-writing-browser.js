/* global window, document, URLSearchParams, Response, bindAppsWorkbenchEvents, showOfficialWritingApp, createOfficialWritingDoc */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function createOfficialWritingPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fs.readFileSync(path.join(root, 'client/chat/partials/workspaces/apps.html'), 'utf8'));
    for (const file of ['common/styles/theme.css', 'chat/chat.shell.css', 'chat/styles/workspaces/shared.css', 'chat/chat.workspace.apps.css']) await page.addStyleTag({ path: path.join(root, 'client', file) });
    await page.evaluate(() => {
        const modules = new Map();
        window.Pivot = { legacy: { currentUser: { id: 1 }, showConfirm: async () => true },
            exposeModule(name, api) { modules.set(name, { ...modules.get(name), ...api }); }, moduleApi(name) { return modules.get(name) || {}; } };
        window.Pivot.moduleApi('');
        window.API_BASE = '/api';
        window.testToasts = [];
        window.showToast = (message, type) => window.testToasts.push({ message, type });
        window.testDocs = new Map();
        window.testRequests = [];
        window.apiFetch = async (url, options = {}) => {
            window.testRequests.push({ url, method: options.method || 'GET' });
            if (window.testApiOverride) { const response = await window.testApiOverride(url, options); if (response) return response; }
            const parsed = new URL(url, 'http://localhost');
            const id = decodeURIComponent(parsed.pathname.split('/').pop());
            const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
            if (parsed.pathname === '/api/apps/catalog') {
                return json({
                    canManage: false,
                    apps: [
                        { id: 'official-writing', name: '公文起草', enabled: true },
                        { id: 'data-analysis', name: '数据分析', enabled: true },
                        { id: 'presentations', name: 'PPT制作', enabled: true }
                    ]
                });
            }
            if (options.method === 'PUT') {
                const body = JSON.parse(options.body);
                const previous = window.testDocs.get(id);
                if (previous && previous.version !== body.version) return json({ error: '公文已在其他窗口更新' }, 409);
                const doc = { id, ...body, version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString() };
                window.testDocs.set(id, doc);
                return json({ document: doc });
            }
            if (options.method === 'DELETE') { window.testDocs.delete(id); return json({ success: true }); }
            if (parsed.search || id === 'documents') {
                const params = new URLSearchParams(parsed.search), query = params.get('query') || '', type = params.get('docType') || '';
                const docs = [...window.testDocs.values()].filter(doc => doc.title.includes(query) && (!type || doc.state.docType === type));
                const pageNo = Number(params.get('page') || 1);
                return json({ data: docs.slice((pageNo - 1) * 10, pageNo * 10).map(doc => ({ ...doc, state: undefined, summary: window.Pivot.moduleApi('apps.officialWritingDocument').summary(doc.state) })), total: docs.length, page: pageNo, limit: 10 });
            }
            if (window.testDocs.has(id)) return json({ document: window.testDocs.get(id) });
            throw new Error('未配置的测试请求：' + url);
        };
        window.createBrowserSseParser = ({ onData, onDone }) => {
            let buffer = '', done = false;
            return { write(chunk) { buffer += chunk; let boundary;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                    const event = buffer.slice(0, boundary).replace(/^data:\s?/, ''); buffer = buffer.slice(boundary + 2);
                    if (event === '[DONE]') { done = true; onDone?.(); } else onData(event);
                }
            }, end() {}, isDone() { return done; } };
        };
    });
    for (const file of ['common/vendor/purify.min.js', 'chat/safe-html.js', 'common/official-writing-document.js', 'common/official-writing-format.js',
        ...['core', 'availability', 'library', 'library-ui', 'surface', 'history', 'editor', 'suggestions', 'proofread', 'ai', 'rewrite', 'export', 'materials', 'attachments', 'rag', 'product'].map(name => `chat/apps-workbench-${name}.js`)]) {
        await page.addScriptTag({ path: path.join(root, 'client', file) });
    }
    await page.evaluate(async () => {
        document.getElementById('apps-workbench-modal').classList.remove('hidden');
        document.getElementById('apps-workbench-modal').setAttribute('aria-hidden', 'false');
        bindAppsWorkbenchEvents();
        await showOfficialWritingApp();
        createOfficialWritingDoc({ title: '浏览器测试文档' });
    });
    return { page, errors };
}

module.exports = { createOfficialWritingPage };
