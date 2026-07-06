const path = require('path');

const MANUAL_PATH = path.resolve(__dirname, '../使用帮助.md');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeHref(href) {
    const value = String(href || '').trim();
    if (/^(https?:|mailto:|\/|#)/i.test(value)) return escapeHtml(value);
    return '#';
}

function renderInline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)]\(([^)]+)\)/g, (match, label, href) => {
        return `<a href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return html;
}

function closeList(state, chunks) {
    if (!state.listType) return;
    chunks.push(`</${state.listType}>`);
    state.listType = '';
}

function openList(type, state, chunks) {
    if (state.listType === type) return;
    closeList(state, chunks);
    chunks.push(`<${type}>`);
    state.listType = type;
}

const VERSION_UPDATE_HEADING_RE = /^##\s+(?:\[?v?\d+\.\d+\.\d+\]?\s*(?:更新提示|更新摘要|更新记录|更新日志|版本更新|版本更新记录)|(?:版本更新记录|版本更新|更新记录|更新日志))\s*$/i;
const SECOND_LEVEL_HEADING_RE = /^##\s+/;

function stripVersionUpdateSections(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const kept = [];
    let skipping = false;
    let inFence = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            if (!skipping) kept.push(line);
            inFence = !inFence;
            continue;
        }

        if (!inFence && VERSION_UPDATE_HEADING_RE.test(trimmed)) {
            skipping = true;
            continue;
        }

        if (!inFence && skipping && SECOND_LEVEL_HEADING_RE.test(trimmed)) {
            skipping = false;
        }

        if (!skipping) kept.push(line);
    }

    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function renderMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const chunks = [];
    const state = { listType: '', inCode: false, codeLines: [], codeLang: '' };

    const closeCode = () => {
        const langClass = state.codeLang ? ` class="language-${escapeHtml(state.codeLang)}"` : '';
        chunks.push(`<pre><code${langClass}>${escapeHtml(state.codeLines.join('\n'))}</code></pre>`);
        state.inCode = false;
        state.codeLines = [];
        state.codeLang = '';
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/g, '');
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            if (state.inCode) {
                closeCode();
            } else {
                closeList(state, chunks);
                state.inCode = true;
                state.codeLang = trimmed.slice(3).trim().replace(/[^\w-]/g, '');
                state.codeLines = [];
            }
            continue;
        }

        if (state.inCode) {
            state.codeLines.push(rawLine);
            continue;
        }

        if (!trimmed) {
            closeList(state, chunks);
            continue;
        }

        const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (heading) {
            closeList(state, chunks);
            const level = heading[1].length;
            chunks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
            continue;
        }

        const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
        if (ordered) {
            openList('ol', state, chunks);
            chunks.push(`<li>${renderInline(ordered[1])}</li>`);
            continue;
        }

        const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
        if (unordered) {
            openList('ul', state, chunks);
            chunks.push(`<li>${renderInline(unordered[1])}</li>`);
            continue;
        }

        closeList(state, chunks);
        chunks.push(`<p>${renderInline(trimmed)}</p>`);
    }

    if (state.inCode) closeCode();
    closeList(state, chunks);
    return chunks.join('\n');
}

function renderManualHtml(markdown, { appVersion = '', nonce = '', embedded = false } = {}) {
    const body = renderMarkdown(stripVersionUpdateSections(markdown));
    const safeVersion = escapeHtml(appVersion || '');
    const safeNonce = escapeHtml(nonce || '');
    const topbarHtml = embedded ? '' : `        <header class="manual-topbar">
            <div class="manual-brand">
                <strong>Pivot 使用帮助</strong>
                <span>版本 ${safeVersion || 'current'} · 面向普通用户的操作说明</span>
            </div>
            <nav class="manual-actions" aria-label="帮助操作">
                <a href="/chat">返回系统</a>
            </nav>
        </header>`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pivot 使用帮助</title>
    <style nonce="${safeNonce}">
        :root { color-scheme: light; --primary: #10a37f; --text: #0f172a; --muted: #64748b; --border: #e2e8f0; --bg: #f8fafc; }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.72; }
        .manual-shell { min-height: 100vh; display: flex; flex-direction: column; }
        .manual-topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; background: rgba(255, 255, 255, 0.92); border-bottom: 1px solid var(--border); backdrop-filter: blur(16px); }
        .manual-brand { display: flex; flex-direction: column; min-width: 0; }
        .manual-brand strong { font-size: 15px; }
        .manual-brand span { color: var(--muted); font-size: 12px; }
        .manual-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .manual-actions a { height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; color: #334155; background: #fff; text-decoration: none; font-size: 13px; font-weight: 700; }
        .manual-actions a:hover { color: var(--primary); border-color: rgba(16, 163, 127, 0.4); }
        main { width: min(980px, calc(100vw - 32px)); margin: 24px auto 48px; padding: 34px 42px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 18px 46px rgba(15, 23, 42, 0.06); }
        h1 { margin: 0 0 16px; font-size: 30px; line-height: 1.25; }
        h2 { margin: 34px 0 12px; padding-top: 18px; border-top: 1px solid #eef2f7; font-size: 22px; line-height: 1.35; }
        h3 { margin: 24px 0 8px; font-size: 17px; line-height: 1.4; }
        p { margin: 8px 0; }
        ul, ol { margin: 8px 0 14px 22px; padding: 0; }
        li { margin: 4px 0; padding-left: 2px; }
        code { padding: 2px 5px; border-radius: 5px; background: #f1f5f9; color: #0f766e; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
        pre { margin: 12px 0 18px; padding: 14px 16px; overflow: auto; border-radius: 8px; background: #0f172a; color: #e2e8f0; }
        pre code { padding: 0; background: transparent; color: inherit; }
        a { color: #047857; text-decoration: none; }
        a:hover { text-decoration: underline; }
        body.manual-embedded { background: #fff; }
        body.manual-embedded main { width: 100%; min-height: 100vh; margin: 0; padding: 24px 32px 44px; border: 0; border-radius: 0; box-shadow: none; }
        body.manual-embedded h1 { font-size: 26px; }
        @media (max-width: 720px) {
            .manual-topbar { padding: 10px 14px; align-items: flex-start; }
            .manual-brand span { display: none; }
            main { width: 100%; margin: 0; padding: 22px 18px 36px; border-left: 0; border-right: 0; border-radius: 0; }
            h1 { font-size: 24px; }
            h2 { font-size: 20px; }
        }
    </style>
</head>
<body${embedded ? ' class="manual-embedded"' : ''}>
    <div class="manual-shell">
${topbarHtml}
        <main>${body}</main>
    </div>
</body>
</html>`;
}

module.exports = {
    MANUAL_PATH,
    renderManualHtml,
    renderMarkdown,
    stripVersionUpdateSections
};
