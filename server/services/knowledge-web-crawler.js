'use strict';
/* global document */
const { safeJsonRequest } = require('./safe-http-client');
const { assertSafeMcpOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');

function normalizeCrawlConfig(input = {}) {
    const start = new URL(input.url);
    if (!['http:', 'https:'].includes(start.protocol) || start.username || start.password) throw new Error('网页来源只支持无内嵌凭据的 HTTP/HTTPS 地址。');
    const prefix = String(input.pathPrefix || new URL('.', start).pathname);
    if (!prefix.startsWith('/') || prefix.includes('..') || !start.pathname.startsWith(prefix)) throw new Error('网页抓取路径范围无效。');
    return { url: start.href, origin: start.origin, pathPrefix: prefix, maxPages: Math.min(Math.max(Number.parseInt(input.maxPages, 10) || 10, 1), 30),
        selector: String(input.selector || 'article, main, [role="main"]').slice(0, 200), waitForSelector: String(input.waitForSelector || '').slice(0, 200),
        credentialRef: String(input.credentialRef || '').slice(0, 64), cookieCredentialRef: String(input.cookieCredentialRef || '').slice(0, 64) };
}

async function crawlKnowledgePages(input, user, { signal, launchBrowser, request = safeJsonRequest } = {}) {
    if (!require('../permissions').isAdmin(user)) throw Object.assign(new Error('网页来源抓取仅允许管理员配置和运行。'), { status: 403 });
    const config = normalizeCrawlConfig(input);
    await assertSafeMcpOutboundUrl(config.url, user);
    const headers = {};
    if (config.credentialRef) {
        const credential = await resolveCredentialSecret(config.credentialRef, user);
        if (!credential?.value) throw new Error('网页来源凭据不可用。');
        headers.Authorization = `Bearer ${credential.value}`;
    }
    const chromium = require('playwright').chromium;
    const browser = await (launchBrowser || (() => chromium.launch({ headless: true,
        executablePath: require('./agent-browser').resolveChromiumExecutable(chromium, {}), args: ['--disable-dev-shm-usage'] })))();
    const abort = () => { void browser.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 90000);
    let bytes = 0, requests = 0;
    try {
        signal?.throwIfAborted();
        const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        if (config.cookieCredentialRef) {
            const secret = await resolveCredentialSecret(config.cookieCredentialRef, user);
            const cookies = JSON.parse(secret?.value || 'null');
            if (!Array.isArray(cookies) || cookies.length > 20) throw new Error('登录凭据必须是受限 Cookie 列表。');
            await context.addCookies(cookies.map(cookie => {
                if (!/^[\w-]{1,80}$/.test(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 4096) throw new Error('Cookie 凭据格式无效。');
                return { name: cookie.name, value: cookie.value, url: config.origin, httpOnly: true, secure: startSecure(config.origin), sameSite: 'Strict' };
            }));
        }
        // 所有页面、脚本和 XHR 均经现有 DNS 固定的安全客户端转发；不让 Chromium 自行解析联网。
        await context.route('**/*', async route => {
            try {
                if (++requests > 300 || bytes > 12 * 1024 * 1024) throw new Error('抓取资源预算已耗尽。');
                const req = route.request(), url = new URL(req.url());
                if (url.origin !== config.origin || url.username || url.password || !['GET', 'HEAD'].includes(req.method()) || ['image', 'font', 'media'].includes(req.resourceType())) return await route.abort();
                const response = await request({ url: url.href, method: req.method(), headers: { ...headers, Cookie: await context.cookies(url.href).then(items => items.map(item => `${item.name}=${item.value}`).join('; ')) },
                    user, assertUrl: assertSafeMcpOutboundUrl, createAgents: actor => createSafeHttpAgentsForUser(actor, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS' }),
                    responseType: 'arraybuffer', timeout: 10000, maxContentLength: 2 * 1024 * 1024, signal, validateStatus: () => true });
                bytes += response.data.length;
                if (response.status >= 300 && response.status < 400) return await route.abort();
                await route.fulfill({ status: response.status, body: Buffer.from(response.data), contentType: String(response.headers['content-type'] || 'text/plain') });
            } catch (_) { await route.abort().catch(() => {}); }
        });
        await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage(), queue = [config.url], seen = new Set(), items = [];
        while (queue.length && items.length < config.maxPages) {
            signal?.throwIfAborted();
            const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            if (!response || response.status() !== 200) throw new Error('网页来源无法读取，请检查认证、状态和网络。');
            if (config.waitForSelector) await page.locator(config.waitForSelector).first().waitFor({ timeout: 10000 });
            const extracted = await page.evaluate(selector => {
                const selected = document.querySelector(selector);
                if (!selected) throw new Error('未找到配置的正文区域，请检查登录状态与页面选择器。');
                const clone = selected.cloneNode(true);
                clone.querySelectorAll('script,style,nav,header,footer,aside,form,button,[aria-hidden="true"]').forEach(node => node.remove());
                const markdown = node => {
                    if (node.nodeType === node.TEXT_NODE) return node.textContent;
                    if (node.nodeType !== node.ELEMENT_NODE) return '';
                    const tag = node.tagName.toLowerCase();
                    const content = [...node.childNodes].map(markdown).join('');
                    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
                    if (tag === 'li') return `\n- ${content.trim()}`;
                    if (['p', 'article', 'section', 'div', 'ul', 'ol'].includes(tag)) return `\n\n${content.trim()}\n\n`;
                    if (tag === 'br') return '\n';
                    if (tag === 'tr') return `\n| ${[...node.children].map(cell => cell.textContent.replace(/\|/g, '\\|')).join(' | ')} |`;
                    if (tag === 'table') return `\n\n${content}\n\n`;
                    return content;
                };
                return { title: document.title, text: markdown(clone), links: [...document.querySelectorAll('a[href]')].map(a => a.href).slice(0, 500) };
            }, config.selector);
            const content = String(extracted.text || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
            if (!content || content.length > 200000) throw new Error('网页正文为空或超过限制，请调整正文选择器。');
            items.push({ id: url, uri: url, title: String(extracted.title || url).slice(0, 200), content: `# ${String(extracted.title || '内网资料').replace(/[\r\n]/g, ' ')}\n\n${content}` });
            for (const href of extracted.links) {
                const next = new URL(href); next.hash = '';
                const withinPath = next.pathname === config.pathPrefix || next.pathname.startsWith(config.pathPrefix.endsWith('/') ? config.pathPrefix : config.pathPrefix + '/');
                if (next.origin === config.origin && withinPath && !next.username && !next.password && !seen.has(next.href) && queue.length < 100) queue.push(next.href);
            }
        }
        return { items, complete: queue.length === 0, bytes, requests };
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); await browser.close(); }
}

function startSecure(origin) { return origin.startsWith('https:'); }
module.exports = { normalizeCrawlConfig, crawlKnowledgePages };
