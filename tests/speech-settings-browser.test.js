'use strict';
/* global window, document -- Chromium 页面执行上下文。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');

test('真实 Chromium 语音设置支持模式切换、密钥留空保存、测试、冲突提示和迟到响应隔离', async () => {
    const root = path.resolve(__dirname, '..');
    const modal = fs.readFileSync(path.join(root, 'client/chat/partials/admin-extra-modals.html'), 'utf8').split('    <!-- 公告编辑弹窗 -->')[0];
    const css = ['admin-retrieval-modals.css', 'admin-tables-models.css'].map(name => fs.readFileSync(path.join(root, 'client/chat/styles/admin', name), 'utf8')).join('\n');
    const server = http.createServer((req, res) => {
        if (req.url === '/speech-settings.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, 'client/chat/speech-settings.js'))); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
            :root{--text-main:#25313d;--text-muted:#637282;--border:#dbe2e8;--primary:#087f65;--bg-primary:white;--bg-secondary:#f4f7f9;--surface:white}
            *{box-sizing:border-box}body{font:14px Arial;margin:20px}.hidden{display:none!important}.modal-overlay{position:fixed;inset:0;background:#0006;z-index:100}
            input,select,textarea{font:inherit;width:100%;padding:8px;border:1px solid #dbe2e8;border-radius:6px}input[type=checkbox]{width:auto}
            button{font:inherit;padding:8px 12px;border:1px solid #cbd5df;border-radius:6px;cursor:pointer;background:white}.btn-primary{background:#087f65;color:white}
            ${css}</style></head><body><div id="retrieval-model-services-body" style="max-width:1100px"></div>${modal}</body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = { enabled: true, provider: 'embedded', revision: 'r1', source: 'settings', canManage: true, configured: true,
        endpoint: 'http://127.0.0.1:8000/transcribe', streamEndpoint: 'ws://127.0.0.1:8000/stream', model: '',
        hasApiKey: true, hotwords: '智枢', cpuThreads: 4, timeoutMs: 30000, endSilenceMs: 1000, maxConcurrent: 2, minConfidence: 0.65, allowExternal: false };
    let saved = { ...config }; const requests = []; let conflict = false; let delay = false;
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/settings/speech**', async route => {
            const req = route.request(); const payload = req.method() === 'GET' ? null : req.postDataJSON(); requests.push({ method: req.method(), payload });
            if (delay) { await new Promise(resolve => setTimeout(resolve, 250)); delay = false; }
            if (req.url().endsWith('/test')) { await new Promise(resolve => setTimeout(resolve, 70)); await route.fulfill({ json: { success: true, state: 'ready', message: '测试连接通过', streaming: true } }); return; }
            if (req.method() === 'PUT') {
                if (conflict) { await route.fulfill({ status: 409, json: { error: '语音配置已被其他操作更新，请重新加载后再保存。' } }); return; }
                saved = { ...saved, ...payload, apiKey: undefined, revision: 'r2', hasApiKey: true };
            }
            await route.fulfill({ json: { success: true, config: saved, status: { available: true, streaming: true, provider: saved.provider } } });
        });
        await page.goto(base);
        await page.evaluate(() => {
            const modules = new Map(); window.Pivot = { exposeModule: (name, api) => modules.set(name, api), moduleApi: (name, fallback = {}) => modules.get(name) || fallback };
            window.API_BASE = '/api'; window.apiFetch = (...args) => fetch(...args);
            window.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
            window.PivotSafeHtml = { setHtml: (node, html) => { node.innerHTML = html; } };
            window.showToast = message => { window.__toast = message; };
        });
        await page.addScriptTag({ url: '/speech-settings.js' });
        await page.evaluate(value => { window.PivotSafeHtml.setHtml(document.getElementById('retrieval-model-services-body'), window.Pivot.moduleApi('settings.speech').renderCard(value)); }, config);
        await page.locator('[data-speech-config-open]').click();
        await page.waitForFunction(() => !document.getElementById('speech-provider').disabled);
        assert.equal(await page.locator('#speech-api-key').inputValue(), '');
        assert.equal(await page.locator('#speech-embedded-fields').isVisible(), true);
        const embeddedLayout = await page.locator('#speech-embedded-fields').evaluate(element => {
            const parts = ['strong', 'p', 'label', 'input'].map(selector => element.querySelector(selector).getBoundingClientRect());
            return parts.map(rect => ({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width }));
        });
        for (let i = 1; i < embeddedLayout.length; i++) assert.ok(embeddedLayout[i].top >= embeddedLayout[i - 1].bottom, '内置识别说明与线程输入须纵向排列');
        assert.ok(embeddedLayout[0].width > 300, '说明文字不应挤成窄列');
        const visualOutput = path.join(root, '.tmp/speech-settings-visual'); fs.mkdirSync(visualOutput, { recursive: true });
        await page.screenshot({ path: path.join(visualOutput, 'embedded-runtime.png'), fullPage: true });
        await page.locator('#speech-provider').selectOption('gateway');
        assert.equal(await page.locator('#speech-embedded-fields').isVisible(), false);
        assert.equal(await page.locator('#speech-stream-field').isVisible(), true);
        assert.equal(await page.locator('#speech-model-field').isVisible(), false);
        await page.locator('#speech-provider').selectOption('openai');
        assert.equal(await page.locator('#speech-model-field').isVisible(), true);
        assert.equal(await page.locator('#speech-stream-field').isVisible(), false);
        await page.locator('#speech-provider').selectOption('gateway');
        const testButton = page.locator('#speech-config-test');
        await testButton.click(); await page.locator('#speech-hotwords').fill('用户继续输入');
        await page.waitForTimeout(130);
        assert.ok(!(await page.locator('#speech-config-status').textContent()).includes('测试连接通过'), '测试结果不能覆盖继续编辑后的状态');
        saved = { ...saved, revision: 'remote-r2' };
        await page.evaluate(() => window.Pivot.moduleApi('settings.speech').refreshStatus());
        await page.locator('#speech-config-save').click();
        await page.waitForFunction(() => document.getElementById('speech-config-status').textContent.includes('已保存并应用'));
        const put = requests.find(request => request.method === 'PUT');
        assert.equal(put.payload.provider, 'gateway'); assert.equal(put.payload.apiKey, ''); assert.equal(put.payload.revision, 'r1');
        assert.equal(await page.locator('#speech-api-key').inputValue(), '');
        assert.equal(await page.locator('#speech-hotwords').inputValue(), '用户继续输入');
        await page.locator('#speech-api-key').fill('draft-only-private-key');
        await page.locator('[data-speech-close]').first().click();
        assert.equal(await page.locator('#speech-api-key').inputValue(), '');
        delay = true; await page.locator('[data-speech-config-open]').click(); await page.locator('[data-speech-close]').first().click();
        await page.waitForTimeout(350); assert.equal(await page.locator('#speech-service-modal').isVisible(), false);
        await page.locator('[data-speech-config-open]').click(); await page.waitForFunction(() => !document.getElementById('speech-provider').disabled);
        conflict = true; await page.locator('#speech-config-save').click();
        await page.waitForFunction(() => document.getElementById('speech-config-status').textContent.includes('重新加载'));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(80);
        const fits = await page.locator('#speech-service-modal .model-modal').evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
        assert.ok(fits.width <= 390 && fits.scrollWidth <= fits.clientWidth + 1, JSON.stringify(fits));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('非最高管理员角色展示只读统一维护状态，并能通过语音能力接口自动更新为就绪', async () => {
    const root = path.resolve(__dirname, '..');
    const server = http.createServer((req, res) => {
        if (req.url === '/speech-settings.js') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(path.join(root, 'client/chat/speech-settings.js')));
            return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="retrieval-model-services-body"></div></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    const nonAdminConfig = {
        enabled: true,
        provider: 'gateway',
        revision: 'r1',
        source: 'settings',
        canManage: false,
        configured: true,
        endpoint: '********',
        streamEndpoint: '********',
        hasApiKey: true
    };
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        let voiceRecognitionRequested = false;
        await page.route('**/api/chat/voice-recognition**', async route => {
            voiceRecognitionRequested = true;
            await route.fulfill({
                json: {
                    success: true,
                    available: true,
                    streaming: true,
                    provider: 'gateway',
                    languages: ['zh-CN']
                }
            });
        });
        await page.goto(base);
        await page.evaluate(() => {
            const modules = new Map();
            window.Pivot = { exposeModule: (name, api) => modules.set(name, api), moduleApi: (name, fallback = {}) => modules.get(name) || fallback };
            window.API_BASE = '/api';
            window.apiFetch = (...args) => fetch(...args);
            window.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
            window.PivotSafeHtml = { setHtml: (node, html) => { node.innerHTML = html; } };
            window.showToast = () => {};
        });
        await page.addScriptTag({ url: '/speech-settings.js' });
        await page.evaluate(value => {
            window.PivotSafeHtml.setHtml(document.getElementById('retrieval-model-services-body'), window.Pivot.moduleApi('settings.speech').renderCard(value));
        }, nonAdminConfig);

        const card = page.locator('#speech-model-service-card');
        assert.ok(await card.textContent().then(t => t.includes('由系统管理员统一维护')));
        assert.ok(await card.textContent().then(t => t.includes('已配置，等待检查运行状态')));
        assert.equal(await page.locator('[data-speech-config-open]').count(), 0);
        assert.equal(await page.locator('[data-speech-card-test]').count(), 0);

        await page.evaluate(() => window.Pivot.moduleApi('settings.speech').refreshStatus());
        await page.waitForFunction(() => document.getElementById('speech-model-service-card')?.textContent.includes('服务已就绪 · 双遍流式识别'));
        assert.equal(voiceRecognitionRequested, true);
        assert.equal(await card.evaluate(el => el.classList.contains('is-ready')), true);
        assert.equal(await card.evaluate(el => el.classList.contains('is-warning')), false);
        assert.ok(await card.textContent().then(t => t.includes('由系统管理员统一维护')));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
