/* global window, Response -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'client/chat/apps-workbench-ocr.js'), 'utf8');
const style = path.join(root, 'client/chat/styles/workspaces/apps/ocr.css');

function fixtureDetail() {
    return {
        job: {
            id: 101,
            status: 'needs_review',
            progress: 100,
            contentRevision: 3,
            sourcePageCount: 5,
            plannedPageCount: 3,
            processedPageCount: 3,
            failedPageCount: 0,
            omittedPages: [1, 3],
            config: { confidenceThreshold: 0.75 },
            result: { coverage: { sourcePageCount: 5, plannedPageCount: 3, processedPageCount: 3, failedPageCount: 0 } }
        },
        file: { originalName: '扫描材料.pdf' },
        pages: [
            { id: 11, pageNumber: 2, width: 320, height: 240, text: '已保存文本', textLength: 5, confidence: 0.5, hasImage: false },
            { id: 12, pageNumber: 4, width: 320, height: 240, text: '第二页文本', textLength: 5, confidence: null, hasImage: false }
        ],
        blocks: Array.from({ length: 125 }, (_item, index) => ({
            id: index + 1,
            pageId: 11,
            text: `文字块 ${index + 1}`,
            confidence: index === 0 ? null : 0.9,
            bbox: [[1, 1], [12, 1], [12, 10], [1, 10]]
        })),
        outputs: [],
        reviews: []
    };
}

async function createOcrPage(browser, options = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent('<style>.hidden{display:none!important}.apps-workspace-body{min-height:700px}</style><main class="apps-workspace-body"></main><div id="apps-home-view"></div><div id="official-writing-view"></div><div id="data-analysis-view"></div><div id="regulations-view"></div><div id="pdf-tools-view"></div><button id="apps-back-btn"></button>');
    await page.addStyleTag({ path: style });
    await page.evaluate(({ detail, desktopSupportedTypes, vlConfigured }) => {
        const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        window.Pivot = { legacy: {
            PivotSafeHtml: { escapeHtml: escape, setHtml: (element, value) => { element.innerHTML = String(value || ''); } },
            PivotDataAnalysis: { resetAiWorkspace() {} },
            setAppsSessionValue: (_key, value) => { window.activeOcrApp = value; },
            getAppsSessionValue: () => window.activeOcrApp,
            renderWorkspacePagination() {}
        }};
        window.isSuperAdminUser = () => false;
        window.setAppsTitle = () => {};
        window.showToast = (message, type) => { window.ocrToasts = [...(window.ocrToasts || []), { message, type }]; };
        window.setInterval = callback => { window.ocrPoll = callback; return 1; };
        if (Array.isArray(desktopSupportedTypes)) {
            window.pivotDesktop = {
                getLocalAuthorizationStatus: async () => ({ supportedTypes: desktopSupportedTypes }),
                requestLocalAuthorization: async () => ({ canceled: false }),
                revokeLocalAuthorization: async () => ({}),
                executeLocalMcpTool: async () => ({})
            };
        }
        window.ocrCalls = [];
        window.ocrFixtureDetail = detail;
        window.apiFetch = async (url, options = {}) => {
            window.ocrCalls.push([url, options.method || 'GET', options]);
            const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (url.endsWith('/capabilities')) return json({ capabilities: { limits: { maxOcrPages: 8, maxRenderPages: 8 }, output: { confidence: 'optional' }, engine: { available: true }, modes: { document_vl: { configured: vlConfigured, available: vlConfigured } } } });
            if (url.endsWith('/preflight')) return json({ preflight: { rejected: 0, files: [] } });
            if (url.endsWith('/jobs') && options.method === 'POST') return json(window.ocrFixtureDetail);
            if (url.includes('/jobs/101') && !url.includes('/outputs/')) return json(window.ocrFixtureDetail);
            if (url.includes('/jobs?')) return json({ data: [{ id: 101, status: 'queued', progress: 0, file: { originalName: '排队材料.pdf' }, config: {} }], total: 1 });
            return json({ success: true });
        };
    }, { detail: options.detail || fixtureDetail(), desktopSupportedTypes: options.desktopSupportedTypes, vlConfigured: options.vlConfigured === true });
    await page.addScriptTag({ path: path.join(root, 'client/common/vendor/purify.min.js') });
    await page.addScriptTag({ path: path.join(root, 'client/common/vendor/marked.min.js') });
    if (options.vlConfigured) {
        await page.addScriptTag({ path: path.join(root, 'client/common/vendor/katex.min.js') });
        await page.addScriptTag({ path: path.join(root, 'client/chat/render.js') });
    }
    await page.addScriptTag({ path: path.join(root, 'client/chat/safe-html.js') });
    await page.addScriptTag({ path: path.join(root, 'client/chat/apps-workbench-ocr-review-views.js') });
    await page.addScriptTag({ path: path.join(root, 'client/chat/apps-workbench-ocr-actions.js') });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.Pivot.legacy.showOcrApp());
    return page;
}

test('OCR 工作区展示排队状态、处理范围、未知置信度和全部文字块', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createOcrPage(browser);
        await expect(page.locator('#ocr-job-table-body')).toContainText('排队中');
        await expect(page.locator('[data-ocr-job-cancel="101"]')).toBeVisible();
        await expect(page.locator('#ocr-pages-input')).toHaveAttribute('max', '8');
        await expect(page.locator('#ocr-mode-select option[value="document_vl"]')).toHaveJSProperty('disabled', true);
        await page.locator('[data-ocr-job-open="101"]').click();
        await expect(page.locator('#ocr-detail')).toContainText('已选择 3/5 页');
        await expect(page.locator('.ocr-block-list .ocr-block-row')).toHaveCount(125);
        await expect(page.locator('.ocr-block-list .ocr-block-row').first()).toContainText('未知');
        await expect(page.locator('.ocr-block-list .ocr-block-row').first()).toHaveClass(/is-unknown/);
        await page.close();
    } finally {
        await browser.close();
    }
});

test('VL 模式随上传提交，详情按页安全展示 Markdown 和失败原因', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const detail = fixtureDetail();
        detail.job.config.ocrMode = 'document_vl';
        detail.pages[0].result = { markdown: '### 解析标题\n\n<table><tr><td>表格内容</td></tr></table>\n\n$$x^2$$\n\n![图片](https://invalid.example/test.png)\n\n[外链](https://invalid.example/)' };
        detail.pages[1].result = { errorMessage: 'VL 服务请求超时' };
        const page = await createOcrPage(browser, { detail, vlConfigured: true });
        const requests = [];
        page.on('request', request => { if (request.url().includes('invalid.example')) requests.push(request.url()); });
        await page.locator('#ocr-mode-select').selectOption('document_vl');
        await page.locator('#ocr-file-input').setInputFiles({ name: '扫描图片.png', mimeType: 'image/png', buffer: Buffer.from('测试图片') });
        await page.locator('#ocr-submit-btn').click();
        await expect.poll(() => page.evaluate(() => window.ocrCalls.filter(([url, method]) => method === 'POST' && /\/(preflight|jobs)$/.test(url)).map(([, , options]) => options.body.get('ocrMode')))).toEqual(['document_vl', 'document_vl']);
        await page.locator('[data-ocr-job-open="101"]').click();
        await expect(page.locator('#ocr-vl-preview h3')).toHaveText('解析标题');
        await expect(page.locator('#ocr-vl-preview td')).toHaveText('表格内容');
        await expect(page.locator('#ocr-vl-preview .katex')).toHaveCount(1);
        await expect(page.locator('#ocr-vl-preview img, #ocr-vl-preview a[href]')).toHaveCount(0);
        assert.deepEqual(requests, []);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('#ocr-vl-preview')).toBeVisible();
        await page.locator('[data-ocr-page-id="12"]').click();
        await expect(page.locator('#ocr-vl-preview')).toHaveText('VL 服务请求超时');
    } finally {
        await browser.close();
    }
});

test('OCR 保存立即显示状态，失败保留输入，重试成功后直接刷新卡片', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(5000);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.setContent('<style>.hidden{display:none!important}</style><main id="admin-container"><section id="tab-content-app-services"><div id="application-services-body"></div></section></main>');
        const markup = fs.readFileSync(path.join(root, 'client/chat/partials/admin-extra-modals.html'), 'utf8');
        await page.evaluate(source => {
            const dialog = new window.DOMParser().parseFromString(source, 'text/html').getElementById('ocr-service-modal');
            window.document.body.appendChild(dialog);
            window.API_BASE = '/api';
            window.isSuperAdminUser = () => true;
            window.showToast = () => {};
            window.ocrSaves = [];
            window.apiFetch = (url, options) => {
                window.ocrSaves.push([url, options.method, JSON.parse(options.body)]);
                return new Promise(resolve => {
                    window.respondToOcrSave = (status, json) => resolve(new Response(JSON.stringify(json), { status }));
                });
            };
        }, markup);
        for (const asset of ['chat/pivot-core.js', 'common/vendor/purify.min.js', 'chat/safe-html.js', 'chat/admin-settings-events.js', 'chat/application-services-settings.js', 'chat/admin-settings.js']) {
            await page.addScriptTag({ path: path.join(root, 'client', asset) });
        }
        await page.evaluate(() => {
            window.escapeHtml = window.Pivot.html.escapeHtml;
            window.Pivot.moduleApi('settings.applicationServices').renderFromSettings({ ocrConfig: { serviceUrl: 'http://previous.example:9100' } });
        });
        const card = page.locator('[data-application-service="ocr"]');
        await card.locator('[data-retrieval-model-config-open="ocr"]').click();
        assert.deepEqual(pageErrors, []);
        const modal = page.locator('#ocr-service-modal');
        const save = modal.locator('[data-retrieval-config-save="ocr"]');
        const addresses = { serviceUrl: 'http://ocr.example:9100', vlServiceUrl: 'http://ocr-vl.example:9101' };
        await modal.locator('#setting-ocr-service-url').fill(addresses.serviceUrl);
        await modal.locator('#setting-ocr-vl-service-url').fill(addresses.vlServiceUrl);
        await save.click();
        await expect(save).toBeDisabled();
        await expect(save).toHaveText('保存中…');
        await expect(modal.getByRole('status')).toHaveText('正在保存 OCR 服务地址…');
        await page.evaluate(() => { window.respondToOcrSave(400, { error: '服务地址校验失败' }); });
        await expect(modal.getByRole('status')).toHaveText('服务地址校验失败');
        await expect(modal.locator('#setting-ocr-vl-service-url')).toHaveValue(addresses.vlServiceUrl);
        await expect(save).toBeEnabled();
        await save.click();
        await page.evaluate(saved => { window.respondToOcrSave(200, { success: true, settings: saved }); }, addresses);
        await expect(modal).toBeHidden();
        await expect(card).toContainText(addresses.serviceUrl);
        await expect(card).toContainText('文档解析（VL）已配置');
        assert.deepEqual(await page.evaluate(() => window.ocrSaves), Array(2).fill(['/api/settings/ocr', 'PUT', addresses]));
    } finally {
        await browser.close();
    }
});

test('旧桌面客户端缺少本机能力时提示升级，不调用不支持的 IPC 授权', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createOcrPage(browser, { desktopSupportedTypes: ['local_database', 'local_report_dir'] });
        await page.locator('#ocr-authorize-watch-btn').click();
        await expect.poll(async () => page.evaluate(() => window.ocrToasts?.at(-1)?.message || '')).toContain('请升级至 Pivot v0.2.23');
        const grantCalls = await page.evaluate(() => window.ocrCalls.filter(([url]) => url.includes('pivot-local-auth:grant')));
        assert.equal(grantCalls.length, 0);
        await page.locator('#ocr-desktop-screenshot-btn').click();
        await expect.poll(async () => page.evaluate(() => window.ocrToasts?.at(-1)?.message || '')).toContain('请升级至 Pivot v0.2.23');
        await page.close();
    } finally {
        await browser.close();
    }
});

test('OCR 工作区在刷新和切页时保留未保存草稿并携带修订号保存', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createOcrPage(browser);
        await page.locator('[data-ocr-job-open="101"]').click();
        await page.locator('#ocr-review-text').fill('未保存修订');
        await page.evaluate(() => window.Pivot.legacy.PivotOcr.loadJobs({ keepActive: true }));
        await expect(page.locator('#ocr-review-text')).toHaveValue('未保存修订');
        await page.locator('[data-ocr-page-id="12"]').click();
        await page.locator('[data-ocr-page-id="11"]').click();
        await expect(page.locator('#ocr-review-text')).toHaveValue('未保存修订');
        await page.locator('[data-ocr-page-save="11"]').click();
        const reviewRequest = await page.evaluate(() => window.ocrCalls.find(([url, method]) => url.includes('/pages/11/review') && method === 'PUT'));
        assert.ok(reviewRequest);
        const body = JSON.parse(reviewRequest[2]?.body || '{}');
        assert.equal(body.expectedRevision, 3);
        assert.equal(body.revisedText, '未保存修订');
        await page.close();
    } finally {
        await browser.close();
    }
});

test('OCR 工作区状态筛选与刷新按钮位于右侧数据表格上方且侧边栏不再包含状态筛选', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createOcrPage(browser);
        // 侧边栏不再包含状态筛选
        await expect(page.locator('.ocr-sidebar #ocr-status-filter')).toHaveCount(0);
        await expect(page.locator('.ocr-sidebar .doc-tool-filter')).toHaveCount(0);

        // 右侧工具栏包含一体化胶囊筛选控件与刷新按钮
        const toolbar = page.locator('.ocr-main .ocr-tools-toolbar');
        await expect(toolbar).toBeVisible();
        await expect(toolbar.locator('#ocr-list-summary')).toHaveText('1 个任务');

        const filterPill = toolbar.locator('.ocr-filter-pill-control');
        await expect(filterPill).toBeVisible();
        await expect(filterPill.locator('.ocr-filter-pill-prefix')).toContainText('状态');

        const select = filterPill.locator('#ocr-status-filter');
        await expect(select).toBeVisible();
        await expect(select.locator('option')).toHaveCount(7);

        const refreshBtn = toolbar.locator('#ocr-refresh-btn');
        await expect(refreshBtn).toBeVisible();

        // 切换状态筛选，触发网络请求
        await select.selectOption('needs_review');
        await expect.poll(() => page.evaluate(() => window.ocrCalls.some(([url]) => url.includes('status=needs_review')))).toBe(true);

        // 点击刷新按钮，触发刷新请求
        const callsBeforeRefresh = await page.evaluate(() => window.ocrCalls.length);
        await refreshBtn.click();
        await expect.poll(() => page.evaluate(() => window.ocrCalls.length)).toBeGreaterThan(callsBeforeRefresh);

        await page.close();
    } finally {
        await browser.close();
    }
});
