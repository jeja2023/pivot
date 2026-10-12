/* global Response, TextEncoder, ReadableStream, window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规问答以流式方式显示增量并保留可回溯依据', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.evaluate(() => {
            window.createBrowserSseParser = ({ onData, onDone } = {}) => {
                let buffer = '';
                let done = false;
                const flush = raw => {
                    const payload = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.replace(/^data:\s?/, '')).join('\n');
                    if (!payload) return;
                    if (payload === '[DONE]') {
                        done = true;
                        onDone?.();
                        return;
                    }
                    onData?.(payload);
                };
                return {
                    write(text) {
                        buffer += String(text || '').replace(/\r\n/g, '\n');
                        let boundary = buffer.indexOf('\n\n');
                        while (boundary >= 0) {
                            flush(buffer.slice(0, boundary));
                            buffer = buffer.slice(boundary + 2);
                            boundary = buffer.indexOf('\n\n');
                        }
                    },
                    end() { if (buffer.trim()) flush(buffer); buffer = ''; },
                    isDone: () => done
                };
            };
            window.apiFetch = async (_url, options) => {
                window.testAiStreamPayload = JSON.parse(options.body);
                const encoder = new TextEncoder();
                const source = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"type":"apps.extra","sources":[{"index":1,"documentId":1,"versionId":1,"articleId":11,"label":"测试法规 / v1 / 第一条","excerpt":"依据正文"}]}\n\n'));
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段回答。"}}]}\n\n'));
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第二段回答。"}}]}\n\n'));
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        controller.close();
                    }
                });
                return new Response(source, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
            };
        });
        await page.evaluate(() => {
            const ns = window.Pivot.legacy.PivotRegulationsInternal;
            ns.state.activeId = 1;
            ns.state.detail = { document: { id: 1, title: '测试法规', status: 'active' }, currentVersion: { id: 1, version_label: 'v1' }, versions: [{ id: 1, version_label: 'v1' }], articles: [] };
        });
        await page.locator('#regulations-ai-open-btn').click();
        await page.locator('#regulations-ai-scope').selectOption('document');
        await page.locator('#regulations-ai-question').fill('这条法规如何执行？');
        await page.locator('#regulations-ai-btn').click();
        await expect(page.locator('#regulations-ai-answer')).toContainText('第一段回答。第二段回答。');
        await expect(page.locator('#regulations-ai-answer')).toContainText('测试法规 / v1 / 第一条');
        await expect(page.locator('[data-regulation-export-format="docx"]')).toHaveCount(1);
        await expect(page.locator('[data-regulation-export-format="pdf"]')).toHaveCount(1);
        await expect(page.locator('#regulations-ai-stop-btn')).toBeHidden();
        const payload = await page.evaluate(() => window.testAiStreamPayload);
        assert.equal(payload.stream, true);
        assert.equal(payload.documentId, 1);
        await page.close();
    } finally {
        await browser.close();
    }
});
