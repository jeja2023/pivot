(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal || {};
    if (ns.coreReady) return;
    window.Pivot.legacy.PivotRegulationsInternal = ns;
    const API = '/api/apps/regulations';
        const FILE_ACCEPT = '.txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.csv,.json,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp';
        const SUPPORTED_FORMATS = 'TXT、Markdown、PDF、Word（DOC/DOCX）、Excel（XLS/XLSX）、CSV、JSON、HTML/HTM';
        const REGULATIONS_PAGE_SIZE = 15;
        const html = window.Pivot.legacy.PivotSafeHtml || {
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
            hasSearched: false,
            effectiveAt: '',
            searchMode: 'hybrid', savedSearches: [],
            filters: { category: '', issuingBody: '', jurisdiction: '', status: '', includeArchived: false },
            aiAnswer: '', aiSources: [], aiTurns: [], aiBusy: false, aiAbortController: null, aiStopSilently: false,
            aiScope: 'library',
            openedFromAi: false,
            openedFromSearch: false,
            importJobs: [], importJobsTimer: null,
            importPreview: null,
            facets: { categories: [], legalLevels: [], issuingBodies: [], jurisdictions: [] },
            libraryView: 'folders', activeFolder: null, categoryFolders: [],
            governancePending: false, governanceScope: '', governanceAssignees: [],
            page: 1, pageSize: REGULATIONS_PAGE_SIZE,
            selectedDocumentIds: new Set(), selectedDocumentTitles: new Map(), batchMode: false, batchDeletePending: false,
            diffView: null,
            busy: false, loaded: false
        };

        const PRESETS = {
            law: { legalLevel: '法律', category: '法律', issuingBody: '全国人民代表大会', jurisdiction: '全国' },
            lawSc: { legalLevel: '法律', category: '法律', issuingBody: '全国人民代表大会常务委员会', jurisdiction: '全国' },
            legalInterpretation: { legalLevel: '法律解释', category: '法律解释', issuingBody: '全国人民代表大会常务委员会', jurisdiction: '全国' },
            regulation: { legalLevel: '行政法规', category: '行政法规', issuingBody: '国务院', jurisdiction: '全国' },
            interpretation: { legalLevel: '司法解释', category: '司法解释', issuingBody: '最高人民法院', jurisdiction: '全国' },
            procuratorate: { legalLevel: '司法解释', category: '司法解释', issuingBody: '最高人民检察院', jurisdiction: '全国' },
            jointInterpretation: { legalLevel: '司法解释', category: '司法解释', issuingBody: '最高人民法院、最高人民检察院', jurisdiction: '全国' },
            rule: { legalLevel: '部门规章', category: '部门规章', issuingBody: '', jurisdiction: '全国' }
        };

        function esc(value) { return html.escapeHtml(value); }

        // 去除 Markdown 格式符号（如 #、**、*、`、~~、> 等），保留纯净文本排版与规范列表符
        function stripMarkdownFormatting(content) {
            if (!content) return '';
            let text = String(content);
            // 移除代码围栏
            text = text.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, '');
            // 移除行首 Markdown 标题标记（如 #、## 等）
            text = text.replace(/^#{1,6}\s+/gm, '');
            // 移除引用符号 >
            text = text.replace(/^>\s*/gm, '');
            // 统一无序列表符号为规范圆点 •
            text = text.replace(/^\s*[-*+]\s+/gm, '• ');
            // 移除加粗与斜体标记 ** 或 * 或 __ 或 _
            text = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
            text = text.replace(/__([^_\n]+?)__/g, '$1');
            text = text.replace(/\*([^*\n]+?)\*/g, '$1');
            text = text.replace(/_([^_\n]+?)_/g, '$1');
            // 清理可能残留的孤立双星号
            text = text.replace(/\*\*/g, '');
            // 移除行内代码标记 `code`
            text = text.replace(/`([^`\n]+?)`/g, '$1');
            // 移除 Markdown 链接 [text](url) -> text
            text = text.replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1');
            // 移除删除线 ~~text~~
            text = text.replace(/~~([^~\n]+?)~~/g, '$1');
            // 移除连续3个以上的分割线 --- 或 ***
            text = text.replace(/^[-*_]{3,}\s*$/gm, '');
            return text.trim();
        }

        // 法规 AI 回答专属渲染：去除 Markdown 格式符号后按结构化段落呈现
        function renderAiCardAnswer(content) {
            const cleanText = stripMarkdownFormatting(content);
            if (!cleanText) return '';
            const paragraphs = cleanText.split(/\n{2,}/);
            return paragraphs.map(p => {
                const lines = p.split('\n').map(line => esc(line.trim())).filter(Boolean);
                return `<p>${lines.join('<br>')}</p>`;
            }).join('');
        }

        // 将正文按 Markdown 渲染为带排版的 HTML，渲染器不可用时回退为转义纯文本
        function renderRichText(content) {
            const text = String(content || '').trim();
            if (!text) return '';
            const markdownFn = window.Pivot?.legacy?.renderMarkdown || window.renderMarkdown || (typeof renderMarkdown === 'function' ? renderMarkdown : null);
            if (typeof markdownFn === 'function') {
                try {
                    const htmlText = markdownFn(text);
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
            return typeof currentUser !== 'undefined' ? currentUser : window.Pivot.legacy.currentUser;
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
            return window.Pivot.legacy.PivotAppModels?.getSelectedModel?.('regulations', 'regulations-ai-model')
                || document.getElementById('regulations-ai-model')?.value
                || '';
        }

        // 删除类操作统一走项目内自定义确认弹窗（不使用浏览器默认 confirm）；showConfirm 不可用时回退
        function regulationConfirm(title, message) {
            return new Promise((resolve) => {
                if (typeof window.Pivot.legacy.showConfirm === 'function') {
                    window.Pivot.legacy.showConfirm(title, message, () => resolve(true));
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
            const requestOptions = { ...options };
            if (requestOptions.body && typeof requestOptions.body === 'string' && !(requestOptions.body instanceof FormData)) {
                requestOptions.headers = {
                    'Content-Type': 'application/json',
                    ...(requestOptions.headers || {})
                };
            }
            const res = await apiFetch(url, requestOptions);
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
        stripMarkdownFormatting,
        renderAiCardAnswer,
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
