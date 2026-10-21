/* global window -- 统一语音服务真实页面验收。 */
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

test('模型配置页统一管理语音 API，保存后生效且刷新保留，加密密钥不回显', async ({ page }) => {
    test.setTimeout(90000);
    const key = 'speech-e2e-private-service-key-32-characters';
    const gateway = http.createServer((req, res) => {
        if (req.url !== '/health' || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end(); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ready: true, backend: 'test', streaming: true }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const origin = `127.0.0.1:${gateway.address().port}`;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
        expect(login.ok()).toBeTruthy(); await page.goto('/chat');
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'models' }));
        await expect(page.locator('#retrieval-model-services-body')).toContainText('语音识别服务');
        await page.locator('[data-speech-config-open]').click();
        await expect(page.locator('#speech-provider')).toBeEnabled();
        await page.locator('#speech-provider').selectOption('gateway');
        await page.locator('#speech-endpoint').fill(`http://${origin}/transcribe`);
        await page.locator('#speech-stream-endpoint').fill(`ws://${origin}/stream`);
        await page.locator('#speech-api-key').fill(key);
        await page.locator('#speech-hotwords').fill('智枢,中华人民共和国刑法');
        await page.locator('#speech-config-test').click();
        await expect(page.locator('#speech-config-status')).toContainText('内网语音网关已就绪');
        await page.locator('#speech-config-save').click();
        await expect(page.locator('#speech-config-status')).toContainText('已保存并应用');
        await expect(page.locator('#speech-api-key')).toHaveValue('');
        const settings = await (await page.request.get('/api/settings')).json();
        expect(settings.speechConfig.provider).toBe('gateway'); expect(settings.speechConfig.hasApiKey).toBe(true);
        expect(JSON.stringify(settings)).not.toContain(key);
        const capability = await (await page.request.get('/api/chat/voice-recognition')).json();
        expect(capability.provider).toBe('gateway'); expect(capability.available).toBe(true); expect(capability.streaming).toBe(true);
        const output = path.resolve(__dirname, '../../.tmp/speech-settings-visual'); fs.mkdirSync(output, { recursive: true });
        await page.waitForTimeout(2500);
        await page.locator('#speech-service-form').evaluate(element => { element.scrollTop = 0; });
        await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
        await page.locator('[data-speech-close]').first().click();
        await page.reload();
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'models' }));
        await page.locator('[data-speech-config-open]').click(); await expect(page.locator('#speech-provider')).toBeEnabled();
        await expect(page.locator('#speech-provider')).toHaveValue('gateway');
        await expect(page.locator('#speech-endpoint')).toHaveValue(`http://${origin}/transcribe`);
        await expect(page.locator('#speech-api-key')).toHaveValue('');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
        const fit = await page.locator('#speech-service-modal .model-modal').evaluate(element => ({ width: element.getBoundingClientRect().width, content: element.scrollWidth, client: element.clientWidth }));
        expect(fit.width).toBeLessThanOrEqual(390); expect(fit.content).toBeLessThanOrEqual(fit.client + 1);
        await page.locator('#speech-provider').selectOption('embedded');
        await expect(page.locator('#speech-remote-fields')).toBeHidden();
        // 在测试机关闭功能再保存，验证切回内置配置而不依赖该 Windows 机的 Python 语音包。
        await page.locator('#speech-enabled').uncheck();
        await page.locator('#speech-config-save').click();
        await expect(page.locator('#speech-config-status')).toContainText('已保存并应用');
        const disabled = await (await page.request.get('/api/chat/voice-recognition')).json(); expect(disabled.available).toBe(false);
        expect(errors).toEqual([]);
    } finally { await new Promise(resolve => gateway.close(resolve)); }
});
