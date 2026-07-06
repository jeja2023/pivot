(function () {
    const ns = window.PivotRegulationsInternal || {};
    if (ns.coreReady) return;
    window.PivotRegulationsInternal = ns;
    const API = '/api/apps/regulations';
        const FILE_ACCEPT = '.txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.csv,.json,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp';
        const SUPPORTED_FORMATS = 'TXT、Markdown、PDF、Word（DOC/DOCX）、Excel（XLS/XLSX）、CSV、JSON、HTML/HTM';
        const REGULATIONS_PAGE_SIZE = 20;
        const html = window.PivotSafeHtml || {
            escapeHtml(value) {
                return String(value ?? '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;');
            }
        };

        const state = {
            documents: [], total: 0, activeId: '', detail: null, matches: [], query: '',
            searchMode: 'hybrid', savedSearches: [],
            filters: { category: '', jurisdiction: '', includeArchived: false },
            aiAnswer: '', aiSources: [], aiTurns: [], aiBusy: false,
            facets: { categories: [], jurisdictions: [] },
            page: 1, pageSize: REGULATIONS_PAGE_SIZE,
            diffView: null,
            busy: false, loaded: false
        };

        const PRESETS = {
            law: { category: '法律', issuingBody: '全国人民代表大会', jurisdiction: '全国' },
            lawSc: { category: '法律', issuingBody: '全国人大常委会', jurisdiction: '全国' },
            regulation: { category: '行政法规', issuingBody: '国务院', jurisdiction: '全国' },
            interpretation: { category: '司法解释', issuingBody: '最高人民法院', jurisdiction: '全国' },
            procuratorate: { category: '司法解释', issuingBody: '最高人民检察院', jurisdiction: '全国' },
            rule: { category: '部门规章', issuingBody: '', jurisdiction: '全国' }
        };

        function esc(value) { return html.escapeHtml(value); }

        // 将正文按 Markdown 渲染为带排版的 HTML，渲染器不可用时回退为转义纯文本
        function renderRichText(content) {
            const text = String(content || '').trim();
            if (!text) return '';
            if (typeof window.renderMarkdown === 'function') {
                try {
                    const htmlText = window.renderMarkdown(text);
                    if (htmlText) return htmlText;
                } catch (_) { /* 渲染失败时回退到纯文本展示 */ }
            }
            return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
        }

        function stripMarkdownTitleLine(value) {
            return String(value || '')
                .trim()
                .replace(/^#{1,6}\s*/, '')
                .replace(/^>\s*/, '')
                .replace(/^[-*+]\s+/, '')
                .replace(/^\d+[.)、]\s+/, '')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/[*_`~]+/g, '')
                .split(/\s+#{1,6}\s+/)[0]
                .trim();
        }

        // 去除标题里残留的 Markdown 标记符号和摘要换行，表格中只展示纯标题
        function cleanDisplayTitle(value, fallback = '未命名法规') {
            const lines = String(value || fallback || '')
                .replace(/\r/g, '\n')
                .split('\n')
                .map(stripMarkdownTitleLine)
                .filter(Boolean);
            return lines[0] || fallback;
        }

        function cleanArticleTitle(value) {
            return cleanDisplayTitle(value, '');
        }

        function escapeRegExp(value) {
            return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        // 在转义后的文本上高亮检索词，仅注入受控的 <mark> 标签，无 XSS 风险
        function highlightText(text, query) {
            const safe = esc(text || '');
            const terms = String(query || '').trim().split(/\s+/).map(esc).filter(term => term.length >= 1);
            if (!terms.length) return safe;
            const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
            return safe.replace(pattern, '<mark class="regulations-hl">$1</mark>');
        }

        function getActiveUser() {
            return typeof currentUser !== 'undefined' ? currentUser : window.currentUser;
        }

        function canManage() {
            const user = getActiveUser();
            if (typeof isAdminUser === 'function' && isAdminUser(user)) return true;
            const tier = String(user?.permissionTier || user?.permission_tier || '').toLowerCase();
            return user?.isAdmin === true
                || user?.is_admin === true
                || tier === 'admin'
                || tier === 'manager';
        }

        function canImportDocuments() {
            const user = getActiveUser();
            return String(user?.username || '').toLowerCase() === 'admin';
        }

        function getRegulationsSelectedModelId() {
            return document.getElementById('model-selector')?.value || '';
        }

        // 删除类操作统一走项目内自定义确认弹窗（不使用浏览器默认 confirm）；showConfirm 不可用时回退
        function regulationConfirm(title, message) {
            return new Promise((resolve) => {
                if (typeof window.showConfirm === 'function') {
                    window.showConfirm(title, message, () => resolve(true));
                    const cancelBtn = document.getElementById('modal-confirm-cancel');
                    const container = document.getElementById('confirm-container');
                    const cleanup = (result) => {
                        cancelBtn?.removeEventListener('click', onCancel);
                        container?.removeEventListener('click', onOverlay);
                        resolve(result);
                    };
                    const onCancel = () => cleanup(false);
                    const onOverlay = (event) => { if (event.target === container) cleanup(false); };
                    cancelBtn?.addEventListener('click', onCancel, { once: true });
                    container?.addEventListener('click', onOverlay, { once: true });
                    return;
                }
                resolve(typeof window.confirm === 'function' ? window.confirm(message) : true);
            });
        }

        function canDeleteDocuments() {
            const user = getActiveUser();
            if (typeof isSuperAdminUser === 'function' && isSuperAdminUser(user)) return true;
            const tier = String(user?.permissionTier || user?.permission_tier || '').toLowerCase();
            const username = String(user?.username || '').trim().toLowerCase();
            return user?.isSuperAdmin === true
                || user?.is_super_admin === true
                || tier === 'admin'
                || (username === 'admin' && (user?.role === 'admin' || user?.isAdmin === true || user?.is_admin === true));
        }

        function toast(message, type) { if (typeof showToast === 'function') showToast(message, type); }

        async function fetchJson(url, options = {}) {
            const res = await apiFetch(url, options);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error?.message || data?.error || `请求失败（${res.status}）`);
            return data;
        }

        function fmtSize(value) {
            const size = Number(value || 0);
            if (!Number.isFinite(size) || size <= 0) return '-';
            if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
            if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
            return `${size} B`;
        }

        function fmtDate(value) {
            if (!value) return '-';
            if (typeof formatDateToCN === 'function') return formatDateToCN(value);
            return String(value).slice(0, 16) || '-';
        }

    Object.assign(ns, {
        API,
        FILE_ACCEPT,
        SUPPORTED_FORMATS,
        REGULATIONS_PAGE_SIZE,
        html,
        state,
        PRESETS,
        esc,
        renderRichText,
        stripMarkdownTitleLine,
        cleanDisplayTitle,
        cleanArticleTitle,
        escapeRegExp,
        highlightText,
        getActiveUser,
        canManage,
        canImportDocuments,
        getRegulationsSelectedModelId,
        regulationConfirm,
        canDeleteDocuments,
        toast,
        fetchJson,
        fmtSize,
        fmtDate,
        coreReady: true
    });
})();
