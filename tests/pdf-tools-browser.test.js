/* global window, Response, FormData -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'client/chat/apps-workbench-pdf-tools.js'), 'utf8');

function fixtureDetail() {
    return {
        job: {
            id: 101,
            status: 'partial_success',
            progress: 100,
            config: { operation: 'watermark' },
            result: { requestedPages: 2, processedPages: 2, processedFiles: 1, failedFiles: 1, items: [{ originalName: '失败文件.pdf', status: 'failed', errorMessage: '测试失败原因' }] },
            allowedActions: { view: true, download: true, retry: false, reprocess: true, cancel: false, delete: true }
        },
        file: { originalName: '结果材料.pdf' },
        pages: [{ id: 11, pageNumber: 1, confidence: 0.98 }],
        outputs: [{ id: 301, fileName: '结果材料-水印结果.pdf', fileSize: 1024 }],
        reviews: [],
        preflight: { mode: 'single', totalPages: 2, files: [{ originalName: '结果材料.pdf', pageCount: 2, warnings: [] }] }
    };
}

async function createPdfPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent('<main class="apps-workspace-body"></main><div id="apps-home-view"></div><div id="official-writing-view"></div><div id="data-analysis-view"></div><div id="regulations-view"></div><div id="ocr-view"></div><button id="apps-back-btn"></button>');
    await page.evaluate(() => {
        const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        window.Pivot = { legacy: {
            PivotSafeHtml: { escapeHtml: escape, setHtml: (element, value) => { element.innerHTML = String(value || ''); } },
            PivotDataAnalysis: { resetAiWorkspace() {} },
            setAppsSessionValue: (_key, value) => { window.activePdfApp = value; },
            getAppsSessionValue: () => window.activePdfApp,
            renderWorkspacePagination() {},
            showConfirm: async () => true
        }};
        window.setAppsTitle = () => {};
        window.showToast = (message, type) => { window.pdfToasts = [...(window.pdfToasts || []), { message, type }]; };
        window.pdfRequests = [];
        window.apiFetch = async (url, options = {}) => {
            const fields = options.body instanceof FormData
                ? [...options.body.keys()].filter(key => key !== 'files')
                : [];
            window.pdfRequests.push([url, options.method || 'GET', fields]);
            const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (url.endsWith('/capabilities')) return json({
                operations: [
                    { id: 'merge', label: '合并 PDF', inputMode: 'combine' },
                    { id: 'watermark', label: '添加水印', inputMode: 'single-or-batch', supportsPages: true, supportsWatermark: true },
                    { id: 'page_numbers', label: '添加页码', inputMode: 'single-or-batch', supportsPages: true, supportsPageNumbers: true },
                    { id: 'crop', label: '裁切页面', inputMode: 'single-or-batch', supportsPages: true, supportsCrop: true },
                    { id: 'insert_blank', label: '插入空白页', inputMode: 'single-or-batch', supportsBlankPage: true }
                    ,{ id: 'redact', label: '永久脱敏（栅格化）', inputMode: 'single-or-batch', supportsRedaction: true }
                    ,{ id: 'page_plan', label: '页面工作区编排', inputMode: 'single', supportsPagePlan: true }
                ],
                presets: [{ id: 'internal-watermark', label: '内部材料水印', operation: 'watermark', config: { watermarkText: '内部资料', watermarkOpacity: 0.18 } }],
                engines: { cjkFont: { available: true, message: '字体可用' } }
            });
            if (url.includes('/jobs/101') && !url.includes('/outputs/')) return json(window.pdfFixtureDetail);
            if (url.includes('/jobs?')) return json({ data: [{ id: 101, status: 'queued', progress: 0, file: { originalName: '排队材料.pdf' }, config: { operation: 'watermark' } }], total: 1 });
            if (url.includes('/dispatch')) return json({ success: true, dispatch: { target: 'knowledge' } });
            return json({ success: true });
        };
        window.pdfFixtureDetail = null;
    });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.Pivot.legacy.PivotPdfTools.showPdfToolsApp());
    return page;
}

test('PDF 工具浏览器工作区呈现排队状态、扩展操作和结果详情', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPdfPage(browser);
        await expect(page.locator('#pdf-job-table-body')).toContainText('排队中');
        await expect(page.locator('[data-pdf-job-cancel="101"]')).toBeVisible();
        const quickPreset = page.locator('[data-pdf-quick-preset="internal-watermark"]');
        await expect(quickPreset).toBeVisible();
        await quickPreset.click();
        await expect(page.locator('#pdf-operation-select')).toHaveValue('watermark');
        await expect(page.locator('#pdf-watermark-text')).toHaveValue('内部资料');
        await expect(quickPreset).toHaveAttribute('aria-pressed', 'true');
        await quickPreset.click();
        await expect(quickPreset).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#pdf-operation-select')).toHaveValue('watermark');
        await expect(page.locator('#pdf-watermark-text')).toHaveValue('内部资料');
        await quickPreset.click();
        await expect(quickPreset).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-pdf-option="watermark"]')).toBeVisible();
        await expect(page.locator('[data-pdf-option="pages"]')).toBeVisible();
        await page.locator('#pdf-operation-select').selectOption('crop');
        await expect(quickPreset).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-pdf-option="crop"]')).toBeVisible();
        await page.locator('#pdf-operation-select').selectOption('insert_blank');
        await expect(page.locator('[data-pdf-option="blank"]')).toBeVisible();
        await page.locator('#pdf-operation-select').selectOption('redact');
        await expect(page.locator('[data-pdf-option="redaction"]')).toBeVisible();
        await page.evaluate(detail => { window.pdfFixtureDetail = detail; }, fixtureDetail());
        await page.locator('[data-pdf-job-open="101"]').click();
        await expect(page.locator('#pdf-detail-panel')).toBeVisible();
        await expect(page.locator('#pdf-detail')).toContainText('文件预检');
        await expect(page.locator('#pdf-detail')).toContainText('批量结果');
        await expect(page.locator('[data-pdf-output-dispatch="301"]')).toHaveCount(2);
        await page.locator('[data-pdf-open-page-plan]').click();
        await expect(page.locator('#pdf-page-plan-panel')).toBeVisible();
        await expect(page.locator('#pdf-page-plan-list')).toContainText('源页 1');
        await page.locator('[data-pdf-plan-blank]').click();
        await expect(page.locator('#pdf-page-plan-list')).toContainText('空白页');
        await page.locator('[data-pdf-plan-undo]').click();
        await expect(page.locator('#pdf-page-plan-list')).not.toContainText('空白页');
        await page.locator('[data-pdf-page-preview="11"]').click();
        await expect(page.locator('#pdf-page-preview-panel')).toBeVisible();
        assert.equal(await page.locator('#pdf-page-preview-image').getAttribute('src'), '/api/apps/pdf-tools/pages/11/image');
        await page.close();
    } finally {
        await browser.close();
    }
});

test('PDF 工具未选择文件时由应用提示，不触发不可聚焦的浏览器原生表单校验', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPdfPage(browser);
        const form = page.locator('#pdf-tools-form');
        await expect(form).toHaveAttribute('novalidate', '');
        await expect(page.locator('#pdf-files-input')).not.toHaveAttribute('required', '');
        await page.locator('#pdf-submit-btn').click();
        await expect.poll(() => page.evaluate(() => window.pdfToasts?.at(-1)?.message || '')).toBe('请选择需要处理的文件。');
        await expect(page.locator('#pdf-files-input')).toBeFocused();
        assert.equal((await page.evaluate(() => window.pdfRequests.filter(([url, method]) => url.endsWith('/jobs') && method === 'POST'))).length, 0);
        await page.close();
    } finally {
        await browser.close();
    }
});

test('PDF 工具仅提交当前操作的配置字段，避免触发 multipart 字段数量上限', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPdfPage(browser);
        await page.locator('#pdf-operation-select').selectOption('watermark');
        await page.locator('#pdf-files-input').setInputFiles({ name: '样例.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
        await page.locator('#pdf-submit-btn').click();
        await expect.poll(() => page.evaluate(() => window.pdfRequests.find(([url, method]) => url.endsWith('/jobs') && method === 'POST')?.[2] || null)).not.toBeNull();
        assert.deepEqual(await page.evaluate(() => window.pdfRequests.find(([url, method]) => url.endsWith('/jobs') && method === 'POST')?.[2]), [
            'operation', 'mode', 'watermarkText', 'watermarkPosition', 'watermarkOpacity'
        ]);
        await page.close();
    } finally {
        await browser.close();
    }
});
