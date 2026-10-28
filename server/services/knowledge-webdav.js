'use strict';

const { DOMParser } = require('@xmldom/xmldom');
const { safeJsonRequest } = require('./safe-http-client');
const { assertSafeMcpOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');
const crypto = require('node:crypto');

function normalizeWebdavConfig(input = {}) {
    const url = new URL(String(input.url || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%(?:2f|5c)/i.test(url.pathname) || url.pathname.includes('\\')) throw new Error('WebDAV 地址必须是不含凭据或参数的 HTTP/HTTPS 目录。');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return { url: url.href, credentialRef: String(input.credentialRef || '').trim().slice(0, 64), maxFiles: Math.min(Math.max(Number.parseInt(input.maxFiles, 10) || 100, 1), 1000),
        recursive: input.recursive === true, maxDepth: Math.min(Math.max(Number.parseInt(input.maxDepth, 10) || 3, 1), 5), syncDeletes: input.syncDeletes === true };
}

function webdavScopeFingerprint(config) {
    return crypto.createHash('sha256').update(JSON.stringify({
        url: config.url, recursive: config.recursive, maxDepth: config.maxDepth,
        maxFiles: config.maxFiles, credentialRef: config.credentialRef
    })).digest('hex');
}

function isWithinWebdavScope(uri, config) {
    try {
        const root = new URL(config.url), target = new URL(uri);
        if (target.origin !== root.origin || target.username || target.password || target.search || target.hash
            || !target.pathname.startsWith(root.pathname) || /%(?:2f|5c)/i.test(target.pathname)) return false;
        const parts = target.pathname.slice(root.pathname.length).split('/');
        if (parts.some(part => !part)) return false;
        const depth = parts.length - 1;
        return depth === 0 || (config.recursive === true && depth <= config.maxDepth);
    } catch (_) { return false; }
}

async function listWebdavFiles(input, user, deps = {}) {
    const config = normalizeWebdavConfig(input);
    const root = new URL(config.url);
    const headers = { Depth: '1', 'Content-Type': 'application/xml', Accept: 'application/xml' };
    let authorization = '';
    if (config.credentialRef) {
        if (root.protocol !== 'https:') throw new Error('使用 WebDAV 凭据时必须使用 HTTPS。');
        const credential = await (deps.resolveCredentialSecret || resolveCredentialSecret)(config.credentialRef, user);
        if (!credential?.value) throw new Error('WebDAV 凭据不存在或无权使用。');
        authorization = `Bearer ${credential.value}`;
    }
    const request = deps.request || safeJsonRequest;
    const items = [];
    let incomplete = false;
    const queue = [{ url: root, depth: 0 }], visited = new Set(), files = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (visited.has(current.url.href)) continue;
        if (visited.size >= 100) { incomplete = true; break; }
        visited.add(current.url.href);
        const response = await request({ method: 'PROPFIND', url: current.url.href, user, headers: { ...headers, ...(authorization ? { Authorization: authorization } : {}) },
            data: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>',
            assertUrl: assertSafeMcpOutboundUrl,
            createAgents: actor => createSafeHttpAgentsForUser(actor, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS' }),
            responseType: 'text', timeout: 30000, maxContentLength: 4 * 1024 * 1024, validateStatus: status => status === 207 });
        if (response.status !== 207 || /<!DOCTYPE|<!ENTITY/i.test(String(response.data || ''))) throw new Error('WebDAV 返回了无效的目录清单。');
        let parseError = false;
        const xml = new DOMParser({ onError: () => { parseError = true; } }).parseFromString(String(response.data || ''), 'text/xml');
        if (parseError || xml.documentElement?.localName !== 'multistatus') throw new Error('WebDAV 目录清单格式无效。');
        const entries = [...xml.getElementsByTagNameNS('DAV:', 'response')];
        let rootConfirmed = false;
        for (const entry of entries) {
        const href = entry.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
        if (!href.trim()) { incomplete = true; continue; }
        let target;
        try { target = new URL(href, current.url); } catch (_) { incomplete = true; continue; }
        if (target.origin !== root.origin || target.username || target.password || target.search || target.hash || !target.pathname.startsWith(root.pathname) || /%(?:2f|5c)/i.test(target.pathname)) { incomplete = true; continue; }
        if (target.pathname === current.url.pathname || target.pathname === current.url.pathname.replace(/\/$/, '')) {
            const propstats = [...entry.getElementsByTagNameNS('DAV:', 'propstat')];
            rootConfirmed = propstats.some(propstat => /(?:^|\s)2\d\d(?:\s|$)/.test(propstat.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent || '')
                && propstat.getElementsByTagNameNS('DAV:', 'collection').length > 0);
            if (!rootConfirmed) incomplete = true;
            continue;
        }
        if (!target.pathname.startsWith(current.url.pathname)) { incomplete = true; continue; }
        const rest = target.pathname.slice(current.url.pathname.length);
        const status = [...entry.getElementsByTagNameNS('DAV:', 'status')].map(node => node.textContent || '');
        if (!status.some(value => /\s2\d\d\s/.test(value))) { incomplete = true; continue; }
        const isDirectory = entry.getElementsByTagNameNS('DAV:', 'collection').length > 0;
        if (isDirectory) {
            if (!rest || rest.replace(/\/$/, '').includes('/')) { incomplete = true; continue; }
            if (config.recursive && current.depth < config.maxDepth) {
                if (!target.pathname.endsWith('/')) target.pathname += '/';
                if (!visited.has(target.href)) queue.push({ url: target, depth: current.depth + 1 });
            } else if (config.recursive) incomplete = true;
            continue;
        }
        if (!rest || rest.includes('/')) { incomplete = true; continue; }
        let title;
        try { title = decodeURIComponent(rest); } catch (_) { incomplete = true; continue; }
        if (!/\.(?:txt|md|pdf|doc|docx|xls|xlsx|csv|json|html|htm)$/i.test(title)) continue;
        if (files.has(target.href)) continue;
        if (items.length >= config.maxFiles) { incomplete = true; continue; }
        files.add(target.href);
        const item = { title, canonicalUri: target.href, downloadUrl: target.href };
        Object.defineProperty(item, 'headers', { value: authorization ? { Authorization: authorization } : {}, enumerable: false });
        items.push(item);
        }
        if (!rootConfirmed) incomplete = true;
    }
    return { items, complete: !incomplete };
}

module.exports = { normalizeWebdavConfig, webdavScopeFingerprint, isWithinWebdavScope, listWebdavFiles };
