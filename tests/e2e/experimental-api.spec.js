'use strict';

const { test, expect } = require('@playwright/test');

test('旧实验接口在真实应用中要求登录并明确报告不可用，DSL 解析仍可使用', async ({ page }) => {
    const anonymous = await page.request.get('/api/evaluation/suites');
    expect(anonymous.status()).toBe(401);

    const login = await page.request.post('/api/auth/login', {
        data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
    });
    expect(login.ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const operations = [
        ['/api/evaluation/suites', 'get'],
        ['/api/streaming/sessions', 'get'],
        ['/api/tools/recommend', 'post'],
        ['/api/planning/create', 'post'],
        ['/api/orchestration/execute', 'post']
    ];
    for (const [url, method] of operations) {
        const response = await page.request[method](url, { headers, ...(method === 'post' ? { data: {} } : {}) });
        expect(response.status(), url).toBe(503);
        expect((await response.json()).code).toBe('EXPERIMENTAL_API_UNAVAILABLE');
    }
    const catalog = await page.request.get('/api/tools/catalog');
    expect(catalog.status(), await catalog.text()).toBe(200);
    const example = await page.request.get('/api/orchestration/example');
    expect(example.status()).toBe(200);
    const parse = await page.request.post('/api/orchestration/parse', {
        headers,
        data: { dsl: (await example.json()).data.dsl }
    });
    expect(parse.status(), await parse.text()).toBe(200);
});
